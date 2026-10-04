/**
 * Per-model capability map for fal.ai image models.
 *
 * fal has no programmatic model-list API, and (crucially) each image model exposes
 * a DIFFERENT request shape. The two size mechanisms underpin everything:
 *   - `image_size`: an object `{width, height}` **or** an enum tier
 *     (`square_hd`, `square`, `portrait_4_3`, …). Used by the FLUX / Recraft /
 *     Cosmos families. Accepts **exact pixel sizes** via the object form.
 *   - `aspect_ratio`: a ratio enum (`1:1`, `4:3`, `16:9`, …). Used by Krea 2 and
 *     Ideogram. No exact pixels — the model picks dimensions.
 *
 * Which field a model accepts, and which of `output_format` / `enable_safety_checker`
 * / `safety_tolerance` it carries, is per-model. This module is the single source of
 * truth so `buildFalImageInput` never guesses. (Schemas captured from
 * `https://fal.ai/models/<id>/api` — the embedded OpenAPI `components.schemas`.)
 */
import type { ModelInfo } from './types.js';

export type FalSizeField = 'image_size' | 'aspect_ratio';

export interface FalImageModelSpec {
  /** The size field this model reads. */
  sizeField: FalSizeField;
  /** When `sizeField` is image_size, whether the object `{width,height}` form is accepted. */
  objectSize: boolean;
  /** Advertised resolution/ratio choices (drives the wizard's size picker). */
  sizes: string[];
  /** Which safety/output knobs the model accepts (seeded defaults only go to models that read them). */
  outputFormat?: boolean;
  enableSafetyChecker?: boolean;
  safetyTolerance?: boolean;
  /** Image-conditioning/reference input, or null when the model has none. */
  referenceField?: 'image_style_references' | 'image_urls' | null;
  /**
   * What that reference input MEANS. `style` = the reference's look/medium is
   * transferred (Krea's `image_style_references`); `subject` = the reference's
   * object/geometry is conditioned on (the FLUX 2 Pro *Edit* endpoint's
   * `image_urls`). Never assume one implies the other.
   */
  referenceSemantics?: 'style' | 'subject';
  /** Model takes a structured colour palette (`colors[]` + `background_color`) — Recraft only. */
  colorFields?: boolean;
  /** Extra options a model uniquely accepts (surfaced for docs; passed via provider_options). */
  notes?: string;
}

/** Models the wizard offers against the curated fal menu (fal has no model-list API). */
export const FAL_IMAGE_CATALOG: ModelInfo[] = [
  { id: 'fal-ai/flux-2-pro', name: 'FLUX 2 Pro' },
  { id: 'fal-ai/flux-pro/v1.1-ultra', name: 'FLUX1.1 [pro] Ultra' },
  { id: 'fal-ai/flux-lora', name: 'FLUX LoRA' },
  { id: 'fal-ai/flux/krea', name: 'FLUX Krea' },
  { id: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3' },
  { id: 'fal-ai/ideogram/v3', name: 'Ideogram V3' },
  { id: 'fal-ai/ideogram/v2', name: 'Ideogram V2' },
  { id: 'krea/v2/large/text-to-image', name: 'Krea 2 Large' },
  { id: 'krea/v2/medium/text-to-image', name: 'Krea 2 Medium' },
  { id: 'nvidia/cosmos-3-super/text-to-image', name: 'NVIDIA Cosmos 3 Super' },
];

/** The `image_size` enum tiers shared by FLUX / Recraft / Cosmos. */
const IMAGE_SIZE_ENUM = ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'];

const specs: { test: (model: string) => boolean; spec: FalImageModelSpec }[] = [
  // FLUX 2 Pro *Edit* — the one fal endpoint with SUBJECT conditioning (`image_urls[]`).
  // Must precede the generic FLUX entry, whose regex also matches this id.
  { test: (m) => /flux-2-pro\/edit|flux-2\/edit|\/edit$/i.test(m) && /flux/i.test(m), spec: {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM,
    outputFormat: true, enableSafetyChecker: true, safetyTolerance: true,
    referenceField: 'image_urls', referenceSemantics: 'subject',
  } },
  // FLUX 2 Pro / FLUX 1.1 pro / FLUX LoRA — object image_size + full safety knobs.
  { test: (m) => /flux-2-pro|flux-pro|flux-lora|^fal-ai\/flux(?!\/)/i.test(m) && !/recraft|ideogram/i.test(m), spec: {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM,
    outputFormat: true, enableSafetyChecker: true, safetyTolerance: true,
  } },
  // FLUX `/krea` (a FLUX variant that ALSO takes object image_size — not aspect_ratio).
  { test: (m) => /flux\/krea|flux\/dev|flux\/schnell/i.test(m), spec: {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM,
    outputFormat: true, enableSafetyChecker: true, safetyTolerance: true,
  } },
  // Recraft V3 — object image_size, enable_safety_checker, no output_format/safety_tolerance.
  // The only fal image model with a STRUCTURED palette input (`colors[]` + `background_color`),
  // so a pinned palette reaches it as data, not just prose.
  { test: (m) => /recraft/i.test(m), spec: {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM,
    enableSafetyChecker: true, colorFields: true, notes: 'colors[], background_color, style',
  } },
  // Cosmos 3 Super — object image_size, num_images + output_format + enable_safety_checker.
  { test: (m) => /cosmos/i.test(m), spec: {
    sizeField: 'image_size', objectSize: true, sizes: IMAGE_SIZE_ENUM,
    outputFormat: true, enableSafetyChecker: true, notes: 'num_inference_steps, guidance_scale, negative_prompt, agentic_*',
  } },
  // Krea 2 — aspect_ratio only; image_style_references is STYLE transfer, not subject
  // conditioning (feeding it a photo makes the output look like that photograph).
  { test: (m) => /krea/i.test(m), spec: {
    sizeField: 'aspect_ratio', objectSize: false,
    sizes: ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16'],
    referenceField: 'image_style_references', referenceSemantics: 'style',
    notes: 'creativity, styles[], moodboards[]',
  } },
  // Ideogram — aspect_ratio only; style + expand_prompt; no output_format check node.
  { test: (m) => /ideogram/i.test(m), spec: {
    sizeField: 'aspect_ratio', objectSize: false,
    sizes: ['10:16', '16:10', '9:16', '16:9', '4:3', '3:4', '1:1', '1:3', '3:1', '3:2', '2:3'],
    notes: 'style, expand_prompt, negative_prompt',
  } },
];

/** Resolve the spec for a given model id, or null if unknown (wizard typed a custom id). */
export function falImageSpec(model: string): FalImageModelSpec | null {
  for (const { test, spec } of specs) if (test(model)) return spec;
  return null;
}

/** The curated image model menu (fal has no model-list API). */
export function falImageCatalog(): ModelInfo[] {
  return FAL_IMAGE_CATALOG;
}
