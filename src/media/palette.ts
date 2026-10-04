/**
 * Structured generation constraints — colour palette, exclusions, background —
 * plus the verification that measures a result against them.
 *
 * Why this exists: the only channel most image gateways offer for "use exactly
 * these two hexes", "no text anywhere", "flat white background" is prose in the
 * prompt, which the model happily drops. Callers ended up re-typing ever longer
 * "STRICT palette: …" preambles by hand. So the constraint is a first-class,
 * server-owned input with two halves:
 *
 *  - COMPILE (`compileConstraints`) turns the structured spec into ONE
 *    deterministic constraint block appended to the prompt, so it reaches every
 *    gateway. Gateways additionally map what they can natively — fal Recraft
 *    `colors[]`/`background_color`, fal `negative_prompt`, OpenRouter
 *    `background` — so the constraint survives provider mapping instead of
 *    being dropped at the boundary.
 *  - VERIFY (`analyzePalette` / `analyzeBackground`) measures the produced image
 *    against the same spec, so the tool reports whether the model honoured it
 *    rather than leaving the caller to eyeball thumbnails.
 *
 * Everything here is local (sharp only) — no network, no cost.
 */
import sharp from 'sharp';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A few colour words we accept in a background spec ("solid white", "flat black"). */
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  grey: '#808080',
  gray: '#808080',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  orange: '#ffa500',
  purple: '#800080',
};

/** Parse `#rgb` / `#rrggbb` (with or without `#`). Throws with a usable message. */
export function parseHexColor(hex: string): Rgb {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new Error(`"${hex}" is not a hex colour (expected #rgb or #rrggbb).`);
  let h = m[1]!.toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function toHex(c: Rgb): string {
  const p = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}

/** Canonical lowercase `#rrggbb` (throws on an invalid input). */
export function normalizeHex(hex: string): string {
  return toHex(parseHexColor(hex));
}

/** Plain RGB euclidean distance (0 … ~441.7). Cheap, and good enough at icon scale. */
export function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function rgbToHsv(c: Rgb): { h: number; s: number; v: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export type HueFamily = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'magenta';

/** The eight hue families we can name — used to spell out which hues are OFF-palette. */
export const HUE_FAMILIES: HueFamily[] = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'];

const HUE_BANDS: { family: HueFamily; from: number; to: number }[] = [
  { family: 'orange', from: 15, to: 45 },
  { family: 'yellow', from: 45, to: 70 },
  { family: 'green', from: 70, to: 165 },
  { family: 'cyan', from: 165, to: 195 },
  { family: 'blue', from: 195, to: 255 },
  { family: 'purple', from: 255, to: 285 },
  { family: 'magenta', from: 285, to: 345 },
];

/** Name a colour's hue family, or `neutral` when it is too desaturated/dark to have one. */
export function hueFamily(c: Rgb): HueFamily | 'neutral' {
  const { h, s, v } = rgbToHsv(c);
  if (s < 0.15 || v < 0.1) return 'neutral';
  for (const band of HUE_BANDS) if (h >= band.from && h < band.to) return band.family;
  return 'red'; // wraps: [345,360) plus [0,15)
}

// ---------------------------------------------------------------------------
// Background spec
// ---------------------------------------------------------------------------

export type BackgroundSpec =
  | { kind: 'transparent'; raw: string }
  | { kind: 'color'; color: Rgb; hex: string; raw: string }
  /** A native provider MODE with no colour to verify: `opaque` (any non-transparent backdrop) or `auto` (provider decides). */
  | { kind: 'mode'; mode: 'opaque' | 'auto'; raw: string }
  | { kind: 'text'; raw: string };

/**
 * Parse a background requirement: `transparent`, a hex (anywhere in the string,
 * so "solid flat #ffffff" works), a colour word ("solid white"), or free text
 * (kept verbatim as a prompt constraint but not machine-verifiable).
 */
export function parseBackgroundSpec(spec: string): BackgroundSpec {
  const raw = spec.trim();
  const lower = raw.toLowerCase();
  if (/^(transparent|alpha|none|no background)$/.test(lower)) return { kind: 'transparent', raw };
  if (lower === 'opaque' || lower === 'auto') return { kind: 'mode', mode: lower, raw };
  const hex = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(raw);
  if (hex) {
    const color = parseHexColor(hex[0]);
    return { kind: 'color', color, hex: toHex(color), raw };
  }
  for (const [name, value] of Object.entries(NAMED_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const color = parseHexColor(value);
      return { kind: 'color', color, hex: toHex(color), raw };
    }
  }
  return { kind: 'text', raw };
}

// ---------------------------------------------------------------------------
// Compile: structured spec -> one deterministic prompt constraint block
// ---------------------------------------------------------------------------

/**
 * Common exclusions expanded to the phrasing that actually suppresses them.
 * ("no text" alone leaves models adding letters; naming the whole family works
 * far better — this is the nagging the caller had to do by hand, done once.)
 */
const EXCLUSION_EXPANSIONS: Record<string, string> = {
  text: 'text, letters, words, numbers, labels, captions, typography, logotype',
  letters: 'letters, words, text, typography',
  typography: 'typography, text, letters, words, labels',
  watermark: 'watermark, signature, stamp, attribution mark',
  logo: 'logo, logotype, brand mark',
  cable: 'cable, wire, cord, lead',
  wire: 'wire, cable, cord, lead',
  cord: 'cord, cable, wire, lead',
  border: 'border, frame, outline box, matte edge',
  shadow: 'drop shadow, cast shadow, contact shadow',
  gradient: 'gradient, colour ramp, soft fade',
  reflection: 'reflection, mirror surface, glossy floor',
  people: 'people, person, hands, fingers, faces',
  props: 'props, scenery, table, surface, environment clutter',
};

/** Normalize an exclusion term ("NO text", "without a cable") and expand known families. */
export function expandExclusion(term: string): string {
  const cleaned = term
    .trim()
    .toLowerCase()
    .replace(/^(no|without|not)\s+/, '')
    .replace(/^(a|an|the)\s+/, '')
    .replace(/[.,;]+$/, '');
  if (!cleaned) return '';
  return EXCLUSION_EXPANSIONS[cleaned] ?? cleaned;
}

export interface GenerationConstraints {
  /** Pinned accent colours — any hex form; normalized on compile. */
  palette?: string[];
  /** Elements the image must not contain ("text", "watermark", "cable", …). */
  exclude?: string[];
  /** Background requirement: `transparent`, a hex, a colour word, or free text. */
  background?: string;
  /** Extra instruction about how supplied reference images must be used. */
  referenceSteer?: string;
}

export interface CompiledConstraints {
  /** The block to append to the prompt ('' when nothing was specified). */
  text: string;
  /** Normalized `#rrggbb` palette (empty when none). */
  palette: string[];
  /** Parsed background spec (null when none). */
  background: BackgroundSpec | null;
  /** A native `negative_prompt` string for gateways that have the field (null when nothing to say). */
  negativePrompt: string | null;
  /** One line per constraint, for the tool's "constraints applied" report. */
  summary: string[];
}

/** Hue families NOT covered by the pinned palette — spelled out so they can be excluded by name. */
export function offPaletteFamilies(palette: string[]): HueFamily[] {
  const covered = new Set<string>();
  for (const hex of palette) covered.add(hueFamily(parseHexColor(hex)));
  return HUE_FAMILIES.filter((f) => !covered.has(f));
}

/** One constraint's contribution to the compiled output. */
interface ConstraintPart {
  line: string;
  summary: string;
  negatives: string[];
}

function paletteConstraint(palette: string[]): ConstraintPart | null {
  if (palette.length === 0) return null;
  const named = palette.map((hex) => {
    const family = hueFamily(parseHexColor(hex));
    return family === 'neutral' ? hex : `${hex} (${family})`;
  });
  const off = offPaletteFamilies(palette);
  return {
    line:
      `- COLOUR PALETTE (exact): ${named.join(', ')}. Use these exact hex values for every accent, highlight, glow and rim light; ` +
      'do not shift, tint, desaturate or substitute them.' +
      (off.length > 0 ? ` No ${off.join(', ')} anywhere — including lighting, reflections and background bounce.` : ''),
    summary: `palette pinned to ${palette.join(', ')}`,
    negatives: off.length > 0 ? [`${off.join(' tones, ')} tones`, 'colours outside the specified palette'] : [],
  };
}

function exclusionConstraint(exclusions: string[]): ConstraintPart | null {
  if (exclusions.length === 0) return null;
  return {
    line: `- MUST NOT CONTAIN: ${exclusions.join('; ')}. None of these may appear anywhere in the image.`,
    summary: `${exclusions.length} exclusion(s)`,
    negatives: exclusions,
  };
}

/** What the background spec contributes to the "constraints applied" report. */
function backgroundSummary(bg: BackgroundSpec): string {
  switch (bg.kind) {
    case 'text':
      return bg.raw;
    case 'transparent':
      return 'transparent';
    case 'mode':
      return `${bg.mode} (native mode)`;
    case 'color':
      return bg.hex;
  }
}

function backgroundConstraint(bg: BackgroundSpec): ConstraintPart {
  const summary = `background: ${backgroundSummary(bg)}`;
  switch (bg.kind) {
    case 'transparent':
      return {
        line: '- BACKGROUND: fully transparent (alpha 0) — the subject only, no backdrop, no scene, no shadow plane.',
        summary,
        negatives: ['background scenery, backdrop, floor, shadow plane'],
      };
    case 'color':
      return {
        line:
          `- BACKGROUND: solid flat ${bg.hex}, edge to edge and perfectly uniform — no gradient, no vignette, ` +
          'no drop shadow, no border, no table, surface, props or scenery.',
        summary,
        negatives: ['gradient background, vignette, textured backdrop, scenery, props'],
      };
    default:
      return { line: `- BACKGROUND: ${bg.raw}.`, summary, negatives: [] };
  }
}

/**
 * Compile the structured constraints into the prompt block + the native
 * negative prompt. Deterministic: the same spec always produces the same text
 * (so a fixture can assert on it, and the caller never re-types it).
 */
export function compileConstraints(c: GenerationConstraints): CompiledConstraints {
  const palette = (c.palette ?? []).map(normalizeHex);
  const background = c.background ? parseBackgroundSpec(c.background) : null;
  const exclusions = (c.exclude ?? []).map(expandExclusion).filter(Boolean);
  const parts = [
    paletteConstraint(palette),
    exclusionConstraint(exclusions),
    background && backgroundConstraint(background),
    c.referenceSteer ? { line: `- REFERENCE IMAGES: ${c.referenceSteer}`, summary: 'reference-use steer', negatives: [] } : null,
  ].filter((p): p is ConstraintPart => p != null);

  const negatives = parts.flatMap((p) => p.negatives);
  const text =
    parts.length === 0 ? '' : ['STRICT CONSTRAINTS — follow these exactly; they override anything implied above:', ...parts.map((p) => p.line)].join('\n');
  return { text, palette, background, negativePrompt: negatives.length > 0 ? negatives.join(', ') : null, summary: parts.map((p) => p.summary) };
}

/** Append the compiled constraint block to a prompt (returns the prompt unchanged when empty). */
export function applyConstraints(prompt: string, compiled: CompiledConstraints): string {
  return compiled.text ? `${prompt}\n\n${compiled.text}` : prompt;
}

// ---------------------------------------------------------------------------
// Verify: measure a produced image against the same spec
// ---------------------------------------------------------------------------

/** Max RGB distance at which an accent pixel counts as "on" a pinned colour. */
export const DEFAULT_PALETTE_TOLERANCE = 60;
/** Max RGB distance at which a border pixel counts as matching the background spec. */
export const DEFAULT_BACKGROUND_TOLERANCE = 24;
/** Share of accent pixels a pinned colour needs to count as actually present. */
const PRESENT_COVERAGE = 0.02;

/** Downscale to a small raw RGBA sample — analysis is statistical, full res buys nothing. */
async function sampleRgba(bytes: Buffer, side = 160): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(bytes)
    .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    // sharp processes in sRGB and can return a different channel count than the
    // source had — always read the real stride from `info`, never assume 4.
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

export interface PaletteColorReport {
  hex: string;
  /** Share of accent pixels within tolerance of this colour (0..1). */
  coverage: number;
  /** Whether the colour is actually present (coverage >= 2% of accent pixels). */
  present: boolean;
}

export interface PaletteReport {
  colors: PaletteColorReport[];
  /** Share of accent pixels that land on SOME pinned colour (0..1). */
  onPaletteFraction: number;
  accentPixels: number;
  sampled: number;
  tolerance: number;
  /** The most common accent colour that is off-palette (null when there is none). */
  offPalette: { hex: string; coverage: number; family: HueFamily | 'neutral' } | null;
}

/** Alpha of the pixel at byte offset `i` (opaque when the sample has no alpha channel). */
const alphaAt = (data: Buffer, i: number, channels: number): number => (channels >= 4 ? data[i + 3]! : 255);

interface OffBucket {
  n: number;
  r: number;
  g: number;
  b: number;
}

/** The pinned colour closest to `px` (index + RGB distance). */
function nearestTarget(px: Rgb, targets: { rgb: Rgb }[]): { index: number; distance: number } {
  let index = -1;
  let distance = Infinity;
  targets.forEach((t, i) => {
    const d = colorDistance(px, t.rgb);
    if (d < distance) {
      distance = d;
      index = i;
    }
  });
  return { index, distance };
}

/**
 * Tally the accent (saturated, opaque) pixels: per pinned colour when within `tolerance`, otherwise
 * into coarse 3-bit-per-channel buckets so the dominant off-palette colour can be named.
 */
function scanAccentPixels(
  sample: { data: Buffer; channels: number },
  targets: { rgb: Rgb }[],
  tolerance: number,
): { counts: number[]; offBuckets: Map<number, OffBucket>; accent: number } {
  const { data, channels } = sample;
  const counts: number[] = new Array(targets.length).fill(0);
  const offBuckets = new Map<number, OffBucket>();
  let accent = 0;
  for (let i = 0; i + channels - 1 < data.length; i += channels) {
    if (alphaAt(data, i, channels) < 128) continue;
    const px: Rgb = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
    const { s, v } = rgbToHsv(px);
    if (s < 0.18 || v < 0.12) continue; // neutral / near-black — not an accent
    accent += 1;
    const nearest = nearestTarget(px, targets);
    if (nearest.index >= 0 && nearest.distance <= tolerance) {
      counts[nearest.index] = (counts[nearest.index] ?? 0) + 1;
      continue;
    }
    const key = ((px.r >> 5) << 10) | ((px.g >> 5) << 5) | (px.b >> 5);
    const bucket = offBuckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += px.r;
    bucket.g += px.g;
    bucket.b += px.b;
    offBuckets.set(key, bucket);
  }
  return { counts, offBuckets, accent };
}

/** The most populated off-palette bucket, as its mean colour (null when there is none). */
function dominantOffPalette(offBuckets: Map<number, OffBucket>, accent: number): PaletteReport['offPalette'] {
  let result: PaletteReport['offPalette'] = null;
  let biggest = 0;
  for (const bucket of offBuckets.values()) {
    if (bucket.n <= biggest) continue;
    biggest = bucket.n;
    const rgb: Rgb = { r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n };
    result = { hex: toHex(rgb), coverage: accent > 0 ? bucket.n / accent : 0, family: hueFamily(rgb) };
  }
  return result;
}

/**
 * Measure how much of the image's accent (saturated, opaque) colour actually
 * lands on the pinned palette, and name the dominant off-palette accent when it
 * does not. Neutrals (near-white/black/grey) are ignored — a palette pins the
 * accents, not the shading.
 */
export async function analyzePalette(bytes: Buffer, hexes: string[], opts: { tolerance?: number } = {}): Promise<PaletteReport> {
  const tolerance = opts.tolerance ?? DEFAULT_PALETTE_TOLERANCE;
  const targets = hexes.map((h) => ({ hex: normalizeHex(h), rgb: parseHexColor(h) }));
  const sample = await sampleRgba(bytes);
  const { counts, offBuckets, accent } = scanAccentPixels(sample, targets, tolerance);

  const colors = targets.map((t, i) => {
    const coverage = accent > 0 ? (counts[i] ?? 0) / accent : 0;
    return { hex: t.hex, coverage, present: coverage >= PRESENT_COVERAGE };
  });
  const onPalette = counts.reduce((a, b) => a + b, 0);
  return {
    colors,
    onPaletteFraction: accent > 0 ? onPalette / accent : 0,
    accentPixels: accent,
    sampled: sample.width * sample.height,
    tolerance,
    offPalette: dominantOffPalette(offBuckets, accent),
  };
}

export interface BackgroundReport {
  spec: BackgroundSpec;
  /** Mean colour of the opaque border pixels. */
  meanHex: string;
  /** Share of border pixels that are transparent (0..1). */
  transparentFraction: number;
  /** Share of border pixels within tolerance of the mean — i.e. how flat the background is. */
  uniformity: number;
  /** Share of border pixels matching the spec (null for a free-text spec). */
  matchFraction: number | null;
  /** matchFraction >= 0.9 (null when the spec is free text and cannot be checked). */
  matched: boolean | null;
  sampled: number;
}

interface BorderRing {
  total: number;
  transparent: number;
  /** The opaque border pixels. */
  pixels: Rgb[];
}

/** Walk the border ring (`band` px thick): opaque pixels are collected, transparent ones counted. */
function scanBorderRing(sample: { data: Buffer; width: number; height: number; channels: number }): BorderRing {
  const { data, width, height, channels } = sample;
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.04));
  let total = 0;
  let transparent = 0;
  const pixels: Rgb[] = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= band && x < width - band) continue;
      const i = (y * width + x) * channels;
      total += 1;
      if (alphaAt(data, i, channels) < 128) transparent += 1;
      else pixels.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
    }
  }
  return { total, transparent, pixels };
}

function meanColor(pixels: Rgb[]): Rgb {
  if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p.r;
    g += p.g;
    b += p.b;
  }
  return { r: r / pixels.length, g: g / pixels.length, b: b / pixels.length };
}

/** Border share matching the spec: transparent pixels, or pixels near the colour; null when unverifiable. */
function backgroundMatchFraction(spec: BackgroundSpec, ring: BorderRing, tolerance: number): number | null {
  if (spec.kind === 'transparent') return ring.total > 0 ? ring.transparent / ring.total : 0;
  if (spec.kind !== 'color') return null;
  const hit = ring.pixels.filter((p) => colorDistance(p, spec.color) <= tolerance).length;
  return ring.total > 0 ? hit / ring.total : 0;
}

/**
 * Measure the image's border ring against the background spec: how transparent
 * it is, how uniform, and (for transparent / a specific colour) whether it
 * matches. A free-text spec is described but not judged.
 */
export async function analyzeBackground(
  bytes: Buffer,
  spec: string | BackgroundSpec,
  opts: { tolerance?: number } = {},
): Promise<BackgroundReport> {
  const parsed = typeof spec === 'string' ? parseBackgroundSpec(spec) : spec;
  const tolerance = opts.tolerance ?? DEFAULT_BACKGROUND_TOLERANCE;
  const ring = scanBorderRing(await sampleRgba(bytes));
  const mean = meanColor(ring.pixels);
  const uniform = ring.pixels.filter((p) => colorDistance(p, mean) <= tolerance).length;
  const matchFraction = backgroundMatchFraction(parsed, ring, tolerance);
  return {
    spec: parsed,
    meanHex: toHex(mean),
    transparentFraction: ring.total > 0 ? ring.transparent / ring.total : 0,
    uniformity: ring.total > 0 ? uniform / ring.total : 0,
    matchFraction,
    matched: matchFraction == null ? null : matchFraction >= 0.9,
    sampled: ring.total,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Human-readable palette-check lines for a tool result. */
export function describePaletteReport(r: PaletteReport): string[] {
  if (r.accentPixels === 0) {
    return ['Palette check: the image has no saturated accent pixels to compare (fully neutral result).'];
  }
  const lines = [`Palette check (tolerance ${r.tolerance}, ${pct(r.onPaletteFraction)} of accent pixels on-palette):`];
  for (const c of r.colors) {
    lines.push(`  ${c.present ? '✓' : '✗'} ${c.hex} — ${pct(c.coverage)} of accent pixels`);
  }
  if (r.offPalette && r.offPalette.coverage >= 0.05) {
    lines.push(`  ⚠ dominant off-palette accent: ${r.offPalette.hex} (${r.offPalette.family}, ${pct(r.offPalette.coverage)})`);
  }
  return lines;
}

/** Human-readable background-check lines for a tool result. */
export function describeBackgroundReport(r: BackgroundReport): string[] {
  if (r.matched == null) {
    return [`Background check: "${r.spec.raw}" is free text (not machine-checkable); border is ${r.meanHex}, ${pct(r.uniformity)} uniform.`];
  }
  const want = r.spec.kind === 'transparent' ? 'transparent' : r.spec.kind === 'color' ? r.spec.hex : r.spec.raw;
  return [
    `Background check: ${r.matched ? '✓' : '✗'} ${want} — ${pct(r.matchFraction ?? 0)} of the border matches` +
      (r.spec.kind === 'color' ? ` (border mean ${r.meanHex}, ${pct(r.uniformity)} uniform)` : ` (${pct(r.transparentFraction)} transparent)`),
  ];
}
