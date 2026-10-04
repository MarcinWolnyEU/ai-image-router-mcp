import type { GatewayId } from '../config/schema.js';
import type { ImageGenResult, VideoGenResult } from '../gateways/types.js';

export type GenerationKind = 'image' | 'image-to-video' | 'text-to-video';
/** A finished generation: an image result or a video result (never both). */
export type GenerationResult = ImageGenResult | VideoGenResult;
export type GenerationJobStatus = 'queued' | 'in-progress' | 'completed' | 'failed';

/** Output/processing preferences snapshot at submit time; reused when the job completes. */
export interface ImageJobMediaOpts {
  format: 'png' | 'webp' | 'jpg' | 'avif' | 'ico' | null;
  tinifyKey: string | null;
  outputMode: 'filePath' | 'base64';
  save: boolean;
  inline: boolean;
  label: string;
  /** Target ICO width/size (only meaningful when format is 'ico'). */
  icoSize?: number;
  /** How a non-square result is squared for an ICO ('pad' keeps everything, 'crop' center-crops). */
  squareFit?: 'pad' | 'crop';
  /** Padding colour for squareFit 'pad' ('transparent' or a hex). */
  padColor?: string;
  /** Palette/background constraints to verify the finished image against. */
  check?: { palette?: string[]; background?: string; tolerance?: number; enabled: boolean };
  /** The exact pixel size the caller asked for (non-ico), so the reply can say when a model ignored it. */
  requestedSize?: { width: number; height: number };
}
export interface VideoJobMediaOpts {
  label: string;
  save: boolean;
  outputMode: 'filePath' | 'base64';
}
export type GenerationJobMediaOpts = ImageJobMediaOpts | VideoJobMediaOpts;

/**
 * The tool reply a finished job rendered to (saved-file links, previews, text).
 * Structural on purpose, so `state/` doesn't import `tools/` — a `ToolResult` fits it.
 */
export interface RenderedJobResult {
  content: Array<{ type: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

/** Saves a finished generation and builds its reply. Supplied by the tool at submit time. */
export type JobRenderer = (result: GenerationResult) => Promise<RenderedJobResult>;

/**
 * A long-running generation (image / image-to-video / text-to-video) tracked by
 * the server so a slow provider call is decoupled from the MCP request that
 * submitted it. The MCP client polls by `id` (the `job_id` returned at submit)
 * instead of keeping a blocking call open past its own timeout. In-memory only:
 * a job that was in flight when the process restarts is gone (the client gets a
 * clear "job not found" and resubmits).
 *
 * A completed job is rendered ONCE (eagerly, when it finishes): its files are saved
 * and every poll returns that same reply, so a repeated poll never re-saves files or
 * re-bills Tinify. The raw media bytes are dropped after rendering.
 */
export interface GenerationJob {
  id: string;
  gateway: GatewayId;
  model: string;
  kind: GenerationKind;
  status: GenerationJobStatus;
  /** Latest human-readable progress (e.g. "submitted", "IN_PROGRESS", "completed"). */
  progress?: string;
  /** Provider's native remote job id when surfaced (fal request_id, Eden public_id). */
  requestId?: string;
  /** The raw generation — held only until it is rendered (or released). */
  result?: GenerationResult;
  /** User-facing failure message (failed jobs). */
  error?: string;
  /** "Possible cause" hints computed from the REAL error object when the job failed. */
  causes?: string[];
  createdAt: number;
  updatedAt: number;
  /** When the job reached completed/failed (drives the payload TTL). */
  finishedAt?: number;
  mediaOpts?: GenerationJobMediaOpts;
  /** Renders `result` into the reply; run once, memoised in `rendered`. */
  render?: JobRenderer;
  /** The memoised reply every poll of a completed job returns. */
  rendered?: RenderedJobResult;
  /** In-flight render shared by concurrent polls. */
  renderInFlight?: Promise<RenderedJobResult>;
  /** Why the media payload was released from memory (TTL / memory budget), when it was. */
  released?: string;
  /** The last render failure (the result could not be saved/processed as requested). */
  renderError?: string;
  /**
   * Raw output written to disk AS-IS because rendering failed — so a paid generation is never
   * lost. Only once these exist may the store drop an unrendered `result` from memory.
   */
  rescuedFiles?: string[];
}

/**
 * A completed job whose raw result exists ONLY in memory: never rendered (saved) and never
 * rescued to disk. Dropping it would lose a paid generation, so the store's bounds skip it.
 */
export function isUnsavedResult(job: GenerationJob): boolean {
  return job.status === 'completed' && job.result != null && job.rendered == null && !job.rescuedFiles?.length;
}

export interface GenerationJobStoreOptions {
  /** Keep at most this many completed/failed jobs before deleting the oldest. Default 200. */
  maxJobs?: number;
  /** Media bytes (raw results + rendered base64) retained across finished jobs. Default 256 MiB. */
  maxRetainedBytes?: number;
  /** A finished job's media payload is released this long after it finished. Default 60 min. */
  finishedTtlMs?: number;
  now?: () => number;
}

const isFinished = (j: GenerationJob): boolean => j.status === 'completed' || j.status === 'failed';
const formatDuration = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
const finishedTime = (j: GenerationJob): number => j.finishedAt ?? j.updatedAt;

/** Bytes of the raw media in a finished generation (image bytes, or video bytes where present). */
function resultBytes(r: GenerationResult): number {
  if ('images' in r) return r.images.reduce((n, img) => n + img.bytes.length, 0);
  return r.videos.reduce((n, v) => n + (v.bytes?.length ?? 0), 0);
}

/** Bytes of inline base64 (image data / embedded resource blobs) in a rendered reply. */
function renderedBytes(rendered: RenderedJobResult | undefined): number {
  let n = 0;
  for (const block of rendered?.content ?? []) {
    if (typeof block['data'] === 'string') n += block['data'].length;
    const res = block['resource'] as { blob?: unknown } | undefined;
    if (typeof res?.blob === 'string') n += res.blob.length;
  }
  return n;
}

/** Bytes of media a job keeps in memory: the raw result plus any base64 in its rendered reply. */
export function retainedBytes(job: GenerationJob): number {
  return (job.result ? resultBytes(job.result) : 0) + renderedBytes(job.rendered);
}

/**
 * Bounded in-memory generation job store. Active jobs are never touched. Finished
 * jobs keep their media payload for `finishedTtlMs` and within `maxRetainedBytes`;
 * past either bound the payload is RELEASED (raw bytes and inline base64 dropped,
 * the reply's text + file links kept — the files are already on disk), and past
 * `maxJobs` the oldest finished jobs are deleted outright. A completed job whose raw
 * result was never saved (`isUnsavedResult`) is exempt from all three until the runtime
 * renders it or rescues it to disk.
 */
export class GenerationJobStore {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly maxJobs: number;
  private readonly maxRetainedBytes: number;
  private readonly finishedTtlMs: number;
  private readonly now: () => number;

  constructor(opts: GenerationJobStoreOptions = {}) {
    this.maxJobs = opts.maxJobs ?? 200;
    this.maxRetainedBytes = opts.maxRetainedBytes ?? 256 * 1024 * 1024;
    this.finishedTtlMs = opts.finishedTtlMs ?? 60 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  put(job: GenerationJob): void {
    this.jobs.set(job.id, job);
    this.prune(job.id);
  }

  get(id: string): GenerationJob | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  /** Re-apply the bounds after a job's payload changed (finished / rendered). */
  touch(): void {
    this.prune();
  }

  private prune(newestId?: string): void {
    const finished = [...this.jobs.values()].filter(isFinished).sort((a, b) => finishedTime(a) - finishedTime(b));

    // 1. Age: release payloads held longer than the TTL.
    const now = this.now();
    for (const j of finished) {
      if (now - finishedTime(j) > this.finishedTtlMs) releasePayload(j, `released ${formatDuration(this.finishedTtlMs)} after the job finished`);
    }
    // 2. Memory: release the oldest payloads until the total fits the budget.
    let total = finished.reduce((sum, j) => sum + retainedBytes(j), 0);
    for (const j of finished) {
      if (total <= this.maxRetainedBytes) break;
      const bytes = retainedBytes(j);
      if (bytes === 0) continue;
      total -= bytes;
      releasePayload(j, 'released to stay within the job-store memory budget');
    }
    // 3. Count: delete the oldest finished jobs outright — never one holding an unsaved result.
    if (this.jobs.size <= this.maxJobs) return;
    const deletable = finished.filter((j) => j.id !== newestId && !isUnsavedResult(j));
    for (const j of deletable.slice(0, this.jobs.size - this.maxJobs)) this.jobs.delete(j.id);
  }
}

/**
 * Drop a finished job's media from memory. A rendered reply keeps its text and file
 * links (small, and the files are on disk) plus a note; inline previews/base64 go.
 * An unsaved raw result is the ONLY copy of a paid generation and is never dropped —
 * only once the runtime has rescued it to disk (`rescuedFiles`).
 */
function releasePayload(job: GenerationJob, reason: string): void {
  // A render in flight is about to save the result to disk — let it finish; the next prune sees it.
  if (job.released || job.renderInFlight || retainedBytes(job) === 0) return;
  if (isUnsavedResult(job)) return;
  job.result = undefined;
  if (job.rendered) {
    const kept = job.rendered.content.filter((b) => b.type === 'text' || b.type === 'resource_link');
    kept.push({ type: 'text', text: `Note: this job's inline media was ${reason}; the saved files listed above are unaffected.` });
    job.rendered = { ...job.rendered, content: kept };
  }
  job.released = reason;
}
