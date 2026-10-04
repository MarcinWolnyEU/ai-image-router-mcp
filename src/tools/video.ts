import { z } from 'zod';
import { runtime } from '../state/runtime.js';
import { extFromMime, saveMedia } from '../util/files.js';
import type { GenerationKind, JobRenderer, VideoJobMediaOpts } from '../state/generationJobs.js';
import type { Gateway, GeneratedVideo, VideoGenParams, VideoGenResult } from '../gateways/types.js';
import { describeError, errorResult, renderMediaContent, textResult, OUTPUT_MODE_DESCRIPTION, type OutputMode, type ToolContent, type ToolResult } from './helpers.js';
import { pollGenerationJob } from './jobs.js';

/** Save generated videos to the output dir and build the tool result content. */
export async function buildVideoResult(result: VideoGenResult, label: string, save: boolean, outputMode: OutputMode = 'filePath'): Promise<ToolResult> {
  // base64 needs the bytes on disk first; force a save.
  if (outputMode === 'base64') save = true;
  const lines = videoHeaderLines(result, save);
  const media: ToolContent[] = [];
  for (const [i, v] of result.videos.entries()) {
    const out = await videoContent(v, i + 1, label, save, outputMode);
    lines.push(...out.lines);
    media.push(...out.media);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }, ...media] };
}

/** Model, cost, adaptation notes, and the save:false caveat. */
function videoHeaderLines(result: VideoGenResult, save: boolean): string[] {
  const lines: string[] = [`Generated ${result.videos.length} video(s) using ${result.modelUsed}.`];
  if (result.cost != null) lines.push(`Reported cost: $${result.cost}`);
  // How the request was adapted (tuning params dropped on a resubmit, a different model ran, …).
  for (const w of result.warnings ?? []) lines.push(`Note: ${w}`);
  if (!save) lines.push(UNSAVED_VIDEO_NOTE);
  return lines;
}

/** One video: saved file (+ output_mode content), or — not saved / no bytes — its remote link. */
async function videoContent(v: GeneratedVideo, idx: number, label: string, save: boolean, outputMode: OutputMode): Promise<{ lines: string[]; media: ToolContent[] }> {
  const ext = extFromMime(v.mimeType, 'mp4');
  if (v.bytes && save) {
    const saved = await saveMedia(runtime.outputDir(), v.bytes, ext, label);
    const media = await renderMediaContent({
      bytes: v.bytes,
      mimeType: v.mimeType,
      saved,
      outputMode,
      inline: false,
      previewMaxBytes: runtime.config.output.previewMaxBytes,
      description: `Generated video #${idx}`,
    });
    return { lines: [`#${idx}: ${saved.path}` + (v.sourceUrl ? `  (source: ${v.sourceUrl})` : '')], media };
  }
  if (!v.sourceUrl) return { lines: [], media: [] };
  // Remote URL only (no bytes, or save:false) — base64 isn't possible, fall back to a link.
  return {
    lines: [`#${idx}: ${v.sourceUrl}`],
    media: [{ type: 'resource_link', uri: v.sourceUrl, name: `video-${idx}.${ext}`, mimeType: v.mimeType, description: `Generated video #${idx} (remote URL)` }],
  };
}

/** save:false keeps nothing locally; the provider link is all that is returned — and it is not public. */
const UNSAVED_VIDEO_NOTE =
  'Not saved (save:false) — no local copy was kept. A provider URL listed below may require your provider API key ' +
  '(e.g. an `Authorization` header) to download and may expire; use save:true to keep the video.';

/** Shared `aspect_ratio` description for the video tools. */
export const VIDEO_ASPECT_RATIO_DESCRIPTION =
  'Frame shape as width:height (e.g. "16:9", "9:16", "1:1"), passed to the model when it has such a field. ' +
  'Many image-to-video models take the shape from the input image and ignore it.';

/** How a `model` override interacts with the configured defaults (both video tools). */
export const MODEL_OVERRIDE_DEFAULTS_NOTE =
  'The configured default resolution/fps/duration were chosen for the configured model, so with a different model ' +
  'they are NOT applied — pass them explicitly if that model needs them.';

/**
 * The configured default resolution/fps/duration — only when the call targets the configured
 * model. Those defaults were picked (by the wizard) for THAT model; sent to an override they
 * cause provider rejections (fal Hailuo 422 on Cosmos' 2 s duration) and resubmits.
 */
export function configuredVideoDefaults(
  cfg: { model: string | null; defaultResolution: string | null; defaultFps: number | null; defaultDuration: number | null },
  overrideModel: string | undefined,
): { resolution: string | null; fps: number | null; duration: number | null } {
  if (overrideModel && overrideModel !== cfg.model) return { resolution: null, fps: null, duration: null };
  return { resolution: cfg.defaultResolution, fps: cfg.defaultFps, duration: cfg.defaultDuration };
}

/** Renders a finished video job with the output settings captured at submit (run once, when it completes). */
export function videoJobRenderer(mo: VideoJobMediaOpts): JobRenderer {
  return (result) => buildVideoResult(result as VideoGenResult, mo.label, mo.save, mo.outputMode);
}

/**
 * Poll a previously-submitted video generation job (see `pollGenerationJob`). `kind` is
 * the job kind expected by this tool (image-to-video / text-to-video). Never throws.
 */
export function pollVideoJob(jobId: string, kind: GenerationKind, label: string, pollTool: string): Promise<ToolResult> {
  return pollGenerationJob(jobId, {
    kind,
    label,
    kindNoun: `a ${label}`,
    tool: pollTool,
    // A job submitted without a renderer renders from its mediaOpts snapshot.
    defaultRenderer: (job) => {
      const mo = job.mediaOpts as Partial<VideoJobMediaOpts> | undefined;
      const outputMode: OutputMode = mo?.outputMode ?? 'filePath';
      return videoJobRenderer({ label: mo?.label ?? label, save: outputMode === 'base64' ? true : (mo?.save ?? true), outputMode });
    },
  });
}

/** The `output_mode` / `wait` / `job_id` inputs both video tools share (client-visible text is identical bar the `wait` lead-in). */
export function videoJobSchemaFields(opts: { mp4Only: boolean }) {
  const lead = opts.mp4Only ? 'mp4 only: override' : 'Override';
  return {
    output_mode: z.enum(['filePath', 'base64']).optional().describe(OUTPUT_MODE_DESCRIPTION),
    wait: z.boolean().optional().describe(`${lead} the configured async mode for this call. true = block until the video is ready; false = submit a background job and return a \`job_id\` to poll. Omit to use the configured mode (default async).`),
    job_id: z.string().optional().describe('Poll a background video job submitted earlier with `wait:false`. When present, the other params are ignored, and the result uses the output settings captured at submit. Re-invoke until it reports "completed" or "failed".'),
  };
}

/** A gateway known to support the video kind asked for (so `generateVideo` is callable). */
export type VideoGateway = Gateway & { generateVideo: NonNullable<Gateway['generateVideo']> };

/** The CURRENT gateway (read at call time) if it supports `cap` and can generate video, else null. */
export function capableVideoGateway(cap: 'textToVideo' | 'imageToVideo'): VideoGateway | null {
  const gw = runtime.gateway;
  return gw.capabilities[cap] && gw.generateVideo ? (gw as VideoGateway) : null;
}

/** Everything the shared submit / wait / render flow needs for one video generation. */
export interface VideoRun {
  /** The MCP tool name, used in logs and in the "poll with" hint. */
  tool: 'generate_video' | 'image_to_video';
  gateway: VideoGateway;
  params: VideoGenParams;
  model: string;
  /** The configured async default for this generation type (`config.<type>.async`). */
  configuredAsync: boolean;
  /** Per-call `wait` override. */
  wait: boolean | undefined;
  /** Stem/label for the saved file(s). */
  label: string;
  output: { outputMode: OutputMode; save: boolean };
}

/**
 * Run a planned video generation: submit a background job and return its `job_id` (async —
 * a slow generation never holds an MCP call open past a client timeout), or block for the
 * result and render it. The configured mode is overridable per call via `wait`.
 */
export async function runVideoGeneration(run: VideoRun): Promise<ToolResult> {
  const { tool, gateway, params, model, output } = run;
  // Pre-billing: a request the gateway knows it cannot honour is refused here, for free —
  // before a sync call, and before a background job is even created.
  const refusal = await gateway.checkVideoRequest?.(params).catch(() => null);
  if (refusal) return errorResult(refusal);
  const waitForResult = run.wait ?? !run.configuredAsync;
  if (waitForResult) {
    const result = await gateway.generateVideo(params);
    runtime.health.lastVideoAt = Date.now();
    runtime.health.generationCount += 1;
    return buildVideoResult(result, run.label, output.save, output.outputMode);
  }

  const mediaOpts: VideoJobMediaOpts = { label: run.label, save: output.save, outputMode: output.outputMode };
  const { id, status } = runtime.submitGenerationJob(params.kind, params, { model }, mediaOpts, videoJobRenderer(mediaOpts));
  runtime.logger.info(`${tool}: submitted async job`, { jobId: id, status, model });
  const req = runtime.getGenerationJob(id)?.requestId;
  const noun = params.kind === 'text-to-video' ? 'Text-to-video' : 'Image-to-video';
  return textResult(`${noun} job submitted as ${id} (status: ${status}).` + (req ? `\nProvider request id: ${req}` : '') + `\nPoll with \`${tool} job_id:"${id}"\`.`);
}

/** The error reply for a failed video call: records it in health and adds the gateway's account/config hints. */
export async function videoFailureResult(tool: string, err: unknown, model: string): Promise<ToolResult> {
  runtime.health.recordError(tool, (err as Error).message);
  const causes = await runtime.gateway.diagnoseFailure?.(err, { model }).catch(() => []);
  return errorResult(describeError(err), causes ?? []);
}
