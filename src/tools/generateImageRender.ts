import { runtime } from '../state/runtime.js';
import { describeImage, ensurePng, extFromMime, imageInfo, makeImagePreview, mediaStem, saveMedia, writeMediaFile, type SavedFile } from '../util/files.js';
import { tinifyCompress, tinifyConvert } from '../media/tinify.js';
import { ICO_MIME } from '../media/ico.js';
import type { GeneratedImage, ImageGenResult } from '../gateways/types.js';
import type { ImageJobMediaOpts, JobRenderer } from '../state/generationJobs.js';
import { renderMediaContent, renderIcoMediaContent, icoPreviewContent, NOTHING_RETURNED_NOTE, type OutputMode, type ToolContent, type ToolResult } from './helpers.js';
import { buildIco, fitSquare, icoImageFromPng, type SquareFit } from '../media/ico.js';
import { analyzeBackground, analyzePalette, describeBackgroundReport, describePaletteReport } from '../media/palette.js';

export type OutputFormat = 'png' | 'webp' | 'jpg' | 'avif' | 'ico';

/** What to measure a produced image against — snapshotted so an async job can still report it. */
export interface ConstraintCheck {
  palette?: string[];
  background?: string;
  tolerance?: number;
  enabled: boolean;
}

/** Measure one produced image against the pinned constraints (best-effort: never throws). */
async function checkConstraintLines(bytes: Buffer, check: ConstraintCheck | undefined): Promise<string[]> {
  if (!check?.enabled) return [];
  const lines: string[] = [];
  try {
    if (check.palette && check.palette.length > 0) {
      const report = await analyzePalette(bytes, check.palette, { ...(check.tolerance != null ? { tolerance: check.tolerance } : {}) });
      lines.push(...describePaletteReport(report));
    }
    if (check.background) {
      lines.push(...describeBackgroundReport(await analyzeBackground(bytes, check.background)));
    }
  } catch (err) {
    runtime.logger.warn('generate_image: constraint check failed', { error: (err as Error).message });
  }
  return lines.map((l) => `  ${l}`);
}

interface RenderOpts {
  format: OutputFormat | null;
  tinifyKey: string | null;
  outputMode: OutputMode;
  save: boolean;
  inline: boolean;
  label: string;
  signal?: AbortSignal;
  referenceDownloads?: string[];
  icoSize?: number;
  squareFit?: SquareFit;
  padColor?: string;
  /** One line per constraint that was applied, for the reply header. */
  constraintSummary?: string[];
  check?: ConstraintCheck;
  requestedSize?: { width: number; height: number };
}

/** The reply's header lines: model, cost, notes, applied constraints, saved reference copies. */
function summaryLines(result: ImageGenResult, opts: RenderOpts): string[] {
  const lines: string[] = [`Generated ${result.images.length} image(s) using ${result.modelUsed}.`];
  if (result.cost != null) lines.push(`Reported cost: $${result.cost}`);
  if (result.text) lines.push(`Model note: ${result.text}`);
  // How the request was adapted to the model (dropped resolution tier, rejected exact size, …).
  for (const w of result.warnings ?? []) lines.push(`Note: ${w}`);
  lines.push(...requestContextLines(opts));
  // save:false with previews off leaves the reply with nothing to look at — say so.
  if (!opts.save && !opts.inline) lines.push(NOTHING_RETURNED_NOTE);
  return lines;
}

/** The applied constraints and the saved copies of downloaded references. */
function requestContextLines(opts: RenderOpts): string[] {
  const lines: string[] = [];
  const constraints = opts.constraintSummary ?? [];
  if (constraints.length > 0) lines.push(`Constraints applied: ${constraints.join('; ')}.`);
  const downloads = opts.referenceDownloads ?? [];
  if (downloads.length > 0) lines.push(`Saved ${downloads.length} downloaded reference copy(ies):`, ...downloads.map((p) => `  ${p}`));
  return lines;
}

/**
 * The model ignored (or could not honour) the exact pixel size the caller asked for — fal
 * Recraft/Krea, Mistral, Eden tiers… Said per image; the bytes are kept as delivered.
 */
async function sizeMismatchLine(bytes: Buffer, requested: RenderOpts['requestedSize'], idx: number, model: string): Promise<string[]> {
  if (!requested) return [];
  const info = await imageInfo(bytes);
  if (!info || (info.width === requested.width && info.height === requested.height)) return [];
  return [
    `#${idx}: Note: requested ${requested.width}×${requested.height}, but ${model} returned ${info.width}×${info.height} — ` +
      'it does not honour exact pixel sizes. Resize locally with transform_media (width/height) if you need that size.',
  ];
}

/** Build the tool result (text summary + media blocks) for a finished generation. */
export async function renderImageResult(result: ImageGenResult, opts: RenderOpts): Promise<ToolResult> {
  const lines = summaryLines(result, opts);
  const media: ToolContent[] = [];
  let idx = 0;
  for (const img of result.images) {
    idx += 1;
    const parts = await processImage(img, idx, opts);
    lines.push(...parts.lines);
    lines.push(...(await sizeMismatchLine(img.bytes, opts.requestedSize, idx, result.modelUsed)));
    lines.push(...(await checkConstraintLines(img.bytes, opts.check)));
    media.push(...parts.content);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

/**
 * Normalise a (possibly partial / snapshotted) media-options record into render options.
 * `extra` carries what is not part of the snapshot: the reference-download and constraint
 * lines for the reply header, and — for a synchronous call only — the client's abort signal.
 */
export function renderOptsFromMedia(
  mo: Partial<ImageJobMediaOpts> | undefined,
  extra: { referenceDownloads?: string[]; constraintSummary?: string[]; signal?: AbortSignal } = {},
): RenderOpts {
  const m: Partial<ImageJobMediaOpts> = mo ?? {};
  const outputMode: OutputMode = m.outputMode ?? 'filePath';
  return {
    format: m.format ?? null,
    tinifyKey: m.tinifyKey ?? null,
    outputMode,
    save: outputMode === 'base64' ? true : (m.save ?? true),
    inline: m.inline ?? runtime.config.output.inlinePreview,
    label: m.label ?? 'generated-image',
    icoSize: m.icoSize,
    squareFit: m.squareFit,
    padColor: m.padColor,
    check: m.check,
    requestedSize: m.requestedSize,
    referenceDownloads: extra.referenceDownloads,
    constraintSummary: extra.constraintSummary,
    signal: extra.signal,
  };
}

/**
 * Renders a finished image job with the output settings snapshotted at submit. The
 * runtime runs it ONCE, when the job completes; every poll returns that same reply.
 * No abort signal: the render belongs to the job, not to whichever poll observes it.
 */
export function imageJobRenderer(mo: Partial<ImageJobMediaOpts> | undefined, extra: { referenceDownloads?: string[]; constraintSummary?: string[] } = {}): JobRenderer {
  const opts = renderOptsFromMedia(mo, extra);
  return (result) => renderImageResult(result as ImageGenResult, opts);
}

// ---- Saving one generated image -----------------------------------------------------

/** Everything the per-format save branches share for ONE image. */
interface SaveContext {
  dir: string;
  previewMaxBytes: number;
  lines: string[];
  content: ToolContent[];
  /** The model's raw output, as delivered (type + pixel size) — reported on every path. */
  sourceDesc: string;
  /**
   * Describes the PNG actually written as the kept original: the model's bytes when they
   * already were a PNG, else the PNG re-encode (saying what it was re-encoded from) — the
   * reply used to label a 313 KB PNG file with the provider's "image/jpeg … (101 KB)".
   */
  describeSourcePng: (sourcePng: Buffer) => Promise<string>;
  /**
   * Emit content for a saved file per the chosen output_mode (resource_link + optional
   * preview, or full base64). Used by every save branch below.
   */
  emit: (bytes: Buffer, mimeType: string, saved: SavedFile, description: string) => Promise<void>;
  /** Inline preview only (used when not saving — base64 mode always saves). */
  previewOnly: (bytes: Buffer, mimeType: string) => Promise<void>;
}

async function createSaveContext(img: GeneratedImage, opts: RenderOpts): Promise<SaveContext> {
  const previewMaxBytes = runtime.config.output.previewMaxBytes;
  const content: ToolContent[] = [];
  const sourceDesc = await describeImage(img.bytes, img.mimeType);
  return {
    dir: runtime.outputDir(),
    previewMaxBytes,
    lines: [],
    content,
    sourceDesc,
    describeSourcePng: async (sourcePng) =>
      sourcePng === img.bytes ? sourceDesc : `${await describeImage(sourcePng, 'image/png')}, re-encoded from the model's ${sourceDesc}`,
    emit: async (bytes, mimeType, saved, description) => {
      const desc = await describeImage(bytes, mimeType);
      content.push(...(await renderMediaContent({ bytes, mimeType, saved, outputMode: opts.outputMode, inline: opts.inline, previewMaxBytes, description: `${description} — ${desc}` })));
    },
    previewOnly: async (bytes, mimeType) => {
      if (!opts.inline) return;
      const preview = await makeImagePreview(bytes, mimeType, previewMaxBytes);
      if (preview) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
    },
  };
}

/** Save one generated image, applying optimization/conversion when configured. */
async function processImage(img: GeneratedImage, idx: number, opts: RenderOpts): Promise<{ lines: string[]; content: ToolContent[] }> {
  const ctx = await createSaveContext(img, opts);
  if (opts.format === 'ico') {
    await saveAsIco(ctx, img, idx, opts);
  } else if (!opts.format || !opts.tinifyKey) {
    await saveUnoptimized(ctx, img, idx, opts);
  } else {
    await saveOptimized(ctx, img, idx, opts, opts.format, opts.tinifyKey);
  }
  return { lines: ctx.lines, content: ctx.content };
}

/**
 * ICO: local container, no optimizer. Fit the model output to the icon size (downscale
 * + sharpen), wrap it as a single-entry ICO, and keep the original PNG.
 */
async function saveAsIco(ctx: SaveContext, img: GeneratedImage, idx: number, opts: RenderOpts): Promise<void> {
  const { dir, lines, content, previewMaxBytes } = ctx;
  const size = opts.icoSize ?? 256;
  const stem = mediaStem(opts.label);
  const sourcePng = await ensurePng(img.bytes, img.mimeType);
  const fitted = await fitSquare(sourcePng, 'image/png', size, {
    fit: opts.squareFit ?? 'pad',
    ...(opts.padColor ? { background: opts.padColor } : {}),
  });
  // Squaring is never silent: say which way it went and what it cost.
  if (fitted.note) lines.push(`#${idx}: ${fitted.note}`);
  const icoBytes = buildIco([icoImageFromPng(fitted.bytes)]);
  const icoDesc = `${ICO_MIME} ${size}×${size} (${Math.round(icoBytes.length / 1024)} KB)`;
  if (!opts.save) {
    // Inline preview of an ICO (used only when not saving) — render the largest entry to PNG.
    if (opts.inline) content.push(...(await icoPreviewContent(icoBytes, previewMaxBytes)));
    if (img.sourceUrl) lines.push(`#${idx}: ${img.sourceUrl}`);
    return;
  }
  const original = await writeMediaFile(dir, `${stem}-original.png`, sourcePng);
  const icoFile = await writeMediaFile(dir, `${stem}.ico`, icoBytes);
  lines.push(`#${idx}: ${icoFile.path}  — ${icoDesc}  (original PNG: ${original.path} — ${await ctx.describeSourcePng(sourcePng)})`);
  content.push(...(await renderIcoMediaContent({ bytes: icoBytes, saved: icoFile, outputMode: opts.outputMode, inline: opts.inline, previewMaxBytes, description: `Generated icon #${idx} — ${icoDesc}` })));
}

/** No optimizer: save the model's bytes as-is. */
async function saveUnoptimized(ctx: SaveContext, img: GeneratedImage, idx: number, opts: RenderOpts): Promise<void> {
  if (!opts.save) {
    ctx.lines.push(`#${idx}: ${img.sourceUrl ?? '(not saved)'}  — ${ctx.sourceDesc}`);
    await ctx.previewOnly(img.bytes, img.mimeType);
    return;
  }
  const saved = await saveMedia(ctx.dir, img.bytes, extFromMime(img.mimeType, 'png'), opts.label);
  ctx.lines.push(`#${idx}: ${saved.path}  — ${ctx.sourceDesc}`);
  await ctx.emit(img.bytes, img.mimeType, saved, `Generated image #${idx}`);
}

const CONVERT: Record<'webp' | 'jpg' | 'avif', { type: string; ext: string; mime: string }> = {
  webp: { type: 'image/webp', ext: 'webp', mime: 'image/webp' },
  jpg: { type: 'image/jpeg', ext: 'jpg', mime: 'image/jpeg' },
  avif: { type: 'image/avif', ext: 'avif', mime: 'image/avif' },
};

/** Tinify path: always work from a PNG source (better input than any model-native WebP/JPEG). */
async function saveOptimized(
  ctx: SaveContext,
  img: GeneratedImage,
  idx: number,
  opts: RenderOpts,
  format: Exclude<OutputFormat, 'ico'>,
  tinifyKey: string,
): Promise<void> {
  const stem = mediaStem(opts.label);
  const sourcePng = await ensurePng(img.bytes, img.mimeType);
  try {
    if (format === 'png') {
      await saveCompressedPng(ctx, sourcePng, idx, opts, stem, tinifyKey);
    } else {
      await saveConverted(ctx, sourcePng, idx, opts, stem, format, tinifyKey);
    }
  } catch (err) {
    // Optimization failed — don't lose the generation; save the source PNG and warn.
    runtime.logger.warn('Image optimization failed; saving the original PNG instead', { error: (err as Error).message });
    runtime.health.recordError('tinify', (err as Error).message);
    await saveSourcePngAfterFailure(ctx, sourcePng, idx, opts, stem, err as Error);
  }
}

async function saveCompressedPng(ctx: SaveContext, sourcePng: Buffer, idx: number, opts: RenderOpts, stem: string, tinifyKey: string): Promise<void> {
  const compressed = await tinifyCompress(tinifyKey, sourcePng, opts.signal);
  if (!opts.save) {
    await ctx.previewOnly(compressed, 'image/png');
    return;
  }
  const original = await writeMediaFile(ctx.dir, `${stem}-original.png`, sourcePng);
  const finalPng = await writeMediaFile(ctx.dir, `${stem}.png`, compressed);
  const pct = original.bytes > 0 ? Math.round((1 - finalPng.bytes / original.bytes) * 100) : 0;
  ctx.lines.push(`#${idx}: ${finalPng.path}  — ${await describeImage(compressed, 'image/png')}  (compressed ${pct}% smaller; original: ${original.path} — ${await ctx.describeSourcePng(sourcePng)})`);
  await ctx.emit(compressed, 'image/png', finalPng, `Generated image #${idx} (compressed PNG)`);
}

async function saveConverted(
  ctx: SaveContext,
  sourcePng: Buffer,
  idx: number,
  opts: RenderOpts,
  stem: string,
  format: 'webp' | 'jpg' | 'avif',
  tinifyKey: string,
): Promise<void> {
  const { type, ext, mime } = CONVERT[format];
  const converted = await tinifyConvert(tinifyKey, sourcePng, type, opts.signal);
  if (!opts.save) {
    await ctx.previewOnly(converted, mime);
    return;
  }
  const pngSaved = await writeMediaFile(ctx.dir, `${stem}.png`, sourcePng); // keep the source PNG
  const convSaved = await writeMediaFile(ctx.dir, `${stem}.${ext}`, converted);
  ctx.lines.push(`#${idx}: ${convSaved.path}  — ${await describeImage(converted, mime)}  (source PNG kept: ${pngSaved.path} — ${await ctx.describeSourcePng(sourcePng)})`);
  await ctx.emit(converted, mime, convSaved, `Generated image #${idx} (${ext.toUpperCase()})`);
}

async function saveSourcePngAfterFailure(ctx: SaveContext, sourcePng: Buffer, idx: number, opts: RenderOpts, stem: string, err: Error): Promise<void> {
  if (!opts.save) {
    await ctx.previewOnly(sourcePng, 'image/png');
    return;
  }
  const saved = await writeMediaFile(ctx.dir, `${stem}.png`, sourcePng);
  ctx.lines.push(`#${idx}: ${saved.path}  — ${await describeImage(sourcePng, 'image/png')}  (⚠️ optimization failed: ${err.message} — saved unoptimized PNG)`);
  await ctx.emit(sourcePng, 'image/png', saved, `Generated image #${idx} (optimization failed; original PNG)`);
}
