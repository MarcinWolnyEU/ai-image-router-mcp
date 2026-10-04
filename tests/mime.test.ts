/**
 * The single magic-byte detector (`src/util/mime.ts`) that every input path uses — and
 * the AVIF/HEIC cases the five separate sniffers it replaced got wrong: AVIF labelled
 * `image/png` (Mistral vision skipped its re-encode), and any ISO-BMFF `ftyp` header
 * classified as VIDEO (an AVIF passed as base64 went to ffmpeg). Pure, no I/O.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectMedia, detectImageMime, sniffImageMime } from '../src/util/mime.js';
import { resolveMediaInput } from '../src/util/inputs.js';
import { buildIco, icoImageFromPng } from '../src/media/ico.js';

/** An ISO-BMFF `ftyp` box: major brand + compatible brands, then filler. */
function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + 4 * compatible.length;
  const box = Buffer.alloc(size + 16);
  box.writeUInt32BE(size, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  compatible.forEach((b, i) => box.write(b, 16 + 4 * i, 'latin1'));
  return box;
}

const solid = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } });

describe('detectMedia — images', () => {
  it('recognises png / jpeg / webp / gif / tiff / avif produced by sharp', async () => {
    const formats = [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['tiff', 'image/tiff'], ['avif', 'image/avif']] as const;
    const cases: Array<[Buffer, string]> = [];
    for (const [format, mime] of formats) cases.push([await solid().toFormat(format).toBuffer(), mime]);
    for (const [bytes, mime] of cases) assert.deepEqual(detectMedia(bytes), { kind: 'image', mime }, mime);
  });

  it('an AVIF whose MAJOR brand is mif1 is still AVIF (compatible-brand scan)', () => {
    assert.deepEqual(detectMedia(ftyp('mif1', ['mif1', 'miaf', 'avif'])), { kind: 'image', mime: 'image/avif' });
  });

  it('HEIC / HEIF brands are images, not video', () => {
    assert.deepEqual(detectMedia(ftyp('heic', ['mif1', 'heic'])), { kind: 'image', mime: 'image/heic' });
    assert.deepEqual(detectMedia(ftyp('mif1', ['mif1'])), { kind: 'image', mime: 'image/heic' });
  });

  it('recognises an ICO, and a real BMP header', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff000080' } }).png().toBuffer();
    assert.deepEqual(detectMedia(buildIco([icoImageFromPng(png)])), { kind: 'image', mime: 'image/x-icon' });
    const bmp = Buffer.alloc(64);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(64, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER
    assert.deepEqual(detectMedia(bmp), { kind: 'image', mime: 'image/bmp' });
  });

  it('text that merely starts with "BM" or 00 00 01 00 is NOT an image', () => {
    assert.equal(detectMedia(Buffer.from('BMW makes cars, this is plain text and not a bitmap')), null);
    assert.equal(detectMedia(Buffer.from([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'ICO with zero entries');
  });
});

describe('detectMedia — video & documents', () => {
  it('mp4 / quicktime ftyp brands are video', () => {
    assert.deepEqual(detectMedia(ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41'])), { kind: 'video', mime: 'video/mp4' });
    assert.deepEqual(detectMedia(ftyp('qt  ', ['qt  '])), { kind: 'video', mime: 'video/quicktime' });
  });

  it('EBML: webm vs matroska by doctype; RIFF AVI', () => {
    const ebml = (doctype: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(doctype, 'latin1'), Buffer.alloc(16)]);
    assert.deepEqual(detectMedia(ebml('webm')), { kind: 'video', mime: 'video/webm' });
    assert.deepEqual(detectMedia(ebml('matroska')), { kind: 'video', mime: 'video/x-matroska' });
    const avi = Buffer.alloc(16);
    avi.write('RIFF', 0, 'latin1');
    avi.write('AVI ', 8, 'latin1');
    assert.deepEqual(detectMedia(avi), { kind: 'video', mime: 'video/x-msvideo' });
  });

  it('PDF and DOCX/PPTX (zip, by name hint) are documents', () => {
    assert.deepEqual(detectMedia(Buffer.from('%PDF-1.7\n')), { kind: 'document', mime: 'application/pdf' });
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    assert.equal(detectMedia(zip)?.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(detectMedia(zip, 'Deck.PPTX')?.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('unknown bytes → null', () => {
    assert.equal(detectMedia(Buffer.from('hello world')), null);
    assert.equal(detectMedia(Buffer.alloc(0)), null);
  });
});

describe('image-mime helpers built on detectMedia', () => {
  it('detectImageMime is null for non-images (video, pdf, text)', () => {
    assert.equal(detectImageMime(ftyp('isom')), null);
    assert.equal(detectImageMime(Buffer.from('%PDF-1.4')), null);
    assert.equal(detectImageMime(Buffer.from('<html>')), null);
  });

  it('sniffImageMime labels AVIF as image/avif (it used to default to image/png)', async () => {
    assert.equal(sniffImageMime(await solid().avif().toBuffer()), 'image/avif');
    assert.equal(sniffImageMime(Buffer.from('opaque')), 'image/png', 'unknown bytes keep the png default');
  });
});

describe('resolveMediaInput classifies by magic bytes', () => {
  it('an AVIF passed as raw base64 is an IMAGE (not video/mp4)', async () => {
    const avif = await solid().avif().toBuffer();
    const r = await resolveMediaInput(avif.toString('base64'));
    assert.equal(r.kind, 'image');
    assert.equal(r.mimeType, 'image/avif');
  });

  it('a data: URL is classified by its bytes, not its declared mime', async () => {
    const avif = await solid().avif().toBuffer();
    const r = await resolveMediaInput(`data:video/mp4;base64,${avif.toString('base64')}`);
    assert.equal(r.kind, 'image');
    assert.equal(r.mimeType, 'image/avif');
  });

  it('a real mp4 header passed as base64 stays video', async () => {
    const r = await resolveMediaInput(ftyp('isom', ['isom', 'mp41']).toString('base64'));
    assert.equal(r.kind, 'video');
    assert.equal(r.mimeType, 'video/mp4');
  });
});
