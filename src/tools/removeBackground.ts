import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { resolveImageInput } from '../util/inputs.js';
import { getBytes } from '../util/http.js';
import { saveMedia } from '../util/files.js';
import { describeError, errorResult, resolveOutputOptions, saveAndRender, NOTHING_RETURNED_NOTE, OUTPUT_MODE_DESCRIPTION, type ToolResult } from './helpers.js';
import { BG_MODELS, type BgModelKey } from '../bgremoval/models.js';

/** Bytes of the input image: local/inline content directly, a remote URL downloaded. Null when it can't be loaded. */
async function loadInputBytes(image: string, signal: AbortSignal): Promise<Buffer | null> {
  const resolved = await resolveImageInput(image);
  if (resolved.bytes) return resolved.bytes;
  return resolved.url ? getBytes(resolved.url, { signal }) : null;
}

/** Save/preview the cutout per the output settings and build the tool reply. */
async function cutoutResult(remover: { modelKey: string; activeEP: string }, png: Buffer, args: { save?: boolean; inline_preview?: boolean; output_mode?: string }): Promise<ToolResult> {
  const { outputMode, save } = resolveOutputOptions(args);
  const { saved, media } = await saveAndRender({
    bytes: png,
    mimeType: 'image/png',
    outputMode,
    save,
    persist: () => saveMedia(runtime.outputDir(), png, 'png', 'nobg'),
    inline: args.inline_preview ?? runtime.config.output.inlinePreview,
    previewMaxBytes: runtime.config.output.previewMaxBytes,
    description: 'Background-removed PNG (transparent)',
  });
  // Named per model — it used to say "BiRefNet" for IS-Net and BEN2 too.
  const label = BG_MODELS[remover.modelKey as BgModelKey]?.label ?? remover.modelKey;
  const lines = [`Removed background with ${label} (${remover.modelKey}, execution provider: ${remover.activeEP}).`];
  if (saved) lines.push(saved.path);
  else if (media.length === 0) lines.push(NOTHING_RETURNED_NOTE);
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

export function registerRemoveBackground(server: McpServer): RegisteredTool {
  return server.registerTool(
    'remove_background',
    {
      title: 'Remove background (local)',
      description:
        'Remove the background from an image — returns a transparent PNG. ' +
        'No gateway/API is used.',
      inputSchema: {
        image: z.string().min(1).describe('Image to process: file path, http(s) URL, data: URL, or base64.'),
        save: z.boolean().optional().describe('Save the resulting PNG to the output directory (default true).'),
        inline_preview: z.boolean().optional().describe('Return an inline preview to the client (default from config).'),
        output_mode: z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      try {
        if (runtime.config.backgroundRemoval.model === 'none') {
          return errorResult('Background removal is disabled. Run `npm run configure` and select birefnet-general or birefnet-massive.');
        }

        const bytes = await loadInputBytes(args.image, extra.signal);
        if (!bytes) return errorResult('Could not load the input image.');

        const remover = await runtime.getRemover();
        const png = await remover.removeBackground(bytes);
        runtime.health.generationCount += 1;

        return await cutoutResult(remover, png, args);
      } catch (err) {
        runtime.health.recordError('remove_background', (err as Error).message);
        return errorResult(describeError(err));
      }
    },
  );
}
