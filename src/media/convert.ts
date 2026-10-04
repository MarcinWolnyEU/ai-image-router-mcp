import sharp from 'sharp';
import { ensurePng } from '../util/files.js';
import { detectImageMime } from '../util/mime.js';
import { tinifyCompress, tinifyConvert } from './tinify.js';

export type ImageFormat = 'png' | 'jpg' | 'webp' | 'avif';

const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** MIME type for a target image format. */
export function formatMime(fmt: ImageFormat): string {
  return FORMAT_MIME[fmt];
}

/** Image MIME types Tinify accepts as input to /shrink. */
const TINIFY_INPUT_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

/** The output's magic bytes must match what we are about to report (else the sharp fallback runs). */
function assertProduced(out: Buffer, mimeType: string): void {
  const actual = detectImageMime(out);
  if (actual !== mimeType) throw new Error(`Tinify returned ${actual ?? 'unrecognized bytes'} instead of ${mimeType}`);
}

export interface ConvertedImage {
  bytes: Buffer;
  mimeType: string;
  ext: ImageFormat;
  /** True when the bytes were produced/optimised by Tinify (so callers can skip re-compressing). */
  tinified: boolean;
}

/**
 * Convert image bytes to `target`. Uses Tinify when a token is supplied (best
 * compression — the same path `generate_image`'s `output_format` uses), else
 * falls back to local sharp encoding so conversion still works without a key.
 * `sourceMime` lets the Tinify path normalise inputs Tinify can't ingest
 * (gif/bmp/tiff) to PNG first.
 */
export async function convertImage(bytes: Buffer, target: ImageFormat, opts: ConvertOpts = {}): Promise<ConvertedImage> {
  const mimeType = FORMAT_MIME[target];
  if (opts.tinifyToken) {
    try {
      return { bytes: await tinifyTo(bytes, target, opts.tinifyToken, opts), mimeType, ext: target, tinified: true };
    } catch (err) {
      // Tinify failed (bad/expired key, quota, network, or a wrong-format answer) — fall back to
      // local sharp rather than failing the conversion. Logged via the caller's logger (so it
      // lands in the log files); console.error (stderr, never stdout) only when no logger was
      // supplied (tests / standalone use).
      const message = `Tinify ${target} conversion failed; falling back to sharp`;
      if (opts.logger) opts.logger.warn(message, { error: (err as Error).message });
      else console.error(`[convertImage] ${message} (${(err as Error).message})`);
    }
  }
  return { bytes: await sharpTo(bytes, target), mimeType, ext: target, tinified: false };
}

interface ConvertOpts {
  tinifyToken?: string | null;
  sourceMime?: string;
  signal?: AbortSignal;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Tinify: compress (png) or convert (the rest); the answer's magic bytes must be the target's. */
async function tinifyTo(bytes: Buffer, target: ImageFormat, token: string, opts: ConvertOpts): Promise<Buffer> {
  const mimeType = FORMAT_MIME[target];
  const sourceMime = (detectImageMime(bytes) ?? opts.sourceMime ?? '').toLowerCase();
  let input = sourceMime && !TINIFY_INPUT_OK.has(sourceMime) ? await ensurePng(bytes, sourceMime) : bytes;
  // Tinify's compress is FORMAT-PRESERVING: a JPEG/WebP/AVIF source compressed "to png"
  // came back as the same JPEG/WebP/AVIF bytes under a .png name. Make it a PNG first.
  if (target === 'png' && detectImageMime(input) !== 'image/png') input = await sharp(input).png().toBuffer();
  const out = target === 'png' ? await tinifyCompress(token, input, opts.signal) : await tinifyConvert(token, input, mimeType, opts.signal);
  assertProduced(out, mimeType);
  return out;
}

/** Local sharp encode — the no-key (and Tinify-failure) path. */
function sharpTo(bytes: Buffer, target: ImageFormat): Promise<Buffer> {
  const img = sharp(bytes);
  if (target === 'jpg') return img.jpeg().toBuffer();
  if (target === 'avif') return img.avif().toBuffer();
  if (target === 'webp') return img.webp().toBuffer();
  return img.png().toBuffer();
}
