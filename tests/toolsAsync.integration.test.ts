/**
 * Tool-level integration tests for the async generation feature. Drives the REAL
 * `generate_image` / `image_to_video` handlers over an in-memory MCP transport
 * (no process spawn, no network/cost), with a fake gateway that can either return
 * instantly or sit on a deferred the test releases — so we can observe the
 * submit → poll → render rhythm deterministically.
 *
 * Because async is now the DEFAULT (config.async=true), any test that wants a
 * BLOCKING result must pass `wait:true` (or set config.async=false) — this is
 * asserted explicitly below.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime } from '../src/state/runtime.js';
import type { AppConfig } from '../src/config/schema.js';
import { fakeCapabilities, startMcpHarness, textOf, type CallResult, type McpHarness } from './helpers/mcp.js';
import type { Gateway, ImageGenParams, ImageGenResult, VideoGenParams, VideoGenResult } from '../src/gateways/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.from('fake-mp4-bytes', 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Fake gateway, controllable per test ---
let deferredMode = false;
let deferredResolve: (() => void) | null = null;
let lastImageParams: ImageGenParams | undefined;
let lastVideoParams: VideoGenParams | undefined;
let imageCalls = 0;

const fakeGateway: Gateway = {
  id: 'openrouter',
  capabilities: fakeCapabilities({
    textToVideo: true,
    imageToVideo: true,
    imageAspectRatioParam: true,
    imageResolutionParam: true,
    listsImageModels: true,
    listsVideoModels: true,
    multiReferenceImages: true,
    imageReferenceImages: true,
  }),
  listImageModels: async () => ({ models: [], source: 'manual', warnings: [] }),
  listVideoModels: async () => ({ models: [], source: 'manual', warnings: [] }),
  imageAspectRatios: () => ({ values: ['1:1', '16:9'], source: 'fallback' }),
  imageResolutions: () => ({ values: ['1K'], source: 'fallback' }),
  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    lastImageParams = params;
    imageCalls += 1;
    params.onProgress?.('submitted', { requestId: 'req-img-1' });
    params.onProgress?.('IN_PROGRESS');
    const result: ImageGenResult = { images: [{ bytes: PNG, mimeType: 'image/png' }], modelUsed: 'fake/img', cost: 0.01, raw: {} };
    if (deferredMode) {
      return new Promise((resolve) => {
        deferredResolve = () => resolve(result);
        params.onProgress?.('in-progress');
      });
    }
    return result;
  },
  async generateVideo(params: VideoGenParams): Promise<VideoGenResult> {
    lastVideoParams = params;
    params.onProgress?.('submitted', { requestId: 'req-vid-1' });
    return { videos: [{ bytes: MP4, mimeType: 'video/mp4' }], modelUsed: 'fake/vid', raw: {} };
  },
};

let h: McpHarness;
let outDir: string;

function hasType(r: CallResult, type: string): boolean {
  return (r.content ?? []).some((c) => c.type === type);
}
const call = (name: string, args: Record<string, unknown>): Promise<CallResult> => h.call(name, args);
/** Poll a background job until it is no longer queued/in-progress (no fixed sleeps — robust under load). */
async function pollDone(tool: string, jobId: string): Promise<CallResult> {
  for (let i = 0; i < 200; i++) {
    const r = await call(tool, { job_id: jobId });
    if (!/ is (queued|in-progress)/.test(r.content[0]?.text ?? '')) return r;
    await sleep(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

before(async () => {
  h = await startMcpHarness({
    gateway: fakeGateway,
    image: { async: true },
    clientName: 'tools-async-integration',
    tmpPrefix: 'air-mcp-tools-',
  });
  outDir = h.outDir;
});

after(() => h.close());

function resetFake(): void {
  deferredMode = false;
  deferredResolve = null;
  lastImageParams = undefined;
  lastVideoParams = undefined;
  imageCalls = 0;
  (runtime.config as AppConfig & { image: { async: boolean } }).image.async = true;
}

describe('generate_image async (default) and sync (wait:true)', () => {
  it('returns a job_id on submit, reports in-progress on the first poll, then renders the result', async () => {
    resetFake();
    deferredMode = true;

    const submitted = await call('generate_image', { prompt: 'a red fox' });
    assert.equal(submitted.isError, undefined);
    const jobId = /submitted as job (\S+)/.exec(submitted.content[0].text ?? '')?.[1];
    assert.ok(jobId, `expected a job id in: ${submitted.content[0].text}`);

    // The job is still running (the fake won't resolve until we release it).
    const poll1 = await call('generate_image', { job_id: jobId });
    assert.equal(poll1.isError, undefined);
    assert.match(poll1.content[0].text ?? '', /is in-progress/);

    // Release the fake, let the background task finish, then poll again → result.
    assert.ok(deferredResolve, 'fake gateway should have registered a deferred');
    deferredResolve!();
    const poll2 = await pollDone('generate_image', jobId!);
    assert.equal(poll2.isError, undefined);
    assert.match(poll2.content[0].text ?? '', /Generated 1 image\(s\) using fake\/img\./);
    assert.ok(hasType(poll2, 'resource_link'), 'completed job returns a saved-file resource_link');
  });

  it('completes, then re-polling reports completion without regenerating', async () => {
    resetFake();
    deferredMode = true;
    const submitted = await call('generate_image', { prompt: 'a red fox' });
    const jobId = /submitted as job (\S+)/.exec(submitted.content[0].text ?? '')?.[1]!;
    deferredResolve!();
    const first = await pollDone('generate_image', jobId!);
    const callsAfterFirst = imageCalls;
    const filesAfterFirst = readdirSync(outDir).length;
    const second = await call('generate_image', { job_id: jobId });
    assert.equal(imageCalls, callsAfterFirst, 'polling a completed job must not re-run generation');
    assert.match(second.content[0].text ?? '', /Generated 1 image\(s\)/);
    // …nor re-SAVE it: the same reply (same paths), and no new files on disk.
    assert.deepEqual(second, first, 'a repeated poll returns the identical reply');
    assert.equal(readdirSync(outDir).length, filesAfterFirst, 'no duplicate files written by a re-poll');
  });

  it('a failed async job keeps the possible-cause hints diagnosed from the real error', async () => {
    resetFake();
    class QuotaError extends Error {}
    const saved = { generateImage: fakeGateway.generateImage, diagnoseFailure: fakeGateway.diagnoseFailure };
    fakeGateway.generateImage = async () => {
      throw new QuotaError('HTTP 402 — Insufficient credits');
    };
    fakeGateway.diagnoseFailure = async (err) => (err instanceof QuotaError ? ['Top up OpenRouter credits.'] : []);
    try {
      const submitted = await call('generate_image', { prompt: 'a red fox' });
      const jobId = /submitted as job (\S+)/.exec(submitted.content[0].text ?? '')?.[1]!;
      const polled = await pollDone('generate_image', jobId!);
      assert.equal(polled.isError, true);
      assert.match(textOf(polled), /failed: HTTP 402 — Insufficient credits/);
      assert.match(textOf(polled), /Possible cause: Top up OpenRouter credits\./);
    } finally {
      fakeGateway.generateImage = saved.generateImage;
      if (saved.diagnoseFailure) fakeGateway.diagnoseFailure = saved.diagnoseFailure;
      else delete (fakeGateway as { diagnoseFailure?: unknown }).diagnoseFailure;
    }
  });

  it('honours the synchronous override wait:true (blocking, returns the image directly)', async () => {
    resetFake();
    const r = await call('generate_image', { prompt: 'a blue tree', wait: true });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /Generated 1 image\(s\) using fake\/img\./);
    assert.ok(hasType(r, 'resource_link'));
  });

  it('uses the synchronous default when config.image.async=false (no wait needed)', async () => {
    resetFake();
    (runtime.config as AppConfig & { image: { async: boolean } }).image.async = false;
    const r = await call('generate_image', { prompt: 'a green car' });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /Generated 1 image\(s\) using fake\/img\./);
  });

  it('errors on an unknown job_id', async () => {
    const r = await call('generate_image', { job_id: 'nope' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /No generation job found/);
  });

  it('errors when a submit is attempted without a prompt and no job_id', async () => {
    resetFake();
    const r = await call('generate_image', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /A `prompt` is required/);
  });
});

describe('generate_image reference images', () => {
  it('resolves a reference and hands it to the gateway', async () => {
    resetFake();
    const refFile = join(outDir, 'ref.png');
    writeFileSync(refFile, PNG);
    const r = await call('generate_image', { prompt: 'turn this into a painting', reference_images: [refFile], wait: true });
    assert.equal(r.isError, undefined);
    assert.ok(lastImageParams?.references, 'gateway received references');
    assert.equal(lastImageParams!.references!.length, 1);
    assert.ok(lastImageParams!.references![0]!.bytes, 'reference was resolved to bytes');
  });

  it('fails closed (no gateway call) when a reference cannot be resolved', async () => {
    resetFake();
    const beforeCalls = imageCalls;
    const r = await call('generate_image', { prompt: 'x', reference_images: ['/no/such/file.png'], wait: true });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text ?? '', /Could not use 1 of 1 reference/);
    assert.equal(imageCalls, beforeCalls, 'gateway must not be called when references fail');
  });
});

describe('image_to_video mp4 async', () => {
  it('submits a background job and renders the video on poll', async () => {
    resetFake();
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
    const submitted = await call('image_to_video', { image: dataUrl, model: 'fake/vid', output_format: 'mp4' });
    assert.equal(submitted.isError, undefined);
    const text = submitted.content[0].text ?? '';
    const jobId = /job submitted as (\S+)/.exec(text)?.[1];
    assert.ok(jobId, `expected a video job id in: ${text}`);

    const polled = await pollDone('image_to_video', jobId!);
    assert.equal(polled.isError, undefined);
    assert.match(polled.content[0].text ?? '', /Generated 1 video\(s\) using fake\/vid\./);
    assert.ok(hasType(polled, 'resource_link'));
  });
});

describe('generate_video async (the poll the submit reply tells you to send)', () => {
  it('submits, then a poll carrying ONLY job_id is accepted and renders the video', async () => {
    resetFake();
    const submitted = await call('generate_video', { prompt: 'waves at dusk', model: 'fake/vid' });
    assert.equal(submitted.isError, undefined, textOf(submitted));
    const text = submitted.content[0].text ?? '';
    const jobId = /job submitted as (\S+)/.exec(text)?.[1];
    assert.ok(jobId, `expected a video job id in: ${text}`);
    assert.match(text, /Poll with `generate_video job_id:/);

    // Exactly what the reply says to send — no prompt. The schema used to reject this (-32602).
    const polled = await pollDone('generate_video', jobId!);
    assert.equal(polled.isError, undefined, textOf(polled));
    assert.match(textOf(polled), /Generated 1 video\(s\) using fake\/vid\./);
    assert.ok(hasType(polled, 'resource_link'));
    assert.equal(lastVideoParams?.prompt, 'waves at dusk');
  });

  it('a submit without a prompt (and no job_id) is refused by the handler, not the schema', async () => {
    resetFake();
    const r = await call('generate_video', { model: 'fake/vid' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /A `prompt` is required/);
    assert.equal(lastVideoParams, undefined, 'nothing reached the gateway');
  });

  it('a request the gateway refuses in checkVideoRequest is never submitted (sync or async)', async () => {
    resetFake();
    fakeGateway.checkVideoRequest = async (p) => (p.model === 'bad/model' ? 'No such model "bad/model". Nothing was submitted.' : null);
    try {
      for (const wait of [false, true]) {
        const r = await call('generate_video', { prompt: 'x', model: 'bad/model', wait });
        assert.equal(r.isError, true);
        assert.match(textOf(r), /No such model "bad\/model"/);
        assert.doesNotMatch(textOf(r), /job submitted/);
      }
      assert.equal(lastVideoParams, undefined, 'generateVideo was never called');
    } finally {
      delete (fakeGateway as { checkVideoRequest?: unknown }).checkVideoRequest;
    }
  });

  it('configured defaults are applied to the configured model only — never to a `model` override', async () => {
    resetFake();
    const t2v = runtime.config.textToVideo as { model: string | null; defaultDuration: number | null; defaultFps: number | null };
    const saved = { model: t2v.model, d: t2v.defaultDuration, f: t2v.defaultFps };
    Object.assign(t2v, { model: 'fake/configured', defaultDuration: 2, defaultFps: 16 });
    try {
      await call('generate_video', { prompt: 'x', wait: true });
      assert.equal(lastVideoParams?.duration, 2, 'configured model → configured default');
      await call('generate_video', { prompt: 'x', model: 'fake/other', wait: true });
      assert.equal(lastVideoParams?.duration, null, 'override → the default is not sent');
      assert.equal(lastVideoParams?.fps, null);
      await call('generate_video', { prompt: 'x', model: 'fake/other', duration: 6, wait: true });
      assert.equal(lastVideoParams?.duration, 6, 'an explicit value always goes through');
    } finally {
      Object.assign(t2v, { model: saved.model, defaultDuration: saved.d, defaultFps: saved.f });
    }
  });
});

describe('a completed job whose result cannot be saved', () => {
  it('an ico render that cannot be produced (no upscaling) rescues the raw output to disk and names it', async () => {
    resetFake();
    const submitted = await call('generate_image', { prompt: 'tiny icon', output_format: 'ico', width: 32 });
    const jobId = /submitted as job (\S+)/.exec(submitted.content[0].text ?? '')?.[1];
    assert.ok(jobId, textOf(submitted));
    const polled = await pollDone('generate_image', jobId!);
    assert.equal(polled.isError, true, 'the requested ICO was not produced');
    const text = textOf(polled);
    assert.match(text, /cannot upscale/);
    const rescued = readdirSync(outDir).filter((f) => f.includes('unsaved') && f.endsWith('.png'));
    assert.equal(rescued.length, 1, `the paid raw output must be on disk: ${readdirSync(outDir).join(', ')}`);
    assert.ok(text.includes(rescued[0]!), 'the reply names the rescued file');
    // A re-poll answers again without writing another copy.
    await call('generate_image', { job_id: jobId });
    assert.equal(readdirSync(outDir).filter((f) => f.includes('unsaved')).length, 1);
  });

  it('a poll whose re-render fails returns a structured error result (it never throws out of the handler)', async () => {
    resetFake();
    const blocker = join(outDir, 'not-a-dir.txt');
    writeFileSync(blocker, 'x');
    const output = runtime.config.output as { dir: string };
    const realDir = output.dir;
    output.dir = join(blocker, 'sub'); // mkdir fails → render AND rescue fail
    try {
      const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
      const submitted = await call('image_to_video', { image: dataUrl, model: 'fake/vid', output_format: 'mp4' });
      const jobId = /job submitted as (\S+)/.exec(submitted.content[0].text ?? '')?.[1];
      assert.ok(jobId, textOf(submitted));
      const polled = await pollDone('image_to_video', jobId!);
      assert.equal(polled.isError, true);
      assert.match(textOf(polled), /completed, but its result could not be saved/);
      assert.match(textOf(polled), /poll again/i);
    } finally {
      output.dir = realDir;
    }
  });
});
