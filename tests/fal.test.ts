/**
 * Unit tests for the fal video "retry without tuning params" fallback over a stubbed
 * `fetch` (no network, no cost). The fallback may only re-submit when no job is left
 * running: the submit itself was refused, or the job finished as a 422 validation
 * error. A failure while POLLING an accepted job must never trigger a second
 * (double-billed) submit.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FalGateway } from '../src/gateways/fal.js';
import type { Logger } from '../src/logging/logger.js';
import type { VideoGenParams } from '../src/gateways/types.js';
import { describeError } from '../src/tools/helpers.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const realFetch = globalThis.fetch;
const MODEL = 'fal-ai/kling-video/v2/master/text-to-video';
const STATUS_URL = 'https://queue.fal.run/fal-ai/kling-video/requests/r1/status';
const RESPONSE_URL = 'https://queue.fal.run/fal-ai/kling-video/requests/r1';
const VIDEO_URL = 'https://v3.fal.media/files/out.mp4';
const CANCEL_URL = 'https://queue.fal.run/fal-ai/kling-video/requests/r1/cancel';

interface Route {
  submit: () => Response;
  status: () => Response;
  result: () => Response;
  cancel?: () => Response;
}
let submits: Array<Record<string, unknown>> = [];
let cancels = 0;

function stub(route: Route): void {
  submits = [];
  cancels = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT' && url === CANCEL_URL) {
      cancels += 1;
      return (route.cancel ?? json(202, { status: 'CANCELLATION_REQUESTED' }))();
    }
    if (init?.method === 'POST') {
      submits.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return route.submit();
    }
    if (url === STATUS_URL) return route.status();
    if (url === RESPONSE_URL) return route.result();
    if (url === VIDEO_URL) return new Response(Buffer.from('mp4-bytes'), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const accepted = json(200, { request_id: 'r1', status_url: STATUS_URL, response_url: RESPONSE_URL, cancel_url: CANCEL_URL, status: 'IN_QUEUE' });
/** Tiny deadlines so a "stalled" job times out in milliseconds. */
const FAST = { imageDeadlineMs: 30, imageWithReferencesDeadlineMs: 30, videoDeadlineMs: 30, pollIntervalMs: 5 };

const params = (): VideoGenParams =>
  ({ kind: 'text-to-video', model: MODEL, prompt: 'a fox', duration: 5, resolution: '1080p', references: [], extra: null }) as unknown as VideoGenParams;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fal video tuning-param fallback', () => {
  it('a 5xx while POLLING an accepted job does NOT resubmit (no double billing) and names the request_id', async () => {
    stub({ submit: accepted, status: json(503, { detail: 'busy' }), result: json(200, {}) });
    const gw = new FalGateway('id:secret', logger);
    await assert.rejects(gw.generateVideo(params()), (e: Error) => /r1/.test(e.message) && /not resubmitted/.test(e.message));
    assert.equal(submits.length, 1, 'exactly one submit');
  });

  it('a job that FINISHED as a 422 validation error is resubmitted with the core body only', async () => {
    let resultCalls = 0;
    stub({
      submit: accepted,
      status: json(200, { status: 'COMPLETED' }),
      result: () => (resultCalls++ === 0 ? json(422, { detail: [{ loc: ['body', 'resolution'], msg: 'bad' }] })() : json(200, { video: { url: VIDEO_URL } })()),
    });
    const gw = new FalGateway('id:secret', logger);
    const out = await gw.generateVideo(params());
    assert.equal(submits.length, 2);
    assert.ok('resolution' in submits[0]! && 'duration' in submits[0]!, 'first submit carries the tuning params');
    assert.deepEqual(Object.keys(submits[1]!).sort(), ['prompt'], 'retry is core-only');
    assert.equal(out.videos[0]?.sourceUrl, VIDEO_URL);
    // The resubmit is never silent: the reply says what the video was generated without.
    assert.ok(out.warnings?.some((w) => /generated WITHOUT: .*resolution.*duration/.test(w)), JSON.stringify(out.warnings));
  });

  it('a 5xx on the SUBMIT is ambiguous (the job may be queued) — it is NOT resubmitted', async () => {
    stub({ submit: json(502, { detail: 'bad gateway' }), status: json(200, { status: 'COMPLETED' }), result: json(200, { video: { url: VIDEO_URL } }) });
    const gw = new FalGateway('id:secret', logger);
    await assert.rejects(gw.generateVideo(params()), (e: Error) => /502/.test(e.message) && /not re-?sent/i.test(e.message) && /not re-?sent/i.test(describeError(e)));
    assert.equal(submits.length, 1, 'a second submit could bill a second Veo/Kling job');
  });

  it('the user-facing message of a poll failure names the accepted request_id', async () => {
    stub({ submit: accepted, status: json(503, { detail: 'busy' }), result: json(200, {}) });
    const gw = new FalGateway('id:secret', logger);
    await assert.rejects(gw.generateVideo(params()), (e: Error) => /request_id r1/.test(describeError(e)));
  });

  it('a submit refused with 422 (nothing queued) is resubmitted core-only', async () => {
    let submitCalls = 0;
    stub({
      submit: () => (submitCalls++ === 0 ? json(422, { detail: 'bad param' })() : accepted()),
      status: json(200, { status: 'COMPLETED' }),
      result: json(200, { video: { url: VIDEO_URL } }),
    });
    const gw = new FalGateway('id:secret', logger);
    await gw.generateVideo(params());
    assert.equal(submits.length, 2);
    assert.deepEqual(Object.keys(submits[1]!).sort(), ['prompt']);
  });
});

describe('fal job that never finishes / unknown model / unsupported inputs', () => {
  it('a job still running at the deadline is CANCELLED via cancel_url, and the error says so with the request_id', async () => {
    stub({ submit: accepted, status: json(200, { status: 'IN_PROGRESS' }), result: json(200, {}) });
    const gw = new FalGateway('id:secret', logger, FAST);
    await assert.rejects(gw.generateVideo(params()), (e: Error) => /request_id r1/.test(describeError(e)) && /CANCELLED/.test(describeError(e)) && !/may still complete/.test(e.message));
    assert.equal(cancels, 1);
    assert.equal(submits.length, 1, 'never resubmitted');
  });

  it('when the cancel answers ALREADY_COMPLETED, the finished (paid) result is collected instead of failing', async () => {
    stub({ submit: accepted, status: json(200, { status: 'IN_PROGRESS' }), result: json(200, { video: { url: VIDEO_URL } }), cancel: json(400, { status: 'ALREADY_COMPLETED' }) });
    const out = await new FalGateway('id:secret', logger, FAST).generateVideo(params());
    assert.equal(out.videos[0]?.sourceUrl, VIDEO_URL);
  });

  it('a refused cancel says the job may still be billed', async () => {
    stub({ submit: accepted, status: json(200, { status: 'IN_PROGRESS' }), result: json(200, {}), cancel: json(500, { detail: 'nope' }) });
    await assert.rejects(new FalGateway('id:secret', logger, FAST).generateVideo(params()), /refused .*may still complete and be billed/);
  });

  it('an unknown model id (fal 404 "Application … not found") names the id that was asked for', async () => {
    stub({ submit: json(404, { detail: 'Application "a-model" not found' }), status: json(200, {}), result: json(200, {}) });
    const gw = new FalGateway('id:secret', logger, FAST);
    await assert.rejects(gw.generateVideo({ ...params(), model: 'definitely-not/a-model' }), (e: Error) => /no endpoint "definitely-not\/a-model"/.test(describeError(e)));
  });

  it('image-to-video with an end frame or extra references is refused BEFORE submitting (fal only sends image_url)', async () => {
    stub({ submit: accepted, status: json(200, { status: 'COMPLETED' }), result: json(200, { video: { url: VIDEO_URL } }) });
    const gw = new FalGateway('id:secret', logger, FAST);
    const png = { bytes: Buffer.from('x'), mimeType: 'image/png' };
    const i2v = {
      ...params(),
      kind: 'image-to-video',
      model: 'nvidia/cosmos-3-super/image-to-video',
      references: [{ ...png, role: 'first_frame' }, { ...png, role: 'last_frame' }],
    } as VideoGenParams;
    assert.match((await gw.checkVideoRequest(i2v)) ?? '', /`image_last` would be dropped/);
    await assert.rejects(gw.generateVideo(i2v), /Nothing was submitted/);
    assert.equal(submits.length, 0);
    assert.equal(await gw.checkVideoRequest({ ...i2v, references: [{ ...png, role: 'first_frame' }] }), null);
  });
});
