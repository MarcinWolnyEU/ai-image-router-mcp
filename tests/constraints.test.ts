/**
 * Constraint fixtures — the remaining needs from the X55 icon session backlog:
 *
 *  S4  a pinned accent palette must be a first-class, server-understood part of
 *      the request (not prose), must survive provider mapping, and the tool must
 *      be able to say whether the model honoured it.
 *  S5  exclusions ("no text", "no watermark", "no cable") and a background spec
 *      must be explicit constraints carried to the provider's own fields.
 *  S6  reference images must distinguish SUBJECT conditioning from STYLE
 *      transfer, and the tool must state what the configured model provides
 *      BEFORE generating (and refuse a mode it cannot do).
 *
 * Real sharp + the real MCP tools over an in-memory transport (a fake gateway
 * records the request the provider would have received). No network, no cost.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { runtime } from '../src/state/runtime.js';
import { buildFalImageInput } from '../src/gateways/fal.js';
import {
  analyzeBackground,
  analyzePalette,
  compileConstraints,
  expandExclusion,
  hueFamily,
  normalizeHex,
  offPaletteFamilies,
  parseBackgroundSpec,
  parseHexColor,
} from '../src/media/palette.js';
import type { Gateway, ImageGenParams, ImageGenResult, ReferenceSemantics } from '../src/gateways/types.js';
import { makeFakeGateway, startMcpHarness, textOf, type McpHarness } from './helpers/mcp.js';

const YELLOW = '#f0ea17';
const RED = '#e60909';

/** Two-tone artwork in the pinned palette on a white field. */
async function twoTone(a = YELLOW, b = RED, bg = '#ffffff'): Promise<Buffer> {
  const svg =
    `<svg width="256" height="256"><rect width="256" height="256" fill="${bg}"/>` +
    `<rect x="40" y="40" width="80" height="176" fill="${a}"/>` +
    `<rect x="136" y="40" width="80" height="176" fill="${b}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const twoToneDataUrl = async (): Promise<string> => `data:image/png;base64,${(await twoTone()).toString('base64')}`;

describe('S4/S5 — constraint compilation (deterministic, no model involved)', () => {
  it('compiles a palette into exact hexes plus the hue families that must NOT appear', () => {
    const c = compileConstraints({ palette: [YELLOW, RED] });
    assert.match(c.text, /COLOUR PALETTE \(exact\): #f0ea17 \(yellow\), #e60909 \(red\)/);
    assert.match(c.text, /No orange, green, cyan, blue, purple, magenta anywhere/);
    assert.deepEqual(c.palette, [YELLOW, RED]);
    // The session's recurring complaint ("NO blue lighting") becomes automatic.
    assert.ok(offPaletteFamilies([YELLOW, RED]).includes('blue'));
    assert.equal(hueFamily(parseHexColor(YELLOW)), 'yellow');
    assert.equal(hueFamily(parseHexColor(RED)), 'red');
  });

  it('expands known exclusions to the phrasing that actually suppresses them', () => {
    assert.equal(expandExclusion('text'), 'text, letters, words, numbers, labels, captions, typography, logotype');
    assert.equal(expandExclusion('NO cable'), 'cable, wire, cord, lead');
    assert.equal(expandExclusion('a watermark'), 'watermark, signature, stamp, attribution mark');
    assert.equal(expandExclusion('joystick base'), 'joystick base', 'unknown terms are kept verbatim');
  });

  it('turns exclusions + background into a constraint block AND a native negative prompt', () => {
    const c = compileConstraints({ exclude: ['text', 'watermark'], background: 'solid flat #ffffff' });
    assert.match(c.text, /MUST NOT CONTAIN: text, letters, words, numbers, labels, captions, typography, logotype; watermark/);
    assert.match(c.text, /BACKGROUND: solid flat #ffffff, edge to edge and perfectly uniform/);
    assert.ok(c.negativePrompt && c.negativePrompt.includes('typography'), 'exclusions must reach the native negative_prompt');
    assert.equal(c.background?.kind, 'color');
    assert.equal((c.background as { hex: string }).hex, '#ffffff');
  });

  it('parses the background spec forms the caller actually types', () => {
    assert.equal(parseBackgroundSpec('transparent').kind, 'transparent');
    assert.equal((parseBackgroundSpec('solid white') as { hex: string }).hex, '#ffffff');
    assert.equal((parseBackgroundSpec('#e60909') as { hex: string }).hex, RED);
    assert.equal(parseBackgroundSpec('a misty forest at dawn').kind, 'text');
  });

  it('rejects a malformed hex (so it fails before a generation is billed)', () => {
    assert.throws(() => normalizeHex('#nothex'), /not a hex colour/);
  });

  it('produces no block at all when nothing is constrained', () => {
    assert.equal(compileConstraints({}).text, '');
  });
});

describe('S4/S5 — verifying a result against the constraints', () => {
  it('measures on-palette coverage and names the dominant off-palette accent', async () => {
    const onPalette = await analyzePalette(await twoTone(), [YELLOW, RED]);
    assert.ok(onPalette.onPaletteFraction > 0.95, `expected on-palette, got ${onPalette.onPaletteFraction}`);
    assert.ok(onPalette.colors.every((c) => c.present));

    // The failure the session actually hit: the model drifted to blue/red.
    const drifted = await analyzePalette(await twoTone('#1e88e5', '#c62828'), [YELLOW, RED]);
    assert.equal(drifted.colors[0]!.present, false, 'the yellow was never produced');
    assert.ok(drifted.onPaletteFraction < 0.6);
    assert.equal(drifted.offPalette?.family, 'blue');
  });

  it('checks the background against the spec (colour and transparency)', async () => {
    const white = await analyzeBackground(await twoTone(), '#ffffff');
    assert.equal(white.matched, true);
    assert.ok(white.uniformity > 0.95);

    const wrong = await analyzeBackground(await twoTone(YELLOW, RED, '#202020'), 'solid white');
    assert.equal(wrong.matched, false);

    const cutout = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    assert.equal((await analyzeBackground(cutout, 'transparent')).matched, true);
    assert.equal((await analyzeBackground(await twoTone(), 'transparent')).matched, false);
  });

  it('does not judge a free-text background, but still describes it', async () => {
    const r = await analyzeBackground(await twoTone(), 'a misty forest at dawn');
    assert.equal(r.matched, null);
    assert.equal(r.spec.kind, 'text');
  });
});

describe('S4/S5 — constraints survive fal provider mapping', () => {
  const base = { prompt: 'an icon', aspectRatio: '1:1', resolution: null, n: null, temperature: null, topP: null, edenProvider: null };

  it('Recraft receives the palette as structured colors[] + background_color, not just prose', () => {
    const input = buildFalImageInput({
      ...base,
      model: 'fal-ai/recraft/v3/text-to-image',
      palette: [YELLOW, RED],
      background: '#ffffff',
    } as never);
    assert.deepEqual(input['colors'], [parseHexColor(YELLOW), parseHexColor(RED)]);
    assert.deepEqual(input['background_color'], parseHexColor('#ffffff'));
  });

  it('a model with no palette field still gets the exclusions as its native negative_prompt', () => {
    const input = buildFalImageInput({
      ...base,
      model: 'nvidia/cosmos-3-super/text-to-image',
      palette: [YELLOW],
      negativePrompt: 'text, letters, watermark',
    } as never);
    assert.equal(input['colors'], undefined, 'Cosmos has no colors[] — do not invent one');
    assert.equal(input['negative_prompt'], 'text, letters, watermark');
  });
});

// ---------------------------------------------------------------------------
// S6 — reference semantics, and S4/S5 end-to-end through generate_image
// ---------------------------------------------------------------------------

interface Recorder {
  calls: number;
  last?: ImageGenParams;
}

function makeGateway(semantics: ReferenceSemantics | null, rec: Recorder, image: () => Promise<Buffer>): Gateway {
  return makeFakeGateway({
    id: 'fal',
    capabilities: { imageAspectRatioParam: true, imageReferenceImages: true },
    imageAspectRatios: () => ({ values: ['1:1'], source: 'fallback' }),
    referenceSemantics: () => semantics,
    async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
      rec.calls += 1;
      rec.last = params;
      return { images: [{ bytes: await image(), mimeType: 'image/png' }], modelUsed: 'fake/model', raw: {} };
    },
  });
}

const STYLE_ONLY: ReferenceSemantics = {
  native: 'style',
  supported: ['style'],
  field: 'image_style_references',
  note: 'Style/medium transfer ONLY.',
};

describe('generate_image with a STYLE-only model (Krea-like)', () => {
  let h: McpHarness;
  const rec: Recorder = { calls: 0 };
  const call = (name: string, args: Record<string, unknown>) => h.call(name, args);

  before(async () => {
    h = await startMcpHarness({
      gateway: makeGateway(STYLE_ONLY, rec, () => twoTone()),
      gatewayId: 'fal',
      image: { model: 'krea/v2/medium/text-to-image' },
      clientName: 'constraints-test',
      tmpPrefix: 'air-constraints-',
    });
  });

  after(() => h.close());

  it('S4/S5: the constraint reaches the provider request and the result is checked against it', async () => {
    rec.calls = 0;
    const r = await call('generate_image', {
      prompt: 'an X55 joystick icon',
      palette: [YELLOW, RED],
      exclude: ['text', 'watermark'],
      background: '#ffffff',
    });
    assert.equal(r.isError, undefined, textOf(r));
    // Carried into the request the provider receives — both in the prompt and structured.
    assert.match(rec.last!.prompt, /an X55 joystick icon/);
    assert.match(rec.last!.prompt, /COLOUR PALETTE \(exact\): #f0ea17 \(yellow\), #e60909 \(red\)/);
    assert.match(rec.last!.prompt, /MUST NOT CONTAIN: text, letters/);
    assert.deepEqual(rec.last!.palette, [YELLOW, RED]);
    assert.equal(rec.last!.background, '#ffffff');
    assert.match(rec.last!.negativePrompt ?? '', /typography/);
    // And measured afterwards, so "did it honour it?" is answered in the reply.
    assert.match(textOf(r), /Constraints applied: palette pinned to #f0ea17, #e60909/);
    assert.match(textOf(r), /Palette check .*on-palette/);
    assert.match(textOf(r), /✓ #f0ea17/);
    assert.match(textOf(r), /Background check: ✓ #ffffff/);
  });

  it('S4: an invalid hex fails before the model is called', async () => {
    rec.calls = 0;
    const r = await call('generate_image', { prompt: 'x', palette: ['#f0ea17', 'nope'] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not a hex colour/);
    assert.equal(rec.calls, 0, 'nothing may be generated (or billed) for an invalid constraint');
  });

  it('S4: drift off the palette is reported, not hidden', async () => {
    runtime.gateway = makeGateway(STYLE_ONLY, rec, () => twoTone('#1e88e5', '#c62828'));
    const r = await call('generate_image', { prompt: 'x', palette: [YELLOW, RED] });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /✗ #f0ea17/);
    assert.match(textOf(r), /dominant off-palette accent/);
    runtime.gateway = makeGateway(STYLE_ONLY, rec, () => twoTone());
  });

  it('S6: subject conditioning is refused BEFORE generating, naming what the model does provide', async () => {
    rec.calls = 0;
    const dataUrl = await twoToneDataUrl();
    const r = await call('generate_image', { prompt: 'x', reference_images: [dataUrl], reference_mode: 'subject' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cannot use reference images for "subject" conditioning/);
    assert.match(textOf(r), /image_style_references/);
    assert.match(textOf(r), /flux-2-pro\/edit/, 'the error points at a model that can do it');
    assert.equal(rec.calls, 0, 'no generation, no credits');
  });

  it('S6: style conditioning is honoured and the reference use is spelled out in the request', async () => {
    rec.calls = 0;
    const dataUrl = await twoToneDataUrl();
    const r = await call('generate_image', { prompt: 'x', reference_images: [dataUrl], reference_mode: 'style' });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(rec.calls, 1);
    assert.match(rec.last!.prompt, /REFERENCE IMAGES: Use the supplied reference image\(s\) as a style/);
    assert.equal(rec.last!.referenceMode, 'style');
  });

  it('S6: health_status states the reference semantics before anything is generated', async () => {
    const r = await call('health_status', {});
    assert.match(textOf(r), /Reference images: style conditioning via image_style_references/);
  });
});

describe('generate_image with a SUBJECT-capable model (edit-endpoint-like)', () => {
  let h: McpHarness;
  const rec: Recorder = { calls: 0 };
  const SUBJECT: ReferenceSemantics = {
    native: 'subject',
    supported: ['subject', 'style'],
    steered: ['style'],
    field: 'image_urls',
  };

  before(async () => {
    h = await startMcpHarness({
      gateway: makeGateway(SUBJECT, rec, () => twoTone()),
      gatewayId: 'fal',
      image: { model: 'fal-ai/flux-2-pro/edit' },
      clientName: 'constraints-test-2',
      tmpPrefix: 'air-constraints2-',
    });
  });

  after(() => h.close());

  it('S6: subject mode keeps the reference’s design but demands the requested medium', async () => {
    const dataUrl = await twoToneDataUrl();
    const r = await h.call('generate_image', { prompt: 'a clean 3D icon of this joystick', reference_images: [dataUrl], reference_mode: 'subject' });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.match(rec.last!.prompt, /Reproduce the OBJECT DESIGN and geometry/);
    assert.match(rec.last!.prompt, /Do NOT reproduce the reference’s medium, lighting, background or photographic look/);
  });

  it('S6: style mode on a subject-native model is steered, not silently ignored', async () => {
    const dataUrl = await twoToneDataUrl();
    const r = await h.call('generate_image', { prompt: 'an icon', reference_images: [dataUrl], reference_mode: 'style' });
    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    assert.match(rec.last!.prompt, /ONLY as a style, palette and medium reference/);
  });

  it('the fal spec map marks the edit endpoint as subject conditioning (image_urls)', () => {
    const input = buildFalImageInput({
      prompt: 'x',
      model: 'fal-ai/flux-2-pro/edit',
      aspectRatio: '1:1',
      references: [{ bytes: Buffer.from('x'), mimeType: 'image/png', role: 'reference' }],
    } as never);
    const urls = input['image_urls'] as string[];
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /^data:image\/png;base64,/);
  });
});

describe('generate_image with a model that has NO conditioning input (fal FLUX schnell-like)', () => {
  let h: McpHarness;
  const rec: Recorder = { calls: 0 };

  before(async () => {
    h = await startMcpHarness({
      gateway: makeGateway(null, rec, () => twoTone()),
      gatewayId: 'fal',
      image: { model: 'fal-ai/flux/schnell', async: true },
      clientName: 'constraints-noref',
      tmpPrefix: 'air-noref-',
    });
  });
  after(() => h.close());

  it('reference_images are refused up front — no job id, no gateway call (it used to fail only on the first poll)', async () => {
    const r = await h.call('generate_image', { prompt: 'x', reference_images: [await twoToneDataUrl()] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /has no image-conditioning input/);
    assert.doesNotMatch(textOf(r), /submitted as job/);
    assert.equal(rec.calls, 0);
  });
});
