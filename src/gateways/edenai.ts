import type { Logger } from '../logging/logger.js';
import { getBytes, getJson, postJson } from '../util/http.js';
import { sniffImageMime } from '../util/files.js';
import { referenceToUrl } from '../util/inputs.js';
import { pollUntil } from './poll.js';
import type {
  Gateway,
  GatewayCapabilities,
  GeneratedImage,
  GeneratedVideo,
  ImageGenParams,
  ImageGenResult,
  ListModelsResult,
  ModelInfo,
  OptionList,
  VideoGenParams,
  VideoGenResult,
  VideoKind,
} from './types.js';

const BASE = 'https://api.edenai.run';

const EDEN_IMAGE_RESOLUTIONS = ['256x256', '512x512', '1024x1024'];
const EDEN_IMAGE_PROVIDERS_FALLBACK = ['openai', 'stabilityai', 'replicate', 'amazon', 'deepai', 'leonardo', 'bytedance', 'google'];
const EDEN_VIDEO_PROVIDERS_FALLBACK: ModelInfo[] = [
  { id: 'minimax', name: 'MiniMax (Hailuo)', provider: 'minimax' },
  { id: 'bytedance', name: 'ByteDance Seedance', provider: 'bytedance' },
  { id: 'google', name: 'Google Veo', provider: 'google' },
  { id: 'amazon', name: 'Amazon Nova Reel', provider: 'amazon' },
  { id: 'openai', name: 'OpenAI Sora 2', provider: 'openai' },
  { id: 'microsoft', name: 'Microsoft (Azure Sora)', provider: 'microsoft' },
];
const VIDEO_CATALOG_TTL_MS = 60 * 60_000;

export class EdenAiGateway implements Gateway {
  readonly id = 'edenai' as const;
  readonly capabilities: GatewayCapabilities = {
    imageGeneration: true,
    textToVideo: true,
    imageToVideo: true,
    imageAspectRatioParam: false, // v2 image is square-resolution based
    imageResolutionParam: true,
    listsImageModels: true,
    listsVideoModels: false,
    multiReferenceImages: true,
    imageReferenceImages: false,
  };

  /** The video catalog, cached in memory for `VIDEO_CATALOG_TTL_MS`. */
  private catalog: { at: number; value: Map<string, EdenVideoCatalogEntry> } | null = null;

  constructor(
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  imageAspectRatios(): null {
    return null;
  }
  imageResolutions(): OptionList {
    return { values: EDEN_IMAGE_RESOLUTIONS, source: 'fallback' };
  }
  /** `input.num_images` on the universal-ai image feature. */
  imageCountRange(): { min: number; max: number } {
    return { min: 1, max: 10 };
  }

  async listImageModels(signal?: AbortSignal): Promise<ListModelsResult> {
    try {
      const info = await getJson<EdenInfo>(`${BASE}/v3/info/image/generation`, { headers: this.headers(), signal, retries: 1 });
      const models = parseEdenInfoModels(info);
      if (models.length > 0) return { models, source: 'api', warnings: [] };
    } catch (err) {
      this.logger.debug('Eden /v3/info/image/generation unavailable; using provider fallback', {
        error: (err as Error).message,
      });
    }
    return {
      models: EDEN_IMAGE_PROVIDERS_FALLBACK.map((p) => ({ id: p, name: p, provider: p })),
      source: 'fallback',
      warnings: ['Could not pull Eden AI image providers from the API; showing a known-provider list.'],
    };
  }

  /**
   * The public video catalog (`/v2/info/provider_subfeatures`, no auth) lists every
   * provider's models and its default; the curated provider list is only the fallback.
   */
  async listVideoModels(_kind: VideoKind, signal?: AbortSignal): Promise<ListModelsResult> {
    const catalog = await this.videoCatalog(signal);
    if (catalog && catalog.size > 0) {
      const models: ModelInfo[] = [];
      for (const [provider, entry] of catalog) {
        for (const m of entry.models) {
          models.push({ id: m, name: `${provider}/${m}${m === entry.defaultModel ? ' (provider default)' : ''}`, provider });
        }
      }
      return { models, source: 'api', warnings: [] };
    }
    return {
      models: EDEN_VIDEO_PROVIDERS_FALLBACK,
      source: 'fallback',
      warnings: ['Could not load the Eden AI video catalog; showing the wired providers (each runs its default model).'],
    };
  }

  /**
   * Eden's video catalog (provider → models + default), fetched lazily and kept for an hour.
   * The endpoint is public — sending the v3 API key makes it 401 ("Token has no 'exp' claim").
   * null when it cannot be loaded (callers then stay optimistic).
   */
  private async videoCatalog(signal?: AbortSignal): Promise<Map<string, EdenVideoCatalogEntry> | null> {
    if (this.catalog && Date.now() - this.catalog.at < VIDEO_CATALOG_TTL_MS) return this.catalog.value;
    try {
      const rows = await getJson<EdenSubfeatureRow[]>(
        `${BASE}/v2/info/provider_subfeatures?feature__name=video&subfeature__name=generation_async`,
        { signal, retries: 1, timeoutMs: 15_000 },
      );
      const value = parseEdenVideoCatalog(rows);
      this.catalog = { at: Date.now(), value };
      return value;
    } catch (err) {
      this.logger.debug('Eden video catalog unavailable', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Refuse an unknown video model BEFORE submitting: Eden forwards any `provider/model` to the
   * provider without checking it, and a provider-side "invalid model" failure is still reported
   * with the full price (probed 2026-10-04: `minimax/definitely-not-a-model` → failed, cost 0.56).
   */
  async checkVideoRequest(params: VideoGenParams): Promise<string | null> {
    const { provider, modelName } = edenVideoTarget(params);
    const catalog = await this.videoCatalog(params.signal);
    if (!catalog || catalog.size === 0) return null; // catalog unreachable — let the provider validate
    const entry = catalog.get(provider);
    if (!entry) return `Eden AI has no video provider "${provider}". Available: ${[...catalog.keys()].join(', ')}. Nothing was submitted.`;
    if (modelName && !entry.models.includes(modelName)) {
      return `Eden AI provider "${provider}" has no video model "${modelName}". Available: ${entry.models.join(', ')} (default: ${entry.defaultModel ?? 'n/a'}). Nothing was submitted.`;
    }
    return null;
  }

  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    const fullModel = edenImageModelId(params);
    const body = buildEdenImageBody(params, fullModel);

    // image/generation is a SYNCHRONOUS universal-ai feature: the async endpoint answers
    // 400 "Not an async feature … Use POST /v3/universal-ai" (verified 2026-10-04 for pruna,
    // openai and google models). The tool's own job store gives callers the async/poll UX.
    params.onProgress?.('submitted');
    const data = await postJson<EdenUniversalResponse>(`${BASE}/v3/universal-ai`, body, {
      headers: this.headers(),
      signal: params.signal,
      timeoutMs: 300_000,
    });
    assertEdenSuccess(data, fullModel);
    const images = await downloadEdenImages(data, params.signal);
    if (images.length === 0) throw new Error(`Eden AI (${fullModel}) returned no image items: ${JSON.stringify(data).slice(0, 300)}`);
    return { images, ...edenCost(data.cost), modelUsed: fullModel, raw: data };
  }

  async generateVideo(params: VideoGenParams): Promise<VideoGenResult> {
    const refusal = await this.checkVideoRequest(params);
    if (refusal) throw new Error(refusal);
    const { provider, modelName } = edenVideoTarget(params);
    const body = buildEdenVideoBody(params, provider, modelName);

    const launch = await postJson<{ public_id?: string }>(`${BASE}/v2/video/generation_async/`, body, {
      headers: this.headers(),
      signal: params.signal,
    });
    const jobId = launch.public_id;
    if (!jobId) throw new Error('Eden AI video launch did not return a public_id.');
    params.onProgress?.('submitted');

    const final = await this.pollVideo(jobId, params);
    const { url, cost, modelKey } = pickEdenVideoOutput(final, provider);
    const bytes = await getBytes(url, { signal: params.signal, timeoutMs: 300_000 });
    return {
      videos: [{ bytes, mimeType: 'video/mp4', sourceUrl: url }],
      ...ranModel(provider, modelName, modelKey),
      ...(cost != null ? { cost } : {}),
      raw: final,
    };
  }

  private pollVideo(jobId: string, params: VideoGenParams): Promise<Record<string, unknown>> {
    return pollUntil<Record<string, unknown>>({
      deadlineMs: 15 * 60_000,
      initialIntervalMs: 5000,
      maxIntervalMs: 12_000,
      signal: params.signal,
      timeoutMessage: `Eden AI video job ${jobId} timed out after 15 minutes.`,
      step: async () => {
        const data = await getJson<Record<string, unknown>>(
          `${BASE}/v2/video/generation_async/${jobId}/?response_as_dict=true&show_base_64=false&show_original_response=false`,
          { headers: this.headers(), signal: params.signal },
        );
        const top = String((data['status'] as string) ?? '').toLowerCase();
        const results = edenVideoResults(data);
        params.onProgress?.(top || 'processing');
        if (['finished', 'success', 'succeeded'].includes(top) && results.some(hasVideoUrl)) return data;
        if (['failed', 'error'].includes(top) || results.some(videoResultFailed)) {
          throw new Error(`Eden AI video job ${jobId} failed: ${JSON.stringify(data['results'] ?? data).slice(0, 300)}`);
        }
        return undefined;
      },
    });
  }
}

/** The `image/generation/<provider>[/<model>]` id Eden's universal-ai endpoint takes. */
function edenImageModelId(params: ImageGenParams): string {
  if (params.model && params.model.startsWith('image/generation/')) return params.model;
  const provider = params.edenProvider || inferProvider(params.model) || 'openai';
  const modelName = edenModelName(params.model, provider);
  return modelName ? `image/generation/${provider}/${modelName}` : `image/generation/${provider}`;
}

function buildEdenImageBody(params: ImageGenParams, fullModel: string): Record<string, unknown> {
  const input: Record<string, unknown> = { text: params.prompt };
  if (params.resolution) input['resolution'] = params.resolution;
  if (params.n != null) input['num_images'] = params.n;
  const body: Record<string, unknown> = { model: fullModel, input };
  // Provider-specific knobs (aspect_ratio, width/height, quality, style, …) pass through here.
  if (params.extra) body['provider_params'] = params.extra;
  return body;
}

/** Decode inline base64 items, downloading the ones that only carry a resource URL. */
async function downloadEdenImages(data: EdenUniversalResponse, signal: AbortSignal | undefined): Promise<GeneratedImage[]> {
  const images: GeneratedImage[] = [];
  for (const item of data.output?.items ?? []) {
    if (item.image) {
      const bytes = Buffer.from(item.image, 'base64');
      images.push({ bytes, mimeType: sniffImageMime(bytes), ...(item.image_resource_url ? { sourceUrl: item.image_resource_url } : {}) });
    } else if (item.image_resource_url) {
      const bytes = await getBytes(item.image_resource_url, { signal });
      images.push({ bytes, mimeType: sniffImageMime(bytes), sourceUrl: item.image_resource_url });
    }
  }
  return images;
}

/** Report the model Eden says RAN (the result key), never just the one asked for — and say when they differ. */
function ranModel(provider: string, modelName: string | null, modelKey: string | undefined): Pick<VideoGenResult, 'modelUsed' | 'warnings'> {
  const requested = modelName ? `${provider}/${modelName}` : provider;
  const differs = modelName != null && modelKey != null && modelKey !== requested;
  return { modelUsed: modelKey ?? requested, ...(differs ? { warnings: [`Requested ${requested}, but Eden AI ran ${modelKey}.`] } : {}) };
}

/** A sync universal-ai answer that failed (`status:"fail"`, or an error with no output) → its provider message. */
function assertEdenSuccess(data: EdenUniversalResponse, model: string): void {
  const failed = String(data.status ?? '').toLowerCase() === 'fail' || (data.error != null && !data.output);
  if (failed) throw new Error(`Eden AI (${model}) failed: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
}

/** Eden reports cost as a numeric string. */
function edenCost(raw: number | string | undefined): { cost?: number } {
  const cost = typeof raw === 'string' ? Number(raw) : raw;
  return cost != null && !Number.isNaN(cost) ? { cost } : {};
}

/** The provider slug and (optional) model name a video request targets; a "model" equal to the provider means its default. */
function edenVideoTarget(params: VideoGenParams): { provider: string; modelName: string | null } {
  const provider = params.edenProvider || inferProvider(params.model) || 'minimax';
  return { provider, modelName: stripProvider(params.model, provider) };
}

/**
 * The model rides in `providers` as `<provider>/<model>` — Eden v2's selector (probed
 * 2026-10-04: it switched MiniMax from its default 2.3 to Hailuo-02). A top-level `model`
 * field is silently ignored (the provider default ran and was billed).
 */
export function buildEdenVideoBody(params: VideoGenParams, provider: string, modelName: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { providers: modelName ? `${provider}/${modelName}` : provider };
  if (params.prompt) body['text'] = params.prompt;
  if (params.duration != null) body['duration'] = params.duration;
  if (params.resolution) body['resolution'] = params.resolution;
  if (params.fps != null) body['fps'] = params.fps;
  Object.assign(body, edenVideoReferenceFields(params.references));
  if (params.extra) Object.assign(body, params.extra);
  return body;
}

/** image-to-video: references as provider-native fields (MiniMax style). */
function edenVideoReferenceFields(refs: VideoGenParams['references']): Record<string, unknown> {
  if (!refs || refs.length === 0) return {};
  const first = refs.find((r) => r.role === 'first_frame') ?? refs.find((r) => !r.role) ?? refs[0];
  const last = refs.find((r) => r.role === 'last_frame');
  const subjects = refs.filter((r) => r.role === 'reference');
  return {
    ...(first ? { first_frame_image: referenceToUrl(first) } : {}),
    ...(last ? { last_frame_image: referenceToUrl(last) } : {}),
    ...(subjects.length > 0 ? { subject_reference: [{ type: 'character', image: subjects.map(referenceToUrl) }] } : {}),
  };
}

/** Per-provider results of a video poll (`results` is keyed `<provider>/<model>`). */
function edenVideoResults(data: Record<string, unknown>): EdenVideoResult[] {
  return Object.values((data['results'] ?? {}) as Record<string, EdenVideoResult>);
}

/** The first provider result that carries a video URL (+ its cost and its `<provider>/<model>` key); throws when none does. */
export function pickEdenVideoOutput(final: Record<string, unknown>, provider: string): { url: string; cost?: number; modelKey?: string } {
  const entries = Object.entries((final['results'] ?? {}) as Record<string, EdenVideoResult>);
  const hit = entries.find(([, r]) => hasVideoUrl(r));
  if (!hit) throw new Error(`Eden AI (${provider}) finished but returned no video URL: ${JSON.stringify(final).slice(0, 300)}`);
  const [modelKey, chosen] = hit;
  const url = (chosen.video_resource_url ?? chosen.video_url) as string;
  return { url, ...(chosen.cost != null ? { cost: chosen.cost } : {}), modelKey };
}

interface EdenVideoCatalogEntry {
  models: string[];
  defaultModel: string | null;
}
interface EdenSubfeatureRow {
  provider?: { name?: string };
  models?: { models?: string[]; default_model?: string } | null;
  constraints?: { models?: string[]; default_model?: string } | null;
}

/** provider → its video models (catalog `models` ∪ `constraints.models`) and default. */
export function parseEdenVideoCatalog(rows: unknown): Map<string, EdenVideoCatalogEntry> {
  const out = new Map<string, EdenVideoCatalogEntry>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows as EdenSubfeatureRow[]) {
    const name = row?.provider?.name;
    if (name) out.set(name, catalogEntry(row));
  }
  return out;
}

function catalogEntry(row: EdenSubfeatureRow): EdenVideoCatalogEntry {
  const listed = [...(row.models?.models ?? []), ...(row.constraints?.models ?? [])];
  const models = [...new Set(listed.filter((m) => typeof m === 'string' && m.length > 0))];
  return { models, defaultModel: row.models?.default_model ?? row.constraints?.default_model ?? null };
}

const hasVideoUrl = (r: EdenVideoResult | null | undefined): boolean => !!r && !!(r.video_resource_url || r.video_url);

const videoResultFailed = (r: EdenVideoResult | null | undefined): boolean =>
  !!r && (String(r.final_status).toLowerCase() === 'failed' || (r.error != null && r.error !== false));

interface EdenInfo {
  models?: unknown;
  providers?: unknown;
  [k: string]: unknown;
}
interface EdenUniversalResponse {
  status?: string;
  cost?: number | string;
  provider?: string;
  output?: { items?: Array<{ image?: string; image_resource_url?: string }> } | null;
  error?: { message?: string; provider_status_code?: number } | null;
}
interface EdenVideoResult {
  id?: string;
  error?: unknown;
  final_status?: string;
  cost?: number;
  video_resource_url?: string;
  video_url?: string;
}

function parseEdenInfoModels(info: EdenInfo): ModelInfo[] {
  const out: ModelInfo[] = [];
  // Eden v3 info ids look like "image/generation/<provider>[/<model>]".
  const add = (raw: string) => {
    const parts = raw.split('/').filter(Boolean);
    let provider: string | undefined;
    let model: string | undefined;
    if (parts[0] === 'image' && parts[1] === 'generation') {
      provider = parts[2];
      model = parts.slice(3).join('/') || undefined;
    } else if (parts.length >= 2) {
      provider = parts[0];
      model = parts.slice(1).join('/') || undefined;
    } else {
      provider = parts[0];
    }
    if (!provider) return;
    out.push({ id: model ?? provider, name: model ? `${provider}/${model}` : provider, provider });
  };
  if (Array.isArray(info.models)) {
    for (const m of info.models) {
      if (typeof m === 'string') add(m);
      else if (m && typeof m === 'object') {
        const obj = m as Record<string, unknown>;
        const id = (obj['name'] ?? obj['model'] ?? obj['id']) as string | undefined;
        if (id) add(String(id));
      }
    }
  }
  return out;
}

function inferProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

/** The bare model name; null for no model or a provider-only id (`minimax`, the wizard's `minimax/minimax`). */
export function stripProvider(model: string | null | undefined, provider: string): string | null {
  if (!model) return null;
  const bare = model.startsWith(provider + '/') ? model.slice(provider.length + 1) : model;
  return bare === provider || bare === '' ? null : bare;
}

/** Reduce any of "image/generation/p/m", "p/m", "m" down to the bare model name (or null). */
function edenModelName(model: string | null | undefined, provider: string): string | null {
  if (!model) return null;
  let m = model;
  if (m.startsWith('image/generation/')) m = m.slice('image/generation/'.length);
  if (m.startsWith(provider + '/')) m = m.slice(provider.length + 1);
  if (m === provider || m === '') return null;
  return m;
}

