import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extFromMime, parseDataUrl, saveDownloadCopy } from './files.js';
import { detectImageMime, detectMedia, sniffImageMime } from './mime.js';
import type { ReferenceImage } from '../gateways/types.js';

/** Connection/download timeout for fetching a remote reference image. */
const REFERENCE_DOWNLOAD_TIMEOUT_MS = 15_000;

/** Whether an input is an http(s) URL (as opposed to a data: URL, path or base64). */
const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** Derive a filename for a downloaded reference from its URL + mime type. */
function downloadFilename(url: string, mimeType: string): string {
  let seg = '';
  try {
    seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    /* keep empty */
  }
  if (!seg) seg = 'image';
  if (!/\.[a-z0-9]+$/i.test(seg)) seg += `.${extFromMime(mimeType, 'png')}`;
  return seg;
}

export interface ResolvedImage {
  bytes?: Buffer;
  mimeType?: string;
  url?: string;
}

/**
 * Strict raw-base64 decode: only the base64 alphabet (whitespace — e.g. MIME line wraps — is
 * ignored) that round-trips cleanly. Null for anything else. Deciding by CONTENT matters because
 * `/` is a base64 character: nearly every real base64 image contains one, so "contains a slash →
 * it's a path" misread them as missing files.
 */
export function decodeRawBase64(s: string): Buffer | null {
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length === 0) return null;
  return bytes.toString('base64').replace(/=+$/, '') === compact.replace(/=+$/, '') ? bytes : null;
}

const LOOKS_LIKE_PATH = /[\\/]/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif)$/i;
/** A path-like string (separator or media extension) short enough to BE a path (Windows MAX_PATH is 260). */
const looksLikePath = (s: string, ext: RegExp): boolean => s.length < 1024 && (LOOKS_LIKE_PATH.test(s) || ext.test(s));

/** The bytes of a non-URL image input (data: URL, existing file, raw base64); throws a clear reason otherwise. */
async function localImageBytes(s: string): Promise<Buffer> {
  const dataUrl = parseDataUrl(s);
  if (dataUrl) return dataUrl.bytes;
  if (existsSync(s)) return readFile(s);
  const raw = decodeRawBase64(s);
  if (raw && (detectMedia(raw) || !looksLikePath(s, IMAGE_EXT_RE))) return raw;
  if (looksLikePath(s, IMAGE_EXT_RE)) throw new Error(`Could not resolve image input: local file not found: "${s.slice(0, 120)}"`);
  throw new Error(`Could not resolve image input (not a URL, data URL, existing file path, or base64): "${s.slice(0, 60)}…"`);
}

/**
 * Accept an image reference as a public URL, a `data:` URL, a local file path,
 * or raw base64, and resolve it to bytes (+ mime) or a passthrough URL. Local/inline
 * content must BE a still image (magic bytes): a video handed in as `image` used to be
 * sent to the provider labelled `image/png` and only failed after submission.
 */
export async function resolveImageInput(input: string): Promise<ResolvedImage> {
  const s = input.trim();
  if (isHttpUrl(s)) return { url: s };
  const bytes = await localImageBytes(s);
  const mimeType = detectImageMime(bytes);
  if (mimeType) return { bytes, mimeType };
  const detected = detectMedia(bytes);
  if (detected?.kind === 'video') {
    throw new Error(
      `The image input is a video (${detected.mime}), not a still image. Pass an image — to use a frame of this video, ` +
        'extract one first with transform_media (output_format:"png").',
    );
  }
  throw new Error(`The image input is not a recognized image (png, jpg, webp, gif, bmp, tiff, avif, heic): "${s.slice(0, 60)}…"`);
}

interface ResolveRefOpts {
  /** When set, a downloaded remote reference is also saved here as a `z-download-` copy. */
  downloadDir?: string;
  /** Shared reserved-filename set, so concurrent downloads don't collide. */
  reserved: Set<string>;
}

interface ResolvedRef {
  image: ReferenceImage;
  /** Local path of the saved copy, for remote downloads that were persisted. */
  downloadPath?: string;
}

const asReference = (bytes: Buffer, mimeType: string): ResolvedRef => ({ image: { bytes, mimeType, role: 'reference' } });

/** Download a remote reference (15s timeout); every failure mode gets a clear message. */
async function fetchReferenceBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REFERENCE_DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError') throw new Error(`download timed out after ${REFERENCE_DOWNLOAD_TIMEOUT_MS / 1000}s`);
    throw new Error(`could not download (${e.message})`);
  }
  if (!res.ok) throw new Error(`could not download (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('downloaded an empty file');
  return { bytes, contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
}

/** Remote URL — download a local copy and optionally persist it as a `z-download-` file. */
async function referenceFromUrl(url: string, opts: ResolveRefOpts): Promise<ResolvedRef> {
  const { bytes, contentType } = await fetchReferenceBytes(url);
  // Magic bytes are authoritative — never trust a (possibly lying) content-type
  // header to accept content the bytes don't actually identify as an image.
  const mimeType = detectImageMime(bytes);
  if (!mimeType) throw new Error(`downloaded content is not a recognized image${contentType ? ` (server sent content-type ${contentType})` : ''}`);
  // Carry bytes (our downloaded copy), not the URL, so the model is served the
  // copy we verified rather than a URL it might not reach. Persist it too.
  const resolved = asReference(bytes, mimeType);
  if (!opts.downloadDir) return resolved;
  const saved = await saveDownloadCopy(opts.downloadDir, bytes, downloadFilename(url, mimeType), opts.reserved);
  return { ...resolved, downloadPath: saved.path };
}

/** Local file — must exist, be readable, and be an image. */
async function referenceFromFile(path: string): Promise<ResolvedRef> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`cannot read local file (${(err as Error).message})`);
  }
  if (bytes.length === 0) throw new Error('local file is empty');
  const mimeType = detectImageMime(bytes);
  if (!mimeType) throw new Error('local file is not a recognized image');
  return asReference(bytes, mimeType);
}

/**
 * Resolve a single caller-supplied reference (http(s) URL, data: URL, local
 * file path, or raw base64) into in-memory image bytes. Fail-closed: remote
 * URLs are downloaded so the model never depends on a URL it might not reach,
 * local files must be readable, and the content must actually be an image.
 */
async function resolveReferenceImage(input: string, opts: ResolveRefOpts): Promise<ResolvedRef> {
  const s = input.trim();
  if (!s) throw new Error('empty reference');
  if (isHttpUrl(s)) return referenceFromUrl(s, opts);

  // data: URL — decode inline. The declared mime is ignored, exactly like a download's
  // content-type: only bytes that are provably an image pass.
  const dataUrl = parseDataUrl(s);
  if (dataUrl) {
    const mimeType = detectImageMime(dataUrl.bytes);
    if (!mimeType) throw new Error(`data URL is not a recognized image (declared ${dataUrl.mimeType})`);
    return asReference(dataUrl.bytes, mimeType);
  }

  if (existsSync(s)) return referenceFromFile(s);
  return referenceFromBase64(s);
}

/**
 * Raw base64 is decided by CONTENT (strict alphabet + round-trip + image magic bytes) BEFORE
 * the path heuristic — `/` is a base64 character, so real images contain it.
 */
function referenceFromBase64(s: string): ResolvedRef {
  const raw = decodeRawBase64(s);
  const rawMime = raw ? detectImageMime(raw) : null;
  if (raw && rawMime) return asReference(raw, rawMime);
  // Looks like a path but does not exist — say so rather than guessing base64.
  if (looksLikePath(s, IMAGE_EXT_RE)) throw new Error('local file not found');
  if (raw) throw new Error('base64 data is not a recognized image');
  throw new Error('not a URL, data URL, readable file path, or base64 image');
}

export interface ReferenceResolution {
  references: ReferenceImage[];
  /** Local paths of remote references that were downloaded + saved (`z-download-*`). */
  downloads: string[];
  /** Per-input failures (`"<input>": <reason>`); non-empty means refuse generation. */
  errors: string[];
}

/**
 * Resolve every caller-supplied reference image, collecting per-input errors so
 * the tool can refuse to generate unless ALL references resolved. Remote URLs
 * are downloaded; pass `downloadDir` to also persist each as a `z-download-` copy.
 */
export async function resolveReferenceImages(inputs: string[], opts: { downloadDir?: string } = {}): Promise<ReferenceResolution> {
  const references: ReferenceImage[] = [];
  const downloads: string[] = [];
  const errors: string[] = [];
  const reserved = new Set<string>();
  const refOpts: ResolveRefOpts = { reserved, ...(opts.downloadDir ? { downloadDir: opts.downloadDir } : {}) };
  const settled = await Promise.allSettled(inputs.map((i) => resolveReferenceImage(i, refOpts)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      references.push(r.value.image);
      if (r.value.downloadPath) downloads.push(r.value.downloadPath);
    } else {
      errors.push(`"${(inputs[i] ?? '').slice(0, 80)}": ${(r.reason as Error).message}`);
    }
  });
  return { references, downloads, errors };
}

/** A ReferenceImage rendered as a string a provider can consume (URL or data URL). */
export function referenceToUrl(r: Pick<ReferenceImage, 'url' | 'bytes' | 'mimeType'>): string {
  if (r.url) return r.url;
  if (r.bytes) return `data:${r.mimeType ?? 'image/png'};base64,${r.bytes.toString('base64')}`;
  throw new Error('Reference image has neither a URL nor bytes.');
}

/**
 * The filename part of an input without its extension (`C:\x\favicon.ico` → `favicon`,
 * `https://h/a/logo.png?s=2` → `logo`); '' for inline data (data: URLs, raw base64), where
 * each caller picks its own fallback name.
 */
export function inputStem(input: string): string {
  const s = input.trim();
  if (/^data:/i.test(s) || /^[A-Za-z0-9+/=]+$/.test(s)) return '';
  const tail = s.replace(/[?#].*$/, '').replace(/\\/g, '/').split('/').pop() ?? '';
  return tail.replace(/\.[^.]+$/, '');
}

export type MediaKind = 'image' | 'video';

export interface ResolvedMedia {
  kind: MediaKind;
  mimeType: string;
  bytes?: Buffer;
  /** A local file path, when the input was already a file (preferred for video/ffmpeg). */
  path?: string;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|ico)$/i;
const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' };
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif', ico: 'image/x-icon' };

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1]!.toLowerCase() : '';
}

/** Image or video by magic bytes; unknown bytes fall back to an image (sharp reports the real error). */
function sniffKind(bytes: Buffer): { kind: MediaKind; mimeType: string } {
  const d = detectMedia(bytes);
  if (d?.kind === 'video') return { kind: 'video', mimeType: d.mime };
  return { kind: 'image', mimeType: d?.kind === 'image' ? d.mime : sniffImageMime(bytes) };
}

/** Remote media: magic bytes first (an AVIF served as octet-stream, or a mislabelled header); the content-type only decides for bytes no signature matches. */
async function mediaFromUrl(url: string): Promise<ResolvedMedia> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (detectMedia(bytes)) return { ...sniffKind(bytes), bytes };
  const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (ct.startsWith('video/')) return { kind: 'video', mimeType: ct, bytes };
  if (ct.startsWith('image/')) return { kind: 'image', mimeType: ct, bytes };
  return { ...sniffKind(bytes), bytes };
}

/** A local file: the extension decides when it is a known one, else the leading bytes. */
async function mediaFromFile(path: string): Promise<ResolvedMedia> {
  const ext = extOf(path);
  if (VIDEO_EXT.test(path)) return { kind: 'video', mimeType: VIDEO_MIME[ext] ?? 'video/mp4', path };
  if (IMAGE_EXT.test(path)) return { kind: 'image', mimeType: IMAGE_MIME[ext] ?? 'image/png', path };
  return { ...sniffKind(await readFile(path)), path };
}

/** Resolve a crop/downsize input (URL, data URL, file path, or base64) into kind + bytes/path. */
export async function resolveMediaInput(input: string): Promise<ResolvedMedia> {
  const s = input.trim();
  if (isHttpUrl(s)) return mediaFromUrl(s);
  const dataUrl = parseDataUrl(s);
  if (dataUrl) {
    if (detectMedia(dataUrl.bytes)) return { ...sniffKind(dataUrl.bytes), bytes: dataUrl.bytes };
    const kind: MediaKind = dataUrl.mimeType.startsWith('video/') ? 'video' : 'image';
    return { kind, mimeType: dataUrl.mimeType, bytes: dataUrl.bytes };
  }
  if (existsSync(s)) return mediaFromFile(s);
  // Raw base64 only when it really is base64; unrecognized bytes are still passed on (sharp names
  // the real problem) unless the string reads as a path — then the file is simply missing.
  const raw = decodeRawBase64(s);
  if (raw && (detectMedia(raw) || !looksLikePath(s, MEDIA_EXT))) return { ...sniffKind(raw), bytes: raw };
  if (looksLikePath(s, MEDIA_EXT)) throw new Error(`Could not resolve media input: local file not found: "${s.slice(0, 120)}"`);
  throw new Error(`Could not resolve media input (not a URL, data URL, existing file path, or base64): "${s.slice(0, 60)}…"`);
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif|ico|mp4|m4v|mov|webm|mkv|avi)$/i;
