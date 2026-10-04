/**
 * Icon-workflow fixtures — the three needs from the X55 icon session backlog:
 *
 *  S1  square-fitting must not silently crop an off-centre subject
 *      (`fitSquare` pad/crop + the `generate_image` ico path).
 *  S2  a whole icon SET must be one operation, each size derived from the
 *      intended master/variant (`build_icon_set`).
 *  S3  an `.ico` must contain exactly the DECLARED size set, with per-entry
 *      provenance, and fail loudly when the sources can't produce it
 *      (`transform_media` `output_format:"ico"` + `sizes`).
 *
 * Real sharp + @fiahfy/ico + the real MCP tools over an in-memory transport.
 * Run: `npm run integration:nonpayment` (no network, no cost).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildIco, fitSquare, icoImageFromPng } from '../src/media/ico.js';
import { colorDistance, parseHexColor } from '../src/media/palette.js';
import type { ImageGenParams, ImageGenResult } from '../src/gateways/types.js';
import { icoLayers } from './helpers/ico.js';
import { linksOf as links, makeFakeGateway, startMcpHarness, textOf, uriToPath, type McpHarness } from './helpers/mcp.js';

const GREEN = '#00c853';

/** A wide (non-square) source whose only subject sits near the LEFT edge. */
async function wideWithLeftDisc(w = 1280, h = 720, color = GREEN): Promise<Buffer> {
  const svg =
    `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>` +
    `<circle cx="120" cy="${h / 2}" r="90" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A square source filled with one flat colour (used to tell master from variant). */
async function squarePng(size: number, color = '#e63946'): Promise<Buffer> {
  const svg = `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** How many pixels of a raw RGBA buffer are (roughly) the given colour. */
function countNear(data: Buffer, hex: string, tol = 60): number {
  const target = parseHexColor(hex);
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    if (colorDistance({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! }, target) <= tol) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// S1 — the primitive
// ---------------------------------------------------------------------------

describe('S1 — square-fitting a non-square source must not silently crop', () => {
  it('pad (the default) keeps an off-centre subject that a center-crop would delete', async () => {
    const wide = await wideWithLeftDisc();

    const padded = await fitSquare(wide, 'image/png', 256);
    const paddedRgba = await sharp(padded.bytes).ensureAlpha().raw().toBuffer();
    assert.equal(padded.applied, 'pad');
    assert.ok(countNear(paddedRgba, GREEN) > 0, 'the subject must survive the square fit');

    const cropped = await fitSquare(wide, 'image/png', 256, { fit: 'crop' });
    const croppedRgba = await sharp(cropped.bytes).ensureAlpha().raw().toBuffer();
    assert.equal(cropped.applied, 'crop');
    assert.equal(countNear(croppedRgba, GREEN), 0, 'the old center-crop drops it entirely — that is why pad is the default');
  });

  it('reports the pad-vs-crop decision instead of making it silently', async () => {
    const wide = await wideWithLeftDisc();
    const padded = await fitSquare(wide, 'image/png', 128);
    assert.match(padded.note, /1280x720 is not square/);
    assert.match(padded.note, /no content was cropped/);
    const cropped = await fitSquare(wide, 'image/png', 128, { fit: 'crop' });
    assert.match(cropped.note, /center-cropped to 720x720/);
    assert.match(cropped.note, /44% of the width/);
  });

  it('pads with a colour when asked, and still refuses to upscale', async () => {
    const padded = await fitSquare(await wideWithLeftDisc(400, 200), 'image/png', 256, { fit: 'pad', background: '#ffffff' });
    const { data, info } = await sharp(padded.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const topLeft = { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
    assert.equal(info.width, 256);
    assert.equal(topLeft.a, 255, 'padding must be opaque when a colour was given');
    assert.ok(colorDistance(topLeft, parseHexColor('#ffffff')) < 12);
    // A source whose long side is below the target is an error, never an upscale.
    const small = await squarePng(64);
    await assert.rejects(() => fitSquare(small, 'image/png', 128), /cannot upscale/);
  });
});

// ---------------------------------------------------------------------------
// S1 (end to end) + S2 + S3 over the real MCP tools
// ---------------------------------------------------------------------------

describe('icon workflow over the MCP tools', () => {
  let h: McpHarness;
  let outDir: string;
  let modelOutput: Buffer;
  let lastParams: ImageGenParams | undefined;
  const call = (name: string, args: Record<string, unknown>) => h.call(name, args);

  before(async () => {
    modelOutput = await wideWithLeftDisc();
    h = await startMcpHarness({
      gateway: makeFakeGateway({
        capabilities: { imageAspectRatioParam: true, imageResolutionParam: true },
        imageAspectRatios: () => ({ values: ['1:1', '16:9'], source: 'fallback' }),
        imageResolutions: () => ({ values: ['512', '1K', '2K'], source: 'fallback' }),
        async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
          lastParams = params;
          return { images: [{ bytes: modelOutput, mimeType: 'image/png' }], modelUsed: 'fake/model', raw: {} };
        },
      }),
      clientName: 'iconset-test',
      tmpPrefix: 'air-iconset-',
    });
    outDir = h.outDir;
  });

  after(() => h.close());

  it('S1: generate_image ico keeps the whole subject of a non-square model result', async () => {
    const r = await call('generate_image', { prompt: 'a mark', output_format: 'ico', width: 128 });
    assert.equal(r.isError, undefined, textOf(r));
    assert.ok(lastParams, 'the gateway was called');
    const ico = links(r).find((l) => l.name.endsWith('.ico'));
    assert.ok(ico, 'expected the .ico resource_link');
    const layers = await icoLayers(await readFile(uriToPath(ico!.uri)));
    assert.equal(layers.length, 1);
    assert.equal(layers[0]!.width, 128);
    assert.ok(countNear(layers[0]!.data, GREEN) > 0, 'the off-centre subject must survive (this was 0 before)');
    assert.match(textOf(r), /no content was cropped/);
  });

  it('S1: square_fit "crop" is available but says what it cost', async () => {
    const r = await call('generate_image', { prompt: 'a mark', output_format: 'ico', width: 128, square_fit: 'crop' });
    assert.equal(r.isError, undefined, textOf(r));
    const ico = links(r).find((l) => l.name.endsWith('.ico'))!;
    const layers = await icoLayers(await readFile(uriToPath(ico.uri)));
    assert.equal(countNear(layers[0]!.data, GREEN), 0);
    assert.match(textOf(r), /center-cropped/);
  });

  it('S2: one build_icon_set call yields every declared size + the .ico', async () => {
    const master = join(outDir, 'x55-master.png');
    await writeFile(master, await squarePng(512, '#e60909'));

    const r = await call('build_icon_set', { image: master, sizes: [256, 64, 32, 16] });
    assert.equal(r.isError, undefined, textOf(r));

    const pngs = links(r).filter((l) => l.name.endsWith('.png'));
    assert.equal(pngs.length, 4, 'one file per declared size');
    for (const [i, size] of [256, 64, 32, 16].entries()) {
      // Deterministic order: largest first, and named by size.
      assert.match(pngs[i]!.name, new RegExp(`-${size}x${size}\\.png$`));
      const meta = await sharp(await readFile(uriToPath(pngs[i]!.uri))).metadata();
      assert.equal(meta.width, size);
      assert.equal(meta.height, size);
    }
    const ico = links(r).find((l) => l.name.endsWith('.ico'));
    assert.ok(ico, 'the set is assembled into one icon');
    const sizes = (await icoLayers(await readFile(uriToPath(ico!.uri)))).map((l) => l.width).sort((a, b) => a - b);
    assert.deepEqual(sizes, [16, 32, 64, 256]);
    assert.match(textOf(r), /exactly the declared set: 16, 32, 64, 256/);
  });

  it('S2: smaller sizes can be derived from a variant, and the reply says which source each came from', async () => {
    const master = join(outDir, 'set-master.png');
    const variant = join(outDir, 'set-simple.png');
    await writeFile(master, await squarePng(512, '#e60909')); // red
    await writeFile(variant, await squarePng(256, '#1e88e5')); // blue

    const r = await call('build_icon_set', {
      image: master,
      sizes: [256, 128, 32, 16],
      variants: [{ image: variant, sizes: [32, 16] }],
      name: 'x55',
    });
    assert.equal(r.isError, undefined, textOf(r));
    const ico = links(r).find((l) => l.name.endsWith('.ico'))!;
    const layers = await icoLayers(await readFile(uriToPath(ico.uri)));
    const byWidth = new Map(layers.map((l) => [l.width, l]));
    assert.deepEqual([...byWidth.keys()].sort((a, b) => a - b), [16, 32, 128, 256]);
    assert.ok(countNear(byWidth.get(256)!.data, '#e60909') > 0, '256 comes from the master');
    assert.ok(countNear(byWidth.get(16)!.data, '#1e88e5') > 0, '16 comes from the variant');
    assert.equal(countNear(byWidth.get(16)!.data, '#e60909'), 0, 'the variant sizes must NOT come from the master');
    // Per-size provenance is in the text, so the set can be confirmed without unpacking.
    assert.match(textOf(r), /256x256 ← master/);
    assert.match(textOf(r), /16x16 ← set-simple/);
  });

  it('S2: duplicate / unknown / un-derivable sizes are rejected before anything is written', async () => {
    const master = join(outDir, 'dup-master.png');
    await writeFile(master, await squarePng(128));

    const dup = await call('build_icon_set', { image: master, sizes: [32, 32] });
    assert.equal(dup.isError, true);
    assert.match(textOf(dup), /Duplicate size 32/);

    const stray = await call('build_icon_set', { image: master, sizes: [32, 16], variants: [{ image: master, sizes: [48] }] });
    assert.equal(stray.isError, true);
    assert.match(textOf(stray), /claims size 48, which is not in the declared/);

    const tooBig = await call('build_icon_set', { image: master, sizes: [256] });
    assert.equal(tooBig.isError, true);
    assert.match(textOf(tooBig), /cannot upscale/);

    const notIco = await call('build_icon_set', { image: master, sizes: [100] });
    assert.equal(notIco.isError, true);
    assert.match(textOf(notIco), /not an allowed ICO size/);
  });

  it('S2: a failure on a SMALL size (after larger ones were derived) still writes nothing', async () => {
    // Largest-first: 256/128 derive fine from the master, then 32 fails from a tiny
    // variant. Every file must be withheld — "Nothing was written" has to be true.
    const master = join(outDir, 'partial-master.png');
    const tiny = join(outDir, 'partial-tiny.png');
    await writeFile(master, await squarePng(512));
    await writeFile(tiny, await squarePng(8));
    const { readdir } = await import('node:fs/promises');
    const beforeFiles = new Set(await readdir(outDir));
    const r = await call('build_icon_set', { image: master, sizes: [256, 128, 32], variants: [{ image: tiny, sizes: [32] }], name: 'partial' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Nothing was written/);
    const written = (await readdir(outDir)).filter((f) => !beforeFiles.has(f));
    assert.deepEqual(written, [], `no partial set may be left behind, found: ${written.join(', ')}`);
  });

  it('S2: ico:false emits just the images (any square size allowed)', async () => {
    const master = join(outDir, 'plain-master.png');
    await writeFile(master, await squarePng(512, '#00c853'));
    const r = await call('build_icon_set', { image: master, sizes: [300, 100], ico: false, output_format: 'webp' });
    assert.equal(r.isError, undefined, textOf(r));
    const files = links(r);
    assert.equal(files.length, 2);
    assert.equal(files.filter((f) => f.name.endsWith('.ico')).length, 0);
    const meta = await sharp(await readFile(uriToPath(files[0]!.uri))).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 300);
  });

  it('S3: transform_media ico refuses when a source is not the size it was declared as', async () => {
    const a = join(outDir, 's3-a.png');
    const b = join(outDir, 's3-b.png');
    await writeFile(a, await squarePng(16));
    await writeFile(b, await squarePng(32)); // declared below as 24 — a real mismatch

    const r = await call('transform_media', { image: [a, b], output_format: 'ico', sizes: [16, 24] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /element 2 \(s3-b\.png\) was declared as 24px but is actually 32x32/);
  });

  it('S3: a declared set that the inputs cannot produce fails loudly (nothing written)', async () => {
    const a = join(outDir, 's3-c.png');
    await writeFile(a, await squarePng(48));
    const r = await call('transform_media', { image: [a], output_format: 'ico', sizes: [16, 48] });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /do not produce the declared set/);
    assert.match(textOf(r), /missing 16/);
  });

  it('S3: a matching declared set succeeds and every entry is reported with its source', async () => {
    const a = join(outDir, 's3-16.png');
    const b = join(outDir, 's3-32.png');
    await writeFile(a, await squarePng(16));
    await writeFile(b, await squarePng(32));
    const merged = join(outDir, 's3-256.ico');
    await writeFile(merged, buildIco([icoImageFromPng(await squarePng(256))]));

    const r = await call('transform_media', { image: [a, b, merged], output_format: 'ico', sizes: [16, 32, 256] });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /matches the declared set/);
    assert.match(textOf(r), /256x256 ← s3-256\.ico \(embedded entry\)/);
    assert.match(textOf(r), /16x16 ← s3-16\.png/);
    const ico = links(r).find((l) => l.name.endsWith('.ico'))!;
    const sizes = (await icoLayers(await readFile(uriToPath(ico.uri)))).map((l) => l.width).sort((x, y) => x - y);
    assert.deepEqual(sizes, [16, 32, 256]);
  });

  it('S3: entries are still listed with their source when no set is declared', async () => {
    const a = join(outDir, 's3-plain.png');
    await writeFile(a, await squarePng(64));
    const r = await call('transform_media', { image: a, output_format: 'ico' });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /Entries \(size ← source\):/);
    assert.match(textOf(r), /64x64 ← s3-plain\.png/);
  });
});
