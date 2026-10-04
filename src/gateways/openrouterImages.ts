/**
 * OpenRouter Image API — the PURE, unit-testable half of the gateway:
 *
 *  1. per-model capability records (`GET /api/v1/images/models/{id}/endpoints`
 *     → `supported_parameters`), which say what a model actually accepts
 *     (resolution tier, quality levels, background modes, n, references …);
 *  2. the request-body builder, which maps `ImageGenParams` onto the `/images`
 *     body USING those capabilities — dropping a `resolution` the model has no
 *     parameter for, refusing a `background:"transparent"` the model can't do
 *     BEFORE anything is billed, and explaining each such decision;
 *  3. the error explainer, which turns OpenRouter's HTTP status + JSON error body
 *     (incl. `metadata.error_type`, moderation metadata, capability-filter
 *     rejections and raw Zod validation dumps) into one actionable message plus
 *     "possible cause" hints.
 *
 * Contract details + live-verified quirks: docs/API-NOTES.md (OpenRouter section).
 */
import type { ImageGenParams } from './types.js';
import { GatewayHttpError } from '../util/http.js';
import { parseBackgroundSpec } from '../media/palette.js';
import { referenceToUrl } from '../util/inputs.js';
import { nearestAspectRatio } from '../util/aspect.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** One `supported_parameters` descriptor (see the Image API docs). */
export type ImageParamDescriptor =
  | { type: 'enum'; values: string[] }
  | { type: 'range'; min: number; max: number }
  | { type: 'boolean' };

export interface OpenRouterImageCapabilities {
  model: string;
  /** Union of `supported_parameters` across the model's endpoints. An ABSENT key = unsupported. */
  params: Record<string, ImageParamDescriptor>;
  /** Provider display names serving the model (e.g. "OpenAI"). */
  providers: string[];
  /** Provider-specific keys accepted under `provider.options[slug]`. */
  passthrough: string[];
  supportsStreaming: boolean;
  fetchedAt: number;
}

interface EndpointRecord {
  provider_name?: string;
  provider_slug?: string;
  supported_parameters?: Record<string, unknown>;
  allowed_passthrough_parameters?: string[];
  supports_streaming?: boolean;
}

function parseDescriptor(raw: unknown): ImageParamDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (d['type'] === 'enum' && Array.isArray(d['values'])) {
    return { type: 'enum', values: (d['values'] as unknown[]).map(String) };
  }
  if (d['type'] === 'range' && typeof d['min'] === 'number' && typeof d['max'] === 'number') {
    return { type: 'range', min: d['min'], max: d['max'] };
  }
  if (d['type'] === 'boolean') return { type: 'boolean' };
  return null;
}

/** Merge two descriptors for the same key across endpoints (union of enums / widest range). */
function mergeDescriptor(a: ImageParamDescriptor, b: ImageParamDescriptor): ImageParamDescriptor {
  if (a.type === 'enum' && b.type === 'enum') return { type: 'enum', values: [...new Set([...a.values, ...b.values])] };
  if (a.type === 'range' && b.type === 'range') return { type: 'range', min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  return a;
}

/** Fold one endpoint's `supported_parameters` into the running per-key union. */
function mergeEndpointParams(params: Record<string, ImageParamDescriptor>, ep: EndpointRecord): void {
  for (const [key, raw] of Object.entries(ep.supported_parameters ?? {})) {
    const d = parseDescriptor(raw);
    if (!d) continue;
    const prev = params[key];
    params[key] = prev ? mergeDescriptor(prev, d) : d;
  }
}

/**
 * Parse the `/images/models/{id}/endpoints` response. Returns null when the
 * model has no endpoint records (unknown model, or the API shape changed) so the
 * caller can fall back to its static defaults instead of treating "nothing" as
 * "supports nothing".
 */
export function parseImageModelEndpoints(model: string, json: unknown, now = Date.now()): OpenRouterImageCapabilities | null {
  const root = (json ?? {}) as { id?: string; endpoints?: EndpointRecord[]; data?: { endpoints?: EndpointRecord[] } };
  const endpoints = root.endpoints ?? root.data?.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
  const params: Record<string, ImageParamDescriptor> = {};
  for (const ep of endpoints) mergeEndpointParams(params, ep);
  const providers = endpoints.map((ep) => ep.provider_name).filter((n): n is string => !!n);
  const passthrough = endpoints.flatMap((ep) => ep.allowed_passthrough_parameters ?? []);
  return {
    model: root.id ?? model,
    params,
    providers: [...new Set(providers)],
    passthrough: [...new Set(passthrough)],
    supportsStreaming: endpoints.some((ep) => ep.supports_streaming),
    fetchedAt: now,
  };
}

/** Enum values a parameter accepts, or null when it is not an enum / unsupported. */
export function enumValues(caps: OpenRouterImageCapabilities | null | undefined, key: string): string[] | null {
  const d = caps?.params[key];
  return d && d.type === 'enum' ? d.values : null;
}

/** Whether a parameter is supported at all (unknown caps → optimistic `true`). */
export function supportsParam(caps: OpenRouterImageCapabilities | null | undefined, key: string): boolean {
  return caps ? key in caps.params : true;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export interface BuiltImageRequest {
  body: Record<string, unknown>;
  /** Human-readable notes on what was dropped/adjusted and why (surfaced in the tool result). */
  warnings: string[];
  /** True when an exact `size` (pixels) was sent — the caller may retry without it. */
  exactSize: boolean;
}

export interface BuildOptions {
  /** Do not send an exact `size` even if width/height were given (used for the retry after a size rejection). */
  noExactSize?: boolean;
}

/** Models known (from the live capability API) to accept `background:"transparent"`. */
const TRANSPARENT_CAPABLE_HINT = 'openai/gpt-image-1, openai/gpt-image-1-mini';

/** What each per-parameter mapper reads/writes while a body is being assembled. */
interface BodyCtx {
  model: string;
  caps: OpenRouterImageCapabilities | null;
  body: Record<string, unknown>;
  warnings: string[];
}

/** " Accepted: a, b." suffix naming the model's advertised enum values for `key` (empty when none). */
function acceptedSuffix(ctx: BodyCtx, key: string): string {
  const v = enumValues(ctx.caps, key);
  return v ? ` Accepted: ${v.join(', ')}.` : '';
}

/** `aspect_ratio` — refused when the model advertises an enum that lacks it. */
function mapAspectRatio(ctx: BodyCtx, aspectRatio: string): void {
  const ratios = enumValues(ctx.caps, 'aspect_ratio');
  if (ratios && !ratios.includes(aspectRatio)) {
    throw new Error(`Aspect ratio "${aspectRatio}" is not supported by ${ctx.model}.${acceptedSuffix(ctx, 'aspect_ratio')} Nothing was generated.`);
  }
  ctx.body['aspect_ratio'] = aspectRatio;
}

/** `resolution` tier — dropped (with a note) when the model has no such parameter at all. */
function mapResolution(ctx: BodyCtx, resolution: string): void {
  if (!supportsParam(ctx.caps, 'resolution')) {
    ctx.warnings.push(
      `${ctx.model} has no resolution-tier parameter, so "${resolution}" was not sent — the model rendered at its native full size (kept as-is, never downscaled).`,
    );
    return;
  }
  const tiers = enumValues(ctx.caps, 'resolution');
  if (tiers && !tiers.includes(resolution)) {
    throw new Error(`Resolution tier "${resolution}" is not supported by ${ctx.model}.${acceptedSuffix(ctx, 'resolution')} Nothing was generated.`);
  }
  ctx.body['resolution'] = resolution;
}

/**
 * Size: exact pixels (`size`, authoritative) OR aspect_ratio + resolution tier.
 * `size` and a mismatched `resolution`/`aspect_ratio` together are rejected with
 * a 400, so an exact size replaces both. Some providers enforce a MINIMUM pixel
 * budget (gpt-image rejected 256x256) — the gateway retries without `size` on that.
 */
function mapSize(ctx: BodyCtx, params: ImageGenParams, exactSize: boolean, sizeRejected: boolean): void {
  if (exactSize) {
    ctx.body['size'] = `${params.width}x${params.height}`;
    if (params.resolution) ctx.warnings.push(`Resolution tier "${params.resolution}" was not sent: the exact size ${params.width}x${params.height} takes precedence.`);
    return;
  }
  const aspectRatio = sizeRejected ? shapeOfRejectedSize(ctx, params) : params.aspectRatio;
  if (aspectRatio) mapAspectRatio(ctx, aspectRatio);
  if (params.resolution) mapResolution(ctx, params.resolution);
}

/** Generic ratios to choose from when the model's own `aspect_ratio` enum is unknown. */
const GENERIC_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * After the provider refused our exact `size`, keep the SHAPE that was asked for: the
 * supported ratio nearest to width/height — not the configured default aspect (a rejected
 * 640×384 used to come back as a 1024² square although 16:9/3:2 was supported).
 */
function shapeOfRejectedSize(ctx: BodyCtx, params: ImageGenParams): string | null | undefined {
  if (params.width == null || params.height == null) return params.aspectRatio;
  const nearest = nearestAspectRatio(params.width / params.height, enumValues(ctx.caps, 'aspect_ratio') ?? GENERIC_ASPECT_RATIOS);
  if (!nearest) return params.aspectRatio;
  if (nearest !== params.aspectRatio) ctx.warnings.push(`Rendered at aspect ratio ${nearest}, the supported shape nearest to the requested ${params.width}x${params.height}.`);
  return nearest;
}

function mapCount(ctx: BodyCtx, n: number): void {
  const d = ctx.caps?.params['n'];
  if (ctx.caps && !d) throw new Error(`${ctx.model} does not accept \`n\` (multiple images per call). Nothing was generated.`);
  if (d && d.type === 'range' && (n < d.min || n > d.max)) {
    throw new Error(`\`n\` must be between ${d.min} and ${d.max} for ${ctx.model} (got ${n}). Nothing was generated.`);
  }
  ctx.body['n'] = n;
}

function mapQuality(ctx: BodyCtx, quality: string): void {
  if (!supportsParam(ctx.caps, 'quality')) {
    throw new Error(`${ctx.model} has no \`quality\` parameter (it was "${quality}"). Nothing was generated.`);
  }
  const levels = enumValues(ctx.caps, 'quality');
  if (levels && !levels.includes(quality)) {
    throw new Error(`Quality "${quality}" is not supported by ${ctx.model}.${acceptedSuffix(ctx, 'quality')} Nothing was generated.`);
  }
  ctx.body['quality'] = quality;
}

/** `transparent` was asked of a model that cannot do it natively — fail before billing. */
function transparentRefusal(ctx: BodyCtx, modes: string[] | null): Error {
  if (!modes) {
    return new Error(
      `${ctx.model} has no \`background\` parameter, so a transparent background cannot be requested natively. ` +
        `Generate on a flat colour and run remove_background afterwards, or pick a model that supports it (e.g. ${TRANSPARENT_CAPABLE_HINT}). Nothing was generated.`,
    );
  }
  return new Error(
    `${ctx.model} cannot produce a transparent background: its \`background\` parameter accepts only ${modes.join(', ')}. ` +
      `Generate on a flat colour (e.g. background:"#00ff00") and run remove_background on the result, or use a model whose background enum includes "transparent" (e.g. ${TRANSPARENT_CAPABLE_HINT}). Nothing was generated.`,
  );
}

/**
 * `background` — the /images enum is only auto|transparent|opaque (per model: gpt-image-2.x =
 * auto|opaque). A specific colour rides in the compiled prompt constraint and maps to `opaque`;
 * a hex here would 400. `transparent` on a model without it is refused BEFORE the request.
 */
function mapBackground(ctx: BodyCtx, background: string): void {
  const bg = parseBackgroundSpec(background);
  const want = bg.kind === 'transparent' ? 'transparent' : bg.kind === 'mode' ? bg.mode : 'opaque';
  const modes = enumValues(ctx.caps, 'background');
  if (ctx.caps && !modes && !supportsParam(ctx.caps, 'background')) {
    if (want === 'transparent') throw transparentRefusal(ctx, null);
    ctx.warnings.push(`${ctx.model} has no \`background\` parameter — "${want}" was carried in the prompt only.`);
    return;
  }
  if (modes && !modes.includes(want)) {
    if (want === 'transparent') throw transparentRefusal(ctx, modes);
    throw new Error(`Background "${want}" is not supported by ${ctx.model}.${acceptedSuffix(ctx, 'background')} Nothing was generated.`);
  }
  ctx.body['background'] = want;
}

function mapReferences(ctx: BodyCtx, references: NonNullable<ImageGenParams['references']>): void {
  const d = ctx.caps?.params['input_references'];
  if (ctx.caps && !d) {
    throw new Error(`${ctx.model} has no image input (\`input_references\`), so reference images cannot be used. Nothing was generated.`);
  }
  if (d && d.type === 'range' && references.length > d.max) {
    throw new Error(`${ctx.model} accepts at most ${d.max} reference image(s); ${references.length} were given. Nothing was generated.`);
  }
  ctx.body['input_references'] = references.map((r) => ({ type: 'image_url', image_url: { url: referenceToUrl(r) } }));
}

/**
 * Map `ImageGenParams` onto a `/api/v1/images` body, honouring the model's
 * advertised capabilities. Throws a plain, actionable Error (BEFORE any request
 * is made, so nothing is billed) for a value the model demonstrably can't take.
 * With unknown capabilities (`caps` null) it is optimistic and sends what it
 * always did — the provider then validates.
 */
export function buildOpenRouterImageBody(
  params: ImageGenParams,
  caps: OpenRouterImageCapabilities | null,
  opts: BuildOptions = {},
): BuiltImageRequest {
  const ctx: BodyCtx = { model: params.model, caps, body: { model: params.model, prompt: params.prompt }, warnings: [] };

  const exactSize = !opts.noExactSize && params.width != null && params.height != null;
  mapSize(ctx, params, exactSize, opts.noExactSize === true);
  if (params.n != null) mapCount(ctx, params.n);
  if (params.quality) mapQuality(ctx, params.quality);
  if (params.background) mapBackground(ctx, params.background);
  if (params.references && params.references.length > 0) mapReferences(ctx, params.references);

  // Caller escape hatch merges LAST so explicit values win.
  if (params.extra) Object.assign(ctx.body, params.extra);
  return { body: ctx.body, warnings: ctx.warnings, exactSize };
}

/** Does a 400 look like the provider rejecting our exact `size` (so a retry without it makes sense)? */
export function isSizeRejection(err: unknown): boolean {
  if (!(err instanceof GatewayHttpError) || err.status !== 400) return false;
  return /\bsize\b|pixel budget|resolution is (below|above)/i.test(err.bodyText);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface OpenRouterErrorBody {
  message?: string;
  code?: number | string;
  type?: string;
  metadata?: {
    error_type?: string;
    provider_code?: string;
    provider_name?: string;
    reasons?: string[];
    flagged_input?: string;
    model_slug?: string;
    failed_routing_step?: string;
    [k: string]: unknown;
  };
}

export interface ExplainedError {
  /** One actionable line: what failed, in the user's terms. */
  message: string;
  /** "Possible cause" hints (each becomes a tagged content block). */
  hints: string[];
  /** OpenRouter's canonical `error_type` when present. */
  errorType?: string;
  status?: number;
}

/** Status → meaning, per https://openrouter.ai/docs/api-reference/errors (Image API shares it). */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request (invalid or missing parameter, or content policy)',
  401: 'Invalid credentials (disabled/invalid API key)',
  402: 'Insufficient credits',
  403: 'Forbidden (permission, guardrail block, or moderation flag)',
  404: 'Not found (unknown model, or no endpoint matches your data policy)',
  408: 'Request timed out',
  413: 'Payload too large',
  422: 'Unprocessable request',
  429: 'Rate limited',
  500: 'OpenRouter internal error',
  502: 'Model/provider failure (the generation did not complete — not billed)',
  503: 'No available provider meets your routing requirements',
  504: 'Provider timed out',
};

const STATUS_HINTS: Record<number, string[]> = {
  401: ['Check the OpenRouter key in your token file (`openrouter token.txt` by default) — it may be revoked or mistyped. Keys: https://openrouter.ai/settings/keys'],
  402: ['Top up OpenRouter credits (https://openrouter.ai/settings/credits) or raise the key\'s spending limit; image generation is billed per output image/token.'],
  403: ['A guardrail or moderation rule blocked the request — soften the prompt, or check guardrails/privacy settings: https://openrouter.ai/settings/privacy'],
  404: ['Verify the model id (list: https://openrouter.ai/api/v1/images/models). A data-policy/"Ignored Providers" mismatch also shows as 404 — see https://openrouter.ai/settings/privacy'],
  408: ['Transient — retry; use `wait:false` (async job) so a slow generation cannot trip a client timeout.'],
  413: ['Shrink or drop the reference images (fewer/smaller files) — the request body exceeded the size limit.'],
  429: ['You are being rate limited — wait for the `Retry-After` period (honoured automatically once) and retry, or spread requests out.'],
  500: ['OpenRouter masked the upstream message (500); retry, and if it persists check https://status.openrouter.ai'],
  502: ['The provider failed or returned an invalid/empty result (a safety-blocked generation also surfaces as 502). Failed generations are not billed — rephrase and retry, or try another model.'],
  503: ['No provider currently matches your routing constraints — check "Ignored Providers"/provider preferences (https://openrouter.ai/settings/preferences) or retry shortly.'],
  504: ['The upstream provider timed out — retry, or lower `quality`/size for a faster render.'],
};

/** Canonical `error_type` → short label (docs: "Typed Error Codes"). */
const ERROR_TYPE_LABEL: Record<string, string> = {
  context_length_exceeded: 'prompt too long for the model',
  max_tokens_exceeded: 'output token limit reached',
  token_limit_exceeded: 'OpenRouter token budget exceeded',
  string_too_long: 'a request string exceeds the provider\'s per-field limit',
  authentication: 'authentication failed',
  permission_denied: 'permission denied / guardrail block',
  payment_required: 'insufficient credits',
  rate_limit_exceeded: 'rate limit exceeded',
  provider_overloaded: 'provider temporarily overloaded',
  provider_unavailable: 'provider returned an invalid or empty response',
  invalid_request: 'invalid request parameter',
  invalid_prompt: 'invalid prompt',
  not_found: 'resource not found',
  precondition_failed: 'precondition failed',
  payload_too_large: 'request body too large',
  unprocessable: 'request semantically unprocessable',
  content_policy_violation: 'content policy violation (input or output flagged)',
  refusal: 'the model refused the request',
  invalid_image: 'a reference image is corrupt or unreadable',
  image_too_large: 'a reference image exceeds the provider\'s size/pixel limit',
  image_too_small: 'a reference image is below the provider\'s minimum dimensions',
  unsupported_image_format: 'reference image format not supported by the provider',
  image_not_found: 'a reference image URL/file could not be resolved',
  image_download_failed: 'OpenRouter could not download a reference image URL',
  server: 'internal server error (upstream message masked)',
  timeout: 'provider timeout',
  unmapped: 'unclassified upstream error',
};

/** Does a parsed JSON value look like an OpenRouter error object (message/code, or a Zod `name`)? */
function looksLikeErrorObject(e: unknown): e is Record<string, unknown> {
  return !!e && typeof e === 'object' && ('message' in e || 'code' in e || 'name' in e);
}

/** Parse an error body (`{ error: {...} }`, or a bare error object, or a raw Zod dump). */
export function parseErrorBody(text: string): OpenRouterErrorBody | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j && typeof j === 'object' ? (j['error'] ?? j) : null;
    if (looksLikeErrorObject(e)) {
      return { ...(e as OpenRouterErrorBody), ...(typeof e['name'] === 'string' ? { type: e['name'] } : {}) };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Is this failure OpenRouter's OWN credit check (not an upstream provider's quota)? Its 402
 * body says so (`metadata.limit_source: "openrouter_credits"`); without a body, the message
 * "Insufficient credits. Add more using https://openrouter.ai/settings/credits" does.
 */
export function isOpenRouterCreditLimit(bodyText: string, message = ''): boolean {
  const meta = parseErrorBody(bodyText)?.metadata;
  if (typeof meta?.['limit_source'] === 'string') return /openrouter/i.test(meta['limit_source']);
  return /insufficient credits/i.test(message) && /openrouter\.ai\/settings\/credits/i.test(`${message} ${bodyText}`);
}

/** `error_type`s that fail identically on a retry: content/prompt/account problems, not transient faults. */
const DETERMINISTIC_ERROR_TYPES = new Set([
  'content_policy_violation',
  'refusal',
  'invalid_prompt',
  'invalid_request',
  'permission_denied',
  'authentication',
  'payment_required',
  'context_length_exceeded',
  'string_too_long',
  'invalid_image',
  'image_too_large',
  'image_too_small',
  'unsupported_image_format',
]);

/**
 * True when a failure body says retrying the same request cannot help — a
 * moderation flag (`metadata.reasons`) or a deterministic `error_type`. A 502
 * safety block is the case that matters: it looks like a transient 5xx.
 */
export function isDeterministicFailure(bodyText: string): boolean {
  const meta = parseErrorBody(bodyText)?.metadata;
  if (Array.isArray(meta?.reasons) && meta.reasons.length > 0) return true;
  return typeof meta?.error_type === 'string' && DETERMINISTIC_ERROR_TYPES.has(meta.error_type);
}

/**
 * OpenRouter validates the body with Zod and returns the raw issue list as the
 * message (`{"name":"ZodError","message":"[ {code, path, message, values} ]"}`).
 * Turn that into `quality: Invalid option: expected one of …`.
 */
function explainZodDump(message: string): string | null {
  try {
    const issues = JSON.parse(message) as Array<{ path?: unknown[]; message?: string; values?: unknown[] }>;
    if (!Array.isArray(issues) || issues.length === 0) return null;
    return issues
      .map((i) => {
        const path = Array.isArray(i.path) && i.path.length > 0 ? i.path.map(String).join('.') : 'request';
        return `${path}: ${i.message ?? 'invalid'}`;
      })
      .join('; ');
  } catch {
    return null;
  }
}

/** The provider-facing message, cleaned up (Zod dumps unpacked; falls back to the raw body). */
function cleanErrorDetail(e: OpenRouterErrorBody | null, bodyText: string): string {
  let detail = e?.message?.trim() ?? '';
  if (e?.type === 'ZodError' || /^\s*\[\s*\{/.test(detail)) {
    const z = explainZodDump(detail);
    if (z) detail = `Invalid request parameter(s) — ${z}`;
  }
  return detail || bodyText.trim().slice(0, 300) || '(no error body)';
}

/**
 * Capability-filter rejection: "No provider for X supports the requested parameter(s):
 * a "v1", b "v2". Provider rejections: OpenAI: b: not supported. Accepted: …"
 * The "requested parameter(s)" list names EVERY filtered field, not only the bad one.
 */
function capabilityFilterHint(detail: string): string | null {
  if (!/supports the requested parameter/i.test(detail)) return null;
  const rej = /Provider rejections:\s*(.+)$/i.exec(detail);
  return (
    (rej ? `The offending value is the one under "Provider rejections" (${rej[1]?.trim()}); ` : 'Only the parameter named under "Provider rejections" is actually unsupported; ') +
    'the "requested parameter(s)" list simply echoes every capability-checked field. Check the model\'s `supported_parameters` (health_status shows them) and adjust that one parameter.'
  );
}

function moderationHint(meta: OpenRouterErrorBody['metadata']): string | null {
  if (!Array.isArray(meta?.reasons) || meta.reasons.length === 0) return null;
  return (
    `Moderation flagged the input (${meta.reasons.join(', ')})` +
    (meta.flagged_input ? ` — flagged segment: "${meta.flagged_input}"` : '') +
    (meta.provider_name ? ` [${meta.provider_name}]` : '') +
    '. Rephrase that part of the prompt.'
  );
}

/** "HTTP 502 — <status meaning> — <error_type>: <label>" (parts omitted when unknown). */
function errorHeadline(code: number | undefined, errorType: string | undefined): string {
  const typeLabel = errorType ? ERROR_TYPE_LABEL[errorType] : undefined;
  return [code != null ? `HTTP ${code}` : null, code != null ? STATUS_TEXT[code] ?? null : null, typeLabel ? `${errorType}: ${typeLabel}` : errorType ?? null]
    .filter(Boolean)
    .join(' — ');
}

/** The HTTP status when there is one, else a numeric `code` from the body (200-with-`error` relays). */
function resolveErrorCode(status: number | undefined, e: OpenRouterErrorBody | null): number | undefined {
  return status ?? (typeof e?.code === 'number' ? e.code : undefined);
}

/** All "possible cause" hints for a failure: capability filter, moderation, provider code, then the status's own. */
function errorHints(detail: string, meta: OpenRouterErrorBody['metadata'], code: number | undefined): string[] {
  const providerCode = typeof meta?.provider_code === 'string' ? `Upstream provider code: ${meta.provider_code}.` : null;
  const statusHints = (code != null ? STATUS_HINTS[code] : undefined) ?? [];
  return [capabilityFilterHint(detail), moderationHint(meta), providerCode, ...statusHints].filter((h): h is string => h !== null);
}

/**
 * Explain an OpenRouter failure. Works from the HTTP status + raw body (a
 * `GatewayHttpError`) or from a 200-with-`error` body (status undefined).
 */
export function explainOpenRouterError(status: number | undefined, bodyText: string, model: string): ExplainedError {
  const e = parseErrorBody(bodyText);
  const meta = e?.metadata;
  const errorType = typeof meta?.error_type === 'string' ? meta.error_type : undefined;
  const detail = cleanErrorDetail(e, bodyText);
  const code = resolveErrorCode(status, e);

  const hints = errorHints(detail, meta, code);
  const head = errorHeadline(code, errorType);
  const message = `${head ? `${head}. ` : ''}${detail}${model ? ` [model: ${model}]` : ''}`;
  return { message, hints, ...(errorType ? { errorType } : {}), ...(code != null ? { status: code } : {}) };
}

/**
 * A `GatewayHttpError` whose `providerMessage` is the EXPLAINED message, so the
 * shared `describeError()` prints something actionable, and whose `hints` feed
 * `diagnoseFailure`. Keeps `status`/`bodyText`/`url` of the original.
 */
export class OpenRouterApiError extends GatewayHttpError {
  readonly hints: string[];
  readonly errorType: string | undefined;
  readonly explanation: string;
  constructor(base: GatewayHttpError, explained: ExplainedError) {
    super(explained.message, base.status, base.bodyText, base.url);
    this.name = 'OpenRouterApiError';
    this.explanation = explained.message;
    this.hints = explained.hints;
    this.errorType = explained.errorType;
  }
  override get providerMessage(): string {
    return this.explanation;
  }
}

/** Wrap a raw HTTP failure from the Image/Video API into an explained error (idempotent). */
export function toOpenRouterApiError(err: GatewayHttpError, model: string): OpenRouterApiError {
  if (err instanceof OpenRouterApiError) return err;
  return new OpenRouterApiError(err, explainOpenRouterError(err.status, err.bodyText, model));
}
