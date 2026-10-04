/**
 * Tests for the local animated-GIF path:
 *  - ssimLuma (pure): identity, divergence, size-mismatch guard.
 *  - msFromFps (pure): fps → per-frame delay mapping incl. clamps.
 *  - encodeGif (integration, no network/cost): frame count, per-frame delays
 *    round-tripping through a real GIF, 1-bit transparency, fixed vs optimized
 *    palette, and the delaysMs-length guard.
 *
 * Run: `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ssimLuma } from '../src/util/ssim.js';
import { encodeGif, msFromFps } from '../src/media/gif.js';

describe('ssimLuma', () => {
  it('identical signals score 1', () => {
    const a = Float32Array.from({ length: 64 }, (_, i) => (i * 3) % 256);
    assert.ok(Math.abs(ssimLuma(a, a.slice(), 8, 8) - 1) < 1e-9);
  });
  it('flat identical signals score 1', () => {
    const a = new Float32Array(64).fill(120);
    assert.ok(Math.abs(ssimLuma(a, a.slice(), 8, 8) - 1) < 1e-9);
  });
  it('divergent signals score below 1', () => {
    const a = new Float32Array(64).fill(0);
    const b = new Float32Array(64).fill(255);
    assert.ok(ssimLuma(a, b, 8, 8) < 0.5);
  });
  it('throws on size mismatch', () => {
    assert.throws(() => ssimLuma(new Float32Array(64), new Float32Array(63), 8, 8));
    assert.throws(() => ssimLuma(new Float32Array(64), new Float32Array(64), 8, 9));
  });
});

describe('msFromFps', () => {
  const cases: Array<[number, number]> = [
    [10, 100],
    [1, 1000],
    [2, 500],
    [50, 20],
    [1000, 10], // clamped to GIF's 10 ms floor
    [0, 100], // invalid → fallback
    [-5, 100], // invalid → fallback
  ];
  for (const [fps, ms] of cases) {
    it(`${fps} fps → ${ms} ms`, () => assert.equal(msFromFps(fps), ms));
  }
});

// --- test frame builders (no I/O, no network) ---
function solid(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();
}
function gradient(w: number, h: number, seed: number): Promise<Buffer> {
  const d = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      d[o] = (x * 4 + seed) & 255;
      d[o + 1] = (y * 4) & 255;
      d[o + 2] = (x + y + seed) & 255;
    }
  return sharp(d, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
function halfTransparent(w: number, h: number): Promise<Buffer> {
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const opaque = x < w / 2;
      d[o] = 220;
      d[o + 1] = 30;
      d[o + 2] = 30;
      d[o + 3] = opaque ? 255 : 0;
    }
  return sharp(d, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe('encodeGif', () => {
  it('assembles frames, preserves per-frame delays, emits a valid GIF', async () => {
    const frames = await Promise.all([gradient(32, 32, 0), gradient(32, 32, 60), gradient(32, 32, 120)]);
    const delaysMs = [100, 300, 200];
    const res = await encodeGif(frames, { delaysMs, optimize: true, width: 32, height: 32 });

    assert.equal(res.frameCount, 3);
    assert.equal(res.width, 32);
    assert.equal(res.height, 32);
    assert.equal(res.bytes.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.ok(res.colors >= 2 && res.colors <= 256);

    const meta = await sharp(res.bytes, { animated: true }).metadata();
    assert.equal(meta.pages, 3);
    assert.deepEqual(meta.delay, delaysMs); // round-trips (all multiples of 10 ms)
    assert.equal(meta.loop, 0); // forever
  });

  it('preserves 1-bit transparency', async () => {
    const frames = await Promise.all([halfTransparent(32, 32), halfTransparent(32, 32)]);
    const res = await encodeGif(frames, { delaysMs: [200, 200], optimize: true, width: 32, height: 32 });
    assert.equal(res.hasTransparency, true);

    const { data, info } = await sharp(res.bytes, { page: 0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let i = 3; i < data.length; i += info.channels) if (data[i] === 0) transparent++;
    // Right half (~512 of 1024 px) should be transparent.
    assert.ok(transparent > 400, `expected ~half transparent, got ${transparent}`);
  });

  it('honors a fixed palette when optimization is off', async () => {
    const frames = await Promise.all([gradient(48, 48, 0), gradient(48, 48, 90)]);
    const res = await encodeGif(frames, { delaysMs: [100, 100], optimize: false, maxColors: 16, width: 48, height: 48 });
    assert.equal(res.optimized, false);
    assert.ok(res.colors <= 16, `realized ${res.colors} colors, expected ≤16`);
    assert.equal(res.candidates, undefined);
  });

  it('optimized sweep returns deduped, bounded candidates', async () => {
    const frames = await Promise.all([gradient(48, 48, 0), gradient(48, 48, 90)]);
    const res = await encodeGif(frames, { delaysMs: [100, 100], optimize: true, maxColors: 256, width: 48, height: 48 });
    assert.equal(res.optimized, true);
    assert.ok(Array.isArray(res.candidates) && res.candidates.length >= 1);
    for (const c of res.candidates!) {
      assert.ok(c.colors >= 2 && c.colors <= 256);
      assert.ok(c.ssim >= 0 && c.ssim <= 1.0001);
    }
    // dedup: no two candidates share a byte size
    const sizes = res.candidates!.map((c) => c.bytes);
    assert.equal(new Set(sizes).size, sizes.length);
  });

  it('rejects a delaysMs length that does not match the frame count', async () => {
    const frames = await Promise.all([solid(16, 16, 10, 20, 30), solid(16, 16, 40, 50, 60)]);
    await assert.rejects(() => encodeGif(frames, { delaysMs: [100], width: 16, height: 16 }));
  });
});
