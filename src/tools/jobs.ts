import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { runtime } from '../state/runtime.js';
import type { GenerationJob, GenerationKind, JobRenderer } from '../state/generationJobs.js';
import { describeError, errorResult, textResult, type ToolContent, type ToolResult } from './helpers.js';

/** Reply for a failed background job — with the hints diagnosed from the real error when it failed. */
export function failedJobReply(job: GenerationJob): ToolResult {
  return errorResult(`Generation job ${job.id} failed: ${job.error ?? 'unknown error'}`, job.causes ?? []);
}

/** "The raw output was saved instead" — an error reply that still links the rescued files. */
function rescuedReply(job: GenerationJob, why: string, files: string[]): ToolResult {
  const r = errorResult(
    `Generation job ${job.id} completed, but its result could not be saved as requested: ${why}\n` +
      `The raw output was saved instead:\n${files.map((f) => `  ${f}`).join('\n')}`,
  );
  const links: ToolContent[] = files.map((f) => ({ type: 'resource_link', uri: pathToFileURL(f).href, name: basename(f), description: 'Raw generation output (unprocessed)' }));
  return { ...r, content: [...r.content, ...links] };
}

/**
 * Reply for a completed background job. The result is rendered (files saved) at most
 * once — normally eagerly when the job finished — and every poll gets that same reply,
 * so polling twice never writes a second copy of the files or re-runs Tinify. When the
 * render fails, the raw output is rescued to disk (once) and the reply says where; it
 * never throws.
 */
export async function completedJobReply(job: GenerationJob): Promise<ToolResult> {
  try {
    const rendered = await runtime.renderGenerationJob(job);
    if (rendered) return rendered as ToolResult;
  } catch (err) {
    job.renderError = describeError(err);
    const files = await runtime.rescueGenerationJob(job);
    if (files.length > 0) return rescuedReply(job, job.renderError, files);
    return errorResult(
      `Generation job ${job.id} completed, but its result could not be saved: ${job.renderError}\n` +
        'The result is still held in memory — fix the problem (e.g. the output directory) and poll again to retry.',
    );
  }
  // Nothing left to render: the raw payload was released (it is only released once rescued).
  if (job.rescuedFiles?.length) return rescuedReply(job, job.renderError ?? 'rendering failed', job.rescuedFiles);
  return errorResult(
    `Generation job ${job.id} completed, but its result was ${job.released ?? 'not retained'} before it could be saved. Submit the generation again.`,
  );
}

export interface PollOptions {
  /** The job kind this tool polls. */
  kind: GenerationKind;
  /** Noun for progress text, e.g. "Generation" or "text-to-video". */
  label: string;
  /** "an image" / "a text-to-video" — for the wrong-tool message. */
  kindNoun: string;
  /** Tool name to re-invoke (shown in the progress text). */
  tool: string;
  /** Renderer for a job submitted without one, built from its mediaOpts snapshot. */
  defaultRenderer: (job: GenerationJob) => JobRenderer;
}

/**
 * Poll a background generation job by id — shared by `generate_image`, `generate_video`
 * and `image_to_video`. Progress text while it runs, the rendered result when it completes,
 * the stored failure (with its hints) when it failed. Never throws: any unexpected failure
 * becomes an error result.
 */
export async function pollGenerationJob(jobId: string, o: PollOptions): Promise<ToolResult> {
  try {
    const job = runtime.getGenerationJob(jobId);
    if (!job) {
      return errorResult(`No generation job found for job_id "${jobId}". It may have been lost (the server restarted) or the id is wrong — submit a new one.`);
    }
    if (job.kind !== o.kind) {
      return errorResult(`job_id "${jobId}" is a ${job.kind} job, not ${o.kindNoun} job — use the matching tool to poll it.`);
    }
    if (job.status === 'queued' || job.status === 'in-progress') {
      const progressText = job.progress ? ` (${job.progress})` : '';
      const req = job.requestId ? ` Provider request id: ${job.requestId}` : '';
      return textResult(`${o.label} job ${jobId} is ${job.status}${progressText}.${req}\nPoll again with \`${o.tool} job_id:"${jobId}"\`.`);
    }
    if (job.status === 'failed') return failedJobReply(job);
    job.render ??= o.defaultRenderer(job);
    return await completedJobReply(job);
  } catch (err) {
    runtime.health.recordError(o.tool, (err as Error).message);
    return errorResult(describeError(err));
  }
}
