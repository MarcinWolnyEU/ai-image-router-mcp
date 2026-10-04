/**
 * `generate_image` over an in-memory MCP transport with a fake gateway that
 * advertises per-model options the way OpenRouter does for gpt-image-2.5:
 * a `quality` enum, `background` auto|opaque (no transparent) and NO resolution
 * tier. Checks the tool schema, that `quality` reaches the gateway, that a
 * transparent background is refused before any gateway call, that gateway
 * `warnings` and each image's type + pixel size are reported, and that
 * `health_status` states the options. No network, no cost.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Gateway, ImageGenParams, ImageGenResult } from '../src/gateways/types.js';
import { describeImage, formatBytes, imageInfo } from '../src/util/files.js';
import { makeFakeGateway, startMcpHarness, textOf, type CallResult, type McpHarness } from './helpers/mcp.js';

interface ToolInfo {
  name: string;
  inputSchema: { properties?: Record<string, { enum?: string[]; description?: string }> };
}

let png: Buffer;
let calls = 0;
let last: ImageGenParams | undefined;
const MODEL = 'openai/gpt-image-2.5-sunburst';

const fakeGateway: Gateway = makeFakeGateway({
  capabilities: { imageAspectRatioParam: true, imageResolutionParam: true, listsImageModels: true, imageReferenceImages: true },
  imageAspectRatios: () => ({ values: ['1:1', '3:2', '16:9', 'auto'], source: 'api' }),
  imageResolutions: () => ({ values: [], source: 'api' }), // the API says: NO resolution parameter
  imageQualityLevels: () => ({ values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'api' }),
  imageBackgroundModes: () => ({ values: ['auto', 'opaque'], source: 'api' }),
  referenceSemantics: () => ({ native: 'subject', supported: ['subject', 'style'], steered: ['style'], field: 'input_references' }),
  async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
    calls += 1;
    last = params;
    return {
      images: [{ bytes: png, mimeType: 'image/png' }],
      modelUsed: MODEL,
      cost: 0.0048,
      warnings: params.resolution ? [`${MODEL} has no resolution-tier parameter, so "${params.resolution}" was not sent — native full size kept.`] : [],
      raw: {},
    };
  },
});

let h: McpHarness;

const causesOf = (r: CallResult): string[] =>
  (r.content ?? []).filter((c) => c._meta?.['ai-image-router/category'] === 'possibleCause').map((c) => c.text ?? '');
const call = (name: string, args: Record<string, unknown>): Promise<CallResult> => h.call(name, args);

before(async () => {
  png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff8800' } }).png().toBuffer();
  h = await startMcpHarness({
    gateway: fakeGateway,
    image: { model: MODEL, defaultAspectRatio: '1:1', defaultResolution: '512' },
    clientName: 'image-result-test',
    tmpPrefix: 'air-mcp-imageresult-',
  });
});

after(() => h.close());

describe('generate_image schema reflects the model\'s advertised options', () => {
  it('offers `quality` with the model enum, no `image_size`, and states the native background modes', async () => {
    const tools = (await h.client.listTools()).tools as unknown as ToolInfo[];
    const gen = tools.find((t) => t.name === 'generate_image')!;
    const props = gen.inputSchema.properties!;
    assert.deepEqual(props['quality']?.enum, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.match(props['quality']!.description!, /auto < low < medium < high < xhigh < max/);
    assert.equal(props['image_size'], undefined, 'a model with no resolution parameter must not offer image_size');
    assert.deepEqual(props['aspect_ratio']?.enum, ['1:1', '3:2', '16:9', 'auto']);
    assert.match(props['background']!.description!, /natively accepts: auto, opaque — it CANNOT render transparency/);
  });
});

describe('generate_image behaviour', () => {
  it('passes quality through, reports the gateway note, and states type + pixel size of the saved file', async () => {
    calls = 0;
    const r = await call('generate_image', { prompt: 'orange rectangle', quality: 'high', wait: true });
    assert.equal(r.isError, undefined);
    assert.equal(calls, 1);
    assert.equal(last?.quality, 'high');
    assert.equal(last?.resolution, '512', 'the configured default tier still reaches the gateway, which decides whether to send it');
    const text = textOf(r);
    assert.match(text, /Note: .*no resolution-tier parameter.*"512" was not sent/);
    assert.match(text, /#1: .*\.png  — image\/png 64×48 \(\d+ B|KB\)/);
    assert.match(text, /Reported cost: \$0\.0048/);
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.equal(link.mimeType, 'image/png');
    assert.match(link.description!, /image\/png 64×48/);
  });

  it('refuses a transparent background BEFORE calling the gateway, with a remove_background hint', async () => {
    calls = 0;
    const r = await call('generate_image', { prompt: 'a logo', background: 'transparent', wait: true });
    assert.equal(r.isError, true);
    assert.equal(calls, 0);
    assert.match(textOf(r), /cannot produce a transparent background.*accepts only auto, opaque/);
    const causes = causesOf(r);
    assert.ok(causes.some((c) => /remove_background/.test(c)));
    assert.ok(causes.some((c) => /gpt-image-1/.test(c)));
  });

  it('a colour / native-mode background is accepted and passed on', async () => {
    calls = 0;
    const r1 = await call('generate_image', { prompt: 'a logo', background: '#00ff00', wait: true, check_constraints: false });
    assert.equal(r1.isError, undefined);
    assert.equal(last?.background, '#00ff00');
    const r2 = await call('generate_image', { prompt: 'a logo', background: 'opaque', wait: true, check_constraints: false });
    assert.equal(r2.isError, undefined);
    assert.equal(last?.background, 'opaque');
    assert.match(textOf(r2), /background: opaque \(native mode\)/);
    assert.equal(calls, 2);
  });

  it('rejects an off-enum quality at the schema (no gateway call)', async () => {
    calls = 0;
    const r = await call('generate_image', { prompt: 'x', quality: 'ultra', wait: true });
    assert.equal(r.isError, true);
    assert.equal(calls, 0);
  });

  it('health_status states the model\'s options (no resolution tier, quality levels, background modes)', async () => {
    const r = await call('health_status', {});
    const t = textOf(r);
    assert.match(t, /resolution tiers none — the model has no resolution parameter/);
    assert.match(t, /quality auto, low, medium, high, xhigh, max \[api\]/);
    assert.match(t, /background auto, opaque \[api\]/);
  });
});

describe('image description helpers', () => {
  it('imageInfo / describeImage / formatBytes', async () => {
    const info = await imageInfo(png);
    assert.deepEqual({ w: info?.width, h: info?.height, f: info?.format, a: info?.hasAlpha }, { w: 64, h: 48, f: 'png', a: false });
    assert.match(await describeImage(png, 'image/png'), /^image\/png 64×48 \(\d+ B\)$/);
    assert.equal(await describeImage(Buffer.from('not an image'), 'image/x-icon'), 'image/x-icon (12 B)');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(882599), '862 KB');
    assert.equal(formatBytes(1843960), '1.8 MB');
    assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
  });
});

describe('generate_image says when a model ignored the requested size', () => {
  it('requested width×height ≠ returned pixels → a per-image note (the bytes are kept as delivered)', async () => {
    const r = await call('generate_image', { prompt: 'x', width: 512, height: 512, wait: true });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /#1: Note: requested 512×512, but openai\/gpt-image-2\.5-sunburst returned 64×48/);
  });

  it('a matching size, or no explicit size, adds no note', async () => {
    const plain = await call('generate_image', { prompt: 'x', wait: true });
    assert.doesNotMatch(textOf(plain), /Note: requested/);
    const exact = await call('generate_image', { prompt: 'x', width: 64, height: 48, wait: true });
    assert.doesNotMatch(textOf(exact), /Note: requested/);
  });

  it('a lone `height` derives the width from the aspect ratio instead of being dropped', async () => {
    await call('generate_image', { prompt: 'x', height: 384, aspect_ratio: '16:9', wait: true });
    assert.equal(last?.height, 384);
    assert.equal(last?.width, Math.round(384 * (16 / 9)));
  });

  it('save:false with previews off says that nothing was returned', async () => {
    const r = await call('generate_image', { prompt: 'x', save: false, inline_preview: false, wait: true });
    assert.match(textOf(r), /nothing was saved and no preview was returned/);
  });
});
