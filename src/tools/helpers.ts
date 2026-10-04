import { GatewayHttpError } from '../util/http.js';
import { makeImagePreview, type SavedFile } from '../util/files.js';
import { icoLargestToPng, ICO_MIME } from '../media/ico.js';

export type ToolContent =
  // `_meta` is a standard, passthrough field on every MCP content block (see SDK
  // ContentBlock schema) — we use it to tag non-display info like possible-cause hints.
  | { type: 'text'; text: string; _meta?: Record<string, unknown> }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string; icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }> }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; blob: string } };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  // The SDK's CallToolResult is a passthrough object; allow extra keys for assignability.
  [key: string]: unknown;
}

/**
 * How a media-returning tool hands bytes back. `filePath` (default) returns a
 * `resource_link` to the saved file (+ optional downscaled inline preview);
 * `base64` returns the FULL bytes inline (image → `image` block; video/other →
 * embedded `resource` blob). MCP can't stream binary, so base64 is one big JSON
 * object — large for video. Either way the file is always saved to disk first.
 */
export type OutputMode = 'filePath' | 'base64';

export interface OutputModeOpts {
  bytes: Buffer;
  mimeType: string;
  /** The file already written to the output dir. */
  saved: SavedFile;
  outputMode: OutputMode;
  /** Downscaled inline preview (filePath mode only). */
  inline: boolean;
  previewMaxBytes: number;
  description?: string;
}

/** Build the media content block(s) for a saved file per the chosen output mode. */
export async function renderMediaContent(o: OutputModeOpts): Promise<ToolContent[]> {
  if (o.outputMode === 'base64') {
    const data = o.bytes.toString('base64');
    if (o.mimeType.startsWith('image/')) return [{ type: 'image', data, mimeType: o.mimeType }];
    return [{ type: 'resource', resource: { uri: o.saved.uri, mimeType: o.mimeType, blob: data } }];
  }
  const out: ToolContent[] = [
    { type: 'resource_link', uri: o.saved.uri, name: o.saved.filename, mimeType: o.mimeType, ...(o.description ? { description: o.description } : {}) },
  ];
  if (o.inline && o.mimeType.startsWith('image/')) {
    const preview = await makeImagePreview(o.bytes, o.mimeType, o.previewMaxBytes);
    if (preview) out.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
  }
  return out;
}

/**
 * The `output_mode` / `save` pair every media tool resolves the same way: base64 always
 * needs the file on disk first (per the `output_mode` contract), so it forces `save`.
 */
export function resolveOutputOptions(args: { output_mode?: string; save?: boolean }): { outputMode: OutputMode; save: boolean } {
  const outputMode: OutputMode = args.output_mode === 'base64' ? 'base64' : 'filePath';
  return { outputMode, save: outputMode === 'base64' ? true : (args.save ?? true) };
}

export interface SaveAndRenderOpts extends Omit<OutputModeOpts, 'saved'> {
  /** Write the file (false = `save:false`: nothing touches disk). */
  save: boolean;
  /** Writes the bytes to the output dir; only called when `save` is true. */
  persist: () => Promise<SavedFile>;
}

/**
 * The tail shared by single-file media tools: persist the bytes and render them per
 * the output mode, or — with `save:false` — return only an inline preview (when enabled).
 * `saved` is null when nothing was written.
 */
export async function saveAndRender(o: SaveAndRenderOpts): Promise<{ saved: SavedFile | null; media: ToolContent[] }> {
  const { save, persist, ...render } = o;
  if (save) {
    const saved = await persist();
    return { saved, media: await renderMediaContent({ ...render, saved }) };
  }
  if (!render.inline) return { saved: null, media: [] };
  const preview = await makeImagePreview(render.bytes, render.mimeType, render.previewMaxBytes);
  return { saved: null, media: preview ? [{ type: 'image', data: preview.data, mimeType: preview.mimeType }] : [] };
}

/**
 * A validation/resolution step's outcome: the value to carry on with, or the finished
 * (error) tool result to return as-is. Lets a handler be a flat sequence of steps.
 */
export type Step<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

export function stepOk<T>(value: T): Step<T> {
  return { ok: true, value };
}

export function stepFail<T = never>(message: string): Step<T> {
  return { ok: false, result: errorResult(message) };
}

/** Options for `renderIcoMediaContent`. The mime is always `image/x-icon` (the file is a container). */
export interface IcoMediaOpts {
  bytes: Buffer;
  saved: SavedFile;
  outputMode: OutputMode;
  inline: boolean;
  previewMaxBytes: number;
  description?: string;
}

/**
 * Build the media content block(s) for a saved ICO per the chosen output mode.
 * The ICO is a container sharp can't decode, so an inline preview renders the
 * largest embedded size to a PNG first (`@fiahfy/ico` handles the DIB→RGBA decode).
 */
export async function renderIcoMediaContent(o: IcoMediaOpts): Promise<ToolContent[]> {
  if (o.outputMode === 'base64') {
    return [{ type: 'image', data: o.bytes.toString('base64'), mimeType: ICO_MIME }];
  }
  const out: ToolContent[] = [
    { type: 'resource_link', uri: o.saved.uri, name: o.saved.filename, mimeType: ICO_MIME, ...(o.description ? { description: o.description } : {}) },
  ];
  if (o.inline) out.push(...(await icoPreviewContent(o.bytes, o.previewMaxBytes)));
  return out;
}

/**
 * Inline PNG preview of an ICO's largest entry (sharp can't decode the container). Best-effort:
 * `[]` when it can't be rendered — a saved file's resource_link stays authoritative.
 */
export async function icoPreviewContent(bytes: Buffer, previewMaxBytes: number): Promise<ToolContent[]> {
  try {
    const png = await icoLargestToPng(bytes);
    const preview = await makeImagePreview(png, 'image/png', previewMaxBytes);
    if (preview) return [{ type: 'image', data: preview.data, mimeType: preview.mimeType }];
  } catch {
    /* best-effort */
  }
  return [];
}

/** Shown when a call keeps no file AND returns no preview (save:false with inline_preview off). */
export const NOTHING_RETURNED_NOTE =
  'Note: nothing was saved and no preview was returned (save:false with inline_preview off) — pass save:true or inline_preview:true to get the result.';

/** Shared zod-less description for the `output_mode` param. */
export const OUTPUT_MODE_DESCRIPTION =
  'How to return the result. "filePath" (default) saves to the output dir and returns the path; ' +
  '"base64" also saves to disk but returns the full bytes inline as base64 (can be very large for video).';

/**
 * Client-compat fix-ups applied to EVERY tool result (via `instrumentToolLogging`):
 * - `resource_link` gets an explicit `icons: []`. Mistral Vibe CLI 2.25.x's harness requires
 *   `icons` to be a list, but the Python MCP SDK dumps an absent `icons` as `null`, so ANY
 *   resource_link without it fails there as `mcp_invalid_result` ("The provided tool call
 *   failed"). An empty `icons` array is spec-valid and harmless for every other client.
 */
export function normalizeResultForClients<T>(result: T): T {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'resource_link' && !Array.isArray((block as { icons?: unknown }).icons)) {
        (block as { icons?: unknown[] }).icons = [];
      }
    }
  }
  return result;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** `_meta` key (namespaced per the MCP convention) marking a content block as a cause hint. */
export const POSSIBLE_CAUSE_META_KEY = 'ai-image-router/category';

/**
 * Build an error result. Optional `possibleCauses` (human-readable guesses at WHY a
 * call failed — account/config issues the API reports opaquely) are each surfaced as a
 * standard `text` content block tagged via `_meta[POSSIBLE_CAUSE_META_KEY]`, so any
 * client displays them AND code can detect them by that key. No non-standard content
 * `type`, and no `structuredContent` (which would need an `outputSchema` to be idiomatic).
 */
export function errorResult(message: string, possibleCauses: string[] = []): ToolResult {
  const content: ToolContent[] = [{ type: 'text', text: message }];
  for (const cause of possibleCauses) {
    content.push({ type: 'text', text: `Possible cause: ${cause}`, _meta: { [POSSIBLE_CAUSE_META_KEY]: 'possibleCause' } });
  }
  return { content, isError: true };
}

/** Turn any thrown error into a concise, user-facing message. */
export function describeError(err: unknown): string {
  if (err instanceof GatewayHttpError) {
    return `Request failed (HTTP ${err.status}): ${err.providerMessage}${err.note ? ` ${err.note}` : ''}`;
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || /aborted/i.test(err.message)) {
      return `The request was cancelled or timed out: ${err.message}`;
    }
    return err.message;
  }
  return String(err);
}
