import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { resolveImageInput, resolveReferenceImages } from '../util/inputs.js';
import { mediaStem, writeMediaFile } from '../util/files.js';
import { encodeGif, msFromFps, type GifEncodeOptions, type GifEncodeResult, type GifFit } from '../media/gif.js';
import type { ReferenceImage } from '../gateways/types.js';
import { describeError, errorResult, resolveOutputOptions, saveAndRender, stepFail, stepOk, type OutputMode, type Step, type ToolResult } from './helpers.js';
import {
  capableVideoGateway,
  configuredVideoDefaults,
  pollVideoJob,
  runVideoGeneration,
  videoFailureResult,
  videoJobSchemaFields,
  MODEL_OVERRIDE_DEFAULTS_NOTE,
  VIDEO_ASPECT_RATIO_DESCRIPTION,
  type VideoGateway,
  type VideoRun,
} from './video.js';
import { refreshOnReload } from './reloadable.js';

/** Frames-per-second as a single value (uniform) or one value per frame (GIF only). */
const fpsSchema = z.union([z.number().positive(), z.array(z.number().positive()).min(1)]);

/** Names the CURRENTLY configured mp4 model, so it is re-derived after a `restart`. */
function imageToVideoDescription(): string {
  const i2vModel = runtime.config.imageToVideo.model;
  return (
    'Turn one or more still images into motion. Two modes via `output_format`:\n' +
    `• "mp4" (default) animates the reference image(s) with the configured image-to-video model${i2vModel ? ` (${i2vModel})` : ''} — long-running (often minutes), costs money, AI-generated motion.\n` +
    '• "gif" assembles the supplied frames locally into an animated GIF (no model, no cost, instant): the ordered frames are `image` (first), then `images_inner` (middle, in order), then `image_last`. Provide at least two of them. ' +
    'GIF supports per-frame timing (see `fps`), looping, 1-bit transparency, and an automatic palette/size optimization.\n' +
    'Every image input may be a file path, http(s) URL, data: URL, or base64.'
  );
}

export function registerImageToVideo(server: McpServer): void {
  const tool = server.registerTool(
    'image_to_video',
    {
      title: 'Image to video / animated GIF',
      description: imageToVideoDescription(),
      inputSchema: {
        image: z.string().min(1).optional().describe('Primary / first-frame image (file path, http(s) URL, data: URL, or base64). Required for mp4; for gif it is the first frame.'),
        images_inner: z.array(z.string()).optional().describe('GIF only: ordered middle frames placed between `image` and `image_last`.'),
        image_last: z.string().optional().describe('End-frame image. For mp4: end frame for first+last-frame models. For gif: the last frame.'),
        last_frame: z.string().optional().describe('Deprecated alias for `image_last`.'),
        output_format: z.enum(['mp4', 'gif']).optional().describe('"mp4" (default) = AI image-to-video via the configured model; "gif" = local animated-GIF assembly of the supplied frames.'),
        prompt: z.string().optional().describe('mp4 only: motion/scene description to guide the animation. Optional here, but some models require one (e.g. HeyGen, Hailuo) and fail without it.'),
        reference_images: z.array(z.string()).optional().describe('mp4 only: additional reference/subject images (for multi-reference models).'),
        model: z.string().optional().describe(`mp4 only: override the configured image-to-video model. ${MODEL_OVERRIDE_DEFAULTS_NOTE}`),
        resolution: z.string().optional().describe('mp4 only: override the default resolution (e.g. "720p", "1080P").'),
        fps: fpsSchema.optional().describe('Frames per second. A single number applies to all frames. For gif you may pass an ARRAY (one fps per frame; length must equal the frame count) for per-frame timing — each frame shows for 1000/fps ms (GIF granularity is 10 ms).'),
        duration: z.number().optional().describe('mp4 only: override the default duration in seconds.'),
        aspect_ratio: z.string().optional().describe(`mp4 only: ${VIDEO_ASPECT_RATIO_DESCRIPTION}`),
        provider_options: z.record(z.string(), z.any()).optional().describe('mp4 only: raw gateway-specific request fields (e.g. a model-native end-frame field, seed, camera commands), merged into the request.'),
        loop: z.number().int().min(-1).optional().describe('gif only: loop count (0 = forever, default; -1 = play once; >0 = number of loops).'),
        max_colors: z.number().int().min(2).max(256).optional().describe('gif only: palette ceiling 2–256 (default 256). With palette optimization on, caps the search; with it off, the fixed palette size.'),
        optimize_palette: z.boolean().optional().describe('gif only: search palette sizes for the best quality/size knee (default true). Turn off to encode at `max_colors` directly.'),
        fit: z.enum(['cover', 'contain', 'fill']).optional().describe('gif only: how frames are fitted to the canvas when sizes differ (default "cover").'),
        width: z.number().int().min(1).optional().describe('gif only: output canvas width in pixels (default: first frame width).'),
        height: z.number().int().min(1).optional().describe('gif only: output canvas height in pixels (default: first frame height).'),
        save: z.boolean().optional().describe('Save the result to the output directory (default true).'),
        ...videoJobSchemaFields({ mp4Only: true }),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      // Poll mode first — works for mp4 jobs (gif is always local/synchronous).
      const jobId = (args.job_id as string | undefined)?.trim();
      if (jobId) {
        return pollVideoJob(jobId, 'image-to-video', 'image-to-video', 'image_to_video');
      }
      const outputFormat = (args.output_format as 'mp4' | 'gif' | undefined) ?? 'mp4';
      if (outputFormat === 'gif') {
        return handleGif(args);
      }
      return handleVideo(args, extra);
    },
  );
  refreshOnReload(server, tool, () => ({ description: imageToVideoDescription() }));
}

// ---------------------------------------------------------------------------
// gif mode: local animated-GIF assembly (no gateway)
// ---------------------------------------------------------------------------

/** Local animated-GIF assembly (no gateway): `output_format: "gif"`. */
async function handleGif(args: GifArgs): Promise<ToolResult> {
  try {
    const inputs = gifFrameInputs(args);
    if (inputs.length < 2) {
      return errorResult('GIF output needs at least 2 frames. Supply them via `image` (first), `images_inner` (ordered middle frames), and/or `image_last`.');
    }

    // save:false writes nothing — not the GIF, and not `z-download-` copies of remote frames.
    const output = resolveOutputOptions(args);

    const frames = await resolveGifFrames(inputs, output.save);
    if (!frames.ok) return frames.result;
    const delays = gifDelays(args.fps, frames.value.length);
    if (!delays.ok) return delays.result;

    const result = await encodeGif(frames.value, gifEncodeOptions(args, delays.value));
    runtime.health.lastVideoAt = Date.now();
    runtime.health.generationCount += 1;
    return await renderGifResult(result, output);
  } catch (err) {
    runtime.health.recordError('image_to_video', (err as Error).message);
    return errorResult(describeError(err));
  }
}

/** Ordered frames: image (first) → images_inner (middle) → image_last (last); blanks skipped. */
function gifFrameInputs(args: GifArgs): string[] {
  const inputs: string[] = [];
  if (args.image?.trim()) inputs.push(args.image.trim());
  for (const m of args.images_inner ?? []) if (m?.trim()) inputs.push(m.trim());
  const last = args.image_last ?? args.last_frame;
  if (last?.trim()) inputs.push(last.trim());
  return inputs;
}

/** Fail-closed resolution: download remote frames, validate each is a real image, refuse unless ALL resolve. */
async function resolveGifFrames(inputs: string[], save: boolean): Promise<Step<Buffer[]>> {
  const resolved = await resolveReferenceImages(inputs, save ? { downloadDir: runtime.outputDir() } : {});
  if (resolved.errors.length) {
    return stepFail(`Could not resolve all GIF frames; generation refused.\n- ${resolved.errors.join('\n- ')}`);
  }
  const frames: Buffer[] = [];
  for (const ref of resolved.references) {
    if (!ref.bytes) return stepFail('A GIF frame did not resolve to image bytes.');
    frames.push(ref.bytes);
  }
  return stepOk(frames);
}

/** Per-frame delays from fps (scalar → uniform; array → one per frame). */
function gifDelays(fps: number | number[] | undefined, frameCount: number): Step<number[]> {
  if (Array.isArray(fps)) {
    if (fps.length !== frameCount) return stepFail(`fps array length (${fps.length}) must equal the number of frames (${frameCount}).`);
    return stepOk(fps.map((f) => msFromFps(f)));
  }
  const uniform = (typeof fps === 'number' ? fps : null) ?? runtime.config.imageToVideo.defaultFps ?? 10;
  return stepOk(new Array<number>(frameCount).fill(msFromFps(uniform)));
}

function gifEncodeOptions(args: GifArgs, delaysMs: number[]): GifEncodeOptions {
  return {
    delaysMs,
    loop: args.loop ?? 0,
    maxColors: args.max_colors ?? 256,
    optimize: args.optimize_palette ?? true,
    ...(args.width != null ? { width: args.width } : {}),
    ...(args.height != null ? { height: args.height } : {}),
    fit: (args.fit as GifFit | undefined) ?? 'cover',
  };
}

/** Human-readable summary of an encoded GIF (size, palette, timing, and the knee search if it ran). */
function describeGif(result: GifEncodeResult): string[] {
  const sizeKB = (result.bytes.length / 1024).toFixed(1);
  const loopText = result.loop === 0 ? 'loops forever' : result.loop < 0 ? 'plays once' : `loops ${result.loop}×`;
  const lines = [
    `Animated GIF: ${result.frameCount} frames, ${result.width}×${result.height}, ${result.colors} colors${result.hasTransparency ? ' + transparency' : ''}, ${sizeKB} KB, ${loopText}.`,
    `Frame delays (ms): ${summarizeDelays(result.delaysMs)}`,
  ];
  if (result.optimized && result.candidates && result.candidates.length > 1) {
    const swept = result.candidates.map((c) => `${c.colors}c=${(c.bytes / 1024).toFixed(0)}KB/${c.ssim}`).join('  ');
    lines.push(`Palette knee → ${result.colors} colors (swept: ${swept}).`);
  }
  return lines;
}

/** Render a per-frame delay list compactly. */
function summarizeDelays(ms: number[]): string {
  return new Set(ms).size === 1 ? `${ms[0]} (all ${ms.length} frames)` : ms.join(', ');
}

/** Save (or just preview, with save:false) the encoded GIF and build the tool reply. */
async function renderGifResult(result: GifEncodeResult, output: { outputMode: OutputMode; save: boolean }): Promise<ToolResult> {
  const lines = describeGif(result);
  const { saved, media } = await saveAndRender({
    bytes: result.bytes,
    mimeType: 'image/gif',
    outputMode: output.outputMode,
    save: output.save,
    persist: () => writeMediaFile(runtime.outputDir(), `${mediaStem('gif')}.gif`, result.bytes),
    inline: runtime.config.output.inlinePreview,
    previewMaxBytes: runtime.config.output.previewMaxBytes,
    description: 'Animated GIF',
  });
  lines.unshift(saved ? saved.path : 'Built the GIF — not saved (save:false).');
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

// ---------------------------------------------------------------------------
// mp4 mode: AI image-to-video via the gateway
// ---------------------------------------------------------------------------

/** AI image-to-video via the configured gateway: `output_format: "mp4"`. */
async function handleVideo(args: VideoArgs, extra: { signal: AbortSignal }): Promise<ToolResult> {
  try {
    const plan = await planImageToVideo(args, extra.signal);
    return plan.ok ? await runVideoGeneration(plan.value) : plan.result;
  } catch (err) {
    return videoFailureResult('image_to_video', err, args.model ?? runtime.config.imageToVideo.model ?? '');
  }
}

/** Gateway capability + required inputs, checked in the order the user would fix them. */
function validateImageToVideo(args: VideoArgs): Step<{ gateway: VideoGateway; model: string; image: string }> {
  const gateway = capableVideoGateway('imageToVideo');
  if (!gateway) {
    return stepFail(`The configured gateway (${runtime.config.gateway}) does not support image-to-video. (Tip: set output_format:"gif" to assemble frames into an animated GIF locally instead.)`);
  }
  if (!args.image) return stepFail('`image` (the first-frame reference) is required for video generation.');
  if (Array.isArray(args.fps)) {
    return stepFail('An fps array is only supported for GIF output (output_format:"gif"). For mp4, pass a single fps number.');
  }
  const model = args.model ?? runtime.config.imageToVideo.model;
  if (!model) return stepFail('No image-to-video model is configured. Run `npm run configure` to enable it (or pass an explicit `model`).');
  return stepOk({ gateway, model, image: args.image });
}

/** Validate, resolve the reference images and build the i2v run (nothing is generated yet). */
async function planImageToVideo(args: VideoArgs, signal: AbortSignal): Promise<Step<VideoRun>> {
  const valid = validateImageToVideo(args);
  if (!valid.ok) return valid;
  const { gateway, model, image } = valid.value;

  const cfg = runtime.config;
  const resolved = await resolveVideoReferences(args, image);
  if (!resolved.ok) return resolved;
  const references = resolved.value;
  const defaults = configuredVideoDefaults(cfg.imageToVideo, args.model);
  return stepOk({
    tool: 'image_to_video',
    gateway,
    params: {
      kind: 'image-to-video',
      prompt: args.prompt ?? null,
      model,
      edenProvider: cfg.imageToVideo.edenProvider,
      resolution: args.resolution ?? defaults.resolution,
      fps: typeof args.fps === 'number' ? Math.round(args.fps) : defaults.fps,
      duration: args.duration ?? defaults.duration,
      aspectRatio: args.aspect_ratio ?? null,
      references,
      extra: args.provider_options ?? null,
      signal,
      onProgress: (status) => runtime.logger.info('image_to_video progress', { status }),
    },
    model,
    configuredAsync: cfg.imageToVideo.async,
    wait: args.wait,
    label: args.prompt ?? 'image-to-video',
    output: resolveOutputOptions(args),
  });
}

/**
 * First frame, optional last frame, then extra references. For a single-reference configured
 * model the extras are REFUSED, not silently dropped: dropping them used to bill a clip that
 * ignored half of what was asked for.
 */
async function resolveVideoReferences(args: VideoArgs, firstFrame: string): Promise<Step<ReferenceImage[]>> {
  const refs: ReferenceImage[] = [{ ...(await resolveImageInput(firstFrame)), role: 'first_frame' }];
  const lastFrame = args.image_last ?? args.last_frame;
  if (lastFrame) refs.push({ ...(await resolveImageInput(lastFrame)), role: 'last_frame' });
  for (const r of args.reference_images ?? []) refs.push({ ...(await resolveImageInput(r)), role: 'reference' });

  const allowMulti = runtime.config.imageToVideo.multiReference || Boolean(args.model);
  if (allowMulti || refs.length <= 1) return stepOk(refs);
  return stepFail(
    `The configured image-to-video model (${runtime.config.imageToVideo.model}) takes a single image, so ` +
      '`image_last` / `reference_images` would be ignored. Nothing was submitted — remove them, or pass `model` to target a model that takes several frames.',
  );
}

// Arg shapes (a subset of the registered inputSchema), kept local for the two handlers.
interface GifArgs {
  image?: string;
  images_inner?: string[];
  image_last?: string;
  last_frame?: string;
  fps?: number | number[];
  loop?: number;
  max_colors?: number;
  optimize_palette?: boolean;
  fit?: 'cover' | 'contain' | 'fill';
  width?: number;
  height?: number;
  save?: boolean;
  output_mode?: string;
}
interface VideoArgs {
  image?: string;
  image_last?: string;
  last_frame?: string;
  prompt?: string;
  reference_images?: string[];
  model?: string;
  resolution?: string;
  fps?: number | number[];
  duration?: number;
  aspect_ratio?: string;
  provider_options?: Record<string, unknown>;
  save?: boolean;
  output_mode?: string;
  wait?: boolean;
  job_id?: string;
}
