import { z } from 'zod';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { inputStem, resolveMediaInput, type ResolvedMedia } from '../util/inputs.js';
import { cropImage, downsizeImage, frameBlackFraction } from '../media/imageEdit.js';
import { cropVideo, downsizeVideo, extractFrame, ffmpegAvailable, ffprobeDuration, transcodeToMp4, withVideoFile, FFMPEG_MISSING_MESSAGE } from '../media/ffmpeg.js';
import { convertImage, type ImageFormat } from '../media/convert.js';
import { tinifyCompress } from '../media/tinify.js';
import { buildIco, icoEntryToRgba, icoImageFromEntry, icoImageFromPng, icoSizeOfSquare, isAllowedIcoSize, isIcoBytes, parseIco, ICO_ALLOWED_SIZES, ICO_MIME, type IcoEntry } from '../media/ico.js';
import { ensurePng, extFromMime, makeImagePreview, mediaStem, writeMediaFile, type SavedFile } from '../util/files.js';
import { describeError, errorResult, icoPreviewContent, renderMediaContent, renderIcoMediaContent, NOTHING_RETURNED_NOTE, OUTPUT_MODE_DESCRIPTION, type OutputMode, type ToolContent, type ToolResult } from './helpers.js';
import { ToolFailure, failuresAsErrorResult } from './toolFailure.js';
import type { IcoImage } from '@fiahfy/ico';

const VIDEO_FORMAT_RE = /^(mp4|webm|mov|m4v|mkv|avi)$/i;

function imageInputOf(media: ResolvedMedia): Buffer | string {
  return media.bytes ?? media.path!;
}

/**
 * Save image bytes and build the result per output_mode. Applies the Tinify-PNG
 * base64 rule: when returning a not-yet-compressed PNG as base64 with Tinify
 * enabled, the uncompressed file is kept as `<stem>-original.png`, compressed in
 * place, and the compressed bytes are returned.
 */
async function emitImage(
  bytes: Buffer,
  mimeType: string,
  label: string,
  o: { save: boolean; inline: boolean; outputMode: OutputMode; description: string; alreadyTinified?: boolean },
): Promise<ToolResult> {
  const dir = runtime.outputDir();
  const previewMaxBytes = runtime.config.output.previewMaxBytes;
  const lines: string[] = [`Output: ${mimeType}`];
  const content: ToolContent[] = [];

  if (!o.save) {
    if (o.inline) {
      const p = await makeImagePreview(bytes, mimeType, previewMaxBytes);
      if (p) content.push({ type: 'image', data: p.data, mimeType: p.mimeType });
    } else {
      lines.push(NOTHING_RETURNED_NOTE);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
  }

  const ext = extFromMime(mimeType, 'png');
  const stem = mediaStem(label);
  let saved = await writeMediaFile(dir, `${stem}.${ext}`, bytes);
  let finalBytes = bytes;

  if (mimeType === 'image/png' && o.outputMode === 'base64' && runtime.tinifyToken && !o.alreadyTinified) {
    try {
      const compressed = await tinifyCompress(runtime.tinifyToken, bytes);
      await rename(saved.path, join(dir, `${stem}-original.png`));
      saved = await writeMediaFile(dir, `${stem}.png`, compressed);
      finalBytes = compressed;
      lines.push(`(Tinify-compressed; uncompressed kept as ${stem}-original.png)`);
    } catch (err) {
      runtime.logger.warn('transform_media: Tinify PNG compression failed; returning uncompressed', { error: (err as Error).message });
    }
  }

  lines.unshift(saved.path);
  content.push(...(await renderMediaContent({ bytes: finalBytes, mimeType, saved, outputMode: o.outputMode, inline: o.inline, previewMaxBytes, description: o.description })));
  return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
}

/** Save raw video bytes (passthrough) and build the result per output_mode. */
async function emitVideoBytes(bytes: Buffer, mimeType: string, label: string, outputMode: OutputMode): Promise<ToolResult> {
  const dir = runtime.outputDir();
  const saved = await writeMediaFile(dir, `${mediaStem(label)}.${extFromMime(mimeType, 'mp4')}`, bytes);
  const content = await renderMediaContent({ bytes, mimeType, saved, outputMode, inline: false, previewMaxBytes: runtime.config.output.previewMaxBytes, description: label });
  return { content: [{ type: 'text', text: `${saved.path}\nOutput: ${mimeType} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)` }, ...content] };
}

/** Run an ffmpeg op that writes a re-encoded mp4 to a path; build the result per output_mode. */
async function videoResult(label: string, outputMode: OutputMode, op: (outPath: string) => Promise<void>): Promise<ToolResult> {
  if (!(await ffmpegAvailable())) return errorResult(FFMPEG_MISSING_MESSAGE);
  const dir = runtime.outputDir();
  await mkdir(dir, { recursive: true });
  const filename = `${mediaStem(label)}.mp4`;
  const outPath = join(dir, filename);
  await op(outPath);
  const size = (await stat(outPath)).size;
  const saved: SavedFile = { path: outPath, filename, uri: pathToFileURL(outPath).href, bytes: size };
  const lines = [outPath, `Output: video/mp4 (${(size / 1024 / 1024).toFixed(2)} MB)`];
  const content: ToolContent[] = [];
  if (outputMode === 'base64') {
    content.push(...(await renderMediaContent({ bytes: await readFile(outPath), mimeType: 'video/mp4', saved, outputMode, inline: false, previewMaxBytes: runtime.config.output.previewMaxBytes, description: `${label} (video)` })));
  } else {
    content.push({ type: 'resource_link', uri: saved.uri, name: filename, mimeType: 'video/mp4', description: `${label} (video)` });
  }
  return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
}

/**
 * Pick a representative still: start at 10% of the duration, stepping forward in
 * 5% increments up to 95% (18 tries), returning the first frame that is not
 * mostly black (≥90% of pixels below luma 32). Falls back to the 10% frame.
 */
async function pickRepresentativeFrame(input: ResolvedMedia, signal?: AbortSignal): Promise<Buffer> {
  // One temp copy of a byte-only video for the whole search (ffprobe + up to 18 extractions);
  // each primitive used to write — and delete — its own copy of the full video.
  return withVideoFile(input, async (media) => {
    const duration = await ffprobeDuration(media, signal);
    const tmp = await mkdtemp(join(tmpdir(), 'air-frame-'));
    try {
      let firstFrame: Buffer | null = null;
      for (let i = 0, frac = 0.1; i < 18 && frac <= 0.951; i++, frac += 0.05) {
        const framePath = join(tmp, `f${i}.png`);
        await extractFrame(media, duration * frac, framePath, signal);
        const bytes = await readFile(framePath);
        if (!firstFrame) firstFrame = bytes;
        if ((await frameBlackFraction(bytes)) < 0.9) return bytes;
      }
      if (!firstFrame) throw new Error('Could not extract any frame from the video.');
      return firstFrame;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
}

type TransformFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'ico' | 'mp4';

interface TransformCtx {
  width?: number;
  height?: number;
  fmt?: TransformFormat;
  outputMode: OutputMode;
  save: boolean;
  inline: boolean;
  signal?: AbortSignal;
  /** Original input string (for deriving the output filename stem when unpacking an ICO). */
  sourceName?: string;
}

/** Target image format → { ext, mime } for the ico-unpack output. */
const IMG_OUT: Record<string, { ext: string; mime: string }> = {
  png: { ext: 'png', mime: 'image/png' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
  avif: { ext: 'avif', mime: 'image/avif' },
};

/** Filename stem (no extension) for an output: from a local file or URL path, else `icon`. */
function sourceStem(name: string | undefined): string {
  return (name ? inputStem(name) : '') || 'icon';
}

function wantsResize(c: TransformCtx): boolean {
  return c.width != null || c.height != null;
}

/** The width/height the caller asked for (only the ones present). */
function dimsOf(c: TransformCtx): { width?: number; height?: number } {
  return { ...(c.width != null ? { width: c.width } : {}), ...(c.height != null ? { height: c.height } : {}) };
}

/**
 * Transform a SINGLE resolved media item (image or video) per the shared context.
 * Width/height are ignored for `ico` (callers route ico through buildIcoFromInputs).
 * The `inline` flag is per-item so batch calls can force it off.
 */
function transformOne(media: ResolvedMedia, c: TransformCtx): Promise<ToolResult> {
  return media.kind === 'video' ? transformVideo(media, c) : transformImage(media, c);
}

/** An image (bytes + its mime) on its way through resize/convert, and whether Tinify already optimized it. */
interface WorkingImage {
  bytes: Buffer;
  mimeType: string;
  alreadyTinified: boolean;
}

async function convertTo(bytes: Buffer, fmt: ImageFormat, mimeType: string, c: TransformCtx): Promise<WorkingImage> {
  const conv = await convertImage(bytes, fmt, { tinifyToken: runtime.tinifyToken, sourceMime: mimeType, signal: c.signal, logger: runtime.logger });
  return { bytes: conv.bytes, mimeType: conv.mimeType, alreadyTinified: conv.tinified };
}

/** Convert an extracted video frame (PNG, possibly resized) to the requested image format. */
async function convertFrame(frame: WorkingImage, fmt: TransformFormat, c: TransformCtx): Promise<WorkingImage> {
  if (fmt !== 'png') return convertTo(frame.bytes, fmt as ImageFormat, frame.mimeType, c);
  // A PNG frame is only optimized (Tinify), in place — no `-original`, and the mime stays as it was.
  const tinifyToken = runtime.tinifyToken;
  if (!tinifyToken) return frame;
  const optimized = await convertImage(frame.bytes, 'png', { tinifyToken, sourceMime: frame.mimeType, signal: c.signal, logger: runtime.logger });
  return { bytes: optimized.bytes, mimeType: frame.mimeType, alreadyTinified: true };
}

/** Video → a representative still frame in an image format. */
async function videoToStill(media: ResolvedMedia, fmt: TransformFormat, c: TransformCtx): Promise<ToolResult> {
  if (!(await ffmpegAvailable())) return errorResult(FFMPEG_MISSING_MESSAGE);
  let frame: WorkingImage = { bytes: await pickRepresentativeFrame(media, c.signal), mimeType: 'image/png', alreadyTinified: false };
  if (wantsResize(c)) {
    const d = await downsizeImage(frame.bytes, dimsOf(c));
    frame = { bytes: d.bytes, mimeType: d.mimeType, alreadyTinified: false };
  }
  const out = await convertFrame(frame, fmt, c);
  return emitImage(out.bytes, out.mimeType, 'frame', { save: c.save, inline: c.inline, outputMode: c.outputMode, description: 'Extracted video frame', alreadyTinified: out.alreadyTinified });
}

async function transformVideo(media: ResolvedMedia, c: TransformCtx): Promise<ToolResult> {
  const { fmt } = c;
  // Video → still frame when an image format is requested.
  if (fmt && !VIDEO_FORMAT_RE.test(fmt)) return videoToStill(media, fmt, c);
  // Video stays video.
  if (wantsResize(c)) return videoResult('downsize', c.outputMode, (outPath) => downsizeVideo(media, outPath, dimsOf(c), c.signal));
  // A container change was asked for: transcode (an mp4 that is already mp4 passes through).
  if (fmt === 'mp4' && media.mimeType !== 'video/mp4') {
    return videoResult('convert', c.outputMode, (outPath) => transcodeToMp4(media, outPath, c.signal));
  }
  // Passthrough (only output_mode / no manipulation).
  return emitVideoBytes(media.bytes ?? (await readFile(media.path!)), media.mimeType, 'video', c.outputMode);
}

/** An ICO input + a non-ico image output_format → unpack every size into its own file. */
function isIcoUnpackRequest(fmt: TransformFormat | undefined, bytes: Buffer): boolean {
  return fmt != null && fmt !== 'ico' && IMG_OUT[fmt] != null && isIcoBytes(bytes);
}

/** Pure passthrough of an existing local file in filePath mode: return it as-is, no copy. */
function isUnchangedFileRequest(c: TransformCtx, media: ResolvedMedia): boolean {
  return !wantsResize(c) && !c.fmt && c.outputMode === 'filePath' && c.save && !!media.path;
}

async function unchangedFileResult(path: string, img: WorkingImage, inline: boolean): Promise<ToolResult> {
  const filename = path.split(/[\\/]/).pop() ?? 'file';
  const content: ToolContent[] = [{ type: 'resource_link', uri: pathToFileURL(path).href, name: filename, mimeType: img.mimeType, description: 'Source file (unchanged)' }];
  if (inline) {
    const p = await makeImagePreview(img.bytes, img.mimeType, runtime.config.output.previewMaxBytes);
    if (p) content.push({ type: 'image', data: p.data, mimeType: p.mimeType });
  }
  return { content: [{ type: 'text', text: `${path}\nOutput: ${img.mimeType} (unchanged)` }, ...content] };
}

/** Stem label for the saved image: what the call did to it. */
function imageOutputLabel(c: TransformCtx): string {
  if (c.fmt) return 'convert';
  return wantsResize(c) ? 'downsize' : 'media';
}

async function transformImage(media: ResolvedMedia, c: TransformCtx): Promise<ToolResult> {
  const { fmt } = c;
  if (fmt && VIDEO_FORMAT_RE.test(fmt)) return errorResult('Use the image_to_video tool to turn an image into a video.');

  const source = media.bytes ?? (await readFile(media.path!));
  if (isIcoUnpackRequest(fmt, source)) return unpackIco(source, c);

  let img: WorkingImage = { bytes: source, mimeType: media.mimeType, alreadyTinified: false };
  if (wantsResize(c)) {
    const d = await downsizeImage(imageInputOf(media), dimsOf(c));
    img = { bytes: d.bytes, mimeType: d.mimeType, alreadyTinified: false };
  }
  if (fmt && fmt !== 'ico') img = await convertTo(img.bytes, fmt as ImageFormat, img.mimeType, c);

  if (isUnchangedFileRequest(c, media)) return unchangedFileResult(media.path!, img, c.inline);
  return emitImage(img.bytes, img.mimeType, imageOutputLabel(c), {
    save: c.save,
    inline: c.inline,
    outputMode: c.outputMode,
    description: 'transform_media result',
    alreadyTinified: img.alreadyTinified,
  });
}

/** Short name for an input in the provenance report (filename, or a kind for inline data). */
function inputLabel(input: string): string {
  if (/^data:/i.test(input)) return 'data: URL';
  if (/^[A-Za-z0-9+/=]+$/.test(input.trim())) return 'base64 input';
  return input.replace(/\?.*$/, '').replace(/\\/g, '/').split('/').pop() || input;
}

/** The entries gathered so far for a multi-size ICO, with where each came from. */
interface IcoCollection {
  images: IcoImage[];
  provenance: { size: number; from: string }[];
  seen: Set<number>;
}

/** The declared `sizes` must be unambiguous and made of allowed ICO sizes. */
function assertDeclaredSizesValid(declared: number[]): void {
  const dupes = declared.filter((s, i) => declared.indexOf(s) !== i);
  if (dupes.length > 0) throw new ToolFailure(`duplicate size(s) ${[...new Set(dupes)].join(', ')} in \`sizes\`; the declared set must be unambiguous.`);
  const bad = declared.filter((s) => !isAllowedIcoSize(s));
  if (bad.length > 0) throw new ToolFailure(`declared size(s) ${bad.join(', ')} are not allowed ICO sizes (${ICO_ALLOWED_SIZES.join(', ')}).`);
}

/** Reserve `size` in the collection, refusing an overlap. */
function claimIcoSize(acc: IcoCollection, size: number, element: number): void {
  if (acc.seen.has(size)) throw new ToolFailure(`duplicate ICO size ${size}px (from element ${element}); sizes must not overlap.`);
  acc.seen.add(size);
}

/** Merge an existing .ico input's entries (each must be an allowed square size). */
async function addIcoInputEntries(acc: IcoCollection, bytes: Buffer, element: number, from: string, intended: number | undefined): Promise<void> {
  const entries = await parseIco(bytes);
  if (intended != null && (entries.length !== 1 || entries[0]!.width !== intended)) {
    throw new ToolFailure(
      `ico element ${element} (${from}) was declared as ${intended}px but contains ${entries.length} entr(y/ies) of ` +
        `${entries.map((e) => `${e.width}px`).join(', ')}. Nothing was written — fix the declared \`sizes\` or the input.`,
    );
  }
  for (const entry of entries) {
    const size = entry.width;
    if (entry.height !== size || !isAllowedIcoSize(size)) {
      throw new ToolFailure(
        `ico element ${element} has a ${entry.width}x${entry.height} entry, which is not an allowed square ICO size (${ICO_ALLOWED_SIZES.join(', ')}).`,
      );
    }
    claimIcoSize(acc, size, element);
    acc.images.push(await icoImageFromEntry(entry));
    acc.provenance.push({ size, from: `${from} (embedded entry)` });
  }
}

/** Add a plain image input — it must already be square AND an allowed size (never resized). */
async function addPlainImageEntry(acc: IcoCollection, bytes: Buffer, mimeType: string, element: number, from: string, intended: number | undefined): Promise<void> {
  let size: number;
  try {
    size = await icoSizeOfSquare(bytes);
  } catch (err) {
    throw new ToolFailure(`ico element ${element}: ${(err as Error).message}`);
  }
  if (intended != null && size !== intended) {
    throw new ToolFailure(
      `ico element ${element} (${from}) was declared as ${intended}px but is actually ${size}x${size}. Nothing was written — ` +
        'this tool never resizes, so fix the declared `sizes`, supply the right file, or use `build_icon_set` to derive the sizes.',
    );
  }
  claimIcoSize(acc, size, element);
  acc.images.push(icoImageFromPng(await ensurePng(bytes, mimeType)));
  acc.provenance.push({ size, from });
}

/** Resolve every input and gather its icon entries; one declared size per element makes each element's REAL size checked against its slot. */
async function collectIcoEntries(inputs: string[], declared: number[] | undefined): Promise<IcoCollection> {
  const acc: IcoCollection = { images: [], provenance: [], seen: new Set<number>() };
  const positional = declared != null && declared.length === inputs.length;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const media = await resolveMediaInput(input);
    if (media.kind !== 'image') throw new ToolFailure(`ico output requires image (or .ico) inputs; element ${i + 1} is a video.`);
    const bytes = media.bytes ?? (await readFile(media.path!));
    const intended = positional ? declared![i]! : undefined;
    const from = inputLabel(input);
    if (isIcoBytes(bytes)) await addIcoInputEntries(acc, bytes, i + 1, from, intended);
    else await addPlainImageEntry(acc, bytes, media.mimeType, i + 1, from, intended);
  }
  return acc;
}

/** The emitted sizes must equal the declared set exactly. */
function assertMatchesDeclaredSet(sizes: number[], declared: number[]): void {
  const wanted = [...declared].sort((a, b) => a - b);
  const missing = wanted.filter((s) => !sizes.includes(s));
  const extra = sizes.filter((s) => !wanted.includes(s));
  if (missing.length === 0 && extra.length === 0) return;
  throw new ToolFailure(
    `the inputs do not produce the declared set (${wanted.join(', ')}): ` +
      [missing.length > 0 ? `missing ${missing.join(', ')}` : '', extra.length > 0 ? `unexpected ${extra.join(', ')}` : '']
        .filter(Boolean)
        .join('; ') +
      '. Nothing was written.',
  );
}

/**
 * Build a multi-size (or merged) ICO from an array of inputs. Each plain image must be
 * square AND an allowed size (no resizing — pass generate_image or build_icon_set to
 * downscale instead); each existing .ico is parsed and its entries merged. No duplicate
 * sizes are allowed. `width`/`height` are ignored. Inline preview renders the largest
 * embedded size.
 *
 * `declared` (the caller's `sizes`) turns this from "embed whatever the files happen to
 * be" into a checked contract: the emitted icon must equal the declared set exactly, and
 * when one size is declared per element, each element must actually BE that size —
 * otherwise the call fails naming the offending element instead of silently shipping a
 * different set. Every entry is reported with the input it came from either way.
 */
function buildIcoFromInputs(
  inputs: string[],
  ctx: { outputMode: OutputMode; save: boolean; inline: boolean; signal?: AbortSignal; declared?: number[] },
): Promise<ToolResult> {
  return failuresAsErrorResult(async () => {
    const declared = ctx.declared;
    if (declared) assertDeclaredSizesValid(declared);
    const { images, provenance } = await collectIcoEntries(inputs, declared);

    if (images.length === 0) throw new ToolFailure('ico output requires at least one image.');
    const sizes = images.map((im) => im.header.width).sort((a, b) => a - b);
    if (declared) assertMatchesDeclaredSet(sizes, declared);

    const summary = [
      `Output: ${ICO_MIME} (${images.length} size(s): ${sizes.join(', ')}${declared ? ' — matches the declared set' : ''})`,
      'Entries (size ← source):',
      ...[...provenance].sort((a, b) => b.size - a.size).map((p) => `  ${p.size}x${p.size} ← ${p.from}`),
    ];
    return emitBuiltIco(buildIco(images), summary, ctx);
  });
}

/** Save (or, under save:false, just preview) the built icon, with the provenance summary. */
async function emitBuiltIco(bytes: Buffer, summary: string[], ctx: { outputMode: OutputMode; save: boolean; inline: boolean }): Promise<ToolResult> {
  if (!ctx.save) {
    // save:false writes nothing: report the icon and preview its largest entry inline.
    const preview = ctx.inline ? await icoPreviewContent(bytes, runtime.config.output.previewMaxBytes) : [];
    return { content: [{ type: 'text', text: [`Built the icon — not saved (save:false).`, ...summary].join('\n') }, ...preview] };
  }
  const saved = await writeMediaFile(runtime.outputDir(), `${mediaStem('icon')}.ico`, bytes);
  const content = await renderIcoMediaContent({
    bytes,
    saved,
    outputMode: ctx.outputMode,
    inline: ctx.inline,
    previewMaxBytes: runtime.config.output.previewMaxBytes,
    description: 'Multi-size icon',
  });
  return { content: [{ type: 'text', text: [saved.path, ...summary].join('\n') }, ...content] };
}

/** One ICO entry re-encoded at its native dimensions in the target format. */
interface UnpackedLayer {
  width: number;
  height: number;
  out: Buffer;
}

/** Encode every entry first (RGBA layer → target format at its native dimensions). */
async function encodeIcoLayers(entries: IcoEntry[], fmt: 'png' | 'jpg' | 'webp' | 'avif'): Promise<UnpackedLayer[]> {
  const layers: UnpackedLayer[] = [];
  for (const entry of entries) {
    const { width, height, data } = icoEntryToRgba(entry);
    const pipeline = sharp(data, { raw: { width, height, channels: 4 } });
    const out = fmt === 'jpg' ? await pipeline.jpeg().toBuffer() : await pipeline[fmt]().toBuffer();
    layers.push({ width, height, out });
  }
  return layers;
}

/**
 * Unpack every size variant of an ICO into its own file in a non-ico image format,
 * named `<stem>-<WxH>.<ext>` (e.g. `favicon-256x256.png`). `width`/`height` are
 * ignored; width comes from each embedded entry. No inline preview (N outputs).
 * Never overwrites: when any name of the set is taken (a second `favicon.ico`, or two
 * data-URL icons both stemmed `icon`), the whole set moves to `<stem>-2-…`, `<stem>-3-…`.
 * `save:false` writes nothing and returns inline previews (when enabled) instead.
 */
async function unpackIco(bytes: Buffer, c: TransformCtx): Promise<ToolResult> {
  const entries = await parseIco(bytes);
  if (entries.length === 0) return errorResult('ICO contains no images.');
  const fmt = c.fmt as 'png' | 'jpg' | 'webp' | 'avif';
  const spec = IMG_OUT[fmt];
  if (!spec) return errorResult(`Cannot unpack an ICO to "${fmt}"; use png, jpg, webp, or avif.`);

  const layers = await encodeIcoLayers(entries, fmt);
  return c.save ? saveUnpackedLayers(layers, spec, c) : previewUnpackedLayers(layers, spec.mime, c.inline);
}

/** save:false — report the sizes and (when enabled) return inline previews; nothing is written. */
async function previewUnpackedLayers(layers: UnpackedLayer[], mime: string, inline: boolean): Promise<ToolResult> {
  const lines = [`Unpacked ${layers.length} ICO size(s) — not saved (save:false): ${layers.map((l) => `${l.width}x${l.height}`).join(', ')}`];
  const media: ToolContent[] = [];
  if (inline) {
    for (const l of layers) {
      const p = await makeImagePreview(l.out, mime, runtime.config.output.previewMaxBytes);
      if (p) media.push({ type: 'image', data: p.data, mimeType: p.mimeType });
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

async function saveUnpackedLayers(layers: UnpackedLayer[], spec: { ext: string; mime: string }, c: TransformCtx): Promise<ToolResult> {
  const { ext, mime } = spec;
  const dir = runtime.outputDir();
  const stem = freeSetStem(dir, sourceStem(c.sourceName), layers.map((l) => `-${l.width}x${l.height}.${ext}`));
  const lines: string[] = [`Unpacked ${layers.length} ICO size(s):`];
  const media: ToolContent[] = [];
  for (const { width, height, out } of layers) {
    const saved = await writeMediaFile(dir, `${stem}-${width}x${height}.${ext}`, out);
    lines.push(`  ${saved.path}`);
    if (c.outputMode === 'base64') {
      media.push({ type: 'image', data: out.toString('base64'), mimeType: mime });
    } else {
      media.push({ type: 'resource_link', uri: saved.uri, name: saved.filename, mimeType: mime, description: `${width}x${height} (unpacked)` });
    }
  }
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

/** First of `stem`, `stem-2`, `stem-3`, … for which NO `<stem><suffix>` already exists in `dir`. */
function freeSetStem(dir: string, stem: string, suffixes: string[]): string {
  const taken = (s: string): boolean => suffixes.some((suffix) => existsSync(join(dir, `${s}${suffix}`)));
  if (!taken(stem)) return stem;
  for (let n = 2; ; n++) if (!taken(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** Combine the content of several ToolResults into one (for batch array inputs). */
function concatResults(results: ToolResult[]): ToolResult {
  const content: ToolContent[] = [];
  let isError: boolean | undefined;
  for (const r of results) {
    content.push(...r.content);
    if (r.isError) isError = true;
  }
  return { content, ...(isError ? { isError: true } : {}) };
}

/** A required integer pixel field with a lower bound (the crop region's four coordinates). */
function pixelInt(min: number, description: string) {
  return z.number().int().min(min).describe(description);
}

/** Output handling shared by every transform_media path, resolved from the raw tool args. */
function transformSettings(args: { output_mode?: string; save?: boolean; inline_preview?: boolean; output_format?: string; image: string | string[] }) {
  const outputMode = (args.output_mode as OutputMode | undefined) ?? 'filePath';
  return {
    outputMode,
    save: outputMode === 'base64' ? true : (args.save ?? true),
    inline: args.inline_preview ?? runtime.config.output.inlinePreview,
    fmt: args.output_format as TransformFormat | undefined,
    inputs: Array.isArray(args.image) ? args.image : [args.image],
  };
}

/**
 * Transform each input independently. A single input is the plain path; an array of non-ico
 * inputs is a batch: results are concatenated and the inline preview is forced off.
 */
async function transformInputs(inputs: string[], base: Omit<TransformCtx, 'inline' | 'sourceName'>, inline: boolean): Promise<ToolResult> {
  const batch = inputs.length > 1;
  const results: ToolResult[] = [];
  for (const input of inputs) {
    const media = await resolveMediaInput(input);
    results.push(await transformOne(media, { ...base, inline: batch ? false : inline, sourceName: input }));
  }
  return batch ? concatResults(results) : results[0]!;
}

export function registerMediaEditTools(server: McpServer): void {
  server.registerTool(
    'crop_media',
    {
      title: 'Crop image or video',
      description:
        'Crop an exact pixel region from an image or video. Input may be a file path, http(s) URL, data: URL, or base64. ' +
        'The region is left/top (top-left corner) plus width/height, in pixels, and must lie within the source bounds.',
      inputSchema: {
        image: z.string().min(1).describe('The image or video to crop (file path, http(s) URL, data: URL, or base64).'),
        left: pixelInt(0, 'X of the crop region’s top-left corner, in pixels.'),
        top: pixelInt(0, 'Y of the crop region’s top-left corner, in pixels.'),
        width: pixelInt(1, 'Crop width in pixels.'),
        height: pixelInt(1, 'Crop height in pixels.'),
        save: z.boolean().optional().describe('Save the result to the output directory (default true).'),
        inline_preview: z.boolean().optional().describe('Return an inline preview for images (default from config).'),
        output_mode: z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      try {
        const media = await resolveMediaInput(args.image);
        const region = { left: args.left, top: args.top, width: args.width, height: args.height };
        const outputMode = (args.output_mode as OutputMode | undefined) ?? 'filePath';
        const save = outputMode === 'base64' ? true : (args.save ?? true);
        const inline = args.inline_preview ?? runtime.config.output.inlinePreview;
        if (media.kind === 'image') {
          const edited = await cropImage(imageInputOf(media), region);
          return await emitImage(edited.bytes, edited.mimeType, 'crop', { save, inline, outputMode, description: 'crop (image)' });
        }
        return await videoResult('crop', outputMode, (outPath) => cropVideo(media, outPath, region, extra.signal));
      } catch (err) {
        runtime.health.recordError('crop_media', (err as Error).message);
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'transform_media',
    {
      title: 'Transform media (resize / convert / extract frame / output mode)',
      description:
        'Resize, convert format, extract a video still, and/or change how the result is returned — all in one tool. ' +
        'Input may be a file path, http(s) URL, data: URL, or base64. With only `output_mode` it returns the file unchanged (as a path or base64). ' +
        'With `output_format` it converts an image (png/jpg/webp/avif; Tinify when configured, else sharp) — no resize. ' +
        'With `width`/`height` it downsizes (Magic Kernel Sharp 2021 for images, ffmpeg for video), only ever shrinking. ' +
        'For a VIDEO input, an image `output_format` extracts a representative still frame (skips mostly-black frames). ' +
        'Requesting a video `output_format` for an image returns an error pointing at `image_to_video`.',
      inputSchema: {
        image: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe('The image(s)/video or .ico to transform. Pass a single value, or an array when batching (each processed independently) or building a multi-size ICO. For `ico`, each entry must be a square, allowed ICO size (' + ICO_ALLOWED_SIZES.join(', ') + '), and you may include existing .ico files to merge. Each entry is a file path, http(s) URL, data: URL, or base64.'),
        width: z.number().int().min(1).optional().describe('Maximum width in pixels (downsize; only ever shrinks). Ignored when output_format is ico.'),
        height: z.number().int().min(1).optional().describe('Maximum height in pixels (downsize; only ever shrinks). Ignored when output_format is ico.'),
        output_format: z
          .enum(['png', 'jpg', 'webp', 'avif', 'ico', 'mp4'])
          .optional()
          .describe('Target format. Image formats (png/jpg/webp/avif) convert an image, or extract+convert a still from a video. "ico" builds a multi-size Windows icon from the image array: each image must already be a square allowed ICO size (' + ICO_ALLOWED_SIZES.join(', ') + '), existing .ico files are merged, and duplicate sizes are rejected (no resizing — use generate_image to downscale a single large image to a chosen width). "mp4" on a VIDEO input converts it to an H.264/AAC mp4 (webm/mov/mkv/avi → mp4; an mp4 passes through unchanged); on an image input it is rejected (use image_to_video).'),
        sizes: z
          .array(z.number().int().min(1))
          .optional()
          .describe(
            'The set of sizes the `.ico` is DECLARED to contain (only with `output_format:"ico"`). The emitted icon must equal ' +
              'this set exactly or the call fails and writes nothing. Pass one size per input and each input must actually be ' +
              'that size — a file whose real dimensions differ from its declared slot is reported by name instead of being ' +
              'silently embedded at its real size. Without `sizes` the entries are still listed with their source in the reply.',
          ),
        output_mode: z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION),
        save: z.boolean().optional().describe('Save the result to the output directory (default true).'),
        inline_preview: z.boolean().optional().describe('Return an inline preview for images (default from config). Ignored (always false) for batch operations — an array of non-ico inputs. For ico, shows the largest embedded size.'),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      try {
        const { outputMode, save, inline, fmt, inputs } = transformSettings(args);

        // Multi-size / merged ICO (array or single string): validate sizes, dedupe, merge.
        if (fmt === 'ico') {
          return await buildIcoFromInputs(inputs, {
            outputMode,
            save,
            inline,
            signal: extra.signal,
            ...(args.sizes ? { declared: args.sizes as number[] } : {}),
          });
        }
        if (args.sizes) {
          return errorResult('`sizes` declares the entries of an `.ico`; use it with `output_format:"ico"` (or `build_icon_set` to derive sizes).');
        }
        return await transformInputs(inputs, { width: args.width, height: args.height, fmt, outputMode, save, signal: extra.signal }, inline);
      } catch (err) {
        runtime.health.recordError('transform_media', (err as Error).message);
        return errorResult(describeError(err));
      }
    },
  );
}
