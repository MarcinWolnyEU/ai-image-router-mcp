/**
 * Unit tests for the HTTP retry policy (src/util/http.ts) over a stubbed global
 * `fetch`: a POST may start a BILLED generation, so it is only re-sent when the
 * failure proves it was not processed (429, never-connected) — never on a
 * timeout / 5xx / truncated 200, which are ambiguous. GETs keep full retries.
 * Also: token resolution never yields an empty secret.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayHttpError, getJson, postJson, rawRequest, requestNeverSent } from '../src/util/http.js';
import { resolveToken, ConfigError } from '../src/config/schema.js';

const realFetch = globalThis.fetch;
let calls = 0;

/** Install a fetch stub that plays `steps` in order (the last one repeats). */
function stubFetch(steps: Array<() => Response | Promise<Response>>): void {
  calls = 0;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    return step();
  }) as typeof fetch;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (status: number, body: string) => () => new Response(body, { status });
const reject = (err: unknown) => () => Promise.reject(err);
/** undici's shape for a socket-level failure. */
const socketError = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const timeoutError = (): Error => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('POST (non-idempotent) retry policy', () => {
  it('a 5xx is NOT re-sent (the provider may already be running/billing it)', async () => {
    stubFetch([json(502, { error: { message: 'upstream' } }), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', { p: 1 }), (e: unknown) => e instanceof GatewayHttpError && e.status === 502);
    assert.equal(calls, 1);
  });

  it('a client-side timeout is NOT re-sent', async () => {
    stubFetch([reject(timeoutError()), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}), /timeout/);
    assert.equal(calls, 1);
  });

  it('a connection reset (ambiguous: may have been received) is NOT re-sent', async () => {
    stubFetch([reject(socketError('ECONNRESET')), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}));
    assert.equal(calls, 1);
  });

  it('a truncated 200 is NOT re-sent — it was accepted — and the error says so', async () => {
    stubFetch([text(200, '{"id":"job-1","sta'), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}), /NOT re-sent/);
    assert.equal(calls, 1);
  });

  it('429 IS retried (rate-limited → not processed), honouring Retry-After', async () => {
    stubFetch([json(429, {}, { 'retry-after': '0.01' }), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/gen', {}), { ok: true });
    assert.equal(calls, 2);
  });

  it('a connection that never opened (ECONNREFUSED / DNS) IS retried', async () => {
    stubFetch([reject(socketError('ECONNREFUSED')), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/gen', {}, { retries: 1 }), { ok: true });
    assert.equal(calls, 2);
  });

  it('idempotent:true opts a harmless POST back into full retries', async () => {
    stubFetch([json(503, {}), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/agents', {}, { idempotent: true, retries: 1 }), { ok: true });
    assert.equal(calls, 2);
  });
});

describe('GET (idempotent) retry policy', () => {
  it('5xx and a truncated 200 are retried', async () => {
    stubFetch([json(500, {}), text(200, '{"partial'), json(200, { ok: 1 })]);
    assert.deepEqual(await getJson('https://x.test/status', { retries: 2 }), { ok: 1 });
    assert.equal(calls, 3);
  });

  it('a timeout is retried', async () => {
    stubFetch([reject(timeoutError()), json(200, { ok: 1 })]);
    assert.deepEqual(await getJson('https://x.test/status', { retries: 1 }), { ok: 1 });
    assert.equal(calls, 2);
  });

  it('rawRequest gives up after `retries` and returns the last response', async () => {
    stubFetch([json(500, { n: 1 })]);
    const res = await rawRequest('https://x.test/status', { retries: 1 });
    assert.equal(res.status, 500);
    assert.equal(calls, 2);
  });
});

describe('requestNeverSent', () => {
  it('recognises never-connected socket errors (incl. nested causes and AggregateError)', () => {
    assert.equal(requestNeverSent(socketError('ECONNREFUSED')), true);
    assert.equal(requestNeverSent(socketError('ENOTFOUND')), true);
    assert.equal(requestNeverSent(socketError('UND_ERR_CONNECT_TIMEOUT')), true);
    const agg = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ENETUNREACH' })]),
    });
    assert.equal(requestNeverSent(agg), true);
  });
  it('treats resets, timeouts, and mixed aggregates as possibly-sent', () => {
    assert.equal(requestNeverSent(socketError('ECONNRESET')), false);
    assert.equal(requestNeverSent(timeoutError()), false);
    const mixed = new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNRESET' })]);
    assert.equal(requestNeverSent(mixed), false);
    assert.equal(requestNeverSent(null), false);
  });
});

describe('resolveToken never returns an empty secret', () => {
  it('rejects an empty / whitespace inline token', async () => {
    await assert.rejects(resolveToken({ type: 'inline', value: '' }), ConfigError);
    await assert.rejects(resolveToken({ type: 'inline', value: '   ' }), /empty/);
  });
  it('rejects a set-but-blank env var, and an unset one', async () => {
    process.env['AIR_TEST_BLANK_TOKEN'] = '  \n';
    await assert.rejects(resolveToken({ type: 'env', value: 'AIR_TEST_BLANK_TOKEN' }), /is empty/);
    delete process.env['AIR_TEST_BLANK_TOKEN'];
    await assert.rejects(resolveToken({ type: 'env', value: 'AIR_TEST_BLANK_TOKEN' }), /not set/);
  });
  it('trims a real value', async () => {
    assert.equal(await resolveToken({ type: 'inline', value: '  abc  ' }), 'abc');
  });
});
