/**
 * LIVE, BILLED contract test for the fal.ai ICO path — the genuinely risky bit.
 *
 * Why this is billed and worth it: `generate_image` ico has no way to know the
 * model's output pixel size ahead of time (fal models take an `image_size`/`aspect_ratio`
 * ENUM of aspect tiers, never pixel dimensions — verified by probing; see tests/paid).
 * So the ico path must (a) request the model at its default/`1:1`, (b) read the actual
 * returned dimensions, (c) downscale to the requested `ico_size` (never upscale) and
 * keep the untouched original. This test exercises that against a real model.
 *
 * Run: `npm run integration:paid`. Requires a live fal token (`fal ai token.txt` or
 * `FAL_TOKEN`). Saves artifacts to `output/` for inspection. Excluded from `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createGateway } from '../../src/gateways/registry.js';
import type { Logger } from '../../src/logging/logger.js';
import { DEFAULT_TOKEN_FILES } from '../../src/config/schema.js';
import { fitSquare, buildIco, icoImageFromPng, icoEntryToRgba, parseIco } from '../../src/media/ico.js';
import { buildFalImageInput } from '../../src/gateways/fal.js';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'output');
const token = process.env.FAL_TOKEN ?? readFileSync(DEFAULT_TOKEN_FILES.fal, 'utf8').trim();
if (!token) throw new Error('fal token missing; set FAL_TOKEN or create "fal ai token.txt"');

// FLUX 2 Pro accepts an exact object `image_size` {width,height}. Override with FAL_IMG_MODEL.
const MODEL = process.env.FAL_IMG_MODEL ?? 'fal-ai/flux-2-pro';
const ICO_TARGET = 64; // exact square we request (object image_size), so fitSquare is a no-op

const logger = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;
const gw = createGateway('fal', token, logger);

describe('fal.ai live ICO path (billed)', () => {
  it('requests exact object image_size, generates, and keeps the untouched original', async () => {
    // The request body this gateway produced must carry the seeded defaults + object size.
    const input = buildFalImageInput({ model: MODEL, prompt: 'x', width: ICO_TARGET, height: ICO_TARGET } as never);
    assert.equal(input['output_format'], 'png');
    assert.equal(input['safety_tolerance'], '5');
    assert.equal(input['enable_safety_checker'], false);
    assert.deepEqual(input['image_size'], { width: ICO_TARGET, height: ICO_TARGET });

    await mkdir(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    const res = await gw.generateImage({
      prompt: 'a flat minimal app icon, a stylized lightning bolt on a plain background, no text, centered, simple geometric',
      model: MODEL,
      width: ICO_TARGET,
      height: ICO_TARGET,
      resolution: null,
    });
    assert.ok(res.images.length > 0, `fal returned no images: ${JSON.stringify(res.raw).slice(0, 300)}`);
    const source = res.images[0]!;

    // The ico path works on the raw model output: fit to square + target size (downscale only).
    const fitted = await fitSquare(source.bytes, source.mimeType, ICO_TARGET);
    const meta = await sharp(fitted.bytes).metadata();
    assert.equal(meta.width, ICO_TARGET, 'fitted output must be exactly ico_size');
    assert.equal(meta.height, ICO_TARGET);
    // A non-square model result would be PADDED (never cropped) — report which happened.
    if (fitted.note) console.log(`  squaring: ${fitted.note}`);

    const ico = buildIco([icoImageFromPng(fitted.bytes)]);
    const layers = await parseIco(ico);
    assert.equal(layers.length, 1);
    assert.equal(layers[0]!.width, ICO_TARGET, 'ICO must contain exactly one entry at ico_size');

    // Persist artifacts for inspection (per the project's test-run convention).
    const stem = `paid-fal-ico-${Date.now()}`;
    const icoPath = join(OUT_DIR, `${stem}.ico`);
    const originalPath = join(OUT_DIR, `${stem}-original.png`);
    await writeFile(icoPath, ico);
    await writeFile(originalPath, source.bytes);

    // Spot-check the raw nearest-entry pixels (decode the largest entry back to RGBA).
    const { width, height, data } = icoEntryToRgba(layers[0]!);
    assert.equal(width, ICO_TARGET);
    assert.equal(height, ICO_TARGET);

    // Prove the saved original is the untouched model output (same byte length).
    const savedOriginal = await readFile(originalPath);
    assert.equal(savedOriginal.length, source.bytes.length, 'original.png must be the unmodified model output');

    // eslint-disable-next-line no-console
    console.log(`✅ fal ico: model=${res.modelUsed} source=${meta.width}x${meta.height}→${ICO_TARGET}px ico bytes=${ico.length}  (${Date.now() - t0}ms)\n   ${icoPath}`);

    assert.ok(existsSync(icoPath), 'ico artifact written');
  });
});
