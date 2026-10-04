import type { Logger } from '../logging/logger.js';
import { GatewayHttpError, getBytes, getJson, postJson, rawRequest } from '../util/http.js';
import { sniffImageMime } from '../util/files.js';
import { referenceToUrl } from '../util/inputs.js';
import { aspectRatioValue } from '../util/aspect.js';
import { pollUntil, PollTimeoutError } from './poll.js';
import { parseBackgroundSpec, parseHexColor } from '../media/palette.js';
import { falImageSpec, falImageCatalog, type FalImageModelSpec } from './falModels.js';
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

// fal exposes one async queue per model endpoint. Submit → poll status → fetch
// result. The queue handles cold starts and load far better than the synchronous
// `fal.run` path, and the same code drives both image and video. See docs/API-NOTES.md.
const QUEUE_BASE = 'https://queue.fal.run';

// No public programmatic model-list API — curated lists (the wizard lets the user
// type any other fal endpoint id). Krea 2 (image) + NVIDIA Cosmos 3 (video) are the
// headline integrations; a few well-known FLUX/video ids round out the menu.
const FAL_IMAGE_FALLBACK: ModelInfo[] = falImageCatalog();
const FAL_I2V_FALLBACK: ModelInfo[] = [
  { id: 'nvidia/cosmos-3-super/image-to-video', name: 'NVIDIA Cosmos 3 Super (image-to-video)' },
  { id: 'fal-ai/kling-video/v2/master/image-to-video', name: 'Kling 2 Master (image-to-video)' },
  { id: 'fal-ai/veo3.1/image-to-video', name: 'Veo 3.1 (image-to-video)' },
];
const FAL_T2V_FALLBACK: ModelInfo[] = [
  { id: 'fal-ai/veo3.1', name: 'Veo 3.1' },
  { id: 'fal-ai/kling-video/v2/master/text-to-video', name: 'Kling 2 Master' },
  { id: 'fal-ai/minimax/hailuo-02/standard/text-to-video', name: 'MiniMax Hailuo 02' },
];

// Other fal image models take an `image_size` enum; we map the common ratios onto it.
const GENERIC_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const FAL_IMAGE_SIZE_BY_RATIO: Record<string, string> = {
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
};
// Fallback enum for a custom/unknown model id that we treat as image_size-based.
const IMAGE_SIZE_ENUM_FALLBACK = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'];

const isCosmos = (model: string): boolean => /cosmos/i.test(model);

/** Poll deadlines/cadence; overridable so tests need not wait out real minutes. */
export interface FalGatewayOptions {
  /** Image job deadline (default 5 min). */
  imageDeadlineMs?: number;
  /** Image job deadline when reference images ride along (default 10 min — Krea style refs run long). */
  imageWithReferencesDeadlineMs?: number;
  /** Video job deadline (default 20 min). */
  videoDeadlineMs?: number;
  /** First poll interval (default 2 s; grows by 1 s per round up to 10 s). */
  pollIntervalMs?: number;
}
const FAL_DEFAULTS: Required<FalGatewayOptions> = {
  imageDeadlineMs: 5 * 60_000,
  imageWithReferencesDeadlineMs: 10 * 60_000,
  videoDeadlineMs: 20 * 60_000,
  pollIntervalMs: 2000,
};

export class FalGateway implements Gateway {
  readonly id = 'fal' as const;
  readonly capabilities: GatewayCapabilities = {
    imageGeneration: true,
    textToVideo: true,
    imageToVideo: true,
    // Krea uses aspect_ratio; for other models we map it onto image_size.
    imageAspectRatioParam: true,
    // Size is derived from the aspect ratio (Krea has no size param at all), so we
    // don't ask for a separate resolution — pass image_size via provider_options.
    imageResolutionParam: false,
    listsImageModels: false,
    listsVideoModels: false,
    // Cosmos i2v takes a single image_url; extra references go via provider_options.
    multiReferenceImages: false,
    // Reference support is PER-MODEL (Krea 2 = image_style_references; most other
    // fal image models have NO conditioning input). The tool exposes the param when
    // any model we serve supports it; `generateImage` hard-errors per model before
    // submitting (no credits) if references are passed to a model that can't take them.
    imageReferenceImages: true,
  };

  private readonly opts: Required<FalGatewayOptions>;

  constructor(
    private readonly token: string,
    private readonly logger: Logger,
    opts: FalGatewayOptions = {},
  ) {
    this.opts = { ...FAL_DEFAULTS, ...opts };
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${this.token}` };
  }

  /**
   * aspect_ratio models (Krea/Ideogram) list their own ratios. The image_size families
   * (FLUX/Recraft/Cosmos) take exact pixels via width/height, AND the ratios that map onto
   * their `image_size` tiers (`FAL_IMAGE_SIZE_BY_RATIO`) — offering none left the wizard's
   * default-aspect question with no effect and `generate_image` without an aspect_ratio.
   */
  imageAspectRatios(model: string): OptionList {
    const spec = falImageSpec(model);
    if (spec?.sizeField === 'aspect_ratio') return { values: spec.sizes, source: 'fallback' };
    return { values: GENERIC_ASPECT_RATIOS, source: 'fallback' };
  }

  imageResolutions(): null {
    return null;
  }

  /**
   * Reference semantics are strictly per-model on fal: Krea 2's
   * `image_style_references` transfers the reference's STYLE/medium, while the
   * FLUX 2 Pro *Edit* endpoint's `image_urls` conditions on its SUBJECT. Every
   * other fal image model has no conditioning input at all.
   */
  referenceSemantics(model: string): ReferenceSemantics | null {
    const spec = falImageSpec(model);
    if (!spec?.referenceField) return null;
    if (spec.referenceSemantics === 'subject') {
      return {
        native: 'subject',
        supported: ['subject', 'style'],
        steered: ['style'],
        field: spec.referenceField,
        note: 'Conditions on the reference subject/geometry; style-only use is steered through the prompt.',
      };
    }
    return {
      native: 'style',
      supported: ['style'],
      field: spec.referenceField,
      note: 'Style/medium transfer ONLY — it copies the reference’s look (a photo reference makes a photographic result), not its object design. For subject conditioning use an image-edit model (e.g. fal-ai/flux-2-pro/edit) or the OpenRouter gateway.',
    };
  }

  async listImageModels(): Promise<ListModelsResult> {
    return {
      models: FAL_IMAGE_FALLBACK,
      source: 'fallback',
      warnings: [],
      notes: ['fal has no public model-list API; showing the wired models. You may type any fal endpoint id.'],
    };
  }

  async listVideoModels(kind: VideoKind): Promise<ListModelsResult> {
    return {
      models: kind === 'image-to-video' ? FAL_I2V_FALLBACK : FAL_T2V_FALLBACK,
      source: 'fallback',
      warnings: [],
      notes: ['fal has no public model-list API; showing wired models. You may type any fal endpoint id.'],
    };
  }

  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    const input = buildFalImageInput(params);

    const result = await this.runQueue(params.model, input, {
      signal: params.signal,
      onProgress: params.onProgress,
      pollDeadlineMs: params.references?.length ? this.opts.imageWithReferencesDeadlineMs : this.opts.imageDeadlineMs,
    });

    const items = extractImageItems(result);
    if (items.length === 0) {
      throw new Error(`fal (${params.model}) returned no images: ${JSON.stringify(result).slice(0, 300)}`);
    }
    const images: GeneratedImage[] = [];
    for (const it of items) {
      const bytes = await getBytes(it.url, { signal: params.signal, timeoutMs: 120_000 });
      images.push({ bytes, mimeType: it.content_type || sniffImageMime(bytes), sourceUrl: it.url });
    }
    return { images, modelUsed: params.model, raw: result };
  }

  /**
   * fal image-to-video sends ONE image (`image_url`). An end frame or extra references would
   * be dropped while the clip is still billed, so they are refused before submitting.
   */
  async checkVideoRequest(params: VideoGenParams): Promise<string | null> {
    return falVideoInputRefusal(params);
  }

  async generateVideo(params: VideoGenParams): Promise<VideoGenResult> {
    const refusal = falVideoInputRefusal(params);
    if (refusal) throw new Error(refusal);
    const { core, optional } = buildFalVideoInput(params);
    const queueOpts: QueueOpts = { signal: params.signal, onProgress: params.onProgress, pollDeadlineMs: this.opts.videoDeadlineMs };
    const { result, warnings } = await this.runVideoQueue(params, core, optional, queueOpts);

    const url = extractVideoUrl(result);
    if (!url) throw new Error(`fal (${params.model}) finished but returned no video URL: ${JSON.stringify(result).slice(0, 300)}`);
    const bytes = await getBytes(url, { signal: params.signal, timeoutMs: 300_000 });
    return {
      videos: [{ bytes, mimeType: 'video/mp4', sourceUrl: url }],
      ...(warnings.length > 0 ? { warnings } : {}),
      modelUsed: params.model,
      raw: result,
    };
  }

  /**
   * Run a video job with the tuning params; if they were definitively rejected, retry with just
   * the core body (mirrors the OpenRouter /videos fallback). Every other failure is annotated
   * for the user and thrown — see `rejectedTuningPhase` for what counts as "definitively".
   */
  private async runVideoQueue(
    params: VideoGenParams,
    core: Record<string, unknown>,
    optional: Record<string, unknown>,
    queueOpts: QueueOpts,
  ): Promise<{ result: Record<string, unknown>; warnings: string[] }> {
    let handle: FalQueueHandle | undefined;
    try {
      handle = await this.submitQueue(params.model, { ...core, ...optional }, queueOpts);
      return { result: await this.awaitQueue(params.model, handle, queueOpts), warnings: [] };
    } catch (err) {
      const httpErr = err instanceof GatewayHttpError ? err : null;
      const phase = rejectedTuningPhase(handle, httpErr);
      const dropped = Object.keys(optional);
      if (phase && dropped.length > 0) {
        this.logger.warn('fal video rejected tuning params; retrying with a minimal body', { status: httpErr?.status, phase, dropped });
        params.onProgress?.('retrying without tuning params');
        const result = await this.runQueue(params.model, core, queueOpts);
        // Never silent: the caller asked for these and did not get them.
        const reason = httpErr ? `: ${httpErr.providerMessage.slice(0, 200)}` : '';
        return { result, warnings: [`${params.model} rejected the tuning parameters (HTTP 422${reason}); the video was generated WITHOUT: ${dropped.join(', ')}.`] };
      }
      throw annotateFailedQueue(err, handle);
    }
  }

  /**
   * Submit a job to a fal model's queue, poll its status until COMPLETED, then
   * fetch and return the result payload. Uses the status/response URLs fal returns
   * (don't reconstruct them — models with sub-paths like `krea/v2/large/...` need
   * fal's own app-relative URLs).
   */
  private async runQueue(modelId: string, input: Record<string, unknown>, opts: QueueOpts): Promise<Record<string, unknown>> {
    const handle = await this.submitQueue(modelId, input, opts);
    return this.awaitQueue(modelId, handle, opts);
  }

  /** Submit to the queue. Once this resolves, a (billable) job EXISTS on fal's side. */
  private async submitQueue(modelId: string, input: Record<string, unknown>, opts: QueueOpts): Promise<FalQueueHandle> {
    let submit: FalSubmitResponse;
    try {
      submit = await postJson<FalSubmitResponse>(`${QUEUE_BASE}/${modelId}`, input, {
        headers: this.headers(),
        signal: opts.signal,
      });
    } catch (err) {
      throw annotateUnknownModel(err, modelId);
    }
    const statusUrl = submit.status_url;
    const responseUrl = submit.response_url;
    if (!statusUrl || !responseUrl) {
      throw new Error(`fal (${modelId}) did not return queue URLs: ${JSON.stringify(submit).slice(0, 200)}`);
    }
    opts.onProgress?.(submit.status ?? 'IN_QUEUE', { requestId: submit.request_id });
    return {
      statusUrl,
      responseUrl,
      ...(submit.cancel_url ? { cancelUrl: submit.cancel_url } : {}),
      ...(submit.request_id ? { requestId: submit.request_id } : {}),
    };
  }

  /** Poll an accepted job until COMPLETED, then fetch its result payload. */
  private async awaitQueue(modelId: string, handle: FalQueueHandle, opts: QueueOpts): Promise<Record<string, unknown>> {
    // The job may complete on a poll that straddles the deadline. Never discard a
    // finished (already billed) job as a timeout — only time out if we never saw COMPLETED
    // (`pollUntil` returns as soon as a step reports COMPLETED, whatever the clock says).
    try {
      await pollUntil<FalStatusResponse>({
        deadlineMs: opts.pollDeadlineMs,
        initialIntervalMs: this.opts.pollIntervalMs,
        maxIntervalMs: Math.max(this.opts.pollIntervalMs, 10_000),
        signal: opts.signal,
        timeoutMessage: `fal (${modelId}) timed out after ${Math.round(opts.pollDeadlineMs / 60_000)} minutes.`,
        step: async () => {
          const status = await getJson<FalStatusResponse>(handle.statusUrl, { headers: this.headers(), signal: opts.signal });
          const s = (status.status ?? '').toUpperCase();
          opts.onProgress?.(s || 'IN_PROGRESS');
          if (s !== 'COMPLETED') return undefined;
          if (status.error) throw new Error(`fal (${modelId}) failed: ${formatFalError(status.error)}`);
          return status;
        },
      });
    } catch (err) {
      if (!(err instanceof PollTimeoutError)) throw err;
      // Still running at the deadline: cancel it so it is not billed after we report failure —
      // unless it finished meanwhile, in which case the (already paid) result is collected after all.
      const outcome = await this.cancelJob(handle);
      if (outcome.kind !== 'already-completed') throw timeoutError(modelId, handle, opts.pollDeadlineMs, outcome);
    }

    const result = await getJson<Record<string, unknown>>(handle.responseUrl, { headers: this.headers(), signal: opts.signal, timeoutMs: 300_000 });
    if (result['error'] || result['detail']) {
      throw new Error(`fal (${modelId}) error: ${formatFalError(result['error'] ?? result['detail'])}`);
    }
    return result;
  }

  /**
   * `PUT {cancel_url}` for a job we are giving up on (fal: 202 CANCELLATION_REQUESTED, or 400
   * ALREADY_COMPLETED). Best-effort; never throws. Cancelling is harmless to repeat.
   */
  private async cancelJob(handle: FalQueueHandle): Promise<CancelOutcome> {
    if (!handle.cancelUrl) return { kind: 'no-cancel-url' };
    try {
      const res = await rawRequest(handle.cancelUrl, { method: 'PUT', headers: this.headers(), timeoutMs: 15_000, retries: 1, idempotent: true });
      const text = await res.text();
      if (/ALREADY_COMPLETED/i.test(text)) return { kind: 'already-completed' };
      if (res.ok) {
        this.logger.warn('fal job timed out; cancelled', { requestId: handle.requestId });
        return { kind: 'cancelled' };
      }
      return { kind: 'refused', detail: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    } catch (err) {
      return { kind: 'failed', detail: (err as Error).message };
    }
  }
}

/** What a cancel attempt achieved (see `FalGateway.cancelJob`). */
type CancelOutcome = { kind: 'cancelled' | 'already-completed' | 'no-cancel-url' } | { kind: 'refused' | 'failed'; detail: string };

/** The error for a job still running at the deadline: names it and says whether it was cancelled. */
function timeoutError(modelId: string, handle: FalQueueHandle, deadlineMs: number, outcome: CancelOutcome): FalTimeoutError {
  const mins = Math.max(1, Math.round(deadlineMs / 60_000));
  return new FalTimeoutError(`fal (${modelId}) did not finish within ${mins} minute(s) (request_id ${handle.requestId ?? 'unknown'}): ${cancelText(outcome)}.`);
}

function cancelText(outcome: CancelOutcome): string {
  if ('detail' in outcome) {
    return `cancelling it ${outcome.kind === 'refused' ? 'was refused' : 'failed'} (${outcome.detail}), so it may still complete and be billed — check your fal dashboard`;
  }
  if (outcome.kind === 'cancelled') return 'it was CANCELLED via its cancel_url, so it should not be billed further';
  return 'fal gave no cancel_url, so it may still complete and be billed — check your fal dashboard';
}

interface QueueOpts {
  signal?: AbortSignal | undefined;
  onProgress?: ((s: string, meta?: { requestId?: string }) => void) | undefined;
  pollDeadlineMs: number;
}

/** An ACCEPTED fal queue job: the URLs fal returned for it (used verbatim). */
interface FalQueueHandle {
  statusUrl: string;
  responseUrl: string;
  cancelUrl?: string;
  requestId?: string;
}

/** A job still running at the deadline; the message already says whether it was cancelled. */
export class FalTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FalTimeoutError';
  }
}

/** fal answers an unknown endpoint with 404 `Application "<last segment>" not found` — name the id that was asked for. */
function annotateUnknownModel(err: unknown, modelId: string): unknown {
  if (err instanceof GatewayHttpError && err.status === 404 && !err.note) {
    err.note = `(fal has no endpoint "${modelId}" — check the model id at https://fal.ai/models; nothing was queued or billed)`;
  }
  return err;
}

/** The refusal for image-to-video inputs fal never sends (null when there are none). */
export function falVideoInputRefusal(params: VideoGenParams): string | null {
  if (params.kind !== 'image-to-video') return null;
  const refs = params.references ?? [];
  const extras = [
    refs.some((r) => r.role === 'last_frame') ? '`image_last`' : null,
    refs.some((r) => r.role === 'reference') ? '`reference_images`' : null,
  ].filter((x): x is string => x !== null);
  if (extras.length === 0) return null;
  return (
    `fal image-to-video sends only the first frame (\`image_url\`), so ${extras.join(' and ')} would be dropped while the clip is still billed. ` +
    `Nothing was submitted. Remove ${extras.length > 1 ? 'them' : 'it'}, or — if ${params.model} has its own field for it (e.g. an end-frame URL) — pass that via provider_options.`
  );
}

/** Add the accepted job's request id to an error so a paid result can still be found. */
function annotateFalJob(err: unknown, handle: FalQueueHandle): unknown {
  const note = ` (fal request_id ${handle.requestId} was accepted and may still complete — it was not resubmitted)`;
  // A timeout already says what happened to the job (cancelled or not) and names its id.
  if (err instanceof FalTimeoutError) return err;
  if (!handle.requestId || !(err instanceof Error) || err.message.includes(note)) return err;
  try {
    err.message += note; // keeps the error's type (GatewayHttpError status etc.)
    // describeError shows a GatewayHttpError's provider message, not `message` — carry the note too.
    if (err instanceof GatewayHttpError) err.note = note.trim();
    return err;
  } catch {
    // DOMException (TimeoutError/AbortError) has a read-only message.
    return new Error(`${err.message}${note}`, { cause: err });
  }
}

/** A 5xx on the queue submit: say the job may exist (and was deliberately not re-sent). */
function annotateAmbiguousSubmit(err: GatewayHttpError): GatewayHttpError {
  const note = '(the submit failed after fal may already have queued the job — it was not re-sent; check your fal dashboard before retrying)';
  if (!err.note) {
    err.note = note;
    err.message += ` ${note}`;
  }
  return err;
}

/**
 * Were the optional tuning params DEFINITIVELY rejected, with no job left running? Only then
 * may the job be resubmitted without them: the submit itself was refused with a 422 (validation —
 * provably nothing queued), or the queued job finished as a 422 on its result. A 5xx on the
 * SUBMIT is ambiguous (fal's edge can fail after the job was enqueued), and a failure while
 * POLLING an accepted job (status 5xx, network error, deadline) leaves a job running — neither
 * is resubmitted: a second submit could pay for the same video twice.
 */
function rejectedTuningPhase(handle: FalQueueHandle | undefined, httpErr: GatewayHttpError | null): 'submit' | 'result' | null {
  if (httpErr?.status !== 422) return null;
  if (handle === undefined) return 'submit';
  return httpErr.url === handle.responseUrl ? 'result' : null;
}

/** Annotate a video failure that is NOT resubmitted, so the user knows whether a job may exist. */
function annotateFailedQueue(err: unknown, handle: FalQueueHandle | undefined): unknown {
  // Name the accepted job so a paid result is still recoverable from fal's dashboard.
  if (handle) return annotateFalJob(err, handle);
  if (err instanceof GatewayHttpError && err.status >= 500) return annotateAmbiguousSubmit(err);
  return err;
}

interface FalSubmitResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  cancel_url?: string;
  status?: string;
}
interface FalStatusResponse {
  status?: string;
  error?: unknown;
  queue_position?: number;
}
interface FalImageItem {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

/** Pull `images[]` (text-to-image) or a single `image` from a fal result. */
function extractImageItems(result: Record<string, unknown>): FalImageItem[] {
  const out: FalImageItem[] = [];
  const push = (v: unknown): void => {
    if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
      out.push(v as FalImageItem);
    }
  };
  const images = result['images'];
  if (Array.isArray(images)) images.forEach(push);
  else if (images) push(images);
  if (out.length === 0 && result['image']) push(result['image']);
  return out;
}

/** Pull the output video URL from a fal result (`video.url`, or `videos[].url`). */
function extractVideoUrl(result: Record<string, unknown>): string | null {
  const video = result['video'];
  if (video && typeof video === 'object' && typeof (video as { url?: unknown }).url === 'string') {
    return (video as { url: string }).url;
  }
  const videos = result['videos'];
  if (Array.isArray(videos)) {
    const hit = videos.find((v) => v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string');
    if (hit) return (hit as { url: string }).url;
  }
  return null;
}

function formatFalError(err: unknown): string {
  if (typeof err === 'string') return err.slice(0, 400);
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o['message'] === 'string') return o['message'].slice(0, 400);
  }
  return JSON.stringify(err).slice(0, 400);
}

/**
 * Video request: the core body (prompt + the i2v source image) is always sent; the optional
 * tuning is kept apart so it can be dropped if a model rejects it. Field names differ across
 * fal models, so tuning is mapped per family (Cosmos vs the rest).
 */
function buildFalVideoInput(params: VideoGenParams): { core: Record<string, unknown>; optional: Record<string, unknown> } {
  const core: Record<string, unknown> = {};
  if (params.prompt) core['prompt'] = params.prompt;
  if (params.kind === 'image-to-video') {
    const first = params.references?.find((r) => r.role === 'first_frame') ?? params.references?.[0];
    if (!first) throw new Error('image-to-video requires a source image.');
    core['image_url'] = referenceToUrl(first);
  }
  const optional = isCosmos(params.model) ? cosmosVideoTuning(params) : genericVideoTuning(params);
  if (params.extra) Object.assign(optional, params.extra);
  return { core, optional };
}

function cosmosVideoTuning(params: VideoGenParams): Record<string, unknown> {
  const optional: Record<string, unknown> = {};
  if (params.fps != null) optional['frames_per_second'] = params.fps;
  if (params.duration != null && params.fps != null) optional['num_frames'] = Math.round(params.duration * params.fps);
  const size = params.aspectRatio ? FAL_IMAGE_SIZE_BY_RATIO[params.aspectRatio] : undefined;
  if (size) optional['image_size'] = size;
  return optional;
}

function genericVideoTuning(params: VideoGenParams): Record<string, unknown> {
  const optional: Record<string, unknown> = {};
  if (params.resolution) optional['resolution'] = params.resolution;
  if (params.fps != null) optional['fps'] = params.fps;
  if (params.duration != null) optional['duration'] = params.duration;
  if (params.aspectRatio) optional['aspect_ratio'] = params.aspectRatio;
  return optional;
}

/** Derive `height` from an explicit height, else from `width * (h/w)`, else width (square). */
function resolvedSize(spec: FalImageModelSpec, params: ImageGenParams): { width?: number; height?: number } {
  const ratio = aspectRatioValue(params.aspectRatio);
  if (spec.sizeField !== 'image_size') return {}; // aspect-only models can't take pixels
  const width = params.width;
  const height = params.height ?? (width != null ? Math.round(width / ratio) : 0);
  return { ...(width != null ? { width } : {}), ...(height > 0 ? { height } : {}) };
}

/**
 * Build the fal image request body from the per-model spec. Seeded defaults
 * (`output_format:"png"`, `safety_tolerance:"5"`, `enable_safety_checker:false`) are only
 * sent to models whose schema carries them. Object `image_size` is used when the model
 * accepts it and a width (and/or height) was requested; otherwise the nearest `image_size`
 * enum tier (or `aspect_ratio` for Krea/Ideogram). References are hard-rejected BEFORE
 * submitting for models with no conditioning input (so no credits are spent).
 */
export function buildFalImageInput(params: ImageGenParams): Record<string, unknown> {
  const spec = falImageSpec(params.model) ?? {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM_FALLBACK,
  };
  const input: Record<string, unknown> = { prompt: params.prompt };

  // Model-specific safety/output knobs (only where the model reads them).
  if (spec.outputFormat) input['output_format'] = 'png';
  if (spec.enableSafetyChecker) input['enable_safety_checker'] = false;
  if (spec.safetyTolerance) input['safety_tolerance'] = '5';

  applyFalReferences(input, spec, params);
  applyFalColors(input, spec, params);
  if (spec.sizeField === 'image_size') applyImageSizeFields(input, spec, params);
  else applyAspectRatioFields(input, params);

  // Escape hatch — anything the model supports but we don't surface (creativity,
  // styles, moodboards, image_size override, seed, …).
  if (params.extra) Object.assign(input, params.extra);
  return input;
}

/** Reference images, mapped to the model's own field — or hard-rejected BEFORE submitting if it has none. */
function applyFalReferences(input: Record<string, unknown>, spec: FalImageModelSpec, params: ImageGenParams): void {
  const refs = params.references;
  if (!refs || refs.length === 0) return;
  if (spec.referenceField === 'image_style_references') {
    // Krea 2's `image_style_references[]` items are `{ image_url, strength? }` — NOT `{ url }`.
    // `image_url` must be publicly accessible, so a bytes/data-URL reference is converted to
    // a data URL; an http(s) URL is passed through. (`strength` defaults to 1; allow override
    // via provider_options, which is merged last.)
    input['image_style_references'] = refs.map((r) => ({ image_url: referenceToUrl(r) }));
  } else if (spec.referenceField === 'image_urls') {
    // FLUX 2 Pro *Edit* — subject conditioning; a flat array of URLs.
    input['image_urls'] = refs.map((r) => referenceToUrl(r));
  } else {
    // Hard fail before the queue submit — no image generation, no credits.
    throw new Error(`fal (${params.model}) cannot take reference images: it has no image-conditioning input. Use a model that supports image_style_references, or pass the reference via provider_options if the model offers one.`);
  }
}

/**
 * Structured colour constraints — only Recraft has a native palette input, so a
 * pinned palette reaches it as DATA there and as the compiled prompt block
 * everywhere else (the tool layer always puts it in the prompt too).
 */
function applyFalColors(input: Record<string, unknown>, spec: FalImageModelSpec, params: ImageGenParams): void {
  if (!spec.colorFields) return;
  if (params.palette && params.palette.length > 0) {
    input['colors'] = params.palette.map((hex) => parseHexColor(hex));
  }
  if (params.background) {
    const bg = parseBackgroundSpec(params.background);
    if (bg.kind === 'color') input['background_color'] = bg.color;
  }
}

/** `image_size`-based models: prefer exact object size `{width, height}`; fall back to an enum tier from the ratio. */
function applyImageSizeFields(input: Record<string, unknown>, spec: FalImageModelSpec, params: ImageGenParams): void {
  const { width, height } = resolvedSize(spec, params);
  if (spec.objectSize && width != null) {
    input['image_size'] = { width, ...(height != null ? { height } : {}) };
  } else if (params.aspectRatio) {
    const tier = FAL_IMAGE_SIZE_BY_RATIO[params.aspectRatio];
    if (tier) input['image_size'] = tier;
  }
  if (params.negativePrompt) input['negative_prompt'] = params.negativePrompt;
  if (params.n != null) input['num_images'] = params.n;
}

/** aspect_ratio-based models (Krea/Ideogram). */
function applyAspectRatioFields(input: Record<string, unknown>, params: ImageGenParams): void {
  if (params.aspectRatio) input['aspect_ratio'] = params.aspectRatio;
  if (params.negativePrompt && /ideogram/i.test(params.model)) input['negative_prompt'] = params.negativePrompt;
}
