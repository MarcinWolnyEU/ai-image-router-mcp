import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedMedia } from '../util/inputs.js';
import { extFromMime } from '../util/files.js';

let cachedAvailable: boolean | null = null;

export const FFMPEG_MISSING_MESSAGE =
  'Video operations (crop/downsize/frame extraction) require the `ffmpeg` command on your PATH, but it was not found. ' +
  'Install ffmpeg (https://ffmpeg.org/download.html) and make sure `ffmpeg` runs from a terminal, then try again.';

export async function ffmpegAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  cachedAvailable = await new Promise<boolean>((resolve) => {
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return cachedAvailable;
}

/**
 * Provide a usable input file path for ffmpeg, writing ONE temp copy if we only have bytes.
 * A caller that runs several ffmpeg/ffprobe passes over the same input (frame search) wraps
 * them all in one call — each primitive below would otherwise write its own copy.
 */
export async function withVideoFile<T>(media: ResolvedMedia, fn: (pathMedia: ResolvedMedia & { path: string }) => Promise<T>): Promise<T> {
  if (media.path) return fn(media as ResolvedMedia & { path: string });
  if (!media.bytes) throw new Error('No input path or bytes available for ffmpeg.');
  const dir = await mkdtemp(join(tmpdir(), 'air-mcp-'));
  const inputPath = join(dir, `input.${extFromMime(media.mimeType, 'mp4')}`);
  try {
    await writeFile(inputPath, media.bytes);
    return await fn({ kind: media.kind, mimeType: media.mimeType, path: inputPath });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Provide a usable input file path for ffmpeg (writing a temp file if we only have bytes). */
async function withInputFile<T>(media: ResolvedMedia, fn: (inputPath: string) => Promise<T>): Promise<T> {
  if (media.path) return fn(media.path);
  if (!media.bytes) throw new Error('No input path or bytes available for ffmpeg.');
  const dir = await mkdtemp(join(tmpdir(), 'air-mcp-'));
  const inputPath = join(dir, `input.${extFromMime(media.mimeType, 'mp4')}`);
  try {
    await writeFile(inputPath, media.bytes);
    return await fn(inputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-nostdin`: never read stdin — ffmpeg otherwise treats stdin as interactive
    // and can block indefinitely in non-TTY/automation contexts.
    const p = spawn('ffmpeg', ['-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', reject);
    if (signal) signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`))));
  });
}

/** Spawn a command and capture stdout (used for ffprobe). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

/** Video duration in seconds via ffprobe (ships with ffmpeg). */
export async function ffprobeDuration(media: ResolvedMedia, signal?: AbortSignal): Promise<number> {
  return withInputFile(media, async (inputPath) => {
    const out = await runCapture('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', inputPath]);
    void signal;
    const d = Number.parseFloat(out.trim());
    if (!Number.isFinite(d) || d <= 0) throw new Error('Could not determine video duration via ffprobe.');
    return d;
  });
}

/** Extract a single frame at `atSeconds` to `outPngPath` (PNG). */
export async function extractFrame(media: ResolvedMedia, atSeconds: number, outPngPath: string, signal?: AbortSignal): Promise<void> {
  await withInputFile(media, (inputPath) => run(['-y', '-ss', atSeconds.toFixed(3), '-i', inputPath, '-frames:v', '1', outPngPath], signal));
}

// Re-encode the video stream (crop/scale need it) to H.264 in an mp4 with a web-friendly moov
// atom. Audio is re-encoded to AAC rather than copied: `-c:a copy` fails outright for codecs an
// mp4 can't carry (PCM, Vorbis — common in .mkv/.webm/.mov inputs).
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

/** Convert any video container/codec to an H.264/AAC mp4 (`transform_media` `output_format:"mp4"`). */
export async function transcodeToMp4(media: ResolvedMedia, outPath: string, signal?: AbortSignal): Promise<void> {
  await withInputFile(media, (inputPath) => run(['-y', '-i', inputPath, ...ENCODE, outPath], signal));
}

export async function cropVideo(
  media: ResolvedMedia,
  outPath: string,
  r: { left: number; top: number; width: number; height: number },
  signal?: AbortSignal,
): Promise<void> {
  await withInputFile(media, (inputPath) =>
    run(['-y', '-i', inputPath, '-vf', `crop=${r.width}:${r.height}:${r.left}:${r.top}`, ...ENCODE, outPath], signal),
  );
}

export async function downsizeVideo(
  media: ResolvedMedia,
  outPath: string,
  dims: { width?: number; height?: number },
  signal?: AbortSignal,
): Promise<void> {
  const { width, height } = dims;
  let vf: string;
  // Fit within the box, preserve aspect, never enlarge (min(iw,W)/min(ih,H)), keep even dimensions.
  if (width && height) vf = `scale='min(iw,${width})':'min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  else if (width) vf = `scale='min(iw,${width})':-2`;
  else if (height) vf = `scale=-2:'min(ih,${height})'`;
  else throw new Error('downsize requires width and/or height.');
  await withInputFile(media, (inputPath) => run(['-y', '-i', inputPath, '-vf', vf, ...ENCODE, outPath], signal));
}
