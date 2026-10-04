import type { GatewayId } from '../config/schema.js';
import type { CapabilityCache } from '../state/capabilityCache.js';

export interface ModelInfo {
  id: string;
  name?: string;
  /** unix seconds — used to sort latest-first */
  created?: number;
  description?: string;
  /** Eden AI: the underlying sub-provider slug */
  provider?: string;
  raw?: unknown;
}

export interface ListModelsResult {
  models: ModelInfo[];
  source: 'api' | 'fallback' | 'manual';
  /** non-fatal issues (e.g. an endpoint 404'd and we used a fallback) */
  warnings: string[];
  /**
   * Informational remarks that are NOT problems (e.g. "fal has no model-list API, so this is
   * the curated list" — true on every run by design). Shown by the wizard, never recorded
   * as a configuration issue.
   */
  notes?: string[];
}

export interface OptionList {
  values: string[];
  source: 'api' | 'fallback';
}

export interface ImageGenParams {
  prompt: string;
  model: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  /** Exact target width (px) — used by gateways whose models accept pixel sizes (e.g. fal object `image_size`). */
  width?: number | null;
  /** Exact target height (px); derived from width × aspect_ratio when omitted. */
  height?: number | null;
  n?: number | null;
  /**
   * Rendering quality/effort level for models that expose one (OpenRouter
   * `quality`: auto|low|medium|high|xhigh|max on gpt-image-2.5). Validated
   * against the model's advertised enum before the request.
   */
  quality?: string | null;
  negativePrompt?: string | null;
  /** Sampling controls, for gateways whose image generation is driven by an LLM. */
  temperature?: number | null;
  topP?: number | null;
  /** Eden AI sub-provider slug */
  edenProvider?: string | null;
  /**
   * Reference images for models that support image-conditioned generation /
   * editing (e.g. Gemini image). Already resolved to bytes by the tool layer.
   */
  references?: ReferenceImage[];
  /**
   * Which reference semantic the caller asked for — condition on the reference's
   * SUBJECT/geometry, or adopt its STYLE/medium. The tool layer validates it
   * against `Gateway.referenceSemantics(model)` before any request is made.
   */
  referenceMode?: ReferenceMode | null;
  /**
   * Pinned accent colours as normalized `#rrggbb`. Already compiled into the
   * prompt by the tool layer; gateways ADDITIONALLY map it to a native field
   * where the model has one (fal Recraft `colors[]`).
   */
  palette?: string[] | null;
  /**
   * Background requirement (`transparent`, a `#rrggbb`, or free text). Already
   * in the prompt; gateways map it natively where possible (OpenRouter
   * `background`, fal Recraft `background_color`).
   */
  background?: string | null;
  /** Raw gateway-specific fields merged into the request body. */
  extra?: Record<string, unknown> | null;
  signal?: AbortSignal;
  /**
   * Progress callback for the (internally polling) generation. `meta.requestId`
   * carries the provider's native remote job id when the gateway surfaces one
   * (fal request_id, Eden public_id) so the async job layer can expose it.
   */
  onProgress?: (status: string, meta?: { requestId?: string }) => void;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  sourceUrl?: string;
}

export interface ImageGenResult {
  images: GeneratedImage[];
  text?: string;
  /**
   * Notes about how the request was adapted to the model (e.g. a resolution tier
   * the model has no parameter for was dropped, an exact size was rejected and
   * the native size used). Surfaced verbatim in the tool result.
   */
  warnings?: string[];
  cost?: number;
  modelUsed: string;
  raw?: unknown;
}

export type VideoKind = 'text-to-video' | 'image-to-video';

/**
 * What a reference image is FOR. `subject` conditions on the reference's
 * object/geometry (image-to-image, edit); `style` transfers its look/medium
 * (palette, shading, photographic vs vector) without copying the object. Models
 * expose one or the other — conflating them is how a photo reference turns a
 * "clean 3D icon" request into a picture of the photo.
 */
export type ReferenceMode = 'subject' | 'style';

export interface ReferenceSemantics {
  /** What the model's conditioning input natively does. */
  native: ReferenceMode;
  /** Modes the gateway can honour — the native one, plus any it can steer via the prompt. */
  supported: ReferenceMode[];
  /** The provider request field references map to (for diagnostics). */
  field: string;
  /** Which supported modes are prompt-steered rather than native. */
  steered?: ReferenceMode[];
  note?: string;
}

export interface ReferenceImage {
  /** Raw bytes (omit if `url` is provided). */
  bytes?: Buffer;
  mimeType?: string;
  role?: 'first_frame' | 'last_frame' | 'reference';
  /** A public URL for this image, if the caller supplied one. */
  url?: string;
}

export interface VideoGenParams {
  kind: VideoKind;
  prompt?: string | null;
  model: string;
  edenProvider?: string | null;
  resolution?: string | null;
  fps?: number | null;
  duration?: number | null;
  aspectRatio?: string | null;
  references?: ReferenceImage[];
  extra?: Record<string, unknown> | null;
  signal?: AbortSignal;
  onProgress?: (status: string) => void;
}

export interface GeneratedVideo {
  bytes?: Buffer;
  mimeType: string;
  sourceUrl?: string;
}

export interface VideoGenResult {
  videos: GeneratedVideo[];
  /**
   * Notes about how the request was adapted (tuning params dropped on a resubmit, the
   * provider ran a different model than asked, …). Surfaced verbatim in the tool result.
   */
  warnings?: string[];
  cost?: number;
  modelUsed: string;
  raw?: unknown;
}

export interface GatewayCapabilities {
  imageGeneration: boolean;
  textToVideo: boolean;
  imageToVideo: boolean;
  /** image aspect-ratio is a real request param (vs prompt-only or fixed-square) */
  imageAspectRatioParam: boolean;
  /** image resolution/size is a real request param */
  imageResolutionParam: boolean;
  listsImageModels: boolean;
  listsVideoModels: boolean;
  /** image-to-video can accept multiple reference images */
  multiReferenceImages: boolean;
  /** image generation can be conditioned on caller-supplied reference images (image editing) */
  imageReferenceImages: boolean;
}

export interface Gateway {
  readonly id: GatewayId;
  readonly capabilities: GatewayCapabilities;
  listImageModels(signal?: AbortSignal): Promise<ListModelsResult>;
  listVideoModels?(kind: VideoKind, signal?: AbortSignal): Promise<ListModelsResult>;
  /** Supported image aspect ratios, or null to fall back to the curated list. */
  imageAspectRatios?(model: string): OptionList | null;
  /**
   * Supported image resolutions/sizes, or null to prompt for a custom value.
   * `{ values: [], source: 'api' }` means the API positively says the model has
   * NO resolution parameter (so don't offer one at all).
   */
  imageResolutions?(model: string): OptionList | null;
  /** Quality/effort levels the model accepts (OpenRouter `quality`), or null when it has no such knob. */
  imageQualityLevels?(model: string): OptionList | null;
  /** How many images one call may request (`n`), or null when the model takes no count. */
  imageCountRange?(model: string): { min: number; max: number } | null;
  /** Native background modes the model accepts (`auto|transparent|opaque` subset), or null when unknown / no such field. */
  imageBackgroundModes?(model: string): OptionList | null;
  /**
   * Optional async warm-up, called once by the runtime after the gateway is
   * created (and by the wizard after model selection): fetch per-model
   * capabilities so the SYNC accessors above can answer from a cache. Must be
   * best-effort — never throw, never block for long. With `cache`, a persisted answer
   * is used at once (no network on a warm start) and refreshed in the background.
   */
  prepare?(ctx: { imageModel?: string | null; cache?: CapabilityCache }): Promise<void>;
  /**
   * What reference images MEAN for this model (subject conditioning vs style
   * transfer), or null when the model has no conditioning input at all. The tool
   * layer surfaces this before generation and refuses a mode the model can't do,
   * so a photographic reference is never silently turned into a style transfer.
   */
  referenceSemantics?(model: string): ReferenceSemantics | null;
  generateImage(params: ImageGenParams): Promise<ImageGenResult>;
  generateVideo?(params: VideoGenParams): Promise<VideoGenResult>;
  /**
   * Pre-billing check of a video request: a refusal message when the gateway knows it
   * cannot honour it (an unknown model id, inputs the model has no field for), else null.
   * The video tools call it BEFORE submitting — sync or async — so a request the provider
   * would accept and bill without the asked-for effect is refused for free. Never throws.
   */
  checkVideoRequest?(params: VideoGenParams): Promise<string | null>;
  /**
   * Inspect a thrown error and return human-readable "possible cause" hints —
   * account/config issues the API reports opaquely (e.g. an ignored provider, a
   * BYOK key routing past remaining credit). May make read-only API calls.
   * Returns [] when it has nothing to add and MUST never throw.
   */
  diagnoseFailure?(err: unknown, ctx: { model: string }): Promise<string[]>;
}
