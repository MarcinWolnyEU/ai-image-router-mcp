/**
 * ICO integration tests. Exercised over the real `@fiahfy/ico` encoder + sharp:
 *  - `fitSquare` (downscale never upscale, original preserved) + single-entry ICO
 *  - `buildIcoFromInputs` (multi-size array, dedupe, ICO merge) via the real MCP tool
 *  - magic-byte detection + ico mime ext mapping
 * Run: `npm run integration:nonpayment` (no network/cost).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { fitSquare, buildIco, icoImageFromPng, icoSizeOfSquare, isIcoBytes, parseIco, pickGenerationResolution, resolutionPixels } from '../src/media/ico.js';
import { buildFalImageInput } from '../src/gateways/fal.js';
import type { ImageGenParams, ImageGenResult } from '../src/gateways/types.js';
import { icoLayers, type IcoLayer } from './helpers/ico.js';
import { linkOf as link, linksOf, makeFakeGateway, startMcpHarness, textOf, uriToPath, type McpHarness } from './helpers/mcp.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A square SVG logo at `size`, transparent corners / opaque centre. */
async function squarePng(size: number, color = '#e63946'): Promise<Buffer> {
  const r = size / 2;
  const svg = `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="transparent"/><circle cx="${r}" cy="${r}" r="${r * 0.8}" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── Hand-built ICOs, the way real-world tools write them (not via @fiahfy/ico) ────────────

/** Assemble an ICO from raw entry payloads: directory (width/height byte 0 = 256) + data. */
function rawIco(entries: Array<{ size: number; bitCount: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(e.bitCount, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

type Rgba = [number, number, number, number?];
/**
 * A classic DIB icon entry at `bpp`: BITMAPINFOHEADER (doubled height) + palette (≤8 bpp) +
 * bottom-up XOR rows padded to 4 bytes + the 1-bpp AND mask (1 = transparent).
 */
function dibEntry(
  size: number,
  bpp: 1 | 4 | 8 | 24 | 32,
  colorAt: (x: number, y: number) => number | Rgba,
  transparentAt: (x: number, y: number) => boolean,
  palette: Array<[number, number, number]> = [],
): Buffer {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(bpp, 14);
  hdr.writeUInt32LE(bpp <= 8 ? palette.length : 0, 32);
  const pal = Buffer.alloc(palette.length * 4);
  palette.forEach(([r, g, b], i) => {
    pal[i * 4] = b;
    pal[i * 4 + 1] = g;
    pal[i * 4 + 2] = r;
  });
  const stride = ((size * bpp + 31) >> 5) << 2;
  const andStride = ((size + 31) >> 5) << 2;
  const xor = Buffer.alloc(stride * size);
  const and = Buffer.alloc(andStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const c = colorAt(x, y);
      if (bpp <= 8) {
        const bit = x * bpp;
        const at = row * stride + (bit >> 3);
        xor[at] = xor[at]! | ((c as number) << (8 - bpp - (bit & 7)));
      } else {
        const [r, g, b, a = 255] = c as Rgba;
        const p = row * stride + x * (bpp / 8);
        xor[p] = b;
        xor[p + 1] = g;
        xor[p + 2] = r;
        if (bpp === 32) xor[p + 3] = a;
      }
      if (transparentAt(x, y)) {
        const at = row * andStride + (x >> 3);
        and[at] = and[at]! | (0x80 >> (x & 7));
      }
    }
  }
  return Buffer.concat([hdr, pal, xor, and]);
}

/** RGBA of pixel (x, y) in a decoded layer. */
const px = (l: IcoLayer, x: number, y: number): number[] => [...l.data.subarray((y * l.width + x) * 4, (y * l.width + x) * 4 + 4)];

/** A typical modern favicon: a PNG-compressed 256 entry + an 8-bpp paletted 16 entry. */
async function realWorldFavicon(): Promise<Buffer> {
  const png256 = await squarePng(256, '#00ff00');
  const dib16 = dibEntry(16, 8, (_x, y) => (y < 8 ? 1 : 0), (x) => x === 0, [[255, 0, 0], [0, 0, 255]]);
  return rawIco([{ size: 256, bitCount: 32, data: png256 }, { size: 16, bitCount: 8, data: dib16 }]);
}

describe('parseIco — real-world entry encodings (PNG-compressed, paletted, 24-bpp, legacy alpha)', () => {
  it('decodes a PNG-compressed 256px entry next to an 8-bpp paletted 16px entry', async () => {
    const layers = await icoLayers(await realWorldFavicon());
    assert.deepEqual(layers.map((l) => `${l.width}x${l.height}`), ['256x256', '16x16']);
    const big = layers[0]!;
    assert.deepEqual(px(big, 128, 128).slice(0, 3), [0, 255, 0], 'PNG entry centre is the green disc');
    assert.equal(px(big, 0, 0)[3], 0, 'PNG entry corner keeps its transparency');
    const small = layers[1]!;
    assert.deepEqual(px(small, 5, 2), [0, 0, 255, 255], 'top half = palette index 1 (blue), opaque');
    assert.deepEqual(px(small, 5, 12), [255, 0, 0, 255], 'bottom half = palette index 0 (red), opaque');
    assert.equal(px(small, 0, 5)[3], 0, 'AND-mask bit → transparent');
  });

  it('decodes 4-bpp and 1-bpp paletted entries', async () => {
    const pal16: Array<[number, number, number]> = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, 7]);
    const four = dibEntry(16, 4, (x) => x % 16, () => false, pal16);
    const one = dibEntry(32, 1, (x, y) => (x + y) % 2, (_x, y) => y === 31, [[0, 0, 0], [255, 255, 255]]);
    const layers = await icoLayers(rawIco([{ size: 16, bitCount: 4, data: four }, { size: 32, bitCount: 1, data: one }]));
    assert.deepEqual(px(layers[0]!, 3, 9), [48, 207, 7, 255]);
    assert.deepEqual(px(layers[1]!, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(px(layers[1]!, 1, 0), [255, 255, 255, 255]);
    assert.equal(px(layers[1]!, 4, 31)[3], 0);
  });

  it('decodes a 24-bpp entry, taking alpha from the AND mask', async () => {
    const e = dibEntry(24, 24, (x) => (x < 12 ? [10, 20, 30] : [200, 100, 50]), (x, y) => x === 23 && y === 0);
    const [l] = await icoLayers(rawIco([{ size: 24, bitCount: 24, data: e }]));
    assert.deepEqual(px(l!, 0, 0), [10, 20, 30, 255]);
    assert.deepEqual(px(l!, 20, 5), [200, 100, 50, 255]);
    assert.equal(px(l!, 23, 0)[3], 0);
  });

  it('a legacy 32-bpp entry with an all-zero alpha channel uses its AND mask instead (not invisible)', async () => {
    const e = dibEntry(16, 32, () => [9, 8, 7, 0], (x) => x === 15);
    const [l] = await icoLayers(rawIco([{ size: 16, bitCount: 32, data: e }]));
    assert.deepEqual(px(l!, 3, 3), [9, 8, 7, 255]);
    assert.equal(px(l!, 15, 3)[3], 0);
  });

  it('rejects a truncated entry with a clear error instead of reading garbage', async () => {
    const ico = rawIco([{ size: 16, bitCount: 32, data: dibEntry(16, 32, () => [1, 2, 3, 255], () => false) }]);
    await assert.rejects(async () => parseIco(ico.subarray(0, ico.length - 200)), /truncated/i);
  });
});

describe('media/ico primitives', () => {
  it('fitSquare downscales (never upscales) to an allowed size, preserving square', async () => {
    const big = await squarePng(1024);
    const fitted = await fitSquare(big, 'image/png', 48);
    const meta = await sharp(fitted.bytes).metadata();
    assert.equal(meta.width, 48);
    assert.equal(meta.height, 48);
    assert.equal(fitted.applied, 'none', 'an already-square source needs no pad/crop decision');
    assert.equal(fitted.note, '');
  });

  it('fitSquare throws when the source is smaller than the target (no upscaling)', async () => {
    const small = await squarePng(16);
    await assert.rejects(() => fitSquare(small, 'image/png', 48), /cannot upscale/);
  });

  it('fitSquare rejects a non-allowed size', async () => {
    const png = await squarePng(64);
    await assert.rejects(() => fitSquare(png, 'image/png', 17), /not allowed/);
  });

  it('buildIco wraps a fitted square as a single-entry icon with alpha preserved', async () => {
    const png = await squarePng(32);
    const bytes = buildIco([icoImageFromPng(png)]);
    assert.equal(isIcoBytes(bytes), true);
    const layers = await icoLayers(bytes);
    assert.equal(layers.length, 1);
    assert.equal(layers[0]!.width, 32);
    // centre opaque, corner transparent
    const cx = layers[0]!.data[(16 * 32 + 16) * 4 + 3];
    const corner = layers[0]!.data[3];
    assert.ok(cx !== 0, 'centre should be opaque');
    assert.equal(corner, 0, 'corner should be transparent');
  });

  it('icoSizeOfSquare rejects a non-square image (icons must be square)', async () => {
    const png = await sharp({ create: { width: 32, height: 48, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    await assert.rejects(() => icoSizeOfSquare(png), /must be square/);
  });
});

describe('resolution size selection (pickGenerationResolution / resolutionPixels)', () => {
  it('resolutionPixels maps tier strings to pixels', () => {
    assert.equal(resolutionPixels('1K'), 1024);
    assert.equal(resolutionPixels('2K'), 2048);
    assert.equal(resolutionPixels('512'), 512);
    assert.equal(resolutionPixels('256x256'), 256);
    assert.equal(resolutionPixels('1024x1024'), 1024);
    assert.equal(resolutionPixels('square_hd'), null); // unparseable tier
  });

  it('picks the smallest size ≥ target (so we downscale, never upscale)', () => {
    // OpenRouter image_size tiers → pick the smallest that still reaches the target.
    assert.equal(pickGenerationResolution(['512', '1K', '2K', '4K'], 48), '512');
    assert.equal(pickGenerationResolution(['512', '1K', '2K', '4K'], 1024), '1K');
    assert.equal(pickGenerationResolution(['512', '1K', '2K', '4K'], 256), '512');
    // Eden pixel sizes.
    assert.equal(pickGenerationResolution(['256x256', '512x512', '1024x1024'], 48), '256x256');
  });

  it('falls back to the largest parseable size when none reaches the target (then we downscale harder)', () => {
    assert.equal(pickGenerationResolution(['256x256', '1024x1024'], 512), '1024x1024');
  });

  it('returns null when nothing parses (fal/mistral) → use the model default + downscale', () => {
    assert.equal(pickGenerationResolution(['square_hd', 'square'], 48), null);
    assert.equal(pickGenerationResolution([], 48), null);
  });
});

describe('fal buildFalImageInput (per-model request defaults)', () => {
  const base = { prompt: 'x', aspectRatio: '1:1', resolution: null, n: null, temperature: null, topP: null, edenProvider: null };

  it('FLUX-family seeds output_format png, safety_tolerance 5, enable_safety_checker false', () => {
    const input = buildFalImageInput({ ...base, model: 'fal-ai/flux-2-pro' } as never);
    assert.equal(input['output_format'], 'png');
    assert.equal(input['safety_tolerance'], '5'); // 1 = most strict … 5 = most permissive
    assert.equal(input['enable_safety_checker'], false);
  });

  it('Krea 2 sends NO output_format/safety knobs (they are not in its schema)', () => {
    const input = buildFalImageInput({ ...base, model: 'krea/v2/medium/text-to-image' } as never);
    assert.equal(input['output_format'], undefined);
    assert.equal(input['safety_tolerance'], undefined);
    assert.equal(input['enable_safety_checker'], undefined);
    assert.equal(input['aspect_ratio'], '1:1');
  });

  it('provider_options (extra) still overrides the seeded defaults (explicit user value wins)', () => {
    const input = buildFalImageInput({ ...base, model: 'fal-ai/flux-2-pro', extra: { output_format: 'jpeg', safety_tolerance: '2', enable_safety_checker: true } } as never);
    assert.equal(input['output_format'], 'jpeg');
    assert.equal(input['safety_tolerance'], '2');
    assert.equal(input['enable_safety_checker'], true);
  });

  it('image_size object from width/height on FLUX-family, and aspect_ratio maps to an enum tier otherwise', () => {
    // width 1024 + aspect 1:1 → exact object
    const obj = buildFalImageInput({ ...base, model: 'fal-ai/flux-2-pro', width: 1024, height: 1024 } as never);
    assert.deepEqual(obj['image_size'], { width: 1024, height: 1024 });
    // no width → enum tier from ratio
    const tier = buildFalImageInput({ ...base, model: 'nvidia/cosmos-3-super/text-to-image', aspectRatio: '16:9' } as never);
    assert.equal(tier['image_size'], 'landscape_16_9');
    assert.equal(tier['output_format'], 'png');
  });

  it('hard-rejects reference_images for a model with no conditioning input (before submit, no credits)', () => {
    const input = { ...base, model: 'fal-ai/flux-2-pro', references: [{ bytes: Buffer.from('x'), mimeType: 'image/png', role: 'reference' }] };
    assert.throws(() => buildFalImageInput(input as never), /cannot take reference images/);
  });

  it('Krea 2 maps reference_images to image_style_references[] of {image_url}', () => {
    const input = buildFalImageInput({ ...base, model: 'krea/v2/medium/text-to-image', references: [{ bytes: Buffer.from('x'), mimeType: 'image/png', role: 'reference' }] } as never);
    const refs = input['image_style_references'] as { image_url: string }[];
    assert.equal(refs.length, 1);
    assert.match(refs[0]!.image_url, /^data:image\/png;base64,/);
    assert.ok(!('url' in (refs[0] as object)), 'must NOT use the wrong `url` key');
  });
});

/** What both ICO tool suites need from a gateway: a capability matrix with the media features on. */
const ICO_CAPS = { textToVideo: true, imageToVideo: true, imageAspectRatioParam: true, imageResolutionParam: true };

describe('transform_media ico (multi-size + merge + dedupe) over the MCP tool', () => {
  let h: McpHarness;
  let outDir: string;
  const call = (name: string, args: Record<string, unknown>) => h.call(name, args);

  before(async () => {
    h = await startMcpHarness({
      gateway: makeFakeGateway({ capabilities: ICO_CAPS, listVideoModels: async () => ({ models: [], source: 'manual', warnings: [] }) }),
      clientName: 'ico-test',
      tmpPrefix: 'air-ico-',
    });
    outDir = h.outDir;
  });

  after(() => h.close());

  it('unpacks a real-world favicon (PNG-compressed 256 + 8-bpp 16) into correct per-size files', async () => {
    const icoPath = join(outDir, 'realfav.ico');
    await writeFile(icoPath, await realWorldFavicon());
    const r = await call('transform_media', { image: icoPath, output_format: 'png' });
    assert.equal(r.isError, undefined, textOf(r));
    const links = linksOf(r);
    assert.deepEqual(links.map((l) => l.name).sort(), ['realfav-16x16.png', 'realfav-256x256.png']);
    const big = links.find((l) => l.name === 'realfav-256x256.png')!;
    const { data, info } = await sharp(await readFile(uriToPath(big.uri))).raw().toBuffer({ resolveWithObject: true });
    const c = (128 * info.width + 128) * info.channels;
    assert.deepEqual([data[c], data[c + 1], data[c + 2]], [0, 255, 0], 'the PNG entry decoded to its real pixels');
  });

  it('merges a real-world favicon with a 48px PNG into a 16/48/256 icon', async () => {
    const icoPath = join(outDir, 'realfav-merge.ico');
    await writeFile(icoPath, await realWorldFavicon());
    await writeFile(join(outDir, 'm48.png'), await squarePng(48));
    const r = await call('transform_media', { image: [icoPath, join(outDir, 'm48.png')], output_format: 'ico' });
    assert.equal(r.isError, undefined, textOf(r));
    const layers = await icoLayers(await readFile(uriToPath(link(r)!.uri)));
    assert.deepEqual(layers.map((l) => l.width).sort((a, b) => a - b), [16, 48, 256]);
  });

  it('merges a mix of allowed-size images and a .ico file, rejecting nothing when no overlap', async () => {
    const a = await writeFile(join(outDir, 'a.png'), await squarePng(16));
    const b = await writeFile(join(outDir, 'b.png'), await squarePng(32));
    // build a single-entry ico (256) on disk to merge in
    const icoBytes = buildIco([icoImageFromPng(await squarePng(256))]);
    await writeFile(join(outDir, 'c.ico'), icoBytes);

    const r = await call('transform_media', { image: [join(outDir, 'a.png'), join(outDir, 'b.png'), join(outDir, 'c.ico')], output_format: 'ico' });
    assert.equal(r.isError, undefined, textOf(r));
    const saved = link(r);
    assert.ok(saved, 'expected a resource_link');
    const layers = await icoLayers(await readFile(uriToPath(saved!.uri)));
    const sizes = layers.map((l) => l.width).sort((x, y) => x - y);
    assert.deepEqual(sizes, [16, 32, 256]);
  });

  it('rejects duplicate sizes across the merge', async () => {
    const a = await writeFile(join(outDir, 'dup1.png'), await squarePng(48));
    const b = await writeFile(join(outDir, 'dup2.png'), await squarePng(48));
    const r = await call('transform_media', { image: [join(outDir, 'dup1.png'), join(outDir, 'dup2.png')], output_format: 'ico' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /duplicate ICO size 48px/);
  });

  it('rejects a non-allowed image size (no resizing in transform_media ico)', async () => {
    const odd = await writeFile(join(outDir, 'odd.png'), await squarePng(300));
    const r = await call('transform_media', { image: [join(outDir, 'odd.png')], output_format: 'ico' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not an allowed ICO size/);
  });

  it('a single image with output_format ico produces a one-size icon', async () => {
    const s = await squarePng(24);
    await writeFile(join(outDir, 'single.png'), s);
    const r = await call('transform_media', { image: join(outDir, 'single.png'), output_format: 'ico' });
    assert.equal(r.isError, undefined, textOf(r));
    const saved = link(r);
    const layers = await icoLayers(await readFile(uriToPath(saved!.uri)));
    assert.equal(layers.length, 1);
    assert.equal(layers[0]!.width, 24);
  });

  it('batch (array + non-ico output_format) processes each and preview is off', async () => {
    const p1 = await writeFile(join(outDir, 'batch1.png'), await squarePng(10));
    const p2 = await writeFile(join(outDir, 'batch2.png'), await squarePng(10));
    const r = await call('transform_media', { image: [join(outDir, 'batch1.png'), join(outDir, 'batch2.png')], output_format: 'webp' });
    assert.equal(r.isError, undefined, textOf(r));
    const links = linksOf(r);
    assert.equal(links.length, 2, 'batch should produce one output per input');
    const images = (r.content ?? []).filter((c: any) => c.type === 'image');
    assert.equal(images.length, 0, 'batch preview must be off');
  });

  it('unpacks a .ico to per-size PNG files named <stem>-<WxH>.png and keeps the source', async () => {
    // build a multi-size ico on disk: 16 + 32
    const icoBytes = buildIco([icoImageFromPng(await squarePng(16)), icoImageFromPng(await squarePng(32))]);
    const icoPath = join(outDir, 'favicon.ico');
    await writeFile(icoPath, icoBytes);
    const r = await call('transform_media', { image: icoPath, output_format: 'png' });
    assert.equal(r.isError, undefined, textOf(r));
    const links = linksOf(r);
    assert.equal(links.length, 2, 'expected one file per ICO size');
    // names: favicon-16x16.png, favicon-32x32.png (source filename, no extension, + size + format)
    const names = links.map((l) => l.name).sort();
    assert.deepEqual(names, ['favicon-16x16.png', 'favicon-32x32.png']);
    // each unzipped file is a real PNG of the right size
    for (const l of links) {
      const meta = await sharp(await readFile(uriToPath(l.uri))).metadata();
      assert.equal(meta.format, 'png');
      assert.equal(meta.width, meta.height);
      assert.ok([16, 32].includes(meta.width!), `unexpected size ${meta.width}`);
    }
  }, { timeout: 15000 });

  it('a second unpack with the same stem never overwrites — the whole set moves to <stem>-2-…', async () => {
    const mk = async (color: string) => `data:image/x-icon;base64,${buildIco([icoImageFromPng(await squarePng(24, color))]).toString('base64')}`;
    const first = await call('transform_media', { image: await mk('#ff0000'), output_format: 'png' });
    const second = await call('transform_media', { image: await mk('#0000ff'), output_format: 'png' });
    const a = link(first)!;
    const b = link(second)!;
    assert.equal(a.name, 'icon-24x24.png');
    assert.equal(b.name, 'icon-2-24x24.png');
    // The first file still holds the FIRST icon's pixels (red), not the second's.
    const { data, info } = await sharp(await readFile(uriToPath(a.uri))).raw().toBuffer({ resolveWithObject: true });
    const centre = (12 * info.width + 12) * info.channels;
    assert.ok(data[centre]! > 200 && data[centre + 2]! < 50, 'first unpacked file was not overwritten');
  });

  it('save:false unpacks without writing any file', async () => {
    const before = new Set(await readdir(outDir));
    const dataUrl = `data:image/x-icon;base64,${buildIco([icoImageFromPng(await squarePng(16)), icoImageFromPng(await squarePng(32))]).toString('base64')}`;
    const r = await call('transform_media', { image: dataUrl, output_format: 'png', save: false, inline_preview: true });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /not saved \(save:false\): 16x16, 32x32/);
    assert.equal(linksOf(r).length, 0);
    assert.equal((r.content ?? []).filter((c: any) => c.type === 'image').length, 2, 'inline previews instead');
    const written = (await readdir(outDir)).filter((f) => !before.has(f));
    assert.deepEqual(written, []);
  });

  it('unpacks a .ico to webp when asked, and to the fallback name `icon-...` for a data: URL input', async () => {
    const dataUrl = `data:image/x-icon;base64,${buildIco([icoImageFromPng(await squarePng(48))]).toString('base64')}`;
    const r = await call('transform_media', { image: dataUrl, output_format: 'webp' });
    assert.equal(r.isError, undefined, textOf(r));
    const webp = link(r)!;
    assert.equal(webp.name, 'icon-48x48.webp');
    const meta = await sharp(await readFile(uriToPath(webp.uri))).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 48);
  }, { timeout: 15000 });

  it('ignores width/height when unpacking an ICO (sizes come from the entries)', async () => {
    const icoPath = join(outDir, 'sizes.ico');
    await writeFile(icoPath, buildIco([icoImageFromPng(await squarePng(16)), icoImageFromPng(await squarePng(64))]));
    const r = await call('transform_media', { image: icoPath, output_format: 'png', width: 200, height: 200 });
    assert.equal(r.isError, undefined, textOf(r));
    const names = linksOf(r).map((l: any) => l.name).sort();
    assert.deepEqual(names, ['sizes-16x16.png', 'sizes-64x64.png']);
  }, { timeout: 15000 });
});

describe('generate_image ico (format: ico) over the MCP tool', () => {
  let h: McpHarness;
  let outDir: string;
  let lastParams: ImageGenParams | undefined;
  let sourceSize = 1024; // the width/height the fake model returns
  let sourceColor = '#e63946';
  const call = (name: string, args: Record<string, unknown>) => h.call(name, args);

  before(async () => {
    h = await startMcpHarness({
      gateway: makeFakeGateway({
        capabilities: ICO_CAPS,
        listVideoModels: async () => ({ models: [], source: 'manual', warnings: [] }),
        imageAspectRatios: () => ({ values: ['1:1', '16:9'], source: 'fallback' }),
        imageResolutions: () => ({ values: ['512', '1K', '2K', '4K'], source: 'fallback' }),
        async generateImage(params: ImageGenParams): Promise<ImageGenResult> {
          lastParams = params;
          const bytes = await squarePng(sourceSize, sourceColor);
          return { images: [{ bytes, mimeType: 'image/png' }], modelUsed: 'fake/model', cost: 0.01, raw: {} };
        },
      }),
      clientName: 'ico-gen-test',
      tmpPrefix: 'air-ico-gen-',
    });
    outDir = h.outDir;
  });
  after(() => h.close());

  it('width 48 on a 1024 source → a single 48px layer + an -original.png kept', async () => {
    sourceSize = 1024;
    lastParams = undefined;
    const r = await call('generate_image', { prompt: 'an icon', output_format: 'ico', width: 48 });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(lastParams?.width, 48, 'width is threaded to the gateway');
    const saved = link(r);
    assert.ok(saved, 'expected a resource_link for the .ico');
    const layers = await icoLayers(await readFile(uriToPath(saved!.uri)));
    assert.equal(layers.length, 1);
    assert.equal(layers[0]!.width, 48);
    assert.match(textOf(r), /original PNG/);
    const stem = saved!.name.replace(/\.ico$/, '');
    const original = join(outDir, `${stem}-original.png`);
    const originalMeta = await sharp(await readFile(original)).metadata();
    assert.equal(originalMeta.width, 1024, 'original PNG must be the untouched model output');
  });

  it('width defaults to 256 on a 1024 source', async () => {
    sourceSize = 1024;
    const r = await call('generate_image', { prompt: 'an icon', output_format: 'ico' });
    assert.equal(r.isError, undefined, textOf(r));
    const saved = link(r);
    const layers = await icoLayers(await readFile(uriToPath(saved!.uri)));
    assert.equal(layers[0]!.width, 256);
  });

  it('errors (no upscaling) when the model returns something smaller than width', async () => {
    sourceSize = 16;
    const r = await call('generate_image', { prompt: 'an icon', output_format: 'ico', width: 48 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cannot upscale/);
  });

  it('an ico width outside the allowlist is rejected before generation (no credits)', async () => {
    sourceSize = 1024;
    const r = await call('generate_image', { prompt: 'an icon', output_format: 'ico', width: 17 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not an allowed icon size/);
  });
});
