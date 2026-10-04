import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { resolveOutputOptions, stepFail, stepOk, type Step, type ToolResult } from './helpers.js';
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

/** The subset of the registered input schema the text-to-video planner reads. */
interface TextToVideoArgs {
  prompt?: string;
  model?: string;
  resolution?: string;
  fps?: number;
  duration?: number;
  aspect_ratio?: string;
  provider_options?: Record<string, unknown>;
  save?: boolean;
  output_mode?: string;
  wait?: boolean;
}

/** Validate against the current gateway/config and build the text-to-video run (no network yet). */
function validateTextToVideo(args: TextToVideoArgs): Step<{ gateway: VideoGateway; model: string; prompt: string }> {
  const cfg = runtime.config;
  const gateway = capableVideoGateway('textToVideo');
  if (!gateway) return stepFail(`The configured gateway (${cfg.gateway}) does not support text-to-video.`);
  const model = args.model ?? cfg.textToVideo.model;
  if (!model) return stepFail('No text-to-video model is configured. Run `npm run configure` to enable it (or pass an explicit `model`).');
  // Optional in the schema only so a `job_id` poll validates; a generation needs one.
  const prompt = args.prompt?.trim();
  if (!prompt) return stepFail('A `prompt` is required to generate a video (or pass a `job_id` to poll a running job).');
  return stepOk({ gateway, model, prompt });
}

function planTextToVideo(args: TextToVideoArgs, signal: AbortSignal): Step<VideoRun> {
  const valid = validateTextToVideo(args);
  if (!valid.ok) return valid;
  const { gateway, model, prompt } = valid.value;
  const cfg = runtime.config;
  const defaults = configuredVideoDefaults(cfg.textToVideo, args.model);

  return stepOk({
    tool: 'generate_video',
    gateway,
    params: {
      kind: 'text-to-video',
      prompt,
      model,
      edenProvider: cfg.textToVideo.edenProvider,
      resolution: args.resolution ?? defaults.resolution,
      fps: args.fps ?? defaults.fps,
      duration: args.duration ?? defaults.duration,
      aspectRatio: args.aspect_ratio ?? null,
      references: [],
      extra: args.provider_options ?? null,
      signal,
      onProgress: (status) => runtime.logger.info('generate_video progress', { status }),
    },
    model,
    configuredAsync: cfg.textToVideo.async,
    wait: args.wait,
    label: prompt,
    output: resolveOutputOptions(args),
  });
}

export function registerGenerateVideo(server: McpServer): RegisteredTool {
  return server.registerTool(
    'generate_video',
    {
      title: 'Generate video (text-to-video)',
      description:
        'Generate a short video from a text prompt using the configured text-to-video model. ' +
        'Long-running (often a few minutes). The video is saved to the output directory and the path is returned.',
      inputSchema: {
        // Optional in the schema so a `{job_id}`-only poll validates; required at runtime otherwise.
        prompt: z.string().optional().describe('Text prompt describing the video to generate (required unless `job_id` is given).'),
        model: z.string().optional().describe(`Override the configured text-to-video model. ${MODEL_OVERRIDE_DEFAULTS_NOTE}`),
        resolution: z.string().optional().describe('Override the default resolution (e.g. "720p", "1080p").'),
        fps: z.number().int().positive().optional().describe('Override the default frames-per-second.'),
        duration: z.number().optional().describe('Override the default duration in seconds.'),
        aspect_ratio: z.string().optional().describe(VIDEO_ASPECT_RATIO_DESCRIPTION),
        provider_options: z.record(z.string(), z.any()).optional().describe('Raw gateway-specific fields (e.g. generate_audio for Veo, camera commands for MiniMax).'),
        save: z.boolean().optional().describe('Save the video to the output directory (default true).'),
        ...videoJobSchemaFields({ mp4Only: false }),
      },
    },
    async (args, extra): Promise<ToolResult> => {
      const jobId = (args.job_id as string | undefined)?.trim();
      if (jobId) {
        return pollVideoJob(jobId, 'text-to-video', 'text-to-video', 'generate_video');
      }
      try {
        const plan = planTextToVideo(args, extra.signal);
        return plan.ok ? await runVideoGeneration(plan.value) : plan.result;
      } catch (err) {
        return videoFailureResult('generate_video', err, args.model ?? runtime.config.textToVideo.model ?? '');
      }
    },
  );
}
