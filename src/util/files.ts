import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

export function slugify(input: string, max = 40): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, max);
  return s || 'media';
}

/** Filesystem-safe timestamp like 2026-06-05_18-04-12. */
export function fileTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

export function extFromMime(mime: string, fallback = 'bin'): string {
  return MIME_EXT[mime.toLowerCase()] ?? fallback;
}

export interface SavedFile {
  path: string;
  filename: string;
  uri: string;
  bytes: number;
}

/** Write bytes to `dir` with a descriptive, unique filename. Returns path + file:// URI. */
export async function saveMedia(
  dir: string,
  bytes: Buffer,
  ext: string,
  label: string,
): Promise<SavedFile> {
  await mkdir(dir, { recursive: true });
  const filename = `${fileTimestamp()}_${slugify(label)}_${randomUUID().slice(0, 8)}.${ext}`;
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return { path, filename, uri: pathToFileURL(path).href, bytes: bytes.length };
}

/**
 * Make a string safe to use as a filename on Windows, macOS and Linux.
 * Replaces, with '-', the union of disallowed characters: the Windows set
 * (`< > : " / \ | ? *`) — a superset that also covers the `/` and `:` that
 * matter on macOS/Linux — plus ALL control characters (incl. NUL / DEL) and
 * internal whitespace. Leading/trailing whitespace and dots are trimmed first
 * (Windows rejects trailing dots/spaces; a leading dot would hide the file on
 * Unix), so a trailing space disappears while an invalid char like '?' becomes
 * a kept '-'. Falls back to 'file' if nothing usable remains.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/^[\s.]+|[\s.]+$/gu, '')
    .replace(/[<>:"/\\|?*\s\p{Cc}]/gu, '-');
  return cleaned || 'file';
}

/**
 * Save a downloaded copy into `dir`, named `z-download-<sanitized>` so it sorts
 * to the end of the folder listing. Invalid filename characters become '-'; if
 * the name is already taken, a numeric suffix (`-1`, `-2`, …) is appended.
 * `reserved` (lowercased filenames) guards against collisions between
 * concurrent saves in the same batch before the file is written.
 */
export async function saveDownloadCopy(
  dir: string,
  bytes: Buffer,
  suggestedName: string,
  reserved: Set<string> = new Set(),
): Promise<SavedFile> {
  await mkdir(dir, { recursive: true });
  const dot = suggestedName.lastIndexOf('.');
  const base = sanitizeFilename(dot > 0 ? suggestedName.slice(0, dot) : suggestedName);
  const ext = dot > 0 ? sanitizeFilename(suggestedName.slice(dot + 1)) : '';
  const suffix = ext ? `.${ext}` : '';
  let filename = `z-download-${base}${suffix}`;
  for (let n = 1; reserved.has(filename.toLowerCase()) || existsSync(join(dir, filename)); n++) {
    filename = `z-download-${base}-${n}${suffix}`;
  }
  reserved.add(filename.toLowerCase()); // reserve synchronously (no await before this) so concurrent saves can't pick it
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return { path, filename, uri: pathToFileURL(path).href, bytes: bytes.length };
}

/** A shared, unique filename stem (no extension) for grouping related outputs. */
export function mediaStem(label: string): string {
  return `${fileTimestamp()}_${slugify(label)}_${randomUUID().slice(0, 8)}`;
}

/** Write bytes to an explicit filename in `dir`. */
export async function writeMediaFile(dir: string, filename: string, bytes: Buffer): Promise<SavedFile> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return { path, filename, uri: pathToFileURL(path).href, bytes: bytes.length };
}

/** Ensure bytes are PNG (convert via sharp if they aren't already). */
export async function ensurePng(bytes: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType.toLowerCase() === 'image/png') return bytes;
  return sharp(bytes).png().toBuffer();
}

export interface DecodedDataUrl {
  bytes: Buffer;
  mimeType: string;
}

/** Parse a `data:[mime][;base64],payload` URL. Returns null if not a data URL. */
export function parseDataUrl(url: string): DecodedDataUrl | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  const mimeType = m[1] || 'application/octet-stream';
  const isBase64 = Boolean(m[2]);
  const payload = m[3] ?? '';
  const bytes = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { bytes, mimeType };
}

export interface ImagePreview {
  data: string; // base64, no data: prefix
  mimeType: string;
}

/**
 * Produce a base64 preview suitable for inlining in an MCP `image` content block.
 * If the original is already under `maxBytes`, returns it untouched; otherwise
 * downscales/recompresses to JPEG until it fits (or returns null if it can't).
 */
export async function makeImagePreview(
  bytes: Buffer,
  mimeType: string,
  maxBytes: number,
): Promise<ImagePreview | null> {
  if (bytes.length <= maxBytes) {
    return { data: bytes.toString('base64'), mimeType };
  }
  try {
    let width = 1024;
    let quality = 80;
    let out = await sharp(bytes).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    while (out.length > maxBytes && quality > 30) {
      quality -= 15;
      out = await sharp(bytes).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    }
    while (out.length > maxBytes && width > 256) {
      width = Math.floor(width * 0.75);
      out = await sharp(bytes).resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    }
    if (out.length > maxBytes) return null;
    return { data: out.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Image mime from magic bytes for provider output that omits it (implemented in `mime.ts`). */
export { sniffImageMime } from './mime.js';

/** Basic facts about an image file, for reporting (never throws — null when undecodable). */
export interface ImageInfo {
  width: number;
  height: number;
  /** sharp's format id (png, jpeg, webp, avif, gif, …). */
  format: string;
  hasAlpha: boolean;
}
export async function imageInfo(bytes: Buffer): Promise<ImageInfo | null> {
  try {
    const m = await sharp(bytes).metadata();
    if (!m.width || !m.height) return null;
    return { width: m.width, height: m.height, format: m.format ?? 'unknown', hasAlpha: m.hasAlpha ?? false };
  } catch {
    return null;
  }
}

/** Human-readable byte count ("862 KB", "1.8 MB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * One-line description of an image for tool results: type + pixel size + bytes,
 * e.g. `image/png 1536×1024 (862 KB)`. Falls back to the mime + bytes when the
 * pixels can't be read (e.g. an ICO container, which sharp can't decode).
 */
export async function describeImage(bytes: Buffer, mimeType: string, info?: ImageInfo | null): Promise<string> {
  const i = info === undefined ? await imageInfo(bytes) : info;
  const dims = i ? ` ${i.width}×${i.height}${i.hasAlpha ? ' with alpha' : ''}` : '';
  return `${mimeType}${dims} (${formatBytes(bytes.length)})`;
}
