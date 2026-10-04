import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { inputStem, resolveMediaInput } from '../util/inputs.js';
import { convertImage, formatMime, type ImageFormat } from '../media/convert.js';
import { mediaStem, writeMediaFile } from '../util/files.js';
import {
  buildIco,
  fitToSquare,
  icoImageFromPng,
  icoImageSize,
  isAllowedIcoSize,
  parseIco,
  ICO_ALLOWED_SIZES,
  type SquareFit,
} from '../media/ico.js';
import {
  describeError,
  errorResult,
  renderIcoMediaContent,
  renderMediaContent,
  OUTPUT_MODE_DESCRIPTION,
  type OutputMode,
  type ToolContent,
  type ToolResult,
} from './helpers.js';
import { ToolFailure, failuresAsErrorResult } from './toolFailure.js';

/**
 * One member of the declared set: the size, and the source it is derived from.
 * Every emitted file and every `.ico` entry can be traced back to one of these,
 * which is what makes "did I actually get the set I asked for?" answerable
 * without unpacking the icon afterwards.
 */
interface SetMember {
  size: number;
  /** Index into the resolved source list (0 = the master). */
  sourceIndex: number;
}

interface IconSource {
  /** The caller's input string (path/URL/data URL), used for provenance in the report. */
  input: string;
  label: string;
  bytes: Buffer;
  mimeType: string;
}

/** Short, readable name for a source in the report ("master", or the variant's filename). */
function sourceLabel(input: string, index: number): string {
  if (index === 0) return 'master';
  return inputStem(input) || `variant ${index}`;
}

const IMAGE_FORMATS = ['png', 'webp', 'jpg', 'avif'] as const;

interface IconVariant {
  image: string;
  sizes: number[];
}

/** Everything the caller asked for, with defaults applied — the pipeline below never reads raw tool args. */
interface IconSetRequest {
  /** The declared set, in the caller's order. */
  declared: number[];
  variants: IconVariant[];
  /** Master first, then each variant's image. */
  inputs: string[];
  wantsIco: boolean;
  fit: SquareFit;
  padColor: string | undefined;
  fmt: ImageFormat;
  outputMode: OutputMode;
  save: boolean;
  inline: boolean;
  /** Output file stem (already passed through `mediaStem`). */
  stem: string;
}

/** One declared size, derived in memory (nothing written yet). */
interface DerivedSize {
  size: number;
  /** The square PNG the icon entry is built from. */
  png: Buffer;
  /** The bytes of the per-size file in the requested output format. */
  bytes: Buffer;
  source: IconSource;
  detail: string;
}

interface DerivedSet {
  derived: DerivedSize[];
  /** One squaring note per source index (from its largest size). */
  squaringNotes: Map<number, string>;
}

/** Validate the declared set BEFORE reading or writing anything. */
function validateDeclaredSizes(declared: number[], wantsIco: boolean): void {
  const seen = new Set<number>();
  for (const size of declared) {
    if (seen.has(size)) throw new ToolFailure(`Duplicate size ${size} in \`sizes\` — each size may appear once (the set must be unambiguous).`);
    seen.add(size);
    if (wantsIco && !isAllowedIcoSize(size)) {
      throw new ToolFailure(
        `Size ${size} is not an allowed ICO size; allowed: ${ICO_ALLOWED_SIZES.join(', ')}. Pass \`ico:false\` to emit the images without assembling an icon.`,
      );
    }
  }
}

/** Map every declared size to the source index it must come from (0 = the master). */
function assignSizesToSources(declared: number[], variants: IconVariant[]): Map<number, number> {
  const assignment = new Map<number, number>();
  for (let v = 0; v < variants.length; v++) {
    for (const size of variants[v]!.sizes) {
      if (!declared.includes(size)) {
        throw new ToolFailure(
          `variants[${v}] claims size ${size}, which is not in the declared \`sizes\` (${declared.join(', ')}). ` +
            'Add it to `sizes` or remove it from the variant — the declared set is authoritative.',
        );
      }
      const existing = assignment.get(size);
      if (existing != null) throw new ToolFailure(`Size ${size} is claimed by more than one source (variants[${existing - 1}] and variants[${v}]).`);
      assignment.set(size, v + 1);
    }
  }
  return assignment;
}

/** Resolve each distinct source once. */
async function resolveSources(inputs: string[]): Promise<IconSource[]> {
  const sources: IconSource[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const media = await resolveMediaInput(input);
    if (media.kind !== 'image') {
      throw new ToolFailure(`${i === 0 ? 'The master' : `variants[${i - 1}]`} input is a video; an icon set needs images.`);
    }
    const bytes = media.bytes ?? (await readFile(media.path!));
    sources.push({ input, label: sourceLabel(input, i), bytes, mimeType: media.mimeType });
  }
  return sources;
}

/** Every declared size with its assigned source, largest first — the conventional icon order, and deterministic. */
function planMembers(declared: number[], assignment: Map<number, number>): SetMember[] {
  return declared.map((size) => ({ size, sourceIndex: assignment.get(size) ?? 0 })).sort((a, b) => b.size - a.size);
}

/**
 * Derive every size from its assigned source — in memory only. Nothing touches the disk until
 * every size is derived AND the icon is verified, so any failure here really does leave nothing
 * written (no partial sets).
 */
async function deriveSizes(members: SetMember[], sources: IconSource[], req: IconSetRequest, signal?: AbortSignal): Promise<DerivedSet> {
  const derived: DerivedSize[] = [];
  const squaringNotes = new Map<number, string>();
  for (const member of members) {
    const source = sources[member.sourceIndex]!;
    let fitted;
    try {
      fitted = await fitToSquare(source.bytes, member.size, { fit: req.fit, ...(req.padColor ? { background: req.padColor } : {}) });
    } catch (err) {
      throw new ToolFailure(`Cannot produce the ${member.size}px entry from ${source.label} (${source.input}): ${(err as Error).message}. Nothing was written.`);
    }
    // Local sharp encode (tinifyToken omitted on purpose): an icon set is many small files,
    // not worth N optimizer round-trips.
    const bytes =
      req.fmt === 'png'
        ? fitted.bytes
        : (await convertImage(fitted.bytes, req.fmt, { tinifyToken: null, sourceMime: 'image/png', signal, logger: runtime.logger })).bytes;
    const detail = `${source.label} (${fitted.sourceWidth}x${fitted.sourceHeight}${fitted.applied === 'none' ? '' : `, ${fitted.applied}`})`;
    derived.push({ size: member.size, png: fitted.bytes, bytes, source, detail });
    // Report each source's squaring decision once — from the largest size, which is processed
    // first (the note is the same shape for all of them).
    if (fitted.note && !squaringNotes.has(member.sourceIndex)) squaringNotes.set(member.sourceIndex, fitted.note);
  }
  return { derived, squaringNotes };
}

/** Assemble the icon, then VERIFY it is exactly the declared set. */
async function assembleVerifiedIco(derived: DerivedSize[], declared: number[]): Promise<{ icoBytes: Buffer; embedded: number[] }> {
  const icoBytes = buildIco(derived.map((e) => icoImageFromPng(e.png)));
  const embedded = (await parseIco(icoBytes)).map(icoImageSize).sort((a, b) => a - b);
  const wanted = [...declared].sort((a, b) => a - b);
  if (embedded.length !== wanted.length || embedded.some((s, i) => s !== wanted[i])) {
    throw new ToolFailure(
      `The assembled icon does not match the declared set: expected ${wanted.join(', ')} but the file contains ${embedded.join(', ')}. Nothing was written.`,
    );
  }
  return { icoBytes, embedded };
}

/** Everything checked out: write the per-size files (or just list them under `save:false`). */
async function writeSizeFiles(derived: DerivedSize[], req: IconSetRequest, lines: string[], content: ToolContent[]): Promise<void> {
  const dir = runtime.outputDir();
  for (const e of derived) {
    if (!req.save) {
      lines.push(`  ${e.size}x${e.size} ← ${e.detail}`);
      continue;
    }
    const saved = await writeMediaFile(dir, `${req.stem}-${e.size}x${e.size}.${req.fmt}`, e.bytes);
    lines.push(`  ${e.size}x${e.size} ← ${e.detail}  ${saved.path}`);
    // Honour output_mode like every other media tool (base64 returns the bytes inline); the
    // per-size files never get an extra inline preview — a whole set would swamp the reply.
    content.push(
      ...(await renderMediaContent({
        bytes: e.bytes,
        mimeType: formatMime(req.fmt),
        saved,
        outputMode: req.outputMode,
        inline: false,
        previewMaxBytes: runtime.config.output.previewMaxBytes,
        description: `${e.size}x${e.size} from ${e.source.label}`,
      })),
    );
  }
}

/** Write the verified `.ico` (or report it under `save:false`) onto the reply. */
async function writeIcoFile(ico: { icoBytes: Buffer; embedded: number[] }, req: IconSetRequest, lines: string[], content: ToolContent[]): Promise<void> {
  const { icoBytes, embedded } = ico;
  if (!req.save) {
    lines.push(`Icon assembled with ${embedded.length} entries (${embedded.join(', ')}) — not saved (save:false): nothing was written; pass save:true to keep the files.`);
    return;
  }
  const icoFile = await writeMediaFile(runtime.outputDir(), `${req.stem}.ico`, icoBytes);
  lines.push(`Icon: ${icoFile.path}`, `  verified ${embedded.length} entries, exactly the declared set: ${embedded.join(', ')}`);
  content.push(
    ...(await renderIcoMediaContent({
      bytes: icoBytes,
      saved: icoFile,
      outputMode: req.outputMode,
      inline: req.inline,
      previewMaxBytes: runtime.config.output.previewMaxBytes,
      description: `Icon set (${embedded.join(', ')})`,
    })),
  );
}

/** validate plan → resolve sources → derive in memory → verify → write. */
async function buildIconSet(req: IconSetRequest, signal?: AbortSignal): Promise<ToolResult> {
  validateDeclaredSizes(req.declared, req.wantsIco);
  const assignment = assignSizesToSources(req.declared, req.variants);
  const sources = await resolveSources(req.inputs);
  const members = planMembers(req.declared, assignment);

  const { derived, squaringNotes } = await deriveSizes(members, sources, req, signal);
  const ico = req.wantsIco ? await assembleVerifiedIco(derived, req.declared) : null;

  const lines: string[] = [`Icon set: ${members.length} size(s) from ${sources.length} source(s), largest first.`];
  const content: ToolContent[] = [];
  await writeSizeFiles(derived, req, lines, content);
  for (const [sourceIndex, note] of squaringNotes) lines.push(`  note (${sources[sourceIndex]!.label}): ${note}`);
  if (ico) await writeIcoFile(ico, req, lines, content);
  return { content: [{ type: 'text', text: lines.join('\n') }, ...content] };
}

/** The raw tool args as the pipeline's `IconSetRequest` (defaults applied). */
function iconSetRequest(args: IconSetArgs): IconSetRequest {
  const outputMode = (args.output_mode as OutputMode | undefined) ?? 'filePath';
  const variants = (args.variants as IconVariant[] | undefined) ?? [];
  const inputs = [args.image as string, ...variants.map((v) => v.image)];
  const baseName = (args.name as string | undefined) ?? inputStem(inputs[0]!);
  return {
    declared: args.sizes as number[],
    variants,
    inputs,
    wantsIco: args.ico ?? true,
    fit: (args.square_fit as SquareFit | undefined) ?? 'pad',
    padColor: args.pad_color as string | undefined,
    fmt: (args.output_format as ImageFormat | undefined) ?? 'png',
    ...outputSettings(args, outputMode),
    stem: mediaStem(baseName || 'icon'),
  };
}

function outputSettings(args: IconSetArgs, outputMode: OutputMode): Pick<IconSetRequest, 'outputMode' | 'save' | 'inline'> {
  return {
    outputMode,
    save: outputMode === 'base64' ? true : (args.save ?? true),
    inline: args.inline_preview ?? runtime.config.output.inlinePreview,
  };
}

/** The validated tool arguments (zod-inferred shape, loosely typed here). */
interface IconSetArgs {
  image: string;
  sizes: number[];
  variants?: IconVariant[] | undefined;
  square_fit?: string | undefined;
  pad_color?: string | undefined;
  output_format?: string | undefined;
  ico?: boolean | undefined;
  name?: string | undefined;
  save?: boolean | undefined;
  inline_preview?: boolean | undefined;
  output_mode?: string | undefined;
}

export function registerBuildIconSet(server: McpServer): void {
  server.registerTool(
    'build_icon_set',
    {
      title: 'Build a coherent icon set (all sizes + the .ico) in one call',
      description:
        'Derive a whole icon set from one master image in a single, verifiable operation: every requested size is produced ' +
        'as its own file (exactly WxH) by downscaling the intended source — never by generating each size separately — and, ' +
        'unless you turn it off, they are assembled into one multi-size `.ico` that contains EXACTLY the sizes you declared. ' +
        'Smaller sizes can be pointed at a simplified `variants` source (e.g. a version without the wordmark) while still ' +
        'belonging to the same declared set. Non-square sources are fitted whole onto a square canvas by default (`square_fit:"pad"`), ' +
        'so an off-centre subject is never silently cropped. The reply lists each entry with its size AND the source it came from, ' +
        'and the operation fails loudly rather than emitting a set that differs from the one you declared.',
      inputSchema: {
        image: z
          .string()
          .min(1)
          .describe('The master image every size is derived from (file path, http(s) URL, data: URL, or base64).'),
        sizes: z
          .array(z.number().int().min(1))
          .min(1)
          .describe(
            'The declared set: every square size to produce, in pixels (e.g. [256,128,64,48,32,24,16]). Duplicates are rejected. ' +
              'When `ico` is on (default) each must be an allowed ICO size (' +
              ICO_ALLOWED_SIZES.join(', ') +
              '). Sources are only ever downscaled — a size larger than the source is an error, never an upscale.',
          ),
        variants: z
          .array(
            z.object({
              image: z.string().min(1).describe('Alternative source (file path, http(s) URL, data: URL, or base64).'),
              sizes: z.array(z.number().int().min(1)).min(1).describe('Which of the declared `sizes` come from this source instead of the master.'),
            }),
          )
          .optional()
          .describe(
            'Point specific sizes at a different source than the master — e.g. a simplified mark for 16/24/32 while the ' +
              'large sizes come from the detailed master. Every size listed here must also appear in `sizes`, and no size may ' +
              'be claimed twice.',
          ),
        square_fit: z
          .enum(['pad', 'crop'])
          .optional()
          .describe(
            'How a non-square source becomes square. "pad" (default) fits the whole image onto a square canvas — nothing is ' +
              'cropped; "crop" center-crops it, which loses anything off-centre. The reply always states which was used.',
          ),
        pad_color: z.string().optional().describe('Padding colour for `square_fit:"pad"` — "transparent" (default) or a hex like "#ffffff".'),
        output_format: z
          .enum(IMAGE_FORMATS)
          .optional()
          .describe('Format for the per-size image files (default "png"). Encoded locally with sharp — no Tinify calls, no cost.'),
        ico: z.boolean().optional().describe('Also assemble the multi-size Windows icon from the set (default true).'),
        name: z.string().optional().describe('Base name for the output files (default: derived from the master input, else "icon").'),
        save: z.boolean().optional().describe('Save the results to the output directory (default true).'),
        inline_preview: z.boolean().optional().describe('Return an inline preview of the assembled icon (default from config).'),
        output_mode: z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      try {
        const request = iconSetRequest(args);
        return await failuresAsErrorResult(() => buildIconSet(request, extra.signal));
      } catch (err) {
        runtime.health.recordError('build_icon_set', (err as Error).message);
        return errorResult(describeError(err));
      }
    },
  );
}
