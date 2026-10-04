import { z } from 'zod';
import { runtime } from '../state/runtime.js';
import type { Gateway, ReferenceMode } from '../gateways/types.js';
import { OUTPUT_MODE_DESCRIPTION } from './helpers.js';

type InputSchema = Record<string, z.ZodTypeAny>;

/** What the configured gateway + model are, captured once per schema build. */
interface SchemaContext {
  gw: Gateway;
  gatewayId: string;
  model: string;
  tinifyEnabled: boolean;
}

/**
 * The input schema is built from the *configured* gateway + model: each option is only
 * surfaced (and its allowed values constrained) when the active model actually supports
 * it. It is built at registration AND rebuilt after every successful `restart`, so a
 * reload that switches gateway/model never leaves the client validating against the old
 * model's enums. The model itself comes from config, not from the tool input.
 */
export function buildGenerateImageSchema(): InputSchema {
  const ctx: SchemaContext = {
    gw: runtime.gateway,
    gatewayId: runtime.config.gateway,
    model: runtime.config.image.model ?? '',
    tinifyEnabled: runtime.tinifyToken != null,
  };

  const inputSchema: InputSchema = {
    // `job_id` re-invokes a background generation submitted earlier with `wait:false`
    // — in that mode `prompt` is not needed, so it is optional (validated at runtime).
    prompt: z.string().optional().describe('The text prompt describing the image to generate (required unless `job_id` is given).'),
  };
  addAspectRatioField(inputSchema, ctx);
  addSizeFields(inputSchema, ctx);
  addQualityField(inputSchema, ctx);
  addGatewaySpecificFields(inputSchema, ctx);
  addOutputFormatField(inputSchema, ctx);
  addReferenceFields(inputSchema, ctx);
  addConstraintFields(inputSchema, ctx);
  addIcoSquaringFields(inputSchema);
  addToolOptionFields(inputSchema);
  return inputSchema;
}

/** Aspect ratio — only when the model exposes it as a real parameter. */
function addAspectRatioField(inputSchema: InputSchema, { gw, model }: SchemaContext): void {
  const ratios = gw.imageAspectRatios?.(model);
  if (ratios && ratios.values.length > 0) {
    inputSchema['aspect_ratio'] = z
      .enum(ratios.values as [string, ...string[]])
      .optional()
      .describe('Shape of the generated image as width:height.');
  }
}

/**
 * Output size. `width` (px) is the primary lever — height is derived from `aspect_ratio`
 * (default 1:1 → square) unless `height` is given explicitly. Gateways whose models
 * accept pixel sizes (fal object `image_size`) use it directly; others map to a tier.
 */
function addSizeFields(inputSchema: InputSchema, { gw, model }: SchemaContext): void {
  inputSchema['width'] = z
    .number().int().min(1)
    .optional()
    .describe('Target width in pixels. For `output_format:"ico"` this is the square icon dimension (must be an allowed ICO size, default 256). For other formats, height is computed from `aspect_ratio` unless `height` is given.');
  inputSchema['height'] = z
    .number().int().min(1)
    .optional()
    .describe('Target height in pixels. When omitted, computed from `width` × `aspect_ratio` (default 1:1 → square). Implies the model should render at exactly width×height where it supports pixel sizes.');
  // The legacy model-resolution tier/token (OpenRouter/Eden), only when the gateway advertises one.
  const resolutions = gw.imageResolutions?.(model);
  // `{values:[], source:'api'}` = the API positively says this model has NO resolution
  // parameter (e.g. gpt-image-2.5 renders at its native full size) — offer nothing.
  const modelHasNoResolutionTier = resolutions != null && resolutions.source === 'api' && resolutions.values.length === 0;
  if (resolutions && resolutions.values.length > 0) {
    inputSchema['image_size'] = z
      .enum(resolutions.values as [string, ...string[]])
      .optional()
      .describe('Output tier (OpenRouter/Eden): larger values give more detail but are slower and cost more. Prefer `width`/`height` for exact pixel sizes.');
  } else if (gw.capabilities.imageResolutionParam && !modelHasNoResolutionTier) {
    inputSchema['image_size'] = z.string().optional().describe('Output size, e.g. "1024x1024". Prefer `width`/`height` for exact pixel sizes.');
  }
}

/**
 * Quality / effort level — only when the configured model advertises one
 * (OpenRouter `quality`, e.g. gpt-image-2.5: auto|low|medium|high|xhigh|max).
 */
function addQualityField(inputSchema: InputSchema, { gw, model }: SchemaContext): void {
  const qualities = gw.imageQualityLevels?.(model);
  if (qualities && qualities.values.length > 0) {
    inputSchema['quality'] = z
      .enum(qualities.values as [string, ...string[]])
      .optional()
      .describe(
        `Rendering quality/effort for ${model}: ${qualities.values.join(' < ')}. Higher levels are slower and cost more (billed per output token); ` +
          'omit to use the provider default ("auto" where offered).',
      );
  }
}

/** Options only some gateways/models have: image count (where advertised) and prompt-sampling controls (Mistral). */
function addGatewaySpecificFields(inputSchema: InputSchema, { gw, gatewayId, model }: SchemaContext): void {
  // Number of images per call — offered wherever the model says it takes one (Eden; OpenRouter
  // models whose live capabilities advertise `n`, e.g. gpt-image-1-mini 1..10).
  const count = gw.imageCountRange?.(model);
  if (count && count.max > 1) {
    inputSchema['n'] = z.number().int().min(count.min).max(count.max).optional().describe(`How many images to generate in one call (${count.min}–${count.max}).`);
  }

  // Sampling controls for how the prompt is interpreted.
  if (gatewayId === 'mistral') {
    inputSchema['temperature'] = z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('How freely the prompt is interpreted: higher (≈1.0+) is more varied and creative, lower (≈0.2) is more literal and repeatable.');
    inputSchema['top_p'] = z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Diversity of choices when interpreting the prompt. Lower values (≈0.1–0.5) keep the result focused and predictable; values near 1.0 allow more variety. Adjust this OR temperature, not both.',
      );
  }
}

/**
 * Desired saved/returned format. `ico` needs no optimizer (it is a local container), so it is
 * always offered; png/jpg/webp/avif are only surfaced when a Tinify key is configured.
 */
function addOutputFormatField(inputSchema: InputSchema, { tinifyEnabled }: SchemaContext): void {
  const nonIco: Array<'png' | 'jpg' | 'webp' | 'avif'> = tinifyEnabled ? ['png', 'jpg', 'webp', 'avif'] : [];
  inputSchema['output_format'] = z
    .enum(['ico', ...nonIco] as [string, ...string[]])
    .optional()
    .describe(
      'Format the image is saved and returned in. "png" is losslessly optimized (the unoptimized source is kept as "<name>-original.png"); "webp", "jpg" and "avif" are converted to that format via Tinify and are usually much smaller (avif is typically the smallest). "ico" wraps the image in a single-entry Windows icon, downscaled (never upscaled) to `width` (square, default 256) with a touch of sharpening, and the original is kept as "<name>-original.png". Default "png" when Tinify is configured, else no conversion.',
    );
}

/**
 * Reference images — only when the configured model can be conditioned on them.
 * The SEMANTICS of that conditioning (subject vs style) are per-model, so they are
 * stated here, before generation, instead of surprising the caller in the output.
 */
function addReferenceFields(inputSchema: InputSchema, { gw, model }: SchemaContext): void {
  if (!gw.capabilities.imageReferenceImages) return;
  const semantics = gw.referenceSemantics?.(model) ?? null;
  inputSchema['reference_images'] = z
    .array(z.string().min(1))
    .optional()
    .describe(
      'One or more reference images for the model to edit or condition on (e.g. refine an existing picture). ' +
        'Each entry is a local file path, an http(s) URL, a data: URL, or raw base64. Remote URLs are downloaded and ' +
        'all inputs are verified before generation — if any reference cannot be fetched/read or is not a valid image ' +
        '(png, jpg, webp, gif, avif, …), the call fails without generating. ' +
        (semantics
          ? `The configured model (${model}) conditions on references as **${semantics.native}** via \`${semantics.field}\`` +
            `${semantics.note ? ` — ${semantics.note}` : '.'}`
          : 'Supported by the configured model.'),
    );
  if (semantics) {
    // Both modes are accepted by the SCHEMA on purpose: an unsupported mode is
    // refused by the handler with an error that names what this model does
    // provide and which model can do what you asked — far more useful than a
    // raw enum-validation dump, and still before anything is generated.
    inputSchema['reference_mode'] = z
      .enum(['subject', 'style'] as [ReferenceMode, ...ReferenceMode[]])
      .optional()
      .describe(
        'What the reference images are FOR. "subject" = condition on their object design/geometry (the generated ' +
          'image reproduces the referenced object, rendered in the medium your prompt asks for); "style" = adopt ' +
          'their look/medium/palette only, not their subject. Conflating the two is why a photo reference turns a ' +
          `"clean 3D icon" request into a photograph. The configured model provides "${semantics.native}" natively` +
          `${semantics.steered && semantics.steered.length > 0 ? `, and "${semantics.steered.join('", "')}" via prompt steering` : ''}` +
          `; requesting anything else fails before generation. Default: ${semantics.native}.`,
      );
  }
}

/** How the `background` parameter's description states what the configured model accepts natively. */
function describeBackgroundSupport(gw: Gateway, model: string): string {
  const bgModes = gw.imageBackgroundModes?.(model) ?? null;
  if (!bgModes) return '';
  if (bgModes.values.length === 0) {
    return `The configured model (${model}) has no native background field; the requirement travels in the prompt only.`;
  }
  return (
    `The configured model (${model}) natively accepts: ${bgModes.values.join(', ')}` +
    (bgModes.values.includes('transparent')
      ? '.'
      : ' — it CANNOT render transparency, so "transparent" is refused before generation (generate on a flat colour and use remove_background instead).')
  );
}

/**
 * Structured constraints (colour / exclusions / background). These are compiled into one
 * deterministic constraint block appended to the prompt AND mapped to native provider
 * fields where they exist, so they are not prose the caller has to keep re-typing and
 * the model can silently drop.
 */
function addConstraintFields(inputSchema: InputSchema, { gw, model }: SchemaContext): void {
  inputSchema['palette'] = z
    .array(z.string().min(3))
    .optional()
    .describe(
      'Pin the accent colours: an array of hex values ("#f0ea17", "#e60909"). They are compiled into an exact-colour ' +
        'constraint (including "no <other hue families>"), mapped to the model\'s native palette field where it has one ' +
        '(fal Recraft `colors[]`), and the result is measured against them — the reply reports the share of accent pixels ' +
        'that landed on each colour, plus the dominant off-palette accent if the model drifted.',
    );
  inputSchema['palette_tolerance'] = z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe('How far an accent pixel may sit from a pinned colour and still count as on-palette (RGB distance, default 60).');
  inputSchema['exclude'] = z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Elements the image must NOT contain ("text", "watermark", "cable", "border", …). Known terms are expanded to the ' +
        'phrasing that actually suppresses them (e.g. "text" → "text, letters, words, numbers, labels, captions, typography, ' +
        'logotype") and sent as the model\'s native `negative_prompt` where it has one, plus the prompt constraint block.',
    );
  inputSchema['background'] = z
    .string()
    .optional()
    .describe(
      'Required background: "transparent", a hex ("#ffffff"), a colour word ("solid white"), the native modes "opaque"/"auto", or free text. Compiled into a ' +
        'flat-background constraint, mapped natively where possible (OpenRouter `background`, fal Recraft `background_color`), ' +
        'and verified against the result\'s border (reported as a match percentage). Free text is passed through but not checked. ' +
        describeBackgroundSupport(gw, model),
    );
  inputSchema['check_constraints'] = z
    .boolean()
    .optional()
    .describe('Measure the result against `palette` / `background` and report it (default true when either is given).');
}

/** ICO squaring policy — how a non-square model result becomes a square icon. */
function addIcoSquaringFields(inputSchema: InputSchema): void {
  inputSchema['square_fit'] = z
    .enum(['pad', 'crop'])
    .optional()
    .describe(
      'For `output_format:"ico"`, how a non-square model result is made square. "pad" (default) fits the WHOLE image onto a ' +
        'square canvas so no content is lost; "crop" center-crops it (edge-to-edge, but anything off-centre is cut off). ' +
        'Either way the reply states what was done.',
    );
  inputSchema['pad_color'] = z
    .string()
    .optional()
    .describe('Padding colour for `square_fit:"pad"` — "transparent" (default) or a hex like "#ffffff".');
}

/** Escape hatch + tool-level options (always available). */
function addToolOptionFields(inputSchema: InputSchema): void {
  inputSchema['provider_options'] = z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional model-specific request fields, merged into the underlying request — use for options not surfaced above.');
  inputSchema['save'] = z.boolean().optional().describe('Save the image(s) to the output directory (default true).');
  inputSchema['inline_preview'] = z.boolean().optional().describe('Return an inline image preview to the client (default from config).');
  inputSchema['output_mode'] = z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION);
  inputSchema['wait'] = z
    .boolean()
    .optional()
    .describe(
      'Override the configured async mode for this call. true = block until generation finishes and return the result; ' +
        'false = submit the job and return immediately with a `job_id` (and the provider request_id when available) — the generation keeps running ' +
        'in the background, and you re-invoke `generate_image` with that `job_id` to poll it (it stays decoupled from any MCP client timeout). ' +
        'Omit to use the configured mode (default async).',
    );
  inputSchema['job_id'] = z
    .string()
    .optional()
    .describe(
      'Poll a background generation submitted earlier with `wait:false` (or resume a slow one). When present, `prompt` and the other ' +
        'generation params are ignored; the result is rendered with the output settings captured at submit time. Re-invoke until the ' +
        'job reports "completed" (returns the image) or "failed".',
    );
}
