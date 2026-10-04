import { runtime } from '../state/runtime.js';
import { resolveReferenceImages } from '../util/inputs.js';
import { aspectRatioValue } from '../util/aspect.js';
import type { Gateway, ImageGenParams, ReferenceMode, ReferenceSemantics } from '../gateways/types.js';
import type { ImageJobMediaOpts } from '../state/generationJobs.js';
import { errorResult, type ToolResult } from './helpers.js';
import { ICO_ALLOWED_SIZES, pickGenerationResolution, type SquareFit } from '../media/ico.js';
import { applyConstraints, compileConstraints, normalizeHex, type CompiledConstraints } from '../media/palette.js';
import type { ConstraintCheck, OutputFormat } from './generateImageRender.js';

/**
 * Turns the raw `generate_image` tool arguments into a validated, fully-resolved request.
 * Every refusal that must happen BEFORE a gateway call (and so before any billing) lives
 * here, in the order the caller would hit them; nothing in this file calls the gateway.
 */

type Args = Record<string, unknown>;
type Config = typeof runtime.config;

/** A request the tool refuses up front; `result` is the error reply to return as-is. */
interface Refusal {
  ok: false;
  result: ToolResult;
}
type Checked<T> = { ok: true; value: T } | Refusal;

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const refuse = (message: string, causes?: string[]): Refusal => ({ ok: false, result: errorResult(message, causes) });

/** The shape of a validated request, ready to submit (async) or run (sync). */
export interface ImageRequest {
  /** The LIVE gateway at call time — never one captured at registration. */
  gateway: Gateway;
  params: ImageGenParams;
  /** Output settings; snapshotted into an async job and used to render a sync result. */
  media: ImageJobMediaOpts;
  referenceDownloads: string[];
  constraintSummary: string[];
  /** Snapshot of the request shape, so slow/aborted runs can be correlated with what was asked for. */
  requestInfo: Record<string, unknown>;
  /** true = block for the result; false = submit a background job and return its id. */
  waitForResult: boolean;
}

/** Wall-clock phase timings (ms), filled in as the call progresses. */
export type Phases = Record<string, number>;

/**
 * Aspect ratio for an ICO render when the caller gave none: square when the model takes
 * '1:1' (or advertises no ratio list to check against), else the configured default —
 * `fitSquare` pads a non-square result either way.
 */
function squareAspectFor(gateway: Gateway, model: string, fallback: string | null): string | null {
  const ratios = gateway.imageAspectRatios?.(model);
  if (!ratios || ratios.values.length === 0 || ratios.values.includes('1:1')) return '1:1';
  return fallback;
}

/** Validate and resolve a tool call into an {@link ImageRequest}, or the refusal to return. */
export async function prepareImageRequest(a: Args, signal: AbortSignal | undefined, phases: Phases): Promise<Checked<ImageRequest>> {
  const cfg = runtime.config;
  const gateway = runtime.gateway;

  const basics = resolveBasics(a, gateway, cfg.image.model);
  if (!basics.ok) return basics;
  const { model, prompt } = basics.value;

  const out = planOutput(a, gateway, model, cfg);
  if (!out.ok) return out;

  const refs = planReferences(a, gateway, model);
  if (!refs.ok) return refs;

  const constraints = compileRequestConstraints(a, refs.value.steer);
  if (!constraints.ok) return constraints;
  const compiled = constraints.value;
  const noTransparency = refuseUnsupportedTransparency(compiled, gateway, model);
  if (noTransparency) return noTransparency;

  // Resolve reference images up front, fail-closed: if any cannot be
  // downloaded/read or is not a valid image, do NOT call the model.
  const resolved = await resolveReferences(refs.value.inputs, phases);
  if (!resolved.ok) return resolved;

  const params = buildImageParams({ a, cfg, model, prompt, out: out.value, refs: refs.value, constraints: compiled, references: resolved.value.references, signal });
  applyIcoResolution(params, out.value.format, gateway, model);
  const media = buildMediaOpts(a, cfg, out.value, prompt, compiled);

  return ok({
    gateway,
    params,
    media,
    referenceDownloads: resolved.value.downloads,
    constraintSummary: compiled.summary,
    requestInfo: describeRequest(cfg, params, out.value, compiled, refs.value),
    // Configured mode (cfg.image.async, default true) drives the default; a per-call
    // `wait:true`/`wait:false` overrides it to force sync/async for this call only.
    waitForResult: (a['wait'] as boolean | undefined) ?? !cfg.image.async,
  });
}

/** Gateway can generate, a model is configured, and the prompt is present. */
function resolveBasics(a: Args, gateway: Gateway, configuredModel: string | null | undefined): Checked<{ model: string; prompt: string }> {
  if (!gateway.capabilities.imageGeneration) {
    return refuse('The configured gateway does not support image generation.');
  }
  if (!configuredModel) {
    return refuse('No image model is configured. Run `npm run configure`.');
  }
  const prompt = (a['prompt'] as string | undefined)?.trim();
  if (!prompt) {
    return refuse('A `prompt` is required to generate an image (or pass a `job_id` to poll a running job).');
  }
  return ok({ model: configuredModel, prompt });
}

// ---- Output format & size ---------------------------------------------------------------

interface OutputPlan {
  format: OutputFormat | null;
  tinifyKey: string | null;
  aspectRatio: string | null;
  width?: number;
  height?: number;
  icoSize?: number;
  squareFit: SquareFit;
  padColor?: string;
}

/**
 * `ico` is always honored (local container, no optimizer needed); the others default to
 * png only when a Tinify key is present (otherwise no conversion is applied).
 */
function chooseFormat(requested: OutputFormat | undefined, tinifyKey: string | null): OutputFormat | null {
  if (requested === 'ico') return 'ico';
  return tinifyKey ? (requested ?? 'png') : null;
}

/** `ico` requires one of the allowed icon sizes. */
function refuseDisallowedIcoWidth(format: OutputFormat | null, width: number | undefined): Refusal | null {
  if (format !== 'ico' || width == null || ICO_ALLOWED_SIZES.includes(width as (typeof ICO_ALLOWED_SIZES)[number])) return null;
  return refuse(`ICO width ${width} is not an allowed icon size; allowed: ${ICO_ALLOWED_SIZES.join(', ')}.`);
}

function planOutput(a: Args, gateway: Gateway, model: string, cfg: Config): Checked<OutputPlan> {
  const tinifyKey = runtime.tinifyToken;
  const format = chooseFormat(a['output_format'] as OutputFormat | undefined, tinifyKey);
  const aspectRatio = resolveAspectRatio(a, format, gateway, model, cfg);
  // `width` is the primary pixel size; `height` defaults to width (square) for ico,
  // else is derived from `width` × `aspect_ratio`. A lone `height` derives the width the
  // same way — every gateway's size mapping keys on width, so it used to be dropped.
  const width = (a['width'] as number | undefined) ?? (format === 'ico' ? 256 : widthFromHeight(a, aspectRatio));
  const badWidth = refuseDisallowedIcoWidth(format, width);
  if (badWidth) return badWidth;
  return ok({
    format,
    tinifyKey,
    aspectRatio,
    width,
    height: resolveHeight(a, format, width, aspectRatio),
    icoSize: format === 'ico' ? (width ?? 256) : undefined,
    squareFit: (a['square_fit'] as SquareFit | undefined) ?? 'pad',
    padColor: (a['pad_color'] as string | undefined) || undefined,
  });
}

/**
 * An icon is square, so for ico the configured default aspect (often 4:3) is NOT
 * applied — only an explicit `aspect_ratio`/`height` makes the render non-square.
 */
function resolveAspectRatio(a: Args, format: OutputFormat | null, gateway: Gateway, model: string, cfg: Config): string | null {
  const explicit = a['aspect_ratio'] as string | undefined;
  if (explicit != null) return explicit;
  return format === 'ico' ? squareAspectFor(gateway, model, cfg.image.defaultAspectRatio) : cfg.image.defaultAspectRatio;
}

function widthFromHeight(a: Args, aspectRatio: string | null): number | undefined {
  const height = a['height'] as number | undefined;
  return height == null ? undefined : Math.round(height * aspectRatioValue(aspectRatio ?? '1:1'));
}

function resolveHeight(a: Args, format: OutputFormat | null, width: number | undefined, aspectRatio: string | null): number | undefined {
  const explicit = a['height'] as number | undefined;
  if (explicit != null) return explicit;
  if (width == null) return undefined;
  if (format === 'ico' && !a['aspect_ratio']) return width;
  return Math.round(width / aspectRatioValue(aspectRatio ?? '1:1'));
}

// ---- Reference semantics: subject conditioning vs style transfer --------------------------

interface ReferencePlan {
  inputs: string[] | undefined;
  mode: ReferenceMode | undefined;
  semantics: ReferenceSemantics | null;
  /** Prompt-level steer on how to USE the references (feeds the constraint block). */
  steer?: string;
}

/**
 * Prompt-level steer describing how the model must USE the references, given the
 * mode the caller asked for and what the model natively does. Even when the mode
 * IS native, saying it explicitly is what keeps a photographic reference from
 * dragging its own medium (soft-shaded photo, paper backdrop) into the result.
 */
function referenceSteerText(mode: ReferenceMode, semantics: ReferenceSemantics): string {
  if (mode === 'style') {
    return semantics.native === 'style'
      ? 'Use the supplied reference image(s) as a style, palette and medium reference only — do not reproduce their subject or composition.'
      : 'Use the supplied reference image(s) ONLY as a style, palette and medium reference. Do not copy their subject, object design, composition or geometry.';
  }
  return (
    'Reproduce the OBJECT DESIGN and geometry of the supplied reference image(s) faithfully — proportions, layout of the ' +
    'parts, silhouette. Do NOT reproduce the reference’s medium, lighting, background or photographic look: render the ' +
    'object in the medium described by this prompt.'
  );
}

/** Refusal for a reference mode the model's reference input cannot honour. */
function unsupportedReferenceMode(model: string, mode: ReferenceMode, semantics: ReferenceSemantics): Refusal {
  return refuse(
    `The configured model (${model}) cannot use reference images for "${mode}" conditioning: its ` +
      `\`${semantics.field}\` input is ${semantics.native}-only. Nothing was generated.`,
    [
      semantics.note ?? `This model only provides "${semantics.native}" reference semantics.`,
      mode === 'subject'
        ? 'For subject/geometry conditioning use an image-edit model (e.g. `fal-ai/flux-2-pro/edit` on fal, or an OpenRouter image model — its `input_references` are image-to-image).'
        : `Use reference_mode:"${semantics.native}", or omit reference_mode to accept the model's native behaviour.`,
    ],
  );
}

/**
 * Validated BEFORE anything is submitted, so an impossible request costs nothing.
 */
function planReferences(a: Args, gateway: Gateway, model: string): Checked<ReferencePlan> {
  const inputs = a['reference_images'] as string[] | undefined;
  const mode = a['reference_mode'] as ReferenceMode | undefined;
  const semantics: ReferenceSemantics | null = gateway.referenceSemantics?.(model) ?? null;
  const plan: ReferencePlan = { inputs, mode, semantics };

  if (!inputs || inputs.length === 0) {
    return mode ? refuse('`reference_mode` only applies together with `reference_images`.') : ok(plan);
  }
  return planReferenceMode(plan, gateway, model);
}

/** References were supplied: the model must accept them and support the requested conditioning mode. */
function planReferenceMode(plan: ReferencePlan, gateway: Gateway, model: string): Checked<ReferencePlan> {
  const { mode, semantics } = plan;
  if (!gateway.capabilities.imageReferenceImages) {
    return refuse('The configured model does not support reference images.');
  }
  // A gateway that ANSWERS per model and says null means "this model has no conditioning
  // input" (fal FLUX schnell, Recraft…). Refuse here, before submitting — the gateway's own
  // refusal used to arrive only on the first poll of an already-created job.
  if (!semantics && gateway.referenceSemantics) {
    return refuse(
      `The configured model (${model}) has no image-conditioning input, so reference_images cannot be used. Nothing was generated.`,
      ['Remove reference_images, or configure a model that takes them (fal: krea/v2/* for style references, fal-ai/flux-2-pro/edit for subject conditioning).'],
    );
  }
  if (!semantics) {
    return mode
      ? refuse(
          `The configured model (${model}) does not declare reference semantics, so "${mode}" conditioning cannot be guaranteed. Drop \`reference_mode\` to pass the references through as-is.`,
        )
      : ok(plan);
  }
  const effectiveMode = mode ?? semantics.native;
  if (!semantics.supported.includes(effectiveMode)) return unsupportedReferenceMode(model, effectiveMode, semantics);
  return ok({ ...plan, steer: referenceSteerText(effectiveMode, semantics) });
}

// ---- Structured constraints (palette / exclude / background) ------------------------------

/** Compile `palette` / `exclude` / `background` (+ the reference steer) into one prompt block + native fields. */
function compileRequestConstraints(a: Args, referenceSteer: string | undefined): Checked<CompiledConstraints> {
  try {
    return ok(
      compileConstraints({
        ...(a['palette'] ? { palette: (a['palette'] as string[]).map(normalizeHex) } : {}),
        ...(a['exclude'] ? { exclude: a['exclude'] as string[] } : {}),
        ...(a['background'] ? { background: a['background'] as string } : {}),
        ...(referenceSteer ? { referenceSteer } : {}),
      }),
    );
  } catch (err) {
    // A malformed hex must fail before generation, not produce an off-palette bill.
    return refuse(`Invalid constraint: ${(err as Error).message}`);
  }
}

/**
 * A transparent background on a model whose native `background` enum lacks it
 * (gpt-image-2.5: auto|opaque) can't be honoured — refuse it here, before the
 * job is submitted, rather than letting it fail inside a background job.
 */
function refuseUnsupportedTransparency(constraints: CompiledConstraints, gateway: Gateway, model: string): Refusal | null {
  const nativeBg = gateway.imageBackgroundModes?.(model) ?? null;
  if (constraints.background?.kind !== 'transparent' || !nativeBg || nativeBg.values.includes('transparent')) return null;
  return refuse(
    `The configured model (${model}) cannot produce a transparent background` +
      (nativeBg.values.length > 0 ? ` — its \`background\` parameter accepts only ${nativeBg.values.join(', ')}.` : ' — it has no native background field.') +
      ' Nothing was generated.',
    [
      'Generate on a flat, high-contrast colour (e.g. background:"#00ff00") and run `remove_background` on the result to get a transparent PNG.',
      'Or configure a model whose background parameter includes "transparent" (OpenRouter: openai/gpt-image-1, openai/gpt-image-1-mini).',
    ],
  );
}

/** What to measure the finished image against; none when no palette/background was pinned. */
function buildConstraintCheck(constraints: CompiledConstraints, tolerance: number | undefined, enabled: boolean): ConstraintCheck | undefined {
  if (constraints.palette.length === 0 && !constraints.background) return undefined;
  return {
    ...(constraints.palette.length > 0 ? { palette: constraints.palette } : {}),
    ...(constraints.background ? { background: constraints.background.raw } : {}),
    ...(tolerance != null ? { tolerance } : {}),
    enabled,
  };
}

// ---- Reference images -------------------------------------------------------------------

async function resolveReferences(
  inputs: string[] | undefined,
  phases: Phases,
): Promise<Checked<{ references?: ImageGenParams['references']; downloads: string[] }>> {
  if (!inputs || inputs.length === 0) return ok({ downloads: [] });
  const refStart = Date.now();
  const { references, downloads, errors } = await resolveReferenceImages(inputs, {
    downloadDir: runtime.outputDir(),
  });
  phases.resolveReferencesMs = Date.now() - refStart;
  if (errors.length > 0) {
    return refuse(
      `Could not use ${errors.length} of ${inputs.length} reference image(s); generation was not run. ` +
        `Fix or remove these and retry:\n- ${errors.join('\n- ')}`,
    );
  }
  return ok({ references, downloads });
}

// ---- Gateway request --------------------------------------------------------------------

interface ParamsInput {
  a: Args;
  cfg: Config;
  model: string;
  prompt: string;
  out: OutputPlan;
  refs: ReferencePlan;
  constraints: CompiledConstraints;
  references: ImageGenParams['references'];
  signal: AbortSignal | undefined;
}

function buildImageParams({ a, cfg, model, prompt, out, refs, constraints, references, signal }: ParamsInput): ImageGenParams {
  const quality = a['quality'] as string | undefined;
  return {
    // The compiled constraint block travels IN the prompt, so it reaches every
    // gateway; the structured fields below let each gateway also map it natively.
    prompt: applyConstraints(prompt, constraints),
    model,
    aspectRatio: out.aspectRatio,
    resolution: (a['image_size'] as string | undefined) ?? cfg.image.defaultResolution,
    ...(out.width != null ? { width: out.width } : {}),
    ...(out.height != null ? { height: out.height } : {}),
    ...samplingParams(a),
    ...(quality ? { quality } : {}),
    edenProvider: cfg.image.edenProvider,
    ...(references ? { references } : {}),
    ...(refs.mode ? { referenceMode: refs.mode } : {}),
    ...constraintFields(constraints),
    extra: (a['provider_options'] as Record<string, unknown> | undefined) ?? null,
    signal,
  };
}

/** Image count and prompt-sampling controls (each gateway reads only the ones it has). */
function samplingParams(a: Args): Pick<ImageGenParams, 'n' | 'temperature' | 'topP'> {
  return {
    n: (a['n'] as number | undefined) ?? null,
    temperature: (a['temperature'] as number | undefined) ?? null,
    topP: (a['top_p'] as number | undefined) ?? null,
  };
}

/** The structured constraint fields each gateway can map natively (palette / background / negative prompt). */
function constraintFields(constraints: CompiledConstraints): Partial<ImageGenParams> {
  return {
    ...(constraints.palette.length > 0 ? { palette: constraints.palette } : {}),
    ...(constraints.background ? { background: constraints.background.raw } : {}),
    ...(constraints.negativePrompt ? { negativePrompt: constraints.negativePrompt } : {}),
  };
}

/**
 * ICO with a model that only exposes resolution tiers (Eden/OpenRouter): pick the
 * smallest tier ≥ width so we can downscale, never upscale. Gateways that accept
 * exact pixel `image_size` (fal object) get width/height directly and skip this.
 * Uses the LIVE gateway, never one captured at registration — after a
 * `restart` that one no longer knows the configured model.
 */
function applyIcoResolution(params: ImageGenParams, format: OutputFormat | null, gateway: Gateway, model: string): void {
  if (format !== 'ico' || params.width == null) return;
  const res = pickGenerationResolution(gateway.imageResolutions?.(model)?.values ?? [], params.width);
  if (res) params.resolution = res;
}

// ---- Output settings & request snapshot ---------------------------------------------------

/** Output settings, snapshotted so an async job renders exactly what a sync call would. */
function buildMediaOpts(a: Args, cfg: Config, out: OutputPlan, prompt: string, constraints: CompiledConstraints): ImageJobMediaOpts {
  const outputMode = (a['output_mode'] as ImageJobMediaOpts['outputMode'] | undefined) ?? 'filePath';
  const check = buildConstraintCheck(constraints, a['palette_tolerance'] as number | undefined, (a['check_constraints'] as boolean | undefined) ?? true);
  return {
    format: out.format,
    tinifyKey: out.tinifyKey,
    outputMode,
    // base64 needs the bytes on disk first; force a save.
    save: outputMode === 'base64' ? true : ((a['save'] as boolean | undefined) ?? true),
    inline: (a['inline_preview'] as boolean | undefined) ?? cfg.output.inlinePreview,
    label: prompt,
    ...(out.format === 'ico' ? { icoSize: out.icoSize, squareFit: out.squareFit, ...(out.padColor ? { padColor: out.padColor } : {}) } : {}),
    ...(check ? { check } : {}),
    ...requestedSizeOf(a, out),
  };
}

/** An explicit non-ico width/height the reply must compare the result against (ico squares/downscales itself). */
function requestedSizeOf(a: Args, out: OutputPlan): Pick<ImageJobMediaOpts, 'requestedSize'> {
  const explicit = a['width'] != null || a['height'] != null;
  if (!explicit || out.format === 'ico' || out.width == null || out.height == null) return {};
  return { requestedSize: { width: out.width, height: out.height } };
}

function describeReferenceMode(refs: ReferencePlan): string {
  return refs.mode ?? refs.semantics?.native ?? '(n/a)';
}

function describeSize(out: OutputPlan): string {
  return out.width != null && out.height != null ? `${out.width}x${out.height}` : '(model default)';
}

/** Snapshot the request shape so slow/aborted runs can be correlated with what was asked for. */
function describeRequest(cfg: Config, params: ImageGenParams, out: OutputPlan, constraints: CompiledConstraints, refs: ReferencePlan): Record<string, unknown> {
  return {
    gateway: cfg.gateway,
    model: params.model,
    resolution: params.resolution ?? '(default)',
    aspectRatio: params.aspectRatio ?? '(default)',
    quality: params.quality ?? '(default)',
    size: describeSize(out),
    promptChars: params.prompt.length,
    referenceCount: params.references?.length ?? 0,
    hasProviderOptions: params.extra != null,
    outputFormat: out.format ?? '(none)',
    ...(out.format === 'ico' ? { icoSize: out.icoSize, squareFit: out.squareFit } : {}),
    constraints: constraints.summary.length > 0 ? constraints.summary : '(none)',
    referenceMode: describeReferenceMode(refs),
  };
}
