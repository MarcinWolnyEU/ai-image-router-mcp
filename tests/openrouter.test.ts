/**
 * OpenRouter Image API — capability-driven request building + error explaining.
 * Pure/unit: no network (a stubbed global `fetch` stands in for OpenRouter where
 * the real gateway class is exercised), no files, no cost.
 *
 * Fixture: the LIVE `/images/models/openai/gpt-image-2.5-sunburst/endpoints`
 * record captured 2026-09-09 — the model has NO `resolution`, `quality` is
 * auto|low|medium|high|xhigh|max and `background` is auto|opaque (no transparent).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenRouterImageBody,
  enumValues,
  explainOpenRouterError,
  isDeterministicFailure,
  isSizeRejection,
  OpenRouterApiError,
  parseErrorBody,
  parseImageModelEndpoints,
  supportsParam,
  toOpenRouterApiError,
} from '../src/gateways/openrouterImages.js';
import { OpenRouterGateway } from '../src/gateways/openrouter.js';
import { GatewayHttpError, retryAfterMs } from '../src/util/http.js';
import { describeError } from '../src/tools/helpers.js';
import { compileConstraints, parseBackgroundSpec } from '../src/media/palette.js';
import type { ImageGenParams } from '../src/gateways/types.js';

const MODEL = 'openai/gpt-image-2.5-sunburst';
const SUNBURST_ENDPOINTS = {
  id: MODEL,
  endpoints: [
    {
      provider_name: 'OpenAI',
      provider_slug: 'openai',
      provider_tag: 'openai',
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'] },
        quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
        background: { type: 'enum', values: ['auto', 'opaque'] },
        n: { type: 'range', min: 1, max: 10 },
        input_references: { type: 'range', min: 0, max: 16 },
        output_compression: { type: 'range', min: 0, max: 100 },
      },
      allowed_passthrough_parameters: ['moderation'],
      supports_streaming: true,
      pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00003 }],
    },
  ],
};
const SEEDREAM_ENDPOINTS = {
  id: 'bytedance-seed/seedream-4.5',
  endpoints: [
    { provider_name: 'Bytedance', supported_parameters: { resolution: { type: 'enum', values: ['1K', '2K', '4K'] }, seed: { type: 'boolean' } } },
    { provider_name: 'Other', supported_parameters: { resolution: { type: 'enum', values: ['2K', '4K', '8K'] }, n: { type: 'range', min: 1, max: 4 } } },
  ],
};
const caps = parseImageModelEndpoints(MODEL, SUNBURST_ENDPOINTS, 1000)!;
const base = (over: Partial<ImageGenParams> = {}): ImageGenParams => ({ prompt: 'an orange circle', model: MODEL, ...over });

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as ConstructorParameters<typeof OpenRouterGateway>[1];
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('parseImageModelEndpoints', () => {
  it('reads the live gpt-image-2.5 record: no resolution, quality + background enums, ranges', () => {
    assert.equal(caps.model, MODEL);
    assert.deepEqual(caps.providers, ['OpenAI']);
    assert.deepEqual(caps.passthrough, ['moderation']);
    assert.equal(caps.supportsStreaming, true);
    assert.equal(supportsParam(caps, 'resolution'), false);
    assert.equal(supportsParam(caps, 'quality'), true);
    assert.deepEqual(enumValues(caps, 'quality'), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(enumValues(caps, 'background'), ['auto', 'opaque']);
    assert.deepEqual(caps.params['n'], { type: 'range', min: 1, max: 10 });
    assert.equal(enumValues(caps, 'n'), null);
  });
  it('unions enums / widens ranges across endpoints, and returns null for no endpoints', () => {
    const c = parseImageModelEndpoints('bytedance-seed/seedream-4.5', SEEDREAM_ENDPOINTS)!;
    assert.deepEqual(enumValues(c, 'resolution'), ['1K', '2K', '4K', '8K']);
    assert.deepEqual(c.params['seed'], { type: 'boolean' });
    assert.deepEqual(c.params['n'], { type: 'range', min: 1, max: 4 });
    assert.equal(parseImageModelEndpoints('x/y', { id: 'x/y', endpoints: [] }), null);
    assert.equal(parseImageModelEndpoints('x/y', { error: { message: 'nope' } }), null);
  });
  it('unknown capabilities are optimistic', () => {
    assert.equal(supportsParam(null, 'anything'), true);
    assert.equal(enumValues(null, 'quality'), null);
  });
});

describe('buildOpenRouterImageBody', () => {
  it('drops a resolution tier the model has no parameter for, with a note (full-size output kept)', () => {
    const r = buildOpenRouterImageBody(base({ aspectRatio: '1:1', resolution: '512' }), caps);
    assert.equal(r.body['resolution'], undefined);
    assert.equal(r.body['aspect_ratio'], '1:1');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /no resolution-tier parameter/);
    assert.match(r.warnings[0]!, /native full size/);
    assert.equal(r.exactSize, false);
  });
  it('sends the tier when the model has one, refuses one outside its enum', () => {
    const c = parseImageModelEndpoints('bytedance-seed/seedream-4.5', SEEDREAM_ENDPOINTS)!;
    const p = { ...base({ resolution: '2K' }), model: 'bytedance-seed/seedream-4.5' };
    assert.equal(buildOpenRouterImageBody(p, c).body['resolution'], '2K');
    assert.throws(() => buildOpenRouterImageBody({ ...p, resolution: '512' }, c), /Resolution tier "512" is not supported.*Accepted: 1K, 2K, 4K, 8K/);
  });
  it('with unknown capabilities sends what was asked (provider validates)', () => {
    const r = buildOpenRouterImageBody(base({ aspectRatio: '4:5', resolution: '512', quality: 'high' }), null);
    assert.deepEqual(r.body, { model: MODEL, prompt: 'an orange circle', aspect_ratio: '4:5', resolution: '512', quality: 'high' });
    assert.deepEqual(r.warnings, []);
  });
  it('quality: sent when valid, refused (before any request) when off-enum or unsupported', () => {
    assert.equal(buildOpenRouterImageBody(base({ quality: 'xhigh' }), caps).body['quality'], 'xhigh');
    assert.throws(() => buildOpenRouterImageBody(base({ quality: 'ultra' }), caps), /Quality "ultra" is not supported.*Accepted: auto, low, medium, high, xhigh, max/);
    const noQuality = parseImageModelEndpoints('bytedance-seed/seedream-4.5', SEEDREAM_ENDPOINTS)!;
    assert.throws(() => buildOpenRouterImageBody({ ...base({ quality: 'low' }), model: 'bytedance-seed/seedream-4.5' }, noQuality), /has no `quality` parameter/);
  });
  it('aspect ratio outside the model enum is refused before the request', () => {
    assert.throws(() => buildOpenRouterImageBody(base({ aspectRatio: '4:5' }), caps), /Aspect ratio "4:5" is not supported.*Accepted: 1:1, 3:2/);
    assert.equal(buildOpenRouterImageBody(base({ aspectRatio: 'auto' }), caps).body['aspect_ratio'], 'auto');
  });
  it('background: transparent is refused on an auto|opaque model with a remove_background hint; colour → opaque; modes pass', () => {
    assert.throws(() => buildOpenRouterImageBody(base({ background: 'transparent' }), caps), /cannot produce a transparent background.*accepts only auto, opaque.*remove_background.*gpt-image-1/);
    assert.equal(buildOpenRouterImageBody(base({ background: '#00ff00' }), caps).body['background'], 'opaque');
    assert.equal(buildOpenRouterImageBody(base({ background: 'solid white' }), caps).body['background'], 'opaque');
    assert.equal(buildOpenRouterImageBody(base({ background: 'auto' }), caps).body['background'], 'auto');
    assert.equal(buildOpenRouterImageBody(base({ background: 'opaque' }), caps).body['background'], 'opaque');
    // A model WITH transparent in its enum lets it through.
    const gpt1 = parseImageModelEndpoints('openai/gpt-image-1', {
      endpoints: [{ provider_name: 'OpenAI', supported_parameters: { background: { type: 'enum', values: ['auto', 'transparent', 'opaque'] } } }],
    })!;
    assert.equal(buildOpenRouterImageBody({ ...base({ background: 'transparent' }), model: 'openai/gpt-image-1' }, gpt1).body['background'], 'transparent');
    // Unknown caps: optimistic (never a hex).
    assert.equal(buildOpenRouterImageBody(base({ background: 'transparent' }), null).body['background'], 'transparent');
    assert.equal(buildOpenRouterImageBody(base({ background: '#123456' }), null).body['background'], 'opaque');
  });
  it('explicit width×height goes out as an exact `size` and replaces aspect_ratio/resolution', () => {
    const r = buildOpenRouterImageBody(base({ width: 2048, height: 2048, aspectRatio: '1:1', resolution: '2K' }), caps);
    assert.equal(r.body['size'], '2048x2048');
    assert.equal(r.body['aspect_ratio'], undefined);
    assert.equal(r.body['resolution'], undefined);
    assert.equal(r.exactSize, true);
    assert.match(r.warnings[0]!, /exact size 2048x2048 takes precedence/);
    // The retry shape after a size rejection: aspect + (dropped) tier again.
    const r2 = buildOpenRouterImageBody(base({ width: 256, height: 256, aspectRatio: '1:1', resolution: '512' }), caps, { noExactSize: true });
    assert.equal(r2.body['size'], undefined);
    assert.equal(r2.body['aspect_ratio'], '1:1');
    assert.equal(r2.exactSize, false);
  });
  it('n and reference counts are range-checked; references map to input_references; extra merges last', () => {
    assert.equal(buildOpenRouterImageBody(base({ n: 3 }), caps).body['n'], 3);
    assert.throws(() => buildOpenRouterImageBody(base({ n: 11 }), caps), /`n` must be between 1 and 10/);
    const refs = Array.from({ length: 17 }, () => ({ bytes: Buffer.from('x'), mimeType: 'image/png' }));
    assert.throws(() => buildOpenRouterImageBody(base({ references: refs }), caps), /at most 16 reference image/);
    const one = buildOpenRouterImageBody(base({ references: [{ bytes: Buffer.from('abc'), mimeType: 'image/png' }], extra: { quality: 'max', seed: 7 } }), caps);
    const refBody = one.body['input_references'] as Array<{ type: string; image_url: { url: string } }>;
    assert.equal(refBody[0]!.type, 'image_url');
    assert.match(refBody[0]!.image_url.url, /^data:image\/png;base64,/);
    assert.equal(one.body['quality'], 'max');
    assert.equal(one.body['seed'], 7);
    const noRefs = parseImageModelEndpoints('bytedance-seed/seedream-4.5', SEEDREAM_ENDPOINTS)!;
    assert.throws(() => buildOpenRouterImageBody({ ...base({ references: refs.slice(0, 1) }), model: 'bytedance-seed/seedream-4.5' }, noRefs), /has no image input/);
  });
});

describe('explainOpenRouterError', () => {
  const http = (status: number, body: unknown): GatewayHttpError => new GatewayHttpError(`HTTP ${status}`, status, JSON.stringify(body), 'https://openrouter.ai/api/v1/images');

  it('turns a raw Zod validation dump into "field: expected one of …"', () => {
    const body = {
      error: {
        name: 'ZodError',
        message: JSON.stringify([{ code: 'invalid_value', values: ['auto', 'low'], path: ['quality'], message: 'Invalid option: expected one of "auto"|"low"' }]),
      },
    };
    const e = explainOpenRouterError(400, JSON.stringify(body), MODEL);
    assert.match(e.message, /^HTTP 400 — Bad request/);
    assert.match(e.message, /Invalid request parameter\(s\) — quality: Invalid option: expected one of "auto"\|"low"/);
    assert.match(e.message, /\[model: openai\/gpt-image-2\.5-sunburst\]/);
  });
  it('capability-filter rejection: points at the "Provider rejections" clause', () => {
    const msg =
      'No provider for openai/gpt-image-2.5-sunburst supports the requested parameter(s): quality "low", background "transparent". Provider rejections: OpenAI: background: not supported. Accepted: auto, opaque';
    const e = explainOpenRouterError(400, JSON.stringify({ error: { message: msg, code: 400, metadata: { failed_routing_step: 'Filter by Image Capabilities' } } }), MODEL);
    assert.match(e.message, /Accepted: auto, opaque/);
    assert.equal(e.hints.length, 1);
    assert.match(e.hints[0]!, /Provider rejections.*OpenAI: background: not supported/);
    assert.match(e.hints[0]!, /echoes every capability-checked field/);
  });
  it('maps status codes to meaning + hints (402, 403 moderation, 429, 502, 503)', () => {
    const e402 = explainOpenRouterError(402, JSON.stringify({ error: { code: 402, message: 'Insufficient credits', metadata: { error_type: 'payment_required' } } }), MODEL);
    assert.match(e402.message, /HTTP 402 — Insufficient credits — payment_required: insufficient credits\. Insufficient credits/);
    assert.equal(e402.errorType, 'payment_required');
    assert.ok(e402.hints.some((h) => /openrouter\.ai\/settings\/credits/.test(h)));

    const e403 = explainOpenRouterError(
      403,
      JSON.stringify({ error: { code: 403, message: 'Input flagged', metadata: { reasons: ['violence'], flagged_input: 'a bloody …', provider_name: 'OpenAI' } } }),
      MODEL,
    );
    assert.ok(e403.hints.some((h) => /Moderation flagged the input \(violence\).*flagged segment: "a bloody …".*\[OpenAI\]/.test(h)));
    assert.ok(e403.hints.some((h) => /guardrail or moderation/.test(h)));

    const e429 = explainOpenRouterError(429, JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded', provider_code: 'rate_limited' } } }), MODEL);
    assert.match(e429.message, /Rate limited/);
    assert.ok(e429.hints.some((h) => /Retry-After/.test(h)));
    assert.ok(e429.hints.some((h) => /Upstream provider code: rate_limited/.test(h)));

    const e502 = explainOpenRouterError(502, '', MODEL);
    assert.match(e502.message, /HTTP 502 — Model\/provider failure.*not billed.*\(no error body\)/);
    assert.ok(e502.hints.some((h) => /safety-blocked generation also surfaces as 502/.test(h)));

    const e503 = explainOpenRouterError(503, 'upstream says no', MODEL);
    assert.match(e503.message, /No available provider meets your routing requirements\. upstream says no/);
    assert.ok(e503.hints.some((h) => /Ignored Providers/.test(h)));
  });
  it('200-with-error bodies: status taken from error.code; error_type labelled', () => {
    const e = explainOpenRouterError(undefined, JSON.stringify({ error: { code: 502, message: 'You exceeded your current quota', metadata: { error_type: 'provider_unavailable' } } }), MODEL);
    assert.equal(e.status, 502);
    assert.match(e.message, /HTTP 502 — Model\/provider failure.*provider_unavailable: provider returned an invalid or empty response\. You exceeded your current quota/);
  });
  it('parseErrorBody tolerates non-JSON and bare error objects', () => {
    assert.equal(parseErrorBody('<html>502</html>'), null);
    assert.equal(parseErrorBody(JSON.stringify({ message: 'bare', code: 400 }))?.message, 'bare');
    assert.equal(parseErrorBody(JSON.stringify({ error: { name: 'ZodError', message: '[]' } }))?.type, 'ZodError');
  });
  it('OpenRouterApiError: describeError prints the explanation; wrapping is idempotent', () => {
    const raw = http(402, { error: { code: 402, message: 'Insufficient credits' } });
    const wrapped = toOpenRouterApiError(raw, MODEL);
    assert.ok(wrapped instanceof OpenRouterApiError);
    assert.ok(wrapped instanceof GatewayHttpError);
    assert.equal(wrapped.status, 402);
    assert.equal(toOpenRouterApiError(wrapped, MODEL), wrapped);
    assert.equal(describeError(wrapped), `Request failed (HTTP 402): ${wrapped.explanation}`);
    assert.match(describeError(wrapped), /Insufficient credits/);
  });
  it('isSizeRejection recognises the provider\'s pixel-budget 400 only', () => {
    assert.equal(isSizeRejection(http(400, { error: { message: "Invalid size '256x256'. Requested resolution is below the current minimum pixel budget.", code: 400 } })), true);
    assert.equal(isSizeRejection(http(400, { error: { message: 'quality invalid', code: 400 } })), false);
    assert.equal(isSizeRejection(http(502, { error: { message: 'size', code: 502 } })), false);
    assert.equal(isSizeRejection(new Error('size')), false);
  });
});

describe('OpenRouterGateway.generateImage over a stubbed fetch', () => {
  const realFetch = globalThis.fetch;
  let requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  let responder: (url: string, body: Record<string, unknown> | null) => { status: number; json: unknown; headers?: Record<string, string> };

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ url, body });
      const r = responder(url, body);
      return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const gw = (): OpenRouterGateway => {
    const g = new OpenRouterGateway('sk-or-v1-test-token-0123456789abcdef', silentLogger);
    g.setImageCapabilities(caps);
    return g;
  };
  const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, json: { created: 1, data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.005 }, ...extra } });

  it('sends quality + background, drops the tier, reports the note and cost; sync accessors answer from the cache', async () => {
    responder = () => ok();
    const g = gw();
    const res = await g.generateImage(base({ aspectRatio: '1:1', resolution: '512', quality: 'low', background: '#ffffff' }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'https://openrouter.ai/api/v1/images');
    assert.deepEqual(requests[0]!.body, { model: MODEL, prompt: 'an orange circle', aspect_ratio: '1:1', quality: 'low', background: 'opaque' });
    assert.equal(res.images.length, 1);
    assert.equal(res.images[0]!.mimeType, 'image/png');
    assert.equal(res.cost, 0.005);
    assert.equal(res.warnings?.length, 1);
    assert.match(res.warnings![0]!, /"512" was not sent/);

    assert.deepEqual(g.imageResolutions(MODEL), { values: [], source: 'api' });
    assert.deepEqual(g.imageQualityLevels(MODEL), { values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'api' });
    assert.deepEqual(g.imageBackgroundModes(MODEL), { values: ['auto', 'opaque'], source: 'api' });
    assert.equal(g.imageAspectRatios(MODEL).source, 'api');
    // An unknown model still gets the static documented lists.
    assert.equal(g.imageResolutions('x/unknown').source, 'fallback');
    assert.equal(g.imageQualityLevels('x/unknown'), null);
    assert.equal(g.imageBackgroundModes('x/unknown'), null);
  });

  it('refuses transparent BEFORE any request (nothing billed)', async () => {
    responder = () => ok();
    await assert.rejects(gw().generateImage(base({ background: 'transparent' })), /cannot produce a transparent background/);
    assert.equal(requests.length, 0);
  });

  it('exact size rejected by the provider → retried once without `size`, with a note', async () => {
    responder = (_url, body) =>
      body && 'size' in body
        ? { status: 400, json: { error: { message: "Invalid size '256x256'. Requested resolution is below the current minimum pixel budget.", code: 400, metadata: { provider_name: 'OpenAI' } } } }
        : ok();
    const res = await gw().generateImage(base({ width: 256, height: 256, aspectRatio: '1:1' }));
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.body!['size'], '256x256');
    assert.equal(requests[1]!.body!['size'], undefined);
    assert.equal(requests[1]!.body!['aspect_ratio'], '1:1');
    assert.equal(res.images.length, 1);
    assert.ok(res.warnings!.some((w) => /Exact size 256x256 was rejected.*minimum pixel budget.*native size/.test(w)));
  });

  it('a rejected exact size keeps the requested SHAPE (nearest supported ratio), not the configured default', async () => {
    responder = (_url, body) =>
      body && 'size' in body ? { status: 400, json: { error: { message: "Invalid size '640x384'.", code: 400 } } } : ok();
    // aspectRatio '1:1' is what the configured default injects when the caller gave none.
    const res = await gw().generateImage(base({ width: 640, height: 384, aspectRatio: '1:1' }));
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.body!['aspect_ratio'], '16:9', '640/384 ≈ 1.67 is nearest 16:9 — the old retry rendered a 1:1 square');
    assert.ok(res.warnings!.some((w) => /aspect ratio 16:9, the supported shape nearest to the requested 640x384/.test(w)));
  });

  it('a 402 surfaces as an explained OpenRouterApiError and diagnoseFailure carries its hints', async () => {
    responder = (url) =>
      url.endsWith('/images')
        ? { status: 402, json: { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', metadata: { error_type: 'payment_required' } } } }
        : { status: 404, json: {} };
    const g = gw();
    let caught: unknown;
    try {
      await g.generateImage(base());
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof OpenRouterApiError);
    assert.equal((caught as OpenRouterApiError).status, 402);
    assert.equal((caught as OpenRouterApiError).errorType, 'payment_required');
    assert.match(describeError(caught), /Request failed \(HTTP 402\): HTTP 402 — Insufficient credits — payment_required/);
    const causes = await g.diagnoseFailure(caught, { model: MODEL });
    assert.ok(causes.some((c) => /Top up OpenRouter credits/.test(c)));
  });

  // The exact body OpenRouter sent during the 2026-10-04 review (balance still showed $0.68).
  const NATIVE_402 = {
    error: {
      message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
      code: 402,
      metadata: { limit_source: 'openrouter_credits', remedy_hint: 'Add credits at https://openrouter.ai/settings/credits' },
    },
  };
  const account = (url: string, key: { include_byok_in_limit: boolean; byok_usage: number }) =>
    url.endsWith('/credits')
      ? { status: 200, json: { data: { total_credits: 146, total_usage: 145.32 } } }
      : url.endsWith('/key')
        ? { status: 200, json: { data: key } }
        : null;
  const diagnose = async (g: OpenRouterGateway): Promise<string[]> => {
    const err = await g.generateImage(base()).then(
      () => assert.fail('expected a failure'),
      (e: unknown) => e,
    );
    return g.diagnoseFailure(err, { model: MODEL });
  };

  it("OpenRouter's own 402 (limit_source openrouter_credits) never suggests BYOK, even with credit left", async () => {
    responder = (url) => account(url, { include_byok_in_limit: false, byok_usage: 0 }) ?? { status: 402, json: NATIVE_402 };
    const causes = await diagnose(gw());
    assert.ok(causes.some((c) => /Top up OpenRouter credits/.test(c)));
    assert.ok(causes.some((c) => /own credit check refused .* \$0\.68 left/.test(c)), causes.join('\n'));
    assert.ok(!causes.some((c) => /BYOK/.test(c)), `no BYOK hint expected:\n${causes.join('\n')}`);
  });

  it('an UPSTREAM quota error while credit remains suggests "Include BYOK" — unless /key shows BYOK unused', async () => {
    const upstream = { status: 200, json: { error: { code: 502, message: 'You exceeded your current quota, please check your plan and billing details.' } } };
    responder = (url) => account(url, { include_byok_in_limit: true, byok_usage: 3.2 }) ?? upstream;
    assert.ok((await diagnose(gw())).some((c) => /Include BYOK/.test(c)));

    responder = (url) => account(url, { include_byok_in_limit: false, byok_usage: 0 }) ?? upstream;
    assert.ok(!(await diagnose(gw())).some((c) => /BYOK/.test(c)), 'BYOK off and unused → not a cause');
  });

  it('a 200 body carrying an `error` object fails fast with the explained message', async () => {
    responder = () => ({ status: 200, json: { error: { code: 502, message: 'You exceeded your current quota', metadata: { error_type: 'provider_unavailable' } } } });
    await assert.rejects(gw().generateImage(base()), /error in a 200 body: HTTP 502 — Model\/provider failure.*You exceeded your current quota/);
    assert.equal(requests.length, 1); // deterministic — no retry
  });

  it('a transient 502 is retried exactly ONCE in total (the HTTP layer never re-sends the POST)', async () => {
    responder = () => ({ status: 502, json: { error: { code: 502, message: 'Provider returned error', metadata: { error_type: 'provider_unavailable' } } } });
    await assert.rejects(gw().generateImage(base()), OpenRouterApiError);
    assert.equal(requests.length, 2, 'one request + one gateway retry — not 3 HTTP tries × 2 attempts');
  });

  it('a 502 safety block (moderation reasons) is deterministic — no retry at all', async () => {
    responder = () => ({
      status: 502,
      json: { error: { code: 502, message: 'Generation blocked', metadata: { error_type: 'content_policy_violation', reasons: ['violence'] } } },
    });
    await assert.rejects(gw().generateImage(base()), OpenRouterApiError);
    assert.equal(requests.length, 1);
  });
});

describe('isDeterministicFailure', () => {
  it('true for moderation reasons / deterministic error_types; false for transient ones and non-JSON', () => {
    assert.equal(isDeterministicFailure(JSON.stringify({ error: { message: 'x', metadata: { reasons: ['sexual'] } } })), true);
    assert.equal(isDeterministicFailure(JSON.stringify({ error: { message: 'x', metadata: { error_type: 'refusal' } } })), true);
    assert.equal(isDeterministicFailure(JSON.stringify({ error: { message: 'x', metadata: { error_type: 'provider_overloaded' } } })), false);
    assert.equal(isDeterministicFailure(JSON.stringify({ error: { message: 'x' } })), false);
    assert.equal(isDeterministicFailure('<html>bad gateway</html>'), false);
  });
});

describe('background spec: native modes', () => {
  it('parses opaque/auto as a mode with no colour to verify, and reports it in the summary', () => {
    assert.deepEqual(parseBackgroundSpec('opaque'), { kind: 'mode', mode: 'opaque', raw: 'opaque' });
    assert.deepEqual(parseBackgroundSpec('AUTO'), { kind: 'mode', mode: 'auto', raw: 'AUTO' });
    const c = compileConstraints({ background: 'opaque' });
    assert.equal(c.background?.kind, 'mode');
    assert.ok(c.summary.some((s) => /background: opaque \(native mode\)/.test(s)));
  });
});

describe('retryAfterMs', () => {
  const h = (v: string | null) => ({ headers: { get: () => v } });
  it('honours delta-seconds and HTTP-dates, capped at 30 s; null when absent/invalid', () => {
    assert.equal(retryAfterMs(h('5')), 5000);
    assert.equal(retryAfterMs(h('600')), 30_000);
    const now = Date.parse('2026-09-09T10:00:00Z');
    assert.equal(retryAfterMs(h('Wed, 09 Sep 2026 10:00:07 GMT'), now), 7000);
    assert.equal(retryAfterMs(h(null)), null);
    assert.equal(retryAfterMs(h('soon')), null);
    assert.equal(retryAfterMs(h('0')), null);
  });
});
