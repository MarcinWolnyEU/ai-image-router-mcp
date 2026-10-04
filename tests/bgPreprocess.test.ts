/**
 * Background-removal input decode (`src/bgremoval/preprocess.ts`). The remover used to read
 * metadata + raw pixels WITHOUT applying EXIF orientation and wrote a PNG with no EXIF, so a
 * phone photo shot in portrait (orientation 6) came back as a landscape cutout rotated 90°.
 * Pure sharp, no ONNX session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodeOrientedRgb } from '../src/bgremoval/preprocess.js';

/** 20×10 stored pixels: left half red, right half blue — tagged EXIF orientation 6 (rotate 90° CW to display). */
async function portraitPhoto(): Promise<Buffer> {
  const w = 20;
  const h = 10;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [255, 0, 0] : [0, 0, 255], (y * w + x) * 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
}

describe('decodeOrientedRgb', () => {
  it('applies EXIF orientation: a 20×10 orientation-6 photo decodes as the 10×20 portrait it displays as', async () => {
    const img = await decodeOrientedRgb(await portraitPhoto());
    assert.equal(img.width, 10);
    assert.equal(img.height, 20);
    assert.equal(img.data.length, 10 * 20 * 3);
    const at = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 3, (y * img.width + x) * 3 + 3)];
    const [r1, , b1] = at(5, 2);
    const [r2, , b2] = at(5, 17);
    assert.ok(r1! > 200 && b1! < 60, 'displayed top = the stored LEFT (red) half');
    assert.ok(b2! > 200 && r2! < 60, 'displayed bottom = the stored RIGHT (blue) half');
  });

  it('drops alpha and always yields 3 channels (grayscale and RGBA inputs too)', async () => {
    const gray = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#808080' } }).toColourspace('b-w').png().toBuffer();
    const rgba = await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    for (const input of [gray, rgba]) {
      const img = await decodeOrientedRgb(input);
      assert.equal(img.data.length, 4 * 3 * 3);
    }
  });
});
