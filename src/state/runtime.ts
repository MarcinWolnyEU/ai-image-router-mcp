import { randomUUID } from 'node:crypto';
import { AppConfig, loadConfig, resolveToken } from '../config/schema.js';
import { CAPABILITY_CACHE_PATH, resolvePath } from '../config/paths.js';
import { FileCapabilityCache } from './capabilityCache.js';
import { Logger } from '../logging/logger.js';
import { createGateway } from '../gateways/registry.js';
import { setHttpLogger } from '../util/http.js';
import { extFromMime, mediaStem, writeMediaFile } from '../util/files.js';
import type { Gateway, ImageGenParams, ImageGenResult, VideoGenParams, VideoGenResult } from '../gateways/types.js';
import type { BgModelKey, DownloadProgress } from '../bgremoval/models.js';
import { describeError } from '../tools/helpers.js';
import { HealthState } from './health.js';
import {
  GenerationJobStore,
  type GenerationJob,
  type GenerationJobMediaOpts,
  type GenerationJobStatus,
  type GenerationKind,
  type JobRenderer,
  type RenderedJobResult,
} from './generationJobs.js';

export type ShutdownHook = (reason: string) => void | Promise<void>;

/** What the runtime needs from a background remover (BiRefNetRemover; a fake in tests). */
export interface BackgroundRemover {
  readonly modelKey: string;
  readonly activeEP: string;
  init(onProgress?: DownloadProgress): Promise<void>;
  removeBackground(input: Buffer): Promise<Buffer>;
  /** Release the native ONNX session (dropping the JS reference does not free its GBs). */
  dispose(): Promise<void>;
}

/** Builds (but does not init) a remover. Lazily imports onnxruntime by default. */
export type RemoverFactory = (modelKey: BgModelKey, executionProvider: string, modelsDir: string, logger: Logger) => Promise<BackgroundRemover>;

const defaultRemoverFactory: RemoverFactory = async (modelKey, executionProvider, modelsDir, logger) => {
  const { BiRefNetRemover } = await import('../bgremoval/birefnet.js');
  return new BiRefNetRemover(modelKey, executionProvider, modelsDir, logger);
};

/**
 * Process-wide runtime: holds the active config, resolved token, gateway client,
 * logger, and health state. `reload()` performs an in-process soft restart.
 */
export class Runtime {
  config!: AppConfig;
  token!: string;
  /** Resolved Tinify key, or null when not configured. */
  tinifyToken: string | null = null;
  /** Shared secret required on the HTTP transport, or null (no auth). */
  httpAuthToken: string | null = null;
  gateway!: Gateway;
  logger!: Logger;
  readonly health = new HealthState();

  private shutdownHook: ShutdownHook | null = null;
  /** Lazily-created background remover. Released and cleared on reload. */
  remover: BackgroundRemover | null = null;
  private removerInit: Promise<BackgroundRemover> | null = null;
  /** Bumped by every applied config: an init that started under an older generation is stale. */
  private removerGeneration = 0;
  /** Seam for tests; the default lazily loads BiRefNetRemover (onnxruntime). */
  removerFactory: RemoverFactory = defaultRemoverFactory;
  /** In-memory async generation-jobs (submit → poll by `job_id`). See `generationJobs.ts`. */
  private readonly generationJobs = new GenerationJobStore();
  private readonly reloadListeners = new Set<() => void>();
  /** Persisted capability answers: a warm start skips the network lookup in `prepare()`. */
  private readonly capabilityCache = new FileCapabilityCache(CAPABILITY_CACHE_PATH);

  async init(): Promise<void> {
    await this.applyConfig(await loadConfig());
  }

  /**
   * Make `cfg` the live configuration. Two phases: everything that can fail (token
   * resolution, logger, gateway construction) is resolved into LOCALS first, then
   * committed to the live fields in one synchronous step. A config that fails to
   * apply (missing token file, empty secret, …) therefore leaves the running state
   * exactly as it was — never `config` describing the new setup while `gateway`,
   * tokens and HTTP auth are still the old ones.
   */
  private async applyConfig(cfg: AppConfig): Promise<void> {
    // ---- Phase 1: resolve (may throw — nothing live is touched yet) ----
    const token = await resolveToken(cfg.token);
    // A configured auth token that can't be resolved (or is empty) fails the whole
    // apply: falling back to "no auth" would silently expose the HTTP transport.
    const httpAuthToken = cfg.http.authToken ? await resolveToken(cfg.http.authToken) : null;
    const logger = new Logger(cfg.logging.policy, cfg.logging.dir);
    await logger.init();
    const tinifyToken = await this.resolveTinifyToken(cfg, logger);
    const gateway = createGateway(cfg.gateway, token, logger);

    // Nothing below can throw, so the new setup is now certain to be committed.
    // Record raw upstream HTTP failures (status + body) so the log is self-sufficient
    // for diagnosis — no live API re-probe needed. Bound to the new logger.
    setHttpLogger((f) => {
      logger.warn('HTTP request failed', {
        method: f.method,
        url: f.url,
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.error !== undefined ? { error: f.error } : {}),
        ...(f.body ? { body: f.body } : {}),
        attempt: f.attempt,
        willRetry: f.willRetry,
      });
    });
    // Warm the gateway's per-model capability cache (OpenRouter: which params the
    // configured image model actually takes) so tool schemas built right after this
    // reflect the model. A persisted answer makes this instant (no network on a warm
    // start — stdio clients spawn a process per session, Vibe per tool call); only a cold
    // start waits, and then within a bound — never blocks startup on a slow API for long.
    if (gateway.prepare) {
      const timeout = new Promise<void>((r) => setTimeout(r, 12_000).unref());
      await Promise.race([
        gateway.prepare({ imageModel: cfg.image.model, cache: this.capabilityCache }).catch((err: unknown) => {
          logger.warn('Gateway prepare() failed; continuing with static defaults', { error: (err as Error).message });
        }),
        timeout,
      ]);
    }

    // ---- Phase 2: commit (synchronous) ----
    this.config = cfg;
    this.logger = logger;
    this.token = token;
    this.tinifyToken = tinifyToken;
    this.httpAuthToken = httpAuthToken;
    this.gateway = gateway;
    // Force a fresh ONNX session for the new config. The old one is RELEASED (its native
    // memory isn't freed by dropping the reference), and any init still loading becomes
    // stale: the generation bump stops it from installing itself when it finishes.
    const previous = this.remover;
    this.removerGeneration += 1;
    this.remover = null;
    this.removerInit = null;
    if (previous) void this.disposeRemover(previous, logger);
    this.health.backgroundModelStatus = cfg.backgroundRemoval.model === 'none' ? 'disabled' : 'pending';
    logger.info('Configuration applied', {
      gateway: cfg.gateway,
      imageModel: cfg.image.model,
      backgroundRemoval: cfg.backgroundRemoval.model,
      logging: cfg.logging.policy,
    });
  }

  /** Optional Tinify key: a resolution failure disables Tinify (recorded), never the apply. */
  private async resolveTinifyToken(cfg: AppConfig, logger: Logger): Promise<string | null> {
    if (!cfg.tinify) return null;
    try {
      return await resolveToken(cfg.tinify.token);
    } catch (err) {
      this.health.recordError('tinify-token', (err as Error).message);
      logger.warn('Tinify token could not be resolved; compression/WebP disabled', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Soft restart: re-read config and re-init gateway + ONNX session in place. On
   * failure the previous configuration stays fully active (see `applyConfig`).
   */
  async reload(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.applyConfig(await loadConfig());
      this.health.markReloaded();
      for (const listener of this.reloadListeners) {
        try {
          listener();
        } catch (err) {
          this.logger.warn('Reload listener failed', { error: (err as Error).message });
        }
      }
      return { ok: true, message: 'Configuration reloaded successfully.' };
    } catch (err) {
      const message = (err as Error).message;
      this.health.recordError('reload', message);
      this.logger?.error('Reload failed; the previous configuration is still active', { error: message });
      return { ok: false, message: `${message} (the previous configuration is still active)` };
    }
  }

  /**
   * Run `listener` after every SUCCESSFUL reload — used to refresh state derived from
   * the config at registration time (tool schemas built from the gateway + model).
   * Returns an unsubscribe function.
   */
  onReload(listener: () => void): () => void {
    this.reloadListeners.add(listener);
    return () => {
      this.reloadListeners.delete(listener);
    };
  }

  /**
   * Lazily download (if needed) + initialise the background remover, caching the
   * single in-flight init so concurrent calls share one download/session.
   *
   * An init is bound to the config generation it started under. If a `restart` lands
   * while it loads, it never installs itself (that would resurrect the OLD model/EP over
   * the new config), never touches health or the newer in-flight init, and releases its
   * session; whoever awaited it is handed the current config's remover instead.
   */
  async getRemover(): Promise<BackgroundRemover> {
    const modelKey = this.config.backgroundRemoval.model;
    if (modelKey === 'none') {
      throw new Error('Background removal is disabled. Run `npm run configure` and select birefnet-general or birefnet-massive.');
    }
    if (this.remover) return this.remover;
    if (this.removerInit) return this.removerInit;

    const generation = this.removerGeneration;
    const { executionProvider, modelsDir } = this.config.backgroundRemoval;
    const logger = this.logger;
    const current = (): boolean => generation === this.removerGeneration;
    let init: Promise<BackgroundRemover> | null = null;
    init = (async (): Promise<BackgroundRemover> => {
      this.health.backgroundModelStatus = 'downloading';
      let r: BackgroundRemover | null = null;
      try {
        r = await this.removerFactory(modelKey, executionProvider, modelsDir, logger);
        await r.init((p) => {
          if (p.phase === 'download' && current()) this.health.backgroundModelStatus = 'downloading';
          logger.info('background-removal model', p);
        });
      } catch (err) {
        if (current()) {
          this.health.backgroundModelStatus = 'error';
          this.health.backgroundModelError = (err as Error).message;
          this.health.recordError('background-removal-init', (err as Error).message);
          if (this.removerInit === init) this.removerInit = null; // allow a retry
        }
        if (r) void this.disposeRemover(r, logger);
        throw err;
      }
      if (!current()) {
        logger.info('background-removal: a restart replaced the config during init; discarding the stale session', { model: modelKey });
        void this.disposeRemover(r, logger);
        return this.getRemover();
      }
      this.health.activeExecutionProvider = r.activeEP;
      this.health.backgroundModelStatus = 'ready';
      this.remover = r;
      return r;
    })();
    this.removerInit = init;
    return init;
  }

  /** Release a remover's native session; never throws. */
  private async disposeRemover(r: BackgroundRemover, logger: Logger): Promise<void> {
    try {
      await r.dispose();
    } catch (err) {
      logger.warn('background-removal: releasing the previous ONNX session failed', { error: (err as Error).message });
    }
  }

  outputDir(): string {
    return resolvePath(this.config.output.dir);
  }

  /**
   * Submit a long-running generation (image / image-to-video / text-to-video) as a
   * background job and return its `{ id, status }` immediately. The job runs the
   * gateway's blocking `generateImage`/`generateVideo` with NO client abort signal
   * (so it keeps running after the MCP call returns), and progress / result / error
   * are captured on the job for a later poll by `getGenerationJob(id)`. Processing
   * preferences (`mediaOpts`) are snapshotted so the poll can render the finished
   * result without the caller re-specifying them.
   *
   * With a `render` function the finished result is saved and rendered ONCE, right
   * when it completes (so a paid result reaches disk even if nobody polls), and every
   * poll returns that same reply. A failure's "possible cause" hints are computed
   * here from the real error object (typed HTTP/OpenRouter errors), not re-derived
   * from a message string at poll time.
   */
  submitGenerationJob(
    kind: GenerationKind,
    params: ImageGenParams | VideoGenParams,
    meta: { model: string },
    mediaOpts: GenerationJobMediaOpts,
    render?: JobRenderer,
  ): { id: string; status: GenerationJobStatus } {
    const id = randomUUID();
    // Bind the job to the gateway that runs it — a `restart` mid-job must not
    // re-attribute it (or its failure diagnosis) to a different gateway.
    const gateway = this.gateway;
    const gatewayId = this.config.gateway;
    const job: GenerationJob = {
      id,
      gateway: gatewayId,
      model: meta.model,
      kind,
      status: 'queued',
      progress: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mediaOpts,
      ...(render ? { render } : {}),
    };
    this.generationJobs.put(job);

    const onProgress = (status: string, meta2?: { requestId?: string }): void => {
      job.progress = status;
      if (meta2?.requestId) job.requestId = meta2.requestId;
      job.updatedAt = Date.now();
    };

    this.logger.info('generation job: submitted', { id, gateway: gatewayId, model: meta.model, kind });

    // Run the blocking gateway call in the background, detached from the client
    // abort signal (the whole point of async jobs). Never rethrow — capture on job.
    void (async () => {
      job.status = 'in-progress';
      job.progress = 'in-progress';
      job.updatedAt = Date.now();
      try {
        let result: ImageGenResult | VideoGenResult;
        if (kind === 'image') {
          result = await gateway.generateImage({ ...(params as ImageGenParams), signal: undefined, onProgress });
        } else if (gateway.generateVideo) {
          result = await gateway.generateVideo({ ...(params as VideoGenParams), signal: undefined, onProgress });
        } else {
          throw new Error(`Configured gateway (${gatewayId}) does not support ${kind}.`);
        }
        job.result = result;
        let count = 0;
        if (kind === 'image') {
          this.health.lastImageAt = Date.now();
          if ('images' in result) count = result.images.length;
        } else {
          this.health.lastVideoAt = Date.now();
          if ('videos' in result) count = result.videos.length;
        }
        this.health.generationCount += 1;
        if (job.render) {
          job.progress = 'saving';
          // A render failure keeps the raw result for a retry on the next poll AND writes it
          // to disk as-is, so the paid output survives even if nobody ever polls.
          await this.renderGenerationJob(job).catch(async (err: unknown) => {
            job.renderError = describeError(err);
            this.logger.warn('generation job: saving the result failed; raw output rescued, render retried on poll', { id, error: job.renderError });
            await this.rescueGenerationJob(job);
          });
        }
        job.status = 'completed';
        job.progress = 'completed';
        job.updatedAt = job.finishedAt = Date.now();
        this.generationJobs.touch();
        this.logger.info('generation job: completed', { id, gateway: gatewayId, model: meta.model, kind, count });
      } catch (err) {
        job.error = describeError(err);
        job.causes = (await gateway.diagnoseFailure?.(err, { model: meta.model }).catch(() => [])) ?? [];
        job.status = 'failed';
        job.progress = 'failed';
        job.updatedAt = job.finishedAt = Date.now();
        this.generationJobs.touch();
        this.logger.error('generation job: failed', { id, gateway: gatewayId, model: meta.model, kind, error: (err as Error).message });
        this.health.recordError('generation-job', (err as Error).message);
      }
    })();

    return { id, status: job.status };
  }

  getGenerationJob(id: string): GenerationJob | undefined {
    return this.generationJobs.get(id);
  }

  /**
   * The reply for a completed job, rendered at most once: concurrent and repeated
   * polls share one render (no duplicate files, no repeated Tinify billing). After a
   * successful render the raw media bytes are dropped — the reply is all a poll needs.
   * Resolves undefined when there is nothing to render (no renderer, or the payload
   * was already released from memory).
   */
  renderGenerationJob(job: GenerationJob): Promise<RenderedJobResult | undefined> {
    if (job.rendered) return Promise.resolve(job.rendered);
    const render = job.render;
    const result = job.result;
    if (!render || !result) return Promise.resolve(undefined);
    if (job.renderInFlight) return job.renderInFlight;
    const inFlight = Promise.resolve()
      .then(() => render(result))
      .then((rendered) => {
        job.rendered = rendered;
        job.result = undefined;
        return rendered;
      });
    job.renderInFlight = inFlight;
    const settle = (): void => {
      if (job.renderInFlight === inFlight) job.renderInFlight = undefined;
      this.generationJobs.touch();
    };
    inFlight.then(settle, settle);
    return inFlight;
  }

  /**
   * Write a completed job's raw media to the output dir as-is (`<stem>-unsaved-<n>.<ext>`)
   * after its render failed, recording the paths on the job. Idempotent and best-effort:
   * when even this write fails (the output dir itself is broken) the job stays unsaved and
   * the store keeps the result in memory for the next poll's retry.
   */
  async rescueGenerationJob(job: GenerationJob): Promise<string[]> {
    if (job.rescuedFiles?.length) return job.rescuedFiles;
    const result = job.result;
    if (!result) return [];
    const items =
      'images' in result
        ? result.images.map((i) => ({ bytes: i.bytes, ext: extFromMime(i.mimeType, 'png') }))
        : result.videos.flatMap((v) => (v.bytes ? [{ bytes: v.bytes, ext: extFromMime(v.mimeType, 'mp4') }] : []));
    if (items.length === 0) return [];
    try {
      const stem = mediaStem(`${job.kind}-unsaved`);
      const files: string[] = [];
      for (const [i, it] of items.entries()) files.push((await writeMediaFile(this.outputDir(), `${stem}-${i + 1}.${it.ext}`, it.bytes)).path);
      job.rescuedFiles = files;
      this.generationJobs.touch();
      this.logger.info('generation job: raw output rescued to disk', { id: job.id, files });
      return files;
    } catch (err) {
      this.logger.error('generation job: could not rescue the raw output; it stays in memory', { id: job.id, error: (err as Error).message });
      return [];
    }
  }

  modelsDir(): string {
    return resolvePath(this.config.backgroundRemoval.modelsDir);
  }

  onShutdown(hook: ShutdownHook): void {
    this.shutdownHook = hook;
  }

  async requestShutdown(reason: string): Promise<void> {
    this.logger?.info('Shutdown requested', { reason });
    if (this.shutdownHook) await this.shutdownHook(reason);
  }
}

export const runtime = new Runtime();
