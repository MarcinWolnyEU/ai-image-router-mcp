/**
 * Integration tests for reference-image resolution (`generate_image`'s
 * `reference_images`). Exercises the real code paths end-to-end: local files,
 * data/base64 inputs, remote downloads over a live HTTP server, the
 * `z-download-` save+dedup+sanitize behavior, magic-byte format detection, and
 * the fail-closed contract (any bad input ⇒ no generation).
 *
 * Run: `npm test`  (node:test via tsx — no test framework dependency).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { decodeRawBase64, resolveImageInput, resolveMediaInput, resolveReferenceImages } from '../src/util/inputs.js';
import { saveDownloadCopy, sanitizeFilename } from '../src/util/files.js';

// A real 1×1 PNG (valid header → detected as image/png).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal temp dir for a test. */
async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'airef-'));
}

// ── A live HTTP server serving various reference payloads ────────────────────
let server: Server;
let base = '';
let jpeg: Buffer;
let webp: Buffer;

before(async () => {
  jpeg = await sharp(PNG_1x1).jpeg().toBuffer();
  webp = await sharp(PNG_1x1).webp().toBuffer();
  server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/pic.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1x1);
    } else if (url === '/photo.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg);
    } else if (url === '/noext') {
      // No extension in the URL — extension must come from the mime type.
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1x1);
    } else if (url === '/lies.png') {
      // Claims to be a PNG but the bytes are HTML — magic-byte check must reject.
      res.writeHead(200, { 'content-type': 'image/png' }).end('<!doctype html><html>nope</html>');
    } else if (url === '/missing') {
      res.writeHead(404).end('not found');
    } else {
      res.writeHead(404).end('unknown');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('reference resolution — local & inline inputs', () => {
  it('resolves a valid local PNG file', async () => {
    const dir = await tmp();
    const file = join(dir, 'ref.png');
    await writeFile(file, PNG_1x1);
    const { references, errors, downloads } = await resolveReferenceImages([file]);
    assert.equal(errors.length, 0);
    assert.equal(downloads.length, 0, 'local files are not re-saved as downloads');
    assert.equal(references.length, 1);
    assert.equal(references[0]!.mimeType, 'image/png');
    assert.ok((references[0]!.bytes?.length ?? 0) > 0);
    assert.equal(references[0]!.role, 'reference');
  });

  it('rejects a missing local path (fail-closed)', async () => {
    const { references, errors } = await resolveReferenceImages([join(await tmp(), 'does-not-exist.png')]);
    assert.equal(references.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /local file not found/);
  });

  it('rejects a local file that is not an image', async () => {
    const dir = await tmp();
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'just some text, definitely not an image');
    const { references, errors } = await resolveReferenceImages([file]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });

  it('resolves a data: URL and raw base64', async () => {
    const dataUrl = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
    const rawB64 = PNG_1x1.toString('base64');
    const { references, errors } = await resolveReferenceImages([dataUrl, rawB64]);
    assert.equal(errors.length, 0);
    assert.equal(references.length, 2);
    assert.ok(references.every((r) => r.mimeType === 'image/png'));
  });

  it('accepts raw base64 that CONTAINS "/" (decided by content, not the path heuristic)', async () => {
    // A real image whose base64 has slashes — nearly every non-trivial one does.
    const raw = Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 37 + (i >> 5) * 11) & 255));
    const img = await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
    const b64 = img.toString('base64');
    assert.ok(b64.includes('/'), 'fixture must contain a "/"');
    const wrapped = b64.replace(/(.{76})/g, '$1\n'); // MIME line wraps are base64 too
    const { references, errors } = await resolveReferenceImages([b64, wrapped]);
    assert.deepEqual(errors, []);
    assert.equal(references.length, 2);
    assert.ok(references.every((r) => r.mimeType === 'image/png'));
  });

  it('a slash-y string that is neither an image nor a file still reads as a missing file', async () => {
    const { errors } = await resolveReferenceImages(['/tmp/abc', 'C:\\nope\\x.png', 'not base64 at all!']);
    assert.match(errors[0]!, /local file not found/);
    assert.match(errors[1]!, /local file not found/);
    assert.match(errors[2]!, /not a URL, data URL, readable file path, or base64 image/);
  });

  it('detects formats by magic bytes, not extension (png/jpeg/webp/gif/bmp/tiff)', async () => {
    const dir = await tmp();
    const cases: Array<[string, Buffer, string]> = [
      ['a.png', PNG_1x1, 'image/png'],
      ['b.jpg', jpeg, 'image/jpeg'],
      ['c.webp', webp, 'image/webp'],
      // header-only buffers are enough — resolution validates the signature, not the full file
      ['d.gif', Buffer.from('GIF89a\x00\x00', 'binary'), 'image/gif'],
      // BMP: 14-byte file header + the 40-byte BITMAPINFOHEADER size (a bare "BM" is too weak a signature)
      ['e.bmp', Buffer.from('BM\x46\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x28\x00\x00\x00', 'binary'), 'image/bmp'],
      ['f.tif', Buffer.from('II\x2a\x00\x00\x00', 'binary'), 'image/tiff'],
    ];
    const paths: string[] = [];
    for (const [name, bytes] of cases) {
      const p = join(dir, name);
      await writeFile(p, bytes);
      paths.push(p);
    }
    const { references, errors } = await resolveReferenceImages(paths);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
    assert.deepEqual(
      references.map((r) => r.mimeType),
      cases.map((c) => c[2]),
    );
  });

  it('rejects a data: URL whose declared image mime lies about its bytes (fail-closed, like files/URLs)', async () => {
    const html = `data:image/png;base64,${Buffer.from('<!doctype html><html>nope</html>').toString('base64')}`;
    const truncated = `data:image/png;base64,${Buffer.from('not-a-real-image').toString('base64')}`;
    const { references, errors } = await resolveReferenceImages([html, truncated]);
    assert.equal(references.length, 0, 'no reference may pass on the strength of its declared mime alone');
    assert.equal(errors.length, 2);
    for (const e of errors) assert.match(e, /not a recognized image/);
  });

  it('a data: URL is labelled by its bytes, not its declared mime', async () => {
    const { references, errors } = await resolveReferenceImages([`data:image/png;base64,${jpeg.toString('base64')}`]);
    assert.equal(errors.length, 0);
    assert.equal(references[0]!.mimeType, 'image/jpeg');
  });

  it('rejects a file whose extension says image but bytes are not', async () => {
    const dir = await tmp();
    const file = join(dir, 'fake.png');
    await writeFile(file, Buffer.from('<html>not a png</html>'));
    const { references, errors } = await resolveReferenceImages([file]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });
});

describe('reference resolution — remote downloads', () => {
  it('downloads a remote image and saves a z-download- copy', async () => {
    const dir = await tmp();
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/pic.png`], { downloadDir: dir });
    assert.equal(errors.length, 0);
    assert.equal(references.length, 1);
    assert.equal(references[0]!.mimeType, 'image/png');
    assert.equal(downloads.length, 1);
    const saved = downloads[0]!;
    assert.ok(existsSync(saved));
    assert.equal(basename(saved), 'z-download-pic.png');
    // The model is served our downloaded bytes, never the URL.
    assert.ok((references[0]!.bytes?.length ?? 0) > 0);
    assert.deepEqual(await readFile(saved), PNG_1x1);
  });

  it('derives the extension from the mime type when the URL has none', async () => {
    const dir = await tmp();
    const { downloads, errors } = await resolveReferenceImages([`${base}/noext`], { downloadDir: dir });
    assert.equal(errors.length, 0);
    assert.equal(basename(downloads[0]!), 'z-download-noext.png');
  });

  it('does not save a copy when no downloadDir is given', async () => {
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/pic.png`]);
    assert.equal(errors.length, 0);
    assert.equal(references.length, 1);
    assert.equal(downloads.length, 0);
  });

  it('dedups colliding download names with -1, -2 …', async () => {
    const dir = await tmp();
    const { downloads, errors } = await resolveReferenceImages(
      [`${base}/pic.png`, `${base}/pic.png`, `${base}/pic.png`],
      { downloadDir: dir },
    );
    assert.equal(errors.length, 0);
    const names = downloads.map((p) => basename(p)).sort();
    assert.deepEqual(names, ['z-download-pic-1.png', 'z-download-pic-2.png', 'z-download-pic.png'].sort());
    // All three actually exist on disk and are distinct.
    assert.equal(new Set(names).size, 3);
    const onDisk = (await readdir(dir)).filter((f) => f.startsWith('z-download-'));
    assert.equal(onDisk.length, 3);
  });

  it('fails closed on HTTP 404 (no reference, clear error)', async () => {
    const dir = await tmp();
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/missing`], { downloadDir: dir });
    assert.equal(references.length, 0);
    assert.equal(downloads.length, 0);
    assert.match(errors[0]!, /could not download \(HTTP 404\)/);
  });

  it('rejects a download whose bytes are not a real image', async () => {
    const { references, errors } = await resolveReferenceImages([`${base}/lies.png`]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });

  it('reports a connection failure clearly (refused port)', async () => {
    // Port 1 is not listening → fast connection error (exercises the catch path).
    const { references, errors } = await resolveReferenceImages(['http://127.0.0.1:1/x.png']);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /could not download|timed out/);
  });
});

describe('fail-closed batch semantics', () => {
  it('a mixed batch surfaces the good reference AND the per-input error', async () => {
    const dir = await tmp();
    const good = join(dir, 'good.png');
    await writeFile(good, PNG_1x1);
    const { references, errors } = await resolveReferenceImages([good, join(dir, 'nope.png')]);
    // The resolver returns both; the tool refuses to generate whenever errors is non-empty.
    assert.equal(references.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /nope\.png/);
  });
});

describe('saveDownloadCopy / sanitizeFilename', () => {
  it('sanitizes invalid filename characters to "-"', () => {
    assert.equal(sanitizeFilename('a:b*c?'), 'a-b-c-');
    assert.equal(sanitizeFilename('  spaced  name '), 'spaced--name');
    assert.equal(sanitizeFilename('....'), 'file');
  });

  it('prefixes z-download-, sanitizes, and dedups against disk + the reserved set', async () => {
    const dir = await tmp();
    const reserved = new Set<string>();
    const a = await saveDownloadCopy(dir, PNG_1x1, 'we:rd*name.png', reserved);
    const b = await saveDownloadCopy(dir, PNG_1x1, 'we:rd*name.png', reserved);
    assert.equal(basename(a.path), 'z-download-we-rd-name.png');
    assert.equal(basename(b.path), 'z-download-we-rd-name-1.png');
    assert.ok(existsSync(a.path) && existsSync(b.path));
  });
});

describe('resolveImageInput / resolveMediaInput (mp4 image_to_video, remove_background, crop/transform)', () => {
  // ISO-BMFF `ftyp` box with an mp4 brand — what detectMedia classifies as video/mp4.
  const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(16)]);

  it('refuses a VIDEO handed in as an image, before anything is sent (it used to go out labelled image/png)', async () => {
    const dir = await tmp();
    const file = join(dir, 'clip.mp4');
    await writeFile(file, MP4_HEAD);
    await assert.rejects(resolveImageInput(file), /is a video \(video\/mp4\), not a still image/);
    await assert.rejects(resolveImageInput(`data:image/png;base64,${MP4_HEAD.toString('base64')}`), /is a video/);
  });

  it('accepts raw base64 with "/" and labels it by its bytes', async () => {
    const img = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#3a7bd5' } }).jpeg().toBuffer();
    const r = await resolveImageInput(img.toString('base64'));
    assert.equal(r.mimeType, 'image/jpeg');
  });

  it('a missing path is reported as a missing file, not decoded as base64 garbage', async () => {
    await assert.rejects(resolveImageInput('C:\\nope\\photo.png'), /local file not found/);
    await assert.rejects(resolveMediaInput('C:\\nope\\photo.png'), /local file not found/);
    await assert.rejects(resolveMediaInput('/tmp/abc'), /local file not found/);
    const ok = await resolveMediaInput(PNG_1x1.toString('base64'));
    assert.equal(ok.kind, 'image');
  });

  it('decodeRawBase64 is strict: alphabet + clean round-trip only', () => {
    assert.ok(decodeRawBase64(PNG_1x1.toString('base64')));
    assert.equal(decodeRawBase64('C:\\x\\y.png'), null);
    assert.equal(decodeRawBase64('hello world!'), null);
    assert.equal(decodeRawBase64('abc'), null, 'too short to be data');
  });
});
