import { createRequire } from 'node:module';
import sharp from 'sharp';
import { ssimLuma } from '../util/ssim.js';

/**
 * Local animated-GIF assembly from a sequence of still frames, using `gifenc`
 * (mattdesl) — chosen over `@skyra/gifenc` by an empirical bake-off (see
 * `output/gifbench/REPORT.md`): zero runtime deps, synchronous, and the only one
 * with a real palette-SIZE knob, which is what makes the quality/size knee below
 * possible (skyra's quality knob is a NeuQuant subsampling factor that does NOT
 * move file size). No vendor SDK and no gateway — this is the `output_format:"gif"`
 * branch of the `image_to_video` tool.
 *
 * gifenc ships no type defs and is dual CJS/ESM with no `exports` map, so a static
 * `import { GIFEncoder } from 'gifenc'` resolves to `undefined`; load it via
 * `createRequire` instead (contained, adds no dependency).
 */

type Palette = number[][];
type PixelFormat = 'rgb565' | 'rgb444' | 'rgba4444';

interface QuantizeOpts {
  format?: PixelFormat;
  clearAlpha?: boolean;
  clearAlphaColor?: number;
  clearAlphaThreshold?: number;
  oneBitAlpha?: boolean | number;
}
interface WriteFrameOpts {
  transparent?: boolean;
  transparentIndex?: number;
  delay?: number; // milliseconds (gifenc rounds to centiseconds internally)
  palette?: Palette | null;
  repeat?: number; // -1 = play once, 0 = loop forever, >0 = loop count
  colorDepth?: number;
  dispose?: number;
}
interface GifEncoderInstance {
  writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOpts): void;
  finish(): void;
  bytes(): Uint8Array;
}
interface Gifenc {
  GIFEncoder(opts?: { initialCapacity?: number; auto?: boolean }): GifEncoderInstance;
  quantize(rgba: Uint8Array, maxColors: number, opts?: QuantizeOpts): Palette;
  applyPalette(rgba: Uint8Array, palette: Palette, format?: PixelFormat): Uint8Array;
}

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc') as Gifenc;

/** Background that composited-over-bg SSIM uses, so 1-bit alpha edges are scored fairly. */
const SSIM_BG: readonly [number, number, number] = [128, 128, 128];
/** Cap the pixels fed to the global-palette quantizer (subsample large clips). */
const SAMPLE_PIXEL_CAP = 1_500_000;
/** Power-of-two palette sizes a GIF color table can actually take. */
const PALETTE_STEPS = [2, 4, 8, 16, 32, 64, 128, 256];

export type GifFit = 'cover' | 'contain' | 'fill';

export interface GifEncodeOptions {
  /** Per-frame display time in milliseconds (length must equal the frame count). */
  delaysMs: number[];
  /** 0 = loop forever (default), -1 = play once, >0 = loop count. */
  loop?: number;
  /** Palette ceiling (2–256). With `optimize`, this caps the knee sweep; without, it's the fixed size. */
  maxColors?: number;
  /** Run the quality/size knee search across palette sizes (default true). */
  optimize?: boolean;
  /** Canvas width; defaults to the first frame's width. */
  width?: number;
  /** Canvas height; defaults to the first frame's height. */
  height?: number;
  /** How non-matching frames are fitted to the canvas (default 'cover'). */
  fit?: GifFit;
  /** Source alpha below this (0–255) becomes fully transparent in the GIF (default 128). */
  alphaThreshold?: number;
}

export interface GifCandidate {
  colors: number;
  bytes: number;
  ssim: number;
}

export interface GifEncodeResult {
  bytes: Buffer;
  width: number;
  height: number;
  frameCount: number;
  /** Realized palette size of the chosen encoding. */
  colors: number;
  optimized: boolean;
  /** Per-candidate (colors, bytes, ssim) when optimized, for reporting. */
  candidates?: GifCandidate[];
  delaysMs: number[];
  loop: number;
  hasTransparency: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The GIF canvas size: explicit `width`/`height`, else the first frame's. When only one
 * dimension is given the other follows the first frame's aspect (0 when it is unknown).
 */
function canvasSize(opt: GifEncodeOptions, baseW: number, baseH: number): { width: number; height: number } {
  const aspectKnown = baseW > 0 && baseH > 0;
  if (opt.width != null && opt.height == null && aspectKnown) return { width: opt.width, height: Math.max(1, Math.round((opt.width * baseH) / baseW)) };
  if (opt.height != null && opt.width == null && aspectKnown) return { width: Math.max(1, Math.round((opt.height * baseW) / baseH)), height: opt.height };
  return { width: opt.width ?? baseW, height: opt.height ?? baseH };
}

async function resolveCanvas(first: Buffer, opt: GifEncodeOptions): Promise<{ width: number; height: number }> {
  const meta = await sharp(first).metadata();
  const size = canvasSize(opt, meta.width ?? 0, meta.height ?? 0);
  if (!size.width || !size.height) throw new Error('Could not determine the GIF canvas size from the first frame.');
  return size;
}

/**
 * Binarize alpha in place (GIF has no partial transparency): ≥ `threshold` → opaque, else clear.
 * Returns whether any pixel became transparent.
 */
function binarizeAlpha(rgba: Uint8Array, threshold: number): boolean {
  let anyClear = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i]! >= threshold) {
      rgba[i] = 255;
    } else {
      rgba[i] = 0;
      anyClear = true;
    }
  }
  return anyClear;
}

/**
 * Decode every input to RGBA at a common canvas size. Alpha is binarized to 1 bit
 * (GIF has no partial transparency). Each frame is returned as a FRESH, exact-length
 * `Uint8Array` (offset 0, byteLength === 4·w·h) because gifenc reads `rgba.buffer`
 * ignoring byteOffset — a sharp pooled buffer view would corrupt quantization.
 */
async function normalizeFrames(
  inputs: Buffer[],
  opt: GifEncodeOptions,
): Promise<{ width: number; height: number; frames: Uint8Array[]; anyAlpha: boolean }> {
  const { width, height } = await resolveCanvas(inputs[0]!, opt);
  const fit = opt.fit ?? 'cover';
  const threshold = opt.alphaThreshold ?? 128;
  const frames: Uint8Array[] = [];
  let anyAlpha = false;

  for (const input of inputs) {
    const { data, info } = await sharp(input)
      .resize(width, height, { fit, kernel: 'mks2021', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error(`Expected RGBA frame (4 channels), got ${info.channels}.`);
    const rgba = new Uint8Array(data); // copy → fresh ArrayBuffer, offset 0, exact length
    if (binarizeAlpha(rgba, threshold)) anyAlpha = true;
    frames.push(rgba);
  }
  return { width, height, frames, anyAlpha };
}

/** Build one exact-backed RGBA buffer sampled across all frames, for global-palette quantization. */
function buildSample(frames: Uint8Array[]): Uint8Array {
  const totalPx = frames.reduce((n, f) => n + f.length, 0) / 4;
  if (totalPx <= SAMPLE_PIXEL_CAP) {
    const out = new Uint8Array(totalPx * 4);
    let o = 0;
    for (const f of frames) {
      out.set(f, o);
      o += f.length;
    }
    return out;
  }
  const stride = Math.ceil(totalPx / SAMPLE_PIXEL_CAP);
  const keep = Math.ceil(totalPx / stride);
  const out = new Uint8Array(keep * 4);
  let o = 0;
  let px = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4, px++) {
      if (px % stride === 0 && o + 4 <= out.length) {
        out[o] = f[i]!;
        out[o + 1] = f[i + 1]!;
        out[o + 2] = f[i + 2]!;
        out[o + 3] = f[i + 3]!;
        o += 4;
      }
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

/** Luma of an RGBA buffer composited over `bg` (Rec.601). */
function lumaOverBg(rgba: Uint8Array, bg: readonly [number, number, number]): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (rgba[i * 4 + 3] ?? 255) / 255;
    const r = (rgba[i * 4] ?? 0) * a + bg[0] * (1 - a);
    const g = (rgba[i * 4 + 1] ?? 0) * a + bg[1] * (1 - a);
    const b = (rgba[i * 4 + 2] ?? 0) * a + bg[2] * (1 - a);
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/** Luma of palette-indexed pixels composited over `bg` (decode-free; LZW is lossless). */
function indexedLumaOverBg(index: Uint8Array, palette: Palette, hasAlpha: boolean, bg: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(index.length);
  for (let i = 0; i < index.length; i++) {
    const p = palette[index[i]!] ?? [0, 0, 0, 255];
    const a = (hasAlpha ? (p[3] ?? 255) : 255) / 255;
    const r = (p[0] ?? 0) * a + bg[0] * (1 - a);
    const g = (p[1] ?? 0) * a + bg[1] * (1 - a);
    const b = (p[2] ?? 0) * a + bg[2] * (1 - a);
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

interface Variant {
  colors: number;
  bytes: number;
  ssim: number;
  buf: Buffer;
}

/** Quantize a global palette at `colors`, encode all frames against it, and score SSIM. */
function buildVariant(
  colors: number,
  ctx: { sample: Uint8Array; frames: Uint8Array[]; width: number; height: number; format: PixelFormat; anyAlpha: boolean; alphaThreshold: number; delaysMs: number[]; loop: number; sourceLuma: Float32Array[] | null },
): Variant {
  const palette = quantize(ctx.sample, colors, {
    format: ctx.format,
    clearAlpha: true,
    oneBitAlpha: ctx.anyAlpha ? ctx.alphaThreshold : false,
  });

  let transparent = false;
  let transparentIndex = 0;
  if (ctx.anyAlpha) {
    const ti = palette.findIndex((p) => (p[3] ?? 255) === 0);
    if (ti >= 0) {
      transparent = true;
      transparentIndex = ti;
    }
  }

  const gif = GIFEncoder();
  let ssimSum = 0;
  ctx.frames.forEach((f, i) => {
    const index = applyPalette(f, palette, ctx.format);
    gif.writeFrame(index, ctx.width, ctx.height, {
      ...(i === 0 ? { palette, repeat: ctx.loop } : {}),
      transparent,
      transparentIndex,
      delay: ctx.delaysMs[i] ?? ctx.delaysMs[ctx.delaysMs.length - 1] ?? 100,
    });
    if (ctx.sourceLuma) {
      const q = indexedLumaOverBg(index, palette, ctx.anyAlpha, SSIM_BG);
      ssimSum += ssimLuma(ctx.sourceLuma[i]!, q, ctx.width, ctx.height);
    }
  });
  gif.finish();
  const buf = Buffer.from(gif.bytes());
  return { colors: palette.length, bytes: buf.length, ssim: ctx.frames.length ? ssimSum / ctx.frames.length : 1, buf };
}

/**
 * Knee of the (bytes, SSIM) curve: the candidate with the greatest gain above the
 * chord joining the smallest and largest encodings (normalized). Picks the elbow
 * where extra bytes stop buying much quality; degrades to "smallest" when quality
 * is flat and to "best quality" when it never plateaus.
 */
function pickKnee(points: Variant[]): Variant {
  if (points.length <= 1) return points[0]!;
  const sorted = [...points].sort((a, b) => a.bytes - b.bytes);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const xr = last.bytes - first.bytes || 1;
  const yr = last.ssim - first.ssim;
  if (yr <= 0) {
    // Quality didn't improve with size — take the highest-SSIM (cheapest on ties).
    return sorted.reduce((best, p) => (p.ssim > best.ssim ? p : best), sorted[0]!);
  }
  let best = sorted[0]!;
  let bestDist = -Infinity;
  for (const p of sorted) {
    const nx = (p.bytes - first.bytes) / xr;
    const ny = (p.ssim - first.ssim) / yr;
    const dist = ny - nx; // perpendicular gain above the chord (∝ ny − nx)
    if (dist > bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/** Palette sizes the knee search tries: the power-of-two steps up to `maxColors`, plus `maxColors` itself. */
function paletteSizes(maxColors: number): number[] {
  const sizes = PALETTE_STEPS.filter((s) => s <= maxColors);
  if (!sizes.includes(maxColors)) sizes.push(maxColors);
  return sizes.sort((a, b) => a - b);
}

/**
 * gifenc collapses the palette to the image's true color count, so several sizes
 * can yield an identical encoding — dedupe by byte length to keep the knee honest.
 */
function dedupeByBytes(variants: Variant[]): Variant[] {
  const seen = new Set<number>();
  return variants.filter((v) => (seen.has(v.bytes) ? false : (seen.add(v.bytes), true)));
}

/** Assemble an animated GIF from ordered frame buffers. See {@link GifEncodeOptions}. */
export async function encodeGif(inputs: Buffer[], options: GifEncodeOptions): Promise<GifEncodeResult> {
  if (inputs.length < 1) throw new Error('encodeGif requires at least one frame.');
  if (options.delaysMs.length !== inputs.length) {
    throw new Error(`delaysMs length (${options.delaysMs.length}) must equal the number of frames (${inputs.length}).`);
  }
  const loop = options.loop ?? 0;
  const maxColors = clamp(Math.round(options.maxColors ?? 256), 2, 256);
  const optimize = options.optimize ?? true;
  const alphaThreshold = options.alphaThreshold ?? 128;

  const { width, height, frames, anyAlpha } = await normalizeFrames(inputs, options);
  const format: PixelFormat = anyAlpha ? 'rgba4444' : 'rgb565';
  const sample = buildSample(frames);
  const sourceLuma = optimize ? frames.map((f) => lumaOverBg(f, SSIM_BG)) : null;

  const ctx = { sample, frames, width, height, format, anyAlpha, alphaThreshold, delaysMs: options.delaysMs, loop, sourceLuma };
  const base = { width, height, frameCount: frames.length, delaysMs: options.delaysMs, loop, hasTransparency: anyAlpha };

  if (!optimize) {
    const v = buildVariant(maxColors, ctx);
    return { ...base, bytes: v.buf, colors: v.colors, optimized: false };
  }

  const distinct = dedupeByBytes(paletteSizes(maxColors).map((c) => buildVariant(c, ctx)));
  const chosen = pickKnee(distinct);
  return {
    ...base,
    bytes: chosen.buf,
    colors: chosen.colors,
    optimized: true,
    candidates: distinct.map((v) => ({ colors: v.colors, bytes: v.bytes, ssim: Number(v.ssim.toFixed(4)) })),
  };
}

/** Convert a frames-per-second value to a per-frame delay in ms (≥10 ms; GIF granularity is 10 ms). */
export function msFromFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 100;
  return Math.max(10, Math.round(1000 / fps));
}
