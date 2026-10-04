import type { Logger } from '../logging/logger.js';
import { GatewayHttpError, getBytes, getJson, postJson } from '../util/http.js';
import { sniffImageMime } from '../util/files.js';
import { referenceToUrl } from '../util/inputs.js';
import { pollUntil, sleep } from './poll.js';
import type { CapabilityCache } from '../state/capabilityCache.js';
import {
  buildOpenRouterImageBody,
  enumValues,
  explainOpenRouterError,
  isDeterministicFailure,
  isOpenRouterCreditLimit,
  isSizeRejection,
  OpenRouterApiError,
  parseImageModelEndpoints,
  toOpenRouterApiError,
  type BuiltImageRequest,
  type OpenRouterImageCapabilities,
} from './openrouterImages.js';
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
  ReferenceSemantics,
  VideoGenParams,
  VideoGenResult,
  VideoKind,
} from './types.js';

const BASE = 'https://openrouter.ai/api/v1';
/** A persisted capability answer is used for up to a week (models rarely change parameters)… */
const CAPS_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** …and refreshed in the background once it is older than an hour. */
const CAPS_CACHE_REFRESH_MS = 60 * 60_000;

// Documented /images enums (https://openrouter.ai/docs/.../image-generation).
const OPENROUTER_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const OPENROUTER_ASPECT_RATIOS_TALL = ['1:4', '4:1', '1:8', '8:1']; // some image models accept these extremes
const OPENROUTER_IMAGE_SIZES = ['512', '1K', '2K', '4K']; // dedicated /images resolution tiers

// No public programmatic video-model list endpoint — curated fallback (ids best-effort).
const OPENROUTER_VIDEO_FALLBACK: ModelInfo[] = [
  { id: 'google/veo-3.1', name: 'Veo 3.1' },
  { id: 'google/veo-3.1-fast', name: 'Veo 3.1 Fast' },
  { id: 'openai/sora-2', name: 'Sora 2' },
  { id: 'openai/sora-2-pro', name: 'Sora 2 Pro' },
  { id: 'bytedance-seed/seedance-1.5-pro', name: 'Seedance 1.5 Pro' },
  { id: 'x-ai/grok-imagine-video', name: 'Grok Imagine Video' },
];

interface ORModel {
  id: string;
  name?: string;
  created?: number;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

export class OpenRouterGateway implements Gateway {
  readonly id = 'openrouter' as const;
  readonly capabilities: GatewayCapabilities = {
    imageGeneration: true,
    textToVideo: true,
    imageToVideo: true,
    imageAspectRatioParam: true,
    imageResolutionParam: true,
    listsImageModels: true,
    listsVideoModels: true,
    multiReferenceImages: true,
    imageReferenceImages: true,
  };

  /**
   * Per-model Image API capabilities (`/images/models/{id}/endpoints` →
   * `supported_parameters`), filled by `prepare()` (runtime init / wizard) or
   * lazily on the first generation. The SYNC accessors below answer from here;
   * with no entry they fall back to the static documented lists.
   */
  private readonly imageCaps = new Map<string, OpenRouterImageCapabilities>();
  private readonly imageCapsInflight = new Map<string, Promise<OpenRouterImageCapabilities | null>>();

  constructor(
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Best-effort warm-up: cache the configured image model's capabilities. Never throws.
   * With a persistent `cache`, a stored answer (≤ 7 days old) is used at once — a warm start
   * makes no network call — and one older than an hour is refreshed in the background for the
   * next start. Only a cold start waits on `/images/models/{id}/endpoints`.
   */
  async prepare(ctx: { imageModel?: string | null; cache?: CapabilityCache }): Promise<void> {
    const model = ctx.imageModel;
    if (!model) return;
    const key = `openrouter:image-caps:${model}`;
    const hit = readCachedCapabilities(ctx.cache, key);
    if (hit) {
      this.imageCaps.set(model, hit.caps);
      if (hit.ageMs > CAPS_CACHE_REFRESH_MS) {
        void this.fetchImageCapabilities(model, undefined, { force: true }).then((fresh) => {
          if (fresh) ctx.cache?.set(key, fresh);
        });
      }
      return;
    }
    const caps = await this.fetchImageCapabilities(model);
    if (caps) ctx.cache?.set(key, caps);
  }

  /** Cached capabilities for a model (null when never fetched / fetch failed). */
  imageCapabilities(model: string): OpenRouterImageCapabilities | null {
    return this.imageCaps.get(model) ?? null;
  }

  /** Inject capabilities without a network call (tests / offline fixtures). */
  setImageCapabilities(caps: OpenRouterImageCapabilities): void {
    this.imageCaps.set(caps.model, caps);
  }

  /**
   * Fetch + cache `supported_parameters` for an image model. Coalesces concurrent
   * calls; a failure is logged and leaves the cache empty (static fallback applies).
   */
  async fetchImageCapabilities(model: string, signal?: AbortSignal, opts: { force?: boolean } = {}): Promise<OpenRouterImageCapabilities | null> {
    const cached = this.imageCaps.get(model);
    if (cached && !opts.force) return cached;
    const inflight = this.imageCapsInflight.get(model);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const json = await getJson<unknown>(`${BASE}/images/models/${model}/endpoints`, {
          headers: this.headers(),
          retries: 1,
          timeoutMs: 10_000,
          ...(signal ? { signal } : {}),
        });
        const caps = parseImageModelEndpoints(model, json);
        if (!caps) {
          this.logger.warn('OpenRouter image capability lookup returned no endpoints; using static defaults', { model });
          return null;
        }
        this.imageCaps.set(model, caps);
        this.logger.info('OpenRouter image model capabilities loaded', {
          model,
          providers: caps.providers,
          params: Object.fromEntries(Object.entries(caps.params).map(([k, d]) => [k, d.type === 'enum' ? d.values : d.type === 'range' ? `${d.min}..${d.max}` : 'bool'])),
        });
        return caps;
      } catch (err) {
        this.logger.warn('OpenRouter image capability lookup failed; using static defaults', { model, error: (err as Error).message });
        return null;
      } finally {
        this.imageCapsInflight.delete(model);
      }
    })();
    this.imageCapsInflight.set(model, task);
    return task;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'HTTP-Referer': 'https://github.com/ai-image-router-mcp',
      'X-Title': 'ai-image-router-mcp',
    };
  }

  imageAspectRatios(model: string): OptionList {
    const api = enumValues(this.imageCapabilities(model), 'aspect_ratio');
    if (api && api.length > 0) return { values: api, source: 'api' };
    const values = /gemini/i.test(model) ? [...OPENROUTER_ASPECT_RATIOS, ...OPENROUTER_ASPECT_RATIOS_TALL] : OPENROUTER_ASPECT_RATIOS;
    return { values, source: 'fallback' };
  }

  /**
   * Resolution tiers. With live capabilities: the model's own enum, or
   * `{values:[], source:'api'}` when the model has NO resolution parameter at all
   * (gpt-image-2.5 — it renders at its native size and silently ignores the tier).
   * Without them: the documented generic tiers.
   */
  imageResolutions(model: string): OptionList {
    const caps = this.imageCapabilities(model);
    if (caps) {
      const api = enumValues(caps, 'resolution');
      return { values: api ?? [], source: 'api' };
    }
    return { values: OPENROUTER_IMAGE_SIZES, source: 'fallback' };
  }

  /** `quality` levels (gpt-image-2.5: auto|low|medium|high|xhigh|max); null when the model has none / unknown. */
  imageQualityLevels(model: string): OptionList | null {
    const api = enumValues(this.imageCapabilities(model), 'quality');
    return api && api.length > 0 ? { values: api, source: 'api' } : null;
  }

  /** `n` when the model's live capabilities advertise it as a range (gpt-image-1-mini: 1..10); null otherwise. */
  imageCountRange(model: string): { min: number; max: number } | null {
    const d = this.imageCapabilities(model)?.params['n'];
    return d && d.type === 'range' ? { min: Math.max(1, d.min), max: d.max } : null;
  }

  /** Native `background` modes; null when unknown. `{values:[]}` when the model has no such field. */
  imageBackgroundModes(model: string): OptionList | null {
    const caps = this.imageCapabilities(model);
    if (!caps) return null;
    return { values: enumValues(caps, 'background') ?? [], source: 'api' };
  }

  /**
   * `input_references` is generic image-to-image conditioning: the reference
   * constrains the SUBJECT/geometry. Style-only use is not a separate field, so
   * we honour it by steering the prompt instead of pretending it is native.
   */
  referenceSemantics(_model: string): ReferenceSemantics {
    return {
      native: 'subject',
      supported: ['subject', 'style'],
      steered: ['style'],
      field: 'input_references',
      note: 'Image-to-image conditioning on the reference subject/geometry (max 16). Style-only use is steered through the prompt, not a separate field.',
    };
  }

  async listImageModels(signal?: AbortSignal): Promise<ListModelsResult> {
    const data = await getJson<{ data: ORModel[] }>(`${BASE}/models?output_modalities=image`, {
      headers: this.headers(),
      signal,
    });
    const models = (data.data ?? [])
      .filter((m) => m.architecture?.output_modalities?.includes('image'))
      .map<ModelInfo>((m) => ({
        id: m.id,
        ...(m.name !== undefined ? { name: m.name } : {}),
        ...(m.created !== undefined ? { created: m.created } : {}),
        ...(m.description !== undefined ? { description: m.description } : {}),
        raw: m,
      }))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return { models, source: 'api', warnings: [] };
  }

  async listVideoModels(_kind: VideoKind, signal?: AbortSignal): Promise<ListModelsResult> {
    // The ?output_modalities=video filter is applied server-side, so map all returned rows.
    try {
      const data = await getJson<{ data: ORModel[] }>(`${BASE}/models?output_modalities=video`, {
        headers: this.headers(),
        signal,
        retries: 1,
      });
      const models = (data.data ?? [])
        .map<ModelInfo>((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.created ? { created: m.created } : {}), raw: m }))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      if (models.length > 0) return { models, source: 'api', warnings: [] };
    } catch (err) {
      this.logger.debug('OpenRouter video list endpoint failed; using fallback', { error: (err as Error).message });
    }
    return {
      models: OPENROUTER_VIDEO_FALLBACK,
      source: 'fallback',
      warnings: ['Could not list OpenRouter video models; showing a curated list. You may type any valid model id.'],
    };
  }

  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    // The dedicated /images router (https://openrouter.ai/docs/.../image-generation):
    // synchronous (or SSE-streaming); no native async job, so the tool layer runs
    // it as a background job for the async path.
    //
    // The body is built against the model's LIVE capabilities (`supported_parameters`):
    // a `resolution` the model has no parameter for is dropped (with a note), an
    // unsupported `quality`/`background`/aspect value is refused before the request
    // (nothing billed), and an explicit width×height goes out as an exact `size`.
    const caps = await this.fetchImageCapabilities(params.model, params.signal);
    const run: ImageRun = { built: buildOpenRouterImageBody(params, caps), warnings: [] };
    run.warnings.push(...run.built.warnings);
    params.onProgress?.('submitted');

    // A 200 with no image is a transient empty completion. Retry ONCE. The HTTP layer
    // never re-sends this POST on a timeout/5xx (it may already be running and billed),
    // so a 5xx gets exactly one retry here — unless the body says it is deterministic
    // (a 502 safety block / moderation flag fails identically every time). If it still
    // fails we surface it explained (status, error_type, moderation reasons) and let
    // diagnoseFailure add account/config hints.
    const MAX_ATTEMPTS = 2;
    let attempt = 1;
    while (attempt <= MAX_ATTEMPTS) {
      let data: ORImageResponse;
      try {
        data = await postJson<ORImageResponse>(`${BASE}/images`, run.built.body, {
          headers: this.headers(),
          signal: params.signal,
          timeoutMs: 300_000,
        });
      } catch (err) {
        if ((await this.recoverImagePost(err, params, caps, run, attempt, MAX_ATTEMPTS)) === 'next-attempt') attempt += 1;
        continue;
      }
      this.failOnErrorBody(data, params.model);
      const images = decodeImages(data);
      if (images.length > 0) return imageResult(params.model, images, data, run.warnings);
      if (attempt < MAX_ATTEMPTS) {
        this.logger.warn('OpenRouter /images returned no image; retrying once after 1s', { attempt });
        params.onProgress?.('retrying (empty result)');
        await sleep(1000);
      }
      attempt += 1;
    }
    throw new Error(`OpenRouter /images returned no images for model "${params.model}" after ${MAX_ATTEMPTS} attempt(s).`);
  }

  /**
   * An /images POST failed. Decide what happens next: a provider refusal of our exact pixel
   * size is a request-shape fix (rebuild without `size`, same attempt number); a 5xx that is not
   * deterministic gets the one transient retry; anything else is thrown (explained).
   */
  private async recoverImagePost(
    err: unknown,
    params: ImageGenParams,
    caps: OpenRouterImageCapabilities | null,
    run: ImageRun,
    attempt: number,
    maxAttempts: number,
  ): Promise<'same-attempt' | 'next-attempt'> {
    // Provider refused our exact pixel size (e.g. gpt-image: "below the current
    // minimum pixel budget" for 256x256). Fall back to aspect_ratio + tier — the
    // model renders at its native size and the tool layer downsizes locally if
    // it must (ico); a failed request is never billed.
    if (run.built.exactSize && isSizeRejection(err)) {
      const reason = err instanceof GatewayHttpError ? explainOpenRouterError(err.status, err.bodyText, params.model).message : String(err);
      this.logger.warn('OpenRouter rejected the exact size; retrying with aspect_ratio/resolution instead', { model: params.model, size: run.built.body['size'], reason });
      run.warnings.push(`Exact size ${String(run.built.body['size'])} was rejected by the provider (${reason}); rendered at the model's native size instead.`);
      run.built = buildOpenRouterImageBody(params, caps, { noExactSize: true });
      run.warnings.push(...run.built.warnings);
      params.onProgress?.('retrying without exact size');
      return 'same-attempt'; // a request-shape fix, not a transient failure
    }
    if (attempt < maxAttempts && err instanceof GatewayHttpError && err.status >= 500 && !isDeterministicFailure(err.bodyText)) {
      params.onProgress?.(`retrying after HTTP ${err.status} (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(1000);
      return 'next-attempt';
    }
    throw explainHttpError(err, params.model);
  }

  /**
   * OpenRouter relays an UPSTREAM failure as an HTTP 200 carrying an `error`
   * object instead of data — surface it explained and fail fast (deterministic).
   */
  private failOnErrorBody(data: { error?: ORError } | undefined, model: string): void {
    const apiErr = apiErrorMessage(data, model);
    if (!apiErr) return;
    this.logger.error('OpenRouter returned an error object in a 200 body', { model, error: data?.error });
    throw new Error(apiErr);
  }

  async generateVideo(params: VideoGenParams): Promise<VideoGenResult> {
    const { core, optional } = buildVideoBodies(params);
    const { launch, dropped } = await this.submitVideo(params, core, optional);
    this.failOnErrorBody(launch, params.model);
    const id = launch.id;
    if (!id) throw new Error('OpenRouter /videos did not return a job id.');
    params.onProgress?.(`submitted (${launch.status ?? 'pending'})`);

    const result = await this.pollVideo(id, params);
    const videos = await this.fetchVideoContents(id, result.unsigned_urls ?? [], params.signal);
    // A core-only resubmit is never silent: say what the video was generated without.
    const warnings = dropped.length > 0 ? [`${params.model} failed with the tuning parameters; the video was generated WITHOUT: ${dropped.join(', ')}.`] : [];
    return {
      videos,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(result.usage?.cost != null ? { cost: result.usage.cost } : {}),
      modelUsed: params.model,
      raw: result,
    };
  }

  /**
   * POST /videos. Optional tuning params make some models 500 (e.g. Seedance 2.0 t2v), so a
   * server-side failure of the full request is retried ONCE with the core body only.
   */
  private async submitVideo(
    params: VideoGenParams,
    core: Record<string, unknown>,
    optional: Record<string, unknown>,
  ): Promise<{ launch: ORVideoLaunch; dropped: string[] }> {
    const post = (body: Record<string, unknown>): Promise<ORVideoLaunch> =>
      postJson<ORVideoLaunch>(`${BASE}/videos`, body, { headers: this.headers(), signal: params.signal });
    try {
      return { launch: await post({ ...core, ...optional }), dropped: [] };
    } catch (err) {
      if (!(err instanceof GatewayHttpError && err.status >= 500 && Object.keys(optional).length > 0)) throw explainHttpError(err, params.model);
      this.logger.warn('OpenRouter /videos rejected tuning params; retrying with a minimal body', {
        status: err.status,
        dropped: Object.keys(optional),
      });
      params.onProgress?.('retrying without tuning params');
      try {
        return { launch: await post(core), dropped: Object.keys(optional) };
      } catch (err2) {
        throw explainHttpError(err2, params.model);
      }
    }
  }

  /** Download each output; a failed download falls back to the signed URL when there is one. */
  private async fetchVideoContents(id: string, urls: string[], signal: AbortSignal | undefined): Promise<GeneratedVideo[]> {
    const videos: GeneratedVideo[] = [];
    for (let i = 0; i < Math.max(urls.length, 1); i++) {
      try {
        const bytes = await getBytes(`${BASE}/videos/${id}/content?index=${i}`, {
          headers: this.headers(),
          signal,
          timeoutMs: 300_000,
        });
        videos.push({ bytes, mimeType: 'video/mp4', ...(urls[i] ? { sourceUrl: urls[i] } : {}) });
      } catch (err) {
        if (urls[i]) videos.push({ mimeType: 'video/mp4', sourceUrl: urls[i] });
        else throw err;
      }
    }
    return videos;
  }

  /**
   * Best-effort "possible cause" hints for an opaque OpenRouter failure. Makes
   * read-only API calls (endpoints/credits) and never throws.
   */
  async diagnoseFailure(err: unknown, ctx: { model: string }): Promise<string[]> {
    const causes: string[] = [];
    try {
      const msg = err instanceof Error ? err.message : String(err);
      const body = err instanceof GatewayHttpError ? err.bodyText : '';
      const haystack = `${msg} ${body}`;

      // (0) Status-code / error_type / moderation hints derived from the response
      // itself (see openrouterImages.ts). Also covers a job that failed with an
      // explained message re-wrapped as a plain Error by the async job store.
      if (err instanceof OpenRouterApiError) {
        causes.push(...err.hints);
      } else if (err instanceof GatewayHttpError) {
        causes.push(...explainOpenRouterError(err.status, err.bodyText, ctx.model).hints);
      }

      // (1) "No endpoints match your data policy / guardrails" — most often the
      // model's only provider is on the account's "Ignored Providers" list.
      if (/no endpoints available|guardrail restrictions and data policy/i.test(haystack)) {
        const provider = await this.providerLabelFor(ctx.model);
        causes.push(
          `You may have this model's provider (${provider}) on your "Ignored Providers" list ` +
            `("Exclude these providers from serving any requests."). Configure: https://openrouter.ai/settings/privacy`,
        );
      }

      // (2) Billing/quota failures: OpenRouter's OWN credit check vs an upstream quota.
      if (/quota|billing|insufficient|payment required/i.test(haystack)) {
        causes.push(...(await this.billingHints(isOpenRouterCreditLimit(body, msg))));
      }
    } catch {
      /* diagnosis is best-effort — never throw from here */
    }
    return causes;
  }

  /** Provider display name(s) for a model id (e.g. "xAI"), falling back to the author slug. */
  private async providerLabelFor(model: string): Promise<string> {
    try {
      const data = await getJson<{ data?: { endpoints?: Array<{ provider_name?: string }> } }>(
        `${BASE}/models/${model}/endpoints`,
        { headers: this.headers(), retries: 0, timeoutMs: 10_000 },
      );
      const names = [...new Set((data.data?.endpoints ?? []).map((e) => e.provider_name).filter((n): n is string => !!n))];
      if (names.length > 0) return names.join(', ');
    } catch {
      /* fall through to the author slug */
    }
    return model.includes('/') ? model.slice(0, model.indexOf('/')) : model;
  }

  /**
   * Hints for a billing/quota failure. OpenRouter's own 402 says where the limit came from
   * (`metadata.limit_source: "openrouter_credits"`, "Insufficient credits"): that is the
   * account's credit check, so "BYOK" is NOT a cause — the old "balance > $0.10 ⇒ Include
   * BYOK" guess fired on exactly these and contradicted the top-up hint. "Include BYOK" is
   * only suggested for an UPSTREAM quota body (e.g. OpenAI's "You exceeded your current
   * quota", relayed by OpenRouter) while OpenRouter credit remains, and never when `/key`
   * shows BYOK is unused.
   */
  private async billingHints(openRouterCreditLimit: boolean): Promise<string[]> {
    const remaining = await this.creditsRemaining();
    if (openRouterCreditLimit) {
      return remaining != null && remaining > 0
        ? [
            `OpenRouter's own credit check refused the request although the account shows $${remaining.toFixed(2)} left. ` +
              'Credit held by generations still running (e.g. background video jobs) and the request\'s worst-case cost count against ' +
              'the balance — wait for running jobs to finish, or top up: https://openrouter.ai/settings/credits',
          ]
        : [];
    }
    if (remaining == null || remaining <= 0.1) return [];
    const byok = await this.byokStatus();
    if (byok && !byok.enabled) return [];
    return [
      `Your OpenRouter API key likely has the "Include BYOK" option enabled: you still have ` +
        `$${remaining.toFixed(2)} of OpenRouter credit left yet the upstream provider reported a quota/billing error, so the request was ` +
        `routed to your own upstream provider key (now out of quota) instead of OpenRouter credit. ` +
        `Configure: open https://openrouter.ai/workspaces/default/keys, select the key ${keyIdentifier(this.token)}, ` +
        `and turn off the "Include BYOK" toggle on the left.`,
    ];
  }

  /** BYOK facts from `GET /key` (`include_byok_in_limit`, `byok_usage`); null when unavailable. */
  private async byokStatus(): Promise<{ enabled: boolean } | null> {
    try {
      const data = await getJson<{ data?: { include_byok_in_limit?: boolean; byok_usage?: number } }>(`${BASE}/key`, {
        headers: this.headers(),
        retries: 0,
        timeoutMs: 10_000,
      });
      const d = data.data;
      if (!d) return null;
      return { enabled: d.include_byok_in_limit === true || (typeof d.byok_usage === 'number' && d.byok_usage > 0) };
    } catch {
      return null;
    }
  }

  /** Remaining OpenRouter credit (total_credits − total_usage), or null if unavailable. */
  private async creditsRemaining(): Promise<number | null> {
    try {
      const data = await getJson<{ data?: { total_credits?: number; total_usage?: number } }>(`${BASE}/credits`, {
        headers: this.headers(),
        retries: 0,
        timeoutMs: 10_000,
      });
      const c = data.data?.total_credits;
      const u = data.data?.total_usage;
      if (typeof c === 'number' && typeof u === 'number') return c - u;
    } catch {
      /* ignore */
    }
    return null;
  }

  private pollVideo(id: string, params: VideoGenParams): Promise<ORVideoStatus> {
    return pollUntil<ORVideoStatus>({
      deadlineMs: 15 * 60_000,
      initialIntervalMs: 4000,
      maxIntervalMs: 12_000,
      signal: params.signal,
      timeoutMessage: `OpenRouter video job ${id} timed out after 15 minutes.`,
      step: async () => {
        const status = await getJson<ORVideoStatus>(`${BASE}/videos/${id}`, {
          headers: this.headers(),
          signal: params.signal,
        });
        const s = (status.status ?? '').toLowerCase();
        params.onProgress?.(s || 'in_progress');
        if (s === 'completed' || s === 'succeeded' || s === 'success') return status;
        if (s === 'failed' || s === 'error' || s === 'cancelled') {
          throw new Error(`OpenRouter video job ${id} ${s}: ${truncate(JSON.stringify(status), 300)}`);
        }
        return undefined;
      },
    });
  }
}

/** Mutable state of one image generation: the body in flight and the notes gathered so far. */
interface ImageRun {
  built: BuiltImageRequest;
  warnings: string[];
}

/** Wrap a raw HTTP failure into an explained one; anything else passes through unchanged. */
function explainHttpError(err: unknown, model: string): unknown {
  return err instanceof GatewayHttpError ? toOpenRouterApiError(err, model) : err;
}

/** Image bytes out of a `/images` response (entries without `b64_json` are skipped). */
function decodeImages(data: ORImageResponse): GeneratedImage[] {
  const images: GeneratedImage[] = [];
  for (const item of data.data ?? []) {
    if (!item.b64_json) continue;
    const bytes = Buffer.from(item.b64_json, 'base64');
    images.push({ bytes, mimeType: item.media_type ?? sniffImageMime(bytes) });
  }
  return images;
}

function imageResult(model: string, images: GeneratedImage[], data: ORImageResponse, warnings: string[]): ImageGenResult {
  const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
  return {
    images,
    ...(cost != null ? { cost } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    modelUsed: model,
    raw: data,
  };
}

/** Core video body (model, prompt, reference frames) plus the optional tuning params kept apart. */
function buildVideoBodies(params: VideoGenParams): { core: Record<string, unknown>; optional: Record<string, unknown> } {
  const core: Record<string, unknown> = { model: params.model };
  if (params.prompt) core['prompt'] = params.prompt;
  Object.assign(core, videoReferenceFields(params.references));

  // Optional tuning params — some models 500 on these, hence kept separate (see submitVideo).
  const optional: Record<string, unknown> = {};
  if (params.resolution) optional['resolution'] = params.resolution;
  if (params.aspectRatio) optional['aspect_ratio'] = params.aspectRatio;
  if (params.duration != null) optional['duration'] = params.duration;
  if (params.extra) Object.assign(optional, params.extra);
  return { core, optional };
}

/** Image-to-video: first/last frames go in `frame_images`, any other reference in `input_references`. */
function videoReferenceFields(references: VideoGenParams['references']): Record<string, unknown[]> {
  const frames: unknown[] = [];
  const refs: unknown[] = [];
  for (const r of references ?? []) {
    const url = referenceToUrl(r);
    if (r.role === 'first_frame' || r.role === 'last_frame') frames.push({ type: 'image_url', image_url: { url }, frame_type: r.role });
    else refs.push({ type: 'image_url', image_url: { url } });
  }
  return {
    ...(frames.length > 0 ? { frame_images: frames } : {}),
    ...(refs.length > 0 ? { input_references: refs } : {}),
  };
}

/** A stored capability record, if it is usable (right shape); `ageMs` says how stale it is. */
function readCachedCapabilities(cache: CapabilityCache | undefined, key: string): { caps: OpenRouterImageCapabilities; ageMs: number } | null {
  const hit = cache?.get(key, CAPS_CACHE_MAX_AGE_MS);
  const cached = hit?.value as OpenRouterImageCapabilities | undefined;
  if (!hit || !cached || typeof cached !== 'object' || !cached.params || typeof cached.params !== 'object') return null;
  return { caps: cached, ageMs: hit.ageMs };
}

interface ORError {
  message?: string;
  code?: number | string;
  type?: string;
  metadata?: Record<string, unknown>;
}
interface ORVideoLaunch {
  id?: string;
  status?: string;
  polling_url?: string;
  error?: ORError;
}
interface ORImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { cost?: number };
  error?: ORError;
}
interface ORVideoStatus {
  status?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Masked key identifier for pointing the user at the right row in the OpenRouter
// keys dashboard, e.g. "sk-or-v1-cec...4c3" — never the full secret.
function keyIdentifier(token: string): string {
  // Too short to mask meaningfully (real keys are ~70 chars) — say nothing rather than leak it.
  return token.length <= 15 ? '(short/invalid key)' : `${token.slice(0, 12)}...${token.slice(-3)}`;
}

// OpenRouter relays upstream failures (quota/billing, provider errors, data-policy)
// as an `error` object in an otherwise-200 body. Format it for the caller, or return
// undefined when there's no error. Keep the upstream message verbatim — it's the
// actionable part (e.g. "You exceeded your current quota...").
function apiErrorMessage(data: { error?: ORError } | undefined, model: string): string | undefined {
  const e = data?.error;
  if (!e || (e.message == null && e.code == null)) return undefined;
  const explained = explainOpenRouterError(undefined, JSON.stringify({ error: e }), model);
  const hints = explained.hints.length > 0 ? ` Hints: ${explained.hints.join(' ')}` : '';
  return `OpenRouter returned an error in a 200 body: ${truncate(explained.message, 600)}${hints}`;
}
