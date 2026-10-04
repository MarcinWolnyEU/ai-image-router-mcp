import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import type { ImageGenResult } from '../gateways/types.js';
import type { ImageJobMediaOpts } from '../state/generationJobs.js';
import { pollGenerationJob } from './jobs.js';
import { refreshOnReload } from './reloadable.js';
import { describeError, errorResult, type ToolResult } from './helpers.js';
import { buildGenerateImageSchema } from './generateImageSchema.js';
import { prepareImageRequest, type ImageRequest, type Phases } from './generateImageRequest.js';
import { imageJobRenderer, renderImageResult, renderOptsFromMedia } from './generateImageRender.js';

export type { ConstraintCheck } from './generateImageRender.js';

export function registerGenerateImage(server: McpServer): void {
  const tool = server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate one or more images from a text prompt using the configured model. ' +
        'Files are saved to the output directory and the absolute path is returned (plus an inline preview for small images). ' +
        'The options below reflect what the configured model supports; pass anything else via provider_options. ' +
        'Long generations can exceed a client timeout, so `wait:false` submits the job asynchronously and returns a `job_id` to poll. ' +
        'Models that support reference images accept `reference_images` (local paths / URLs / data-URLs).',
      inputSchema: buildGenerateImageSchema(),
    },
    async (args, extra): Promise<ToolResult> => {
      const a = args as Record<string, unknown>;
      // Phase timing — localize where a slow/timed-out call spends its time
      // (reference resolution vs. the gateway HTTP call vs. tinify post-proc).
      const t0 = Date.now();
      const phases: Phases = {};
      try {
        // ---- Poll mode: re-invoke with the job_id a previous `wait:false` returned. ----
        const jobId = a['job_id'] as string | undefined;
        if (jobId) {
          return await pollJob(jobId);
        }

        const prepared = await prepareImageRequest(a, extra.signal, phases);
        if (!prepared.ok) return prepared.result;
        const request = prepared.value;

        return request.waitForResult
          ? await generateAndRender(request, extra.signal, phases, t0)
          : submitBackgroundJob(request);
      } catch (err) {
        return await failureResult(err, t0, phases, extra.signal);
      }
    },
  );
  refreshOnReload(server, tool, () => ({ paramsSchema: buildGenerateImageSchema() }));
}

/**
 * Async submit: return a job_id immediately, generation runs detached. The runtime renders
 * the result eagerly when the job completes, using the output settings snapshotted here.
 */
function submitBackgroundJob(req: ImageRequest): ToolResult {
  const render = imageJobRenderer(req.media, { referenceDownloads: req.referenceDownloads, constraintSummary: req.constraintSummary });
  const { id, status } = runtime.submitGenerationJob('image', req.params, { model: req.params.model }, req.media, render);
  runtime.logger.info('generate_image: submitted async job', { jobId: id, status, ...req.requestInfo });
  const providerRequestId = runtime.getGenerationJob(id)?.requestId;
  return {
    content: [
      {
        type: 'text',
        text:
          `Image generation submitted as job ${id} (status: ${status}).` +
          (providerRequestId ? `\nProvider request id: ${providerRequestId}` : '') +
          `\nPoll with \`generate_image job_id:"${id}"\`.`,
      },
    ],
  };
}

/** Blocking mode: call the gateway, then save/convert/preview the result into the reply. */
async function generateAndRender(req: ImageRequest, signal: AbortSignal | undefined, phases: Phases, t0: number): Promise<ToolResult> {
  const result = await callGateway(req, signal, phases);
  runtime.health.lastImageAt = Date.now();
  runtime.health.generationCount += 1;

  const postStart = Date.now();
  const rendered = await renderImageResult(
    result,
    renderOptsFromMedia(req.media, { referenceDownloads: req.referenceDownloads, constraintSummary: req.constraintSummary, signal }),
  );
  phases.postProcessMs = Date.now() - postStart;

  runtime.logger.info('generate_image: done', { totalMs: Date.now() - t0, images: result.images.length, phases });
  return rendered;
}

/** The gateway call, with the timing/outcome logged either way (errors are rethrown). */
async function callGateway(req: ImageRequest, signal: AbortSignal | undefined, phases: Phases): Promise<ImageGenResult> {
  runtime.logger.info('generate_image: calling gateway', req.requestInfo);
  const gwStart = Date.now();
  try {
    const result = await req.gateway.generateImage(req.params);
    phases.gatewayMs = Date.now() - gwStart;
    runtime.logger.info('generate_image: gateway returned', {
      gatewayMs: phases.gatewayMs,
      images: result.images.length,
      modelUsed: result.modelUsed,
      cost: result.cost ?? null,
      ...req.requestInfo,
    });
    return result;
  } catch (gwErr) {
    phases.gatewayMs = Date.now() - gwStart;
    runtime.logger.error('generate_image: gateway failed', {
      gatewayMs: phases.gatewayMs,
      errorName: gwErr instanceof Error ? gwErr.name : 'unknown',
      error: gwErr instanceof Error ? gwErr.message : String(gwErr),
      clientAborted: signal?.aborted ?? false,
      ...req.requestInfo,
    });
    throw gwErr;
  }
}

/** Log + record a failed call and turn it into an error reply with the gateway's diagnostic hints. */
async function failureResult(err: unknown, t0: number, phases: Phases, signal: AbortSignal | undefined): Promise<ToolResult> {
  runtime.logger.error('generate_image: aborted', {
    totalMs: Date.now() - t0,
    errorName: err instanceof Error ? err.name : 'unknown',
    error: err instanceof Error ? err.message : String(err),
    clientAborted: signal?.aborted ?? false,
    phases,
  });
  runtime.health.recordError('generate_image', (err as Error).message);
  const causes = await runtime.gateway.diagnoseFailure?.(err, { model: runtime.config.image.model ?? '' }).catch(() => []);
  return errorResult(describeError(err), causes ?? []);
}

/**
 * Poll a previously-submitted background job. Returns a progress text while it is
 * running, the rendered result when it completes, or an error when it failed.
 */
function pollJob(jobId: string): Promise<ToolResult> {
  return pollGenerationJob(jobId, {
    kind: 'image',
    label: 'Generation',
    kindNoun: 'an image',
    tool: 'generate_image',
    // Rendered once (normally already, when the job finished). A job submitted without a
    // renderer renders from its mediaOpts snapshot.
    defaultRenderer: (job) => imageJobRenderer(job.mediaOpts as Partial<ImageJobMediaOpts> | undefined),
  });
}
