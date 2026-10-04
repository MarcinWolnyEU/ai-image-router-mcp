/**
 * Integration test for the async generation-job rhythm at the runtime level:
 * submit (returns a job_id immediately) → the gateway call runs detached → poll
 * by job_id until completed. Uses a fake gateway that reports progress and a
 * native request_id, so we exercise `runtime.submitGenerationJob`/`getGenerationJob`
 * without any network or cost. (Live gateways are covered by the smoke harness.)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/state/runtime.js';
import type { Gateway, GatewayCapabilities, ImageGenParams, ImageGenResult } from '../src/gateways/types.js';
import type { GenerationJob } from '../src/state/generationJobs.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const fakeGateway: Gateway = {
  id: 'openrouter',
  capabilities: { imageGeneration: true } as GatewayCapabilities,
  listImageModels: async () => ({ models: [], source: 'manual', warnings: [] }),
  imageAspectRatios: () => ({ values: [], source: 'fallback' }),
  imageResolutions: () => ({ values: [], source: 'fallback' }),
  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    params.onProgress?.('submitted', { requestId: 'req-123' });
    params.onProgress?.('IN_PROGRESS');
    return { images: [{ bytes: PNG, mimeType: 'image/png' }], modelUsed: 'fake', raw: {} };
  },
};

before(() => {
  // Mutate the process-wide singleton's live fields (fresh process per test file).
  runtime.gateway = fakeGateway;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).config = { gateway: 'openrouter', image: { async: true } };
  runtime.logger = { info() {}, error() {}, warn() {}, debug() {} } as unknown as typeof runtime.logger;
});

/** Wait for a detached job to finish (near-instant with the fakes). */
async function settle(id: string): Promise<GenerationJob> {
  let job = runtime.getGenerationJob(id);
  for (let i = 0; i < 100 && job && job.status !== 'completed' && job.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = runtime.getGenerationJob(id);
  }
  return job!;
}

describe('runtime async image job', () => {
  it('submits immediately, surfaces progress + native request_id, and completes', async () => {
    const params = { prompt: 'a red fox', model: 'x', signal: undefined } as ImageGenParams;
    const { id, status } = runtime.submitGenerationJob(
      'image',
      params,
      { model: 'x' },
      { format: null, tinifyKey: null, outputMode: 'filePath', save: true, inline: false, label: 'a red fox' },
    );
    // The background task may flip the status to 'in-progress' before we read it.
    assert.ok(status === 'queued' || status === 'in-progress', `unexpected initial status ${status}`);
    assert.ok(id.length > 0);

    const job = await settle(id);
    assert.equal(job.status, 'completed');
    assert.equal(job.requestId, 'req-123');
    assert.equal(job.progress, 'completed');
    assert.ok(job.result && 'images' in job.result, 'has an image result');
    assert.equal((job.result as ImageGenResult).images.length, 1);
    // Health bumped exactly once (the detached completion path).
    assert.equal(runtime.health.generationCount, 1);
    assert.ok(runtime.health.lastImageAt != null);
  });

  it('reports a clean miss for an unknown job id', () => {
    assert.equal(runtime.getGenerationJob('nope'), undefined);
  });
});

const MEDIA = { format: null, tinifyKey: null, outputMode: 'filePath', save: true, inline: false, label: 'x' } as const;

describe('runtime async job: render once', () => {
  it('renders EAGERLY on completion, exactly once; concurrent/repeated renders share it; raw bytes dropped', async () => {
    let renders = 0;
    const render = async () => {
      renders += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { content: [{ type: 'text', text: `saved by render #${renders}` }] };
    };
    const { id } = runtime.submitGenerationJob('image', { prompt: 'p', model: 'x' } as ImageGenParams, { model: 'x' }, { ...MEDIA }, render);
    const job = await settle(id);
    assert.equal(job.status, 'completed');
    assert.equal(renders, 1, 'rendered when the job finished, before any poll');
    assert.equal(job.result, undefined, 'raw media released once rendered');
    const [a, b, c] = await Promise.all([runtime.renderGenerationJob(job), runtime.renderGenerationJob(job), runtime.renderGenerationJob(job)]);
    assert.equal(renders, 1, 'polls never re-render (no duplicate files, no repeat Tinify)');
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(a?.content[0]?.['text'], 'saved by render #1');
  });

  it('a failed render keeps the result, the job still completes, and the next render retries', async () => {
    let attempts = 0;
    const render = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk full');
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    const { id } = runtime.submitGenerationJob('image', { prompt: 'p', model: 'x' } as ImageGenParams, { model: 'x' }, { ...MEDIA }, render);
    const job = await settle(id);
    assert.equal(job.status, 'completed');
    assert.ok(job.result, 'result kept for a retry');
    const out = await runtime.renderGenerationJob(job);
    assert.equal(out?.content[0]?.['text'], 'ok');
    assert.equal(attempts, 2);
  });
});

describe('runtime async job: failure diagnosis', () => {
  class TypedProviderError extends Error {
    readonly hints = ['Top up your credits.'];
  }

  it('diagnoses with the REAL error object (typed hints survive), on the gateway that ran the job', async () => {
    let diagnosedWith: unknown;
    const failing: Gateway = {
      ...fakeGateway,
      async generateImage() {
        // A restart swaps runtime.gateway while this job is in flight.
        runtime.gateway = fakeGateway;
        throw new TypedProviderError('HTTP 402 — insufficient credits');
      },
      async diagnoseFailure(err: unknown) {
        diagnosedWith = err;
        return err instanceof TypedProviderError ? err.hints : ['(lost the error type)'];
      },
    };
    runtime.gateway = failing;
    const { id } = runtime.submitGenerationJob('image', { prompt: 'p', model: 'x' } as ImageGenParams, { model: 'x' }, { ...MEDIA });
    const job = await settle(id);
    assert.equal(job.status, 'failed');
    assert.ok(diagnosedWith instanceof TypedProviderError, 'diagnoseFailure saw the original error, not new Error(message)');
    assert.deepEqual(job.causes, ['Top up your credits.']);
    assert.match(job.error ?? '', /insufficient credits/);
    runtime.gateway = fakeGateway;
  });
});
