/**
 * ICO (.ico) encoding built on `@fiahfy/ico` — a zero-native-dep ICO parser +
 * builder (it embeds a pure-JS pngjs). We use it to output Windows icons that
 * are readable on Windows 98 → XP → Vista → 11, Linux and macOS: `@fiahfy/ico`
 * encodes every entry as a classic 32-bpp BMP/DIB + AND mask (the most
 * broadly-compatible format), exactly as a hand-rolled encoder would, so we get
 * full control over size sets without importing a vendor SDK.
 *
 * READING is our own `parseIco` (below): `@fiahfy/ico`'s parser only understands
 * 32-bpp DIB entries, so a typical Vista+ favicon (a PNG-compressed 256px entry,
 * plus 8-bpp/24-bpp small sizes) used to parse as garbage. Every entry is decoded
 * to RGBA; merged entries are re-encoded through the same 32-bpp writer.
 *
 * The caller owns the high-level policy (which sizes are allowed, dedup, merge,
 * generation-resolution selection, downscale-with-sharpen); this module is the
 * format + geometry primitives.
 */
import sharp from 'sharp';
import { Ico, IcoImage } from '@fiahfy/ico';
import { parseHexColor, toHex } from './palette.js';
import { isIcoSignature } from '../util/mime.js';

/** Conventional square icon dimensions we accept/emit. */
export const ICO_ALLOWED_SIZES = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256] as const;
export type IcoSize = (typeof ICO_ALLOWED_SIZES)[number];
export const ICO_MIME = 'image/x-icon';

// `IcoImage.fromPNG` validates the source width against this shared allowlist;
// widen it to our full set. (The property is `static readonly` on the array
// *reference*, but the array itself is mutable — splice, don't reassign.)
Ico.supportedIconSizes.splice(0, Ico.supportedIconSizes.length, ...ICO_ALLOWED_SIZES);

export function isAllowedIcoSize(size: number): size is IcoSize {
  return (ICO_ALLOWED_SIZES as readonly number[]).includes(size);
}

/** Build a single- or multi-entry ICO buffer from already-validated entries. */
export function buildIco(images: IcoImage[]): Buffer {
  const ico = new Ico();
  for (const img of images) ico.append(img);
  return ico.data;
}

/** Wrap a square PNG of an allowed size as a single ICO entry (throws if invalid). */
export function icoImageFromPng(png: Buffer): IcoImage {
  return IcoImage.fromPNG(png);
}

/**
 * One decoded ICO entry: its pixel size, where it came from, and top-down RGBA.
 * Produced by our own `parseIco` — not the one in `@fiahfy/ico`, which only
 * understands 32-bpp DIB entries and misreads the PNG-compressed 256px entries
 * that most Vista+ favicons carry.
 */
export interface IcoEntry {
  width: number;
  height: number;
  /** `png` = a PNG-compressed entry; `dib` = a classic BITMAPINFOHEADER bitmap. */
  encoding: 'png' | 'dib';
  /** Bits per pixel of the source entry (32 for PNG entries). */
  bitCount: number;
  /** Top-down RGBA, `width * height * 4` bytes. */
  rgba: Buffer;
}

/** Largest entry dimension we decode — real icons stop at 256 (PNG entries rarely exceed 1024). */
const ICO_MAX_ENTRY_PX = 4096;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parse an ICO into decoded entries (directory order). Handles PNG-compressed entries
 * (decoded with sharp), classic DIB entries at 1/4/8 bpp (paletted), 16, 24 and 32 bpp,
 * the AND transparency mask, and legacy 32-bpp entries whose alpha channel is all zero
 * (alpha then comes from the AND mask). Truncated or out-of-range entries throw a clear
 * error before any large allocation.
 */
export async function parseIco(bytes: Buffer): Promise<IcoEntry[]> {
  if (!isIcoSignature(bytes)) throw new Error('not an ICO file (bad header).');
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + 16 * count) throw new Error(`ICO directory is truncated (${count} entries declared).`);
  const entries: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const d = 6 + 16 * i;
    const dirW = bytes[d]! || 256;
    const dirH = bytes[d + 1]! || 256;
    const size = bytes.readUInt32LE(d + 8);
    const offset = bytes.readUInt32LE(d + 12);
    if (size === 0 || offset + size > bytes.length) {
      throw new Error(`ICO entry ${i + 1} is truncated (needs bytes ${offset}..${offset + size}, the file has ${bytes.length}).`);
    }
    const data = bytes.subarray(offset, offset + size);
    entries.push(data.subarray(0, 8).equals(PNG_SIG) ? await decodePngEntry(data, i) : decodeDibEntry(data, i, dirW, dirH));
  }
  return entries;
}

async function decodePngEntry(data: Buffer, i: number): Promise<IcoEntry> {
  try {
    const { data: rgba, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width > ICO_MAX_ENTRY_PX || info.height > ICO_MAX_ENTRY_PX) throw new Error(`${info.width}x${info.height} exceeds ${ICO_MAX_ENTRY_PX}px`);
    return { width: info.width, height: info.height, encoding: 'png', bitCount: 32, rgba: Buffer.from(rgba) };
  } catch (err) {
    throw new Error(`ICO entry ${i + 1}: PNG data could not be decoded (${(err as Error).message}).`);
  }
}

/** Fields of a BITMAPINFOHEADER that decoding needs (height is the ICON height, not the doubled DIB height). */
interface DibHeader {
  where: string;
  hdrSize: number;
  width: number;
  height: number;
  topDown: boolean;
  bpp: number;
  compression: number;
  clrUsed: number;
}

/** Where each region of a DIB entry lives (all offsets/strides in bytes from the start of the entry). */
interface DibLayout {
  paletteAt: number;
  xorAt: number;
  xorStride: number;
  andAt: number;
  andStride: number;
  hasMask: boolean;
}

function parseDibHeader(data: Buffer, i: number, dirW: number, dirH: number): DibHeader {
  const where = `ICO entry ${i + 1}`;
  if (data.length < 40) throw new Error(`${where} is truncated (bitmap header).`);
  const hdrSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const dibHeight = data.readInt32LE(8);
  // The DIB height covers the XOR image AND the mask, so it is twice the icon height.
  const half = Math.abs(dibHeight) / 2;
  const height = half >= 1 && Number.isInteger(half) ? half : dirH;
  if (hdrSize < 40 || width < 1 || width > ICO_MAX_ENTRY_PX || height > ICO_MAX_ENTRY_PX) {
    throw new Error(`${where} has an implausible bitmap header (${width}x${height}, header ${hdrSize} bytes; the directory says ${dirW}x${dirH}).`);
  }
  return { where, hdrSize, width, height, topDown: dibHeight < 0, bpp: data.readUInt16LE(14), compression: data.readUInt32LE(16), clrUsed: data.readUInt32LE(32) };
}

function assertSupportedDib({ where, bpp, compression }: DibHeader): void {
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new Error(`${where} uses an unsupported ${bpp}-bpp bitmap.`);
  // BI_RGB, or BI_BITFIELDS with the standard masks (all that icons use in practice).
  if (compression !== 0 && !(compression === 3 && (bpp === 16 || bpp === 32))) {
    throw new Error(`${where} uses unsupported bitmap compression ${compression}.`);
  }
}

function dibLayout(h: DibHeader, dataLength: number): DibLayout {
  const paletteCount = h.bpp <= 8 ? h.clrUsed || 1 << h.bpp : 0;
  const paletteAt = h.hdrSize + (h.compression === 3 && h.hdrSize === 40 ? 12 : 0);
  const xorStride = ((h.width * h.bpp + 31) >> 5) << 2;
  const andStride = ((h.width + 31) >> 5) << 2;
  const xorAt = paletteAt + paletteCount * 4;
  const andAt = xorAt + xorStride * h.height;
  if (dataLength < andAt) throw new Error(`${h.where} is truncated (pixel data).`);
  return { paletteAt, xorAt, xorStride, andAt, andStride, hasMask: dataLength >= andAt + andStride * h.height };
}

/** Writes pixel `x` of the XOR row starting at byte `row` into `rgba[o..o+3]` (opaque unless the format carries alpha). */
type DibPixelReader = (rgba: Buffer, o: number, row: number, x: number) => void;

function dibPixelReader(data: Buffer, bpp: number, paletteAt: number): DibPixelReader {
  if (bpp <= 8) {
    return (rgba, o, row, x) => {
      const bit = x * bpp;
      const idx = (data[row + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
      const p = paletteAt + idx * 4;
      rgba[o] = data[p + 2] ?? 0;
      rgba[o + 1] = data[p + 1] ?? 0;
      rgba[o + 2] = data[p] ?? 0;
      rgba[o + 3] = 255;
    };
  }
  if (bpp === 16) {
    return (rgba, o, row, x) => {
      const v = data.readUInt16LE(row + x * 2); // 5-5-5
      rgba[o] = Math.round((((v >> 10) & 31) * 255) / 31);
      rgba[o + 1] = Math.round((((v >> 5) & 31) * 255) / 31);
      rgba[o + 2] = Math.round(((v & 31) * 255) / 31);
      rgba[o + 3] = 255;
    };
  }
  const bytesPerPixel = bpp / 8;
  return (rgba, o, row, x) => {
    const p = row + x * bytesPerPixel;
    rgba[o] = data[p + 2]!;
    rgba[o + 1] = data[p + 1]!;
    rgba[o + 2] = data[p]!;
    rgba[o + 3] = bpp === 32 ? data[p + 3]! : 255;
  };
}

/** Byte offset of image row `y` (top-down output order) in a region whose first stored row is at `base`. */
function dibRowAt(base: number, stride: number, y: number, height: number, topDown: boolean): number {
  return base + (topDown ? y : height - 1 - y) * stride;
}

function hasAnyAlpha(rgba: Buffer): boolean {
  for (let o = 3; o < rgba.length; o += 4) if (rgba[o] !== 0) return true;
  return false;
}

/** Overwrite alpha from the 1-bpp AND mask (set bit = transparent). */
function applyAndMask(rgba: Buffer, data: Buffer, h: DibHeader, l: DibLayout): void {
  for (let y = 0; y < h.height; y++) {
    const row = dibRowAt(l.andAt, l.andStride, y, h.height, h.topDown);
    for (let x = 0; x < h.width; x++) {
      const transparent = (data[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
      rgba[(y * h.width + x) * 4 + 3] = transparent ? 0 : 255;
    }
  }
}

function decodeDibEntry(data: Buffer, i: number, dirW: number, dirH: number): IcoEntry {
  const h = parseDibHeader(data, i, dirW, dirH);
  assertSupportedDib(h);
  const l = dibLayout(h, data.length);
  const readPixel = dibPixelReader(data, h.bpp, l.paletteAt);

  const rgba = Buffer.alloc(h.width * h.height * 4);
  for (let y = 0; y < h.height; y++) {
    const row = dibRowAt(l.xorAt, l.xorStride, y, h.height, h.topDown);
    for (let x = 0; x < h.width; x++) readPixel(rgba, (y * h.width + x) * 4, row, x);
  }
  // The AND mask is the transparency for everything below 32 bpp — and for legacy 32-bpp
  // entries whose alpha channel was left all zero (they would otherwise be invisible).
  if (l.hasMask && (h.bpp !== 32 || !hasAnyAlpha(rgba))) applyAndMask(rgba, data, h, l);
  return { width: h.width, height: h.height, encoding: 'dib', bitCount: h.bpp, rgba };
}

/** The square dimension (px) a parsed ICO entry holds. */
export function icoImageSize(entry: IcoEntry): number {
  return entry.width;
}

/** True when bytes are an ICO file (`00 00 01 00` + a plausible first directory entry; see `mime.ts`). */
export function isIcoBytes(bytes: Buffer): boolean {
  return isIcoSignature(bytes);
}

/** A decoded entry's top-down RGBA (for previews, unpacking and re-encoding). */
export function icoEntryToRgba(entry: IcoEntry): { width: number; height: number; data: Buffer } {
  return { width: entry.width, height: entry.height, data: entry.rgba };
}

/** Render one ICO entry to a PNG buffer (for previews). */
export async function icoEntryToPng(entry: IcoEntry): Promise<Buffer> {
  return sharp(entry.rgba, { raw: { width: entry.width, height: entry.height, channels: 4 } }).png().toBuffer();
}

/**
 * Re-encode a decoded entry as a classic 32-bpp BMP/DIB icon image (the broadly-compatible
 * form every icon we WRITE uses), for merging an existing ICO's entries into a new one.
 */
export async function icoImageFromEntry(entry: IcoEntry): Promise<IcoImage> {
  return icoImageFromPng(await icoEntryToPng(entry));
}

/** Parse the largest-size entry of an ICO buffer to a PNG (for the inline preview). */
export async function icoLargestToPng(bytes: Buffer): Promise<Buffer> {
  const entries = await parseIco(bytes);
  if (entries.length === 0) throw new Error('ICO contains no images.');
  const largest = entries.reduce((a, b) => (icoImageSize(b) > icoImageSize(a) ? b : a));
  return icoEntryToPng(largest);
}

/** How a non-square source is made square: keep everything, or center-crop. */
export type SquareFit = 'pad' | 'crop';

export interface SquareFitResult {
  /** The square PNG at exactly `size` x `size`. */
  bytes: Buffer;
  /** What was actually done — `none` when the source was already square. */
  applied: 'none' | 'pad' | 'crop';
  sourceWidth: number;
  sourceHeight: number;
  /**
   * Human-readable description of the pad-vs-crop decision (empty when the
   * source was already square, i.e. there was no decision to make). Callers
   * surface this so squaring is never silent.
   */
  note: string;
}

/** Pad colour: `transparent` (default) or any hex; sharp wants an RGBA object. */
function padBackground(spec?: string): { r: number; g: number; b: number; alpha: number } {
  if (!spec || /^transparent$/i.test(spec.trim())) return { r: 0, g: 0, b: 0, alpha: 0 };
  const { r, g, b } = parseHexColor(spec);
  return { r, g, b, alpha: 1 };
}

/**
 * Fit an arbitrary image to a square `size`.
 *
 * `fit:'pad'` (DEFAULT) letterboxes the whole image onto a square canvas — the
 * complete subject survives, which is what "make this an icon" almost always
 * means; an off-centre subject in a wide render used to be silently sliced off
 * by the old center-crop. `fit:'crop'` restores the center-crop when the caller
 * explicitly wants edge-to-edge coverage. Either way the decision is reported
 * back in `note`, and we never upscale (throws when the source is too small).
 */
export async function fitSquare(
  bytes: Buffer,
  mimeType: string,
  size: number,
  opts: { fit?: SquareFit; background?: string } = {},
): Promise<SquareFitResult> {
  if (!isAllowedIcoSize(size)) {
    throw new Error(`ICO size ${size} is not allowed; allowed sizes: ${ICO_ALLOWED_SIZES.join(', ')}`);
  }
  return fitToSquare(bytes, size, opts);
}

/**
 * The same geometry as `fitSquare` WITHOUT the ICO size allowlist — for square
 * outputs that are not (or not yet) icon entries, e.g. the members of an icon
 * set that is emitted as plain images.
 */
export async function fitToSquare(bytes: Buffer, size: number, opts: { fit?: SquareFit; background?: string } = {}): Promise<SquareFitResult> {
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) throw new Error('could not read image dimensions.');

  // Already square — no pad/crop decision exists, just (maybe) downscale.
  if (w === h) return fitAlreadySquare(bytes, w, size);
  return (opts.fit ?? 'pad') === 'crop' ? fitByCrop(bytes, w, h, size) : fitByPad(bytes, w, h, size, opts.background);
}

/** Never upscale: `needed` is the source side that has to reach `size` for the chosen fit mode. */
function assertNotUpscaling(w: number, h: number, size: number, needed: number): void {
  if (needed < size) {
    throw new Error(`image is ${w}x${h}, smaller than the requested ${size}; cannot upscale (choose a smaller width).`);
  }
}

/** Downscale a square image buffer to `size` with a light sharpen (the shared icon resample). */
function downscaleSquare(input: Buffer, size: number): Promise<Buffer> {
  return sharp(input).resize({ width: size, height: size, fit: 'fill' }).sharpen({ sigma: 1 }).png().toBuffer();
}

async function fitAlreadySquare(bytes: Buffer, side: number, size: number): Promise<SquareFitResult> {
  assertNotUpscaling(side, side, size, side);
  const out = side === size ? await sharp(bytes).png().toBuffer() : await downscaleSquare(bytes, size);
  return { bytes: out, applied: 'none', sourceWidth: side, sourceHeight: side, note: '' };
}

async function fitByCrop(bytes: Buffer, w: number, h: number, size: number): Promise<SquareFitResult> {
  const s = Math.min(w, h);
  assertNotUpscaling(w, h, size, s);
  const longSide = Math.max(w, h);
  const droppedPct = Math.round(((longSide - s) / longSide) * 100);
  const square = await sharp(bytes)
    .extract({ left: Math.round((w - s) / 2), top: Math.round((h - s) / 2), width: s, height: s })
    .png()
    .toBuffer();
  const out = s === size ? square : await downscaleSquare(square, size);
  return {
    bytes: out,
    applied: 'crop',
    sourceWidth: w,
    sourceHeight: h,
    note:
      `source ${w}x${h} is not square — center-cropped to ${s}x${s}, dropping ${droppedPct}% of the ` +
      `${w > h ? 'width' : 'height'} (content outside the centre is lost). Use square_fit:"pad" to keep the whole image.`,
  };
}

/** pad: contain the whole image on a square canvas. Only the LONG side has to reach `size` (a 1280x720 source can still make a 256 icon without upscaling). */
async function fitByPad(bytes: Buffer, w: number, h: number, size: number, backgroundSpec?: string): Promise<SquareFitResult> {
  const longSide = Math.max(w, h);
  assertNotUpscaling(w, h, size, longSide);
  const background = padBackground(backgroundSpec);
  let pipeline = sharp(bytes).resize({ width: size, height: size, fit: 'contain', position: 'centre', background });
  if (longSide > size) pipeline = pipeline.sharpen({ sigma: 1 });
  const out = await pipeline.png().toBuffer();
  const bgDesc = background.alpha === 0 ? 'transparent padding' : `padding ${toHex(background)}`;
  return {
    bytes: out,
    applied: 'pad',
    sourceWidth: w,
    sourceHeight: h,
    note:
      `source ${w}x${h} is not square — the whole image was fitted onto a ${size}x${size} canvas with ${bgDesc}; ` +
      'no content was cropped. Use square_fit:"crop" to center-crop instead.',
  };
}

/**
 * Validate an image is square AND an allowed ICO size, and return that size.
 * Used by `transform_media` ico, which does NOT resize — inputs must already be
 * a usable (square, allowed) size, unlike `generate_image` (which downscales).
 */
export async function icoSizeOfSquare(bytes: Buffer): Promise<number> {
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) throw new Error('could not read image dimensions.');
  if (w !== h) throw new Error(`image must be square for an ICO (got ${w}x${h}).`);
  if (!isAllowedIcoSize(w)) {
    throw new Error(`image size ${w}px is not an allowed ICO size; allowed sizes: ${ICO_ALLOWED_SIZES.join(', ')}.`);
  }
  return w;
}

/** Parse a model resolution option value ('1K', '512x512', '1024') to a pixel count (null if unknown). */
export function resolutionPixels(value: string): number | null {
  const v = value.toLowerCase();
  if (/^\d+x\d+$/.test(v)) return Number(v.split('x')[0]);
  const k = /^(\d+)k$/.exec(v);
  if (k) return Number(k[1]) * 1024;
  if (/^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Choose a model resolution string whose pixel size is the smallest that is still
 * ≥ `targetPx` (so we always downscale, never upscale — the "closest allowed size
 * above it" rule). Falls back to the largest parseable size, then null (model
 * default) if nothing parses. `@fiahfy`/gateway resolution strings are per-model.
 */
export function pickGenerationResolution(values: string[], targetPx: number): string | null {
  const parsed = values.flatMap((value) => {
    const px = resolutionPixels(value);
    return px == null ? [] : [{ value, px }];
  });
  // Strict comparisons: on a tie the earlier option wins.
  const smallestAbove = firstBest(parsed.filter((o) => o.px >= targetPx), (a, b) => a.px < b.px);
  return (smallestAbove ?? firstBest(parsed, (a, b) => a.px > b.px))?.value ?? null;
}

/** The first item no later item beats (`better(candidate, current)` must be strict). */
function firstBest<T>(items: T[], better: (candidate: T, current: T) => boolean): T | undefined {
  return items.reduce<T | undefined>((current, candidate) => (current === undefined || better(candidate, current) ? candidate : current), undefined);
}
