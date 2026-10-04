/**
 * Unit + integration tests for the media transform pieces:
 * convertImage (sharp fallback), blackFraction / frameBlackFraction, the
 * renderMediaContent output_mode helper, and the ffmpeg frame primitives that
 * back transform_media's video→still extraction (gated on ffmpeg being present).
 *
 * Run: `npm test`. No network/cost (Tinify path is exercised live elsewhere).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { convertImage } from '../src/media/convert.js';
import { blackFraction, cropImage, downsizeImage, frameBlackFraction } from '../src/media/imageEdit.js';
import { renderMediaContent } from '../src/tools/helpers.js';
import { extractFrame, ffmpegAvailable, ffprobeDuration } from '../src/media/ffmpeg.js';
import type { SavedFile } from '../src/util/files.js';

async function solidPng(r = 200, g = 120, b = 40): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

function magic(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && buf.toString('ascii', 8, 12).toLowerCase().startsWith('avif')) return 'avif';
  return 'unknown';
}

describe('convertImage (sharp fallback, no Tinify token)', () => {
  it('converts PNG → webp / jpg / png by magic bytes', async () => {
    const png = await solidPng();
    for (const [target, expected] of [['webp', 'webp'], ['jpg', 'jpg'], ['png', 'png']] as const) {
      const out = await convertImage(png, target, {});
      assert.equal(out.tinified, false);
      assert.equal(out.ext, target);
      assert.equal(magic(out.bytes), expected, `expected ${expected} bytes`);
    }
  });

  it('converts PNG → avif via sharp', async () => {
    const out = await convertImage(await solidPng(), 'avif', {});
    assert.equal(magic(out.bytes), 'avif');
  });
});

/**
 * A stand-in for api.tinify.com with Tinify's real semantics: /shrink stores the upload,
 * GET <Location> (compress) returns it in the SAME format, POST <Location> (convert)
 * answers whatever `convert` produces.
 */
function stubTinify(convert: (uploaded: Buffer) => Buffer): () => void {
  const realFetch = globalThis.fetch;
  let uploaded = Buffer.alloc(0);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/shrink')) {
      uploaded = Buffer.from(init!.body as Uint8Array);
      return new Response('{}', { status: 201, headers: { location: 'https://api.tinify.com/output/stub' } });
    }
    return new Response(init?.method === 'POST' ? convert(uploaded) : uploaded, { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}
const QUIET = { warn: () => {} };

describe('convertImage with Tinify (stubbed API)', () => {
  it('png target from a JPEG / WebP source yields REAL png bytes (compress is format-preserving)', async () => {
    const restore = stubTinify((b) => b);
    try {
      for (const source of [await sharp(await solidPng()).jpeg().toBuffer(), await sharp(await solidPng()).webp().toBuffer()]) {
        const out = await convertImage(source, 'png', { tinifyToken: 'k', logger: QUIET });
        assert.equal(magic(out.bytes), 'png', 'the bytes must be a PNG, not the source format under a .png name');
        assert.equal(out.mimeType, 'image/png');
        assert.equal(out.tinified, true);
      }
    } finally {
      restore();
    }
  });

  it('a Tinify answer in the wrong format is not trusted — sharp produces the target instead', async () => {
    const restore = stubTinify((b) => b); // "convert" hands the PNG back unchanged
    try {
      const out = await convertImage(await solidPng(), 'webp', { tinifyToken: 'k', logger: QUIET });
      assert.equal(magic(out.bytes), 'webp');
      assert.equal(out.tinified, false);
    } finally {
      restore();
    }
  });
});

describe('downsizeImage', () => {
  it('with BOTH width and height it fits inside the box (aspect kept) — it never crops', async () => {
    const src = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const out = await downsizeImage(src, { width: 200, height: 200 });
    const meta = await sharp(out.bytes).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 150]);
  });
});

describe('cropImage', () => {
  it('a region outside the image is refused with the bounds, not a raw libvips error', async () => {
    const src = await solidPng();
    const { width, height } = await sharp(src).metadata();
    await assert.rejects(cropImage(src, { left: width! - 2, top: 0, width: 10, height: 1 }), new RegExp(`exceeds the image bounds \\(${width}×${height}\\)`));
  });
});

describe('blackFraction', () => {
  it('is 1 for an all-black buffer and 0 for all-white', () => {
    const black = Buffer.alloc(3 * 100, 0);
    const white = Buffer.alloc(3 * 100, 255);
    assert.equal(blackFraction(black, 3), 1);
    assert.equal(blackFraction(white, 3), 0);
  });
  it('counts a pixel black only if its brightest channel is below threshold', () => {
    // one pixel (10,10,10) = black; one pixel (10,10,200) = not black (blue channel high)
    const buf = Buffer.from([10, 10, 10, 10, 10, 200]);
    assert.equal(blackFraction(buf, 3, 32), 0.5);
  });
  it('handles empty / zero-channel input as fully black', () => {
    assert.equal(blackFraction(Buffer.alloc(0), 3), 1);
    assert.equal(blackFraction(Buffer.from([1, 2, 3]), 0), 1);
  });
  it('frameBlackFraction reads a real PNG (black ≈ 1, bright ≈ 0)', async () => {
    assert.ok((await frameBlackFraction(await solidPng(0, 0, 0))) > 0.99);
    assert.ok((await frameBlackFraction(await solidPng(240, 240, 240))) < 0.01);
  });
});

describe('renderMediaContent (output_mode)', () => {
  const saved: SavedFile = { path: '/out/x.png', filename: 'x.png', uri: 'file:///out/x.png', bytes: 3 };
  /** Render a PNG (or `over.bytes`) with the common defaults; each test states only what it varies. */
  const render = async (over: Partial<Parameters<typeof renderMediaContent>[0]>) =>
    renderMediaContent({ bytes: await solidPng(), mimeType: 'image/png', saved, outputMode: 'filePath', inline: false, previewMaxBytes: 9_000_000, ...over });

  it('filePath mode → a resource_link (no inline when off)', async () => {
    const c = await render({});
    assert.equal(c.length, 1);
    assert.equal(c[0]!.type, 'resource_link');
  });

  it('filePath mode + inline → resource_link + image preview', async () => {
    const c = await render({ inline: true });
    assert.equal(c.length, 2);
    assert.equal(c[1]!.type, 'image');
  });

  it('base64 image → a single image block with the full bytes', async () => {
    const png = await solidPng();
    const c = await render({ bytes: png, outputMode: 'base64', inline: true, previewMaxBytes: 1 });
    assert.equal(c.length, 1);
    assert.equal(c[0]!.type, 'image');
    assert.equal((c[0] as { data: string }).data, png.toString('base64'));
  });

  it('base64 non-image (video) → an embedded resource blob', async () => {
    const bytes = Buffer.from('fake-mp4-bytes');
    const vsaved: SavedFile = { path: '/out/v.mp4', filename: 'v.mp4', uri: 'file:///out/v.mp4', bytes: bytes.length };
    const c = await render({ bytes, mimeType: 'video/mp4', saved: vsaved, outputMode: 'base64', previewMaxBytes: 1 });
    assert.equal(c.length, 1);
    assert.equal(c[0]!.type, 'resource');
    assert.equal((c[0] as { resource: { blob: string } }).resource.blob, bytes.toString('base64'));
  });
});

// ── ffmpeg-gated integration: video→frame primitives ─────────────────────────
//
// Gated on a *functional* ffmpeg, not merely a present one: clip creation is
// bounded and self-killing, so a hanging or non-transcoding ffmpeg (some
// sandboxed CI environments — observed wedging the run for >1h) makes these
// tests SKIP fast instead of hanging the whole suite. `-nostdin` avoids the
// classic stdin hang. Each test also has a hard timeout as a backstop.
const FF_TIMEOUT = 30_000;

/** Build a 2s test clip (1s black + 1s red). Resolves false (never hangs/throws) on timeout/error. */
function makeTestClip(out: string, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(
      'ffmpeg',
      ['-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', out],
      { stdio: 'ignore' },
    );
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && existsSync(out));
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      done(false);
    }, timeoutMs);
    p.on('error', () => done(false));
    p.on('close', (code) => done(code === 0));
  });
}

describe('ffmpeg frame primitives (video → still)', () => {
  let available = false;
  let dir = '';
  let clip = '';
  const SKIP = 'ffmpeg unavailable or unable to transcode in this environment';

  before(async () => {
    if (!(await ffmpegAvailable())) return;
    dir = await mkdtemp(join(tmpdir(), 'air-vtest-'));
    clip = join(dir, 'clip.mp4');
    available = await makeTestClip(clip); // only "available" if a real clip was produced
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('ffprobeDuration reports ~2s', { timeout: FF_TIMEOUT }, async (t) => {
    if (!available) return t.skip(SKIP);
    const d = await ffprobeDuration({ kind: 'video', mimeType: 'video/mp4', path: clip });
    assert.ok(d > 1.5 && d < 2.6, `duration ${d}`);
  });

  it('a frame in the black head is mostly black; one in the red tail is not', { timeout: FF_TIMEOUT }, async (t) => {
    if (!available) return t.skip(SKIP);
    const media = { kind: 'video' as const, mimeType: 'video/mp4', path: clip };
    const blackPath = join(dir, 'black.png');
    const redPath = join(dir, 'red.png');
    await extractFrame(media, 0.2, blackPath); // 10% ≈ inside black head
    await extractFrame(media, 1.5, redPath); // inside red tail
    const { readFile } = await import('node:fs/promises');
    assert.ok((await frameBlackFraction(await readFile(blackPath))) >= 0.9, 'head frame should be mostly black');
    assert.ok((await frameBlackFraction(await readFile(redPath))) < 0.9, 'tail frame should not be mostly black');
  });
});
