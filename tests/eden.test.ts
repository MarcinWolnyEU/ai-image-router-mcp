/**
 * Unit tests for the Eden AI gateway over a stubbed `fetch` (no network, no cost):
 *  - image generation uses the SYNC `/v3/universal-ai` endpoint (the async one answers
 *    400 "Not an async feature" for image/generation — the 2026-10-04 review's H1);
 *  - video model selection rides in `providers` as `<provider>/<model>` (a top-level
 *    `model` field was silently ignored and the provider default was billed — M5);
 *  - an unknown video model is refused BEFORE submitting, from the public catalog;
 *  - the reply names the model Eden says RAN (the result key), not the one asked for.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EdenAiGateway, buildEdenVideoBody, parseEdenVideoCatalog, pickEdenVideoOutput, stripProvider } from '../src/gateways/edenai.js';
import type { Logger } from '../src/logging/logger.js';
import type { ImageGenParams, VideoGenParams } from '../src/gateways/types.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const realFetch = globalThis.fetch;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The shape of the public `/v2/info/provider_subfeatures` video catalog (trimmed). */
const CATALOG = [
  {
    provider: { name: 'minimax' },
    models: { models: ['T2V/I2V-01-Director', 'S2V-01', 'MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3'], default_model: 'MiniMax-Hailuo-2.3' },
    constraints: { models: ['MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3'], default_model: 'MiniMax-Hailuo-2.3' },
  },
  { provider: { name: 'amazon' }, models: { models: ['amazon.nova-reel-v1:1'], default_model: 'amazon.nova-reel-v1:1' } },
];

interface Seen {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}
let seen: Seen[] = [];

function stub(handler: (s: Seen) => { status: number; json: unknown }): void {
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const s: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      auth: headers.get('authorization'),
    };
    seen.push(s);
    const r = handler(s);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const video = (over: Partial<VideoGenParams> = {}): VideoGenParams =>
  ({ kind: 'text-to-video', prompt: 'a red ball', model: 'minimax/minimax', edenProvider: 'minimax', duration: 6, references: [], extra: null, ...over }) as VideoGenParams;

describe('Eden image generation (sync universal-ai)', () => {
  it('POSTs /v3/universal-ai (not /async) and decodes output.items[].image', async () => {
    stub((s) =>
      s.url.endsWith('/v3/universal-ai')
        ? { status: 200, json: { status: 'success', cost: '0.005000000', provider: 'pruna', output: { items: [{ image: PNG_B64 }] }, error: null } }
        : { status: 400, json: { detail: { error: 'Not an async feature' } } },
    );
    const gw = new EdenAiGateway('tok', logger);
    const res = await gw.generateImage({ prompt: 'a red circle', model: 'p-image', edenProvider: 'pruna', resolution: '256x256' } as ImageGenParams);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, 'https://api.edenai.run/v3/universal-ai');
    assert.deepEqual(seen[0]!.body, { model: 'image/generation/pruna/p-image', input: { text: 'a red circle', resolution: '256x256' } });
    assert.equal(res.images.length, 1);
    assert.equal(res.images[0]!.mimeType, 'image/png');
    assert.equal(res.cost, 0.005);
  });

  it('a `status:"fail"` body surfaces the provider message', async () => {
    stub(() => ({ status: 200, json: { status: 'fail', cost: '0', output: null, error: { message: 'prompt rejected by provider' } } }));
    await assert.rejects(new EdenAiGateway('tok', logger).generateImage({ prompt: 'x', model: 'p-image', edenProvider: 'pruna' } as ImageGenParams), /prompt rejected by provider/);
  });
});

describe('Eden video model selection', () => {
  it('sends the model in `providers` as provider/model; a provider-only id sends just the provider', () => {
    assert.equal(buildEdenVideoBody(video(), 'minimax', 'MiniMax-Hailuo-02')['providers'], 'minimax/MiniMax-Hailuo-02');
    assert.equal(buildEdenVideoBody(video(), 'minimax', 'MiniMax-Hailuo-02')['model'], undefined, 'no ignored top-level model field');
    assert.equal(buildEdenVideoBody(video(), 'minimax', null)['providers'], 'minimax');
  });

  it("stripProvider treats the wizard's provider-only `minimax/minimax` as the provider default", () => {
    assert.equal(stripProvider('minimax/minimax', 'minimax'), null);
    assert.equal(stripProvider('minimax', 'minimax'), null);
    assert.equal(stripProvider('minimax/MiniMax-Hailuo-02', 'minimax'), 'MiniMax-Hailuo-02');
  });

  it('parses the catalog (models ∪ constraints, default)', () => {
    const c = parseEdenVideoCatalog(CATALOG);
    assert.deepEqual(c.get('minimax')?.models, ['T2V/I2V-01-Director', 'S2V-01', 'MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3']);
    assert.equal(c.get('minimax')?.defaultModel, 'MiniMax-Hailuo-2.3');
    assert.equal(parseEdenVideoCatalog({ not: 'an array' }).size, 0);
  });

  it('an unknown model is refused BEFORE any submit (Eden would forward it and still report the full price)', async () => {
    stub((s) => (s.url.includes('/v2/info/provider_subfeatures') ? { status: 200, json: CATALOG } : { status: 500, json: {} }));
    const gw = new EdenAiGateway('tok', logger);
    const refusal = await gw.checkVideoRequest(video({ model: 'minimax/definitely-not-a-model' }));
    assert.match(refusal ?? '', /no video model "definitely-not-a-model".*MiniMax-Hailuo-02.*Nothing was submitted/);
    assert.equal(await gw.checkVideoRequest(video({ model: 'minimax/MiniMax-Hailuo-02' })), null);
    assert.equal(await gw.checkVideoRequest(video()), null, 'provider default is always fine');
    assert.match((await gw.checkVideoRequest(video({ edenProvider: 'nope', model: 'nope' }))) ?? '', /no video provider "nope"/);
    await assert.rejects(gw.generateVideo(video({ model: 'minimax/definitely-not-a-model' })), /Nothing was submitted/);
    assert.ok(!seen.some((s) => s.method === 'POST'), 'nothing was POSTed');
    // The catalog is public: the v3 API key makes it 401, so it is fetched WITHOUT auth.
    assert.ok(seen.filter((s) => s.url.includes('provider_subfeatures')).every((s) => s.auth === null));
    assert.equal(seen.filter((s) => s.url.includes('provider_subfeatures')).length, 1, 'cached after the first fetch');
  });

  it('an unreachable catalog does not block generation (the provider validates)', async () => {
    stub(() => ({ status: 503, json: {} }));
    assert.equal(await new EdenAiGateway('tok', logger).checkVideoRequest(video({ model: 'minimax/anything' })), null);
  });

  it('reports the model from the result key, and notes when Eden ran a different one', () => {
    const final = { status: 'finished', results: { 'minimax/MiniMax-Hailuo-2.3': { final_status: 'succeeded', cost: 0.56, video_resource_url: 'https://cdn/x.mp4' } } };
    const out = pickEdenVideoOutput(final, 'minimax');
    assert.deepEqual(out, { url: 'https://cdn/x.mp4', cost: 0.56, modelKey: 'minimax/MiniMax-Hailuo-2.3' });
  });

  it('end to end: the reply names the model that ran and warns when it is not the one requested', async () => {
    stub((s) => {
      if (s.url.includes('provider_subfeatures')) return { status: 200, json: CATALOG };
      if (s.method === 'POST') return { status: 200, json: { public_id: 'job1' } };
      if (s.url.includes('/generation_async/job1/')) {
        return { status: 200, json: { status: 'finished', results: { 'minimax/MiniMax-Hailuo-2.3': { final_status: 'succeeded', cost: 0.56, video_resource_url: 'https://cdn.example/x.mp4' } } } };
      }
      return { status: 200, json: { ok: true } }; // the video download
    });
    const res = await new EdenAiGateway('tok', logger).generateVideo(video({ model: 'minimax/MiniMax-Hailuo-02' }));
    assert.equal(seen.find((s) => s.method === 'POST')?.body?.['providers'], 'minimax/MiniMax-Hailuo-02');
    assert.equal(res.modelUsed, 'minimax/MiniMax-Hailuo-2.3');
    assert.ok(res.warnings?.some((w) => /Requested minimax\/MiniMax-Hailuo-02, but Eden AI ran minimax\/MiniMax-Hailuo-2\.3/.test(w)));
  });
});
