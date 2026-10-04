/**
 * `transform_media` on VIDEO inputs, over the real tool on an in-memory MCP transport with
 * real ffmpeg (skipped when ffmpeg is not installed). No network, no cost.
 *
 *  - `output_format:"mp4"` on a non-mp4 container must actually transcode (it used to fall
 *    through to the passthrough and return the .mkv/.webm unchanged);
 *  - audio an mp4 can't carry as-is (PCM) is re-encoded instead of failing `-c:a copy`;
 *  - a passthrough keeps the real container extension (an .mkv was written as `.mp4`);
 *  - frame extraction from a video passed as BYTES works with a single temp copy.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ffmpegAvailable } from '../src/media/ffmpeg.js';
import { detectMedia } from '../src/util/mime.js';
import { makeFakeGateway, startMcpHarness, textOf, uriToPath, type McpHarness } from './helpers/mcp.js';

const FF_TIMEOUT = 60_000;
const hasFfmpeg = await ffmpegAvailable();

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code}: ${err.slice(-300)}`))));
  });
}
/** Codec names of a file's streams, e.g. ['h264', 'aac']. */
async function codecs(path: string): Promise<string[]> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path]);
  return out.trim().split(/\r?\n/).filter(Boolean);
}

let dir: string;
let mkvPath: string;
let mp4Path: string;
let h: McpHarness;

const call = (args: Record<string, unknown>) => h.call('transform_media', args);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'air-tv-'));
  if (hasFfmpeg) {
    mkvPath = join(dir, 'clip.mkv');
    mp4Path = join(dir, 'clip.mp4');
    // MPEG-4 Part 2 video + PCM audio in Matroska: PCM cannot be stream-copied into mp4.
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', mkvPath]);
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path]);
  }
  h = await startMcpHarness({
    gateway: makeFakeGateway(),
    image: { model: 'x/y' },
    outDir: join(dir, 'out'),
    clientName: 'transform-video-test',
    tmpPrefix: 'air-tv-',
  });
});

after(async () => {
  await h.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('transform_media video', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('output_format mp4 on an .mkv TRANSCODES to a real mp4 (PCM audio re-encoded, not copied)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mkvPath, output_format: 'mp4' });
    assert.equal(r.isError, undefined, textOf(r));
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.match(link.name ?? '', /\.mp4$/);
    const out = uriToPath(link.uri!);
    assert.equal(detectMedia(await readFile(out))?.mime, 'video/mp4', 'the bytes are an mp4 container, not the source mkv');
    assert.deepEqual(await codecs(out), ['h264', 'aac']);
  });

  it('output_format mp4 on an mp4 needs no re-encode — the file passes through unchanged', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mp4Path, output_format: 'mp4' });
    assert.equal(r.isError, undefined, textOf(r));
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.ok((await readFile(uriToPath(link.uri!))).equals(await readFile(mp4Path)));
  });

  it('downsizing an .mkv with PCM audio succeeds (audio is re-encoded for the mp4 container)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mkvPath, width: 32 });
    assert.equal(r.isError, undefined, textOf(r));
    const out = uriToPath(r.content.find((c) => c.type === 'resource_link')!.uri!);
    assert.deepEqual(await codecs(out), ['h264', 'aac']);
  });

  it('a passthrough keeps the real container extension (.mkv, not .mp4)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: `data:video/x-matroska;base64,${(await readFile(mkvPath)).toString('base64')}` });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(r.content.find((c) => c.type === 'resource_link')!.name ?? '', /\.mkv$/);
  });

  it('extracts a still from a video passed as base64 bytes', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: (await readFile(mp4Path)).toString('base64'), output_format: 'png' });
    assert.equal(r.isError, undefined, textOf(r));
    const out = uriToPath(r.content.find((c) => c.type === 'resource_link')!.uri!);
    const meta = await sharp(await readFile(out)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 64);
  });
});
