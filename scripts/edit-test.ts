/** Validate Tinify (compress/convert) + sharp crop/downsize + ffmpeg video crop/downsize. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tinifyCompress, tinifyConvert } from '../src/media/tinify.js';
import { cropImage, downsizeImage } from '../src/media/imageEdit.js';
import { cropVideo, downsizeVideo, ffmpegAvailable } from '../src/media/ffmpeg.js';
import { resolveMediaInput } from '../src/util/inputs.js';
import { findProjectRoot } from './root.mjs';

const ROOT = findProjectRoot(import.meta.url);
const out = join(ROOT, 'output');
const pct = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}% smaller`;

const png = readdirSync(out).find((f) => /robot/i.test(f) && /\.png$/i.test(f))!;
const pngBytes = readFileSync(join(out, png));
console.error('source PNG:', png, pngBytes.length, 'bytes');

// --- Tinify ---
console.error('\n--- Tinify ---');
const key = readFileSync(join(ROOT, 'tinify com token.txt'), 'utf8').trim();
const compressed = await tinifyCompress(key, pngBytes);
writeFileSync(join(out, '_edit_tinify.png'), compressed);
console.error('compress PNG:', pngBytes.length, '->', compressed.length, `(${pct(pngBytes.length, compressed.length)})`);
const webp = await tinifyConvert(key, pngBytes, 'image/webp');
writeFileSync(join(out, '_edit_tinify.webp'), webp);
console.error('convert WebP:', pngBytes.length, '->', webp.length, `(${pct(pngBytes.length, webp.length)})`);

// --- sharp image edits ---
console.error('\n--- sharp ---');
const cropped = await cropImage(pngBytes, { left: 300, top: 150, width: 450, height: 450 });
writeFileSync(join(out, `_edit_crop.${cropped.mimeType.split('/')[1]}`), cropped.bytes);
console.error('crop image ->', cropped.mimeType, cropped.bytes.length, 'bytes');
const ds = await downsizeImage(pngBytes, { width: 256 });
writeFileSync(join(out, `_edit_downsize.${ds.mimeType.split('/')[1]}`), ds.bytes);
console.error('downsize image (w=256) ->', ds.mimeType, ds.bytes.length, 'bytes');

// --- ffmpeg video edits ---
console.error('\n--- ffmpeg ---');
console.error('ffmpeg available:', await ffmpegAvailable());
const mp4 = readdirSync(out).find((f) => /or-i2v/i.test(f) && /\.mp4$/i.test(f)) ?? readdirSync(out).find((f) => /\.mp4$/i.test(f));
if (mp4) {
  console.error('source video:', mp4);
  const media = await resolveMediaInput(join(out, mp4));
  await cropVideo(media, join(out, '_edit_crop_video.mp4'), { left: 100, top: 50, width: 512, height: 288 });
  console.error('crop video -> _edit_crop_video.mp4');
  await downsizeVideo(media, join(out, '_edit_downsize_video.mp4'), { width: 320 });
  console.error('downsize video (w=320) -> _edit_downsize_video.mp4');
}
console.error('\nOK');
