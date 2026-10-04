/**
 * Validate video generation through the real gateway clients.
 *   npx tsx scripts/video-test.ts probe-or                 # list OpenRouter video models (free)
 *   npx tsx scripts/video-test.ts eden-i2v                 # Eden MiniMax image-to-video
 *   npx tsx scripts/video-test.ts or-i2v <model>           # OpenRouter image-to-video (e.g. Seedance)
 *   npx tsx scripts/video-test.ts eden-t2v <model> <provider>   # Eden text-to-video
 *   npx tsx scripts/video-test.ts or-t2v <model>           # OpenRouter text-to-video
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../src/logging/logger.js';
import { createGateway } from '../src/gateways/registry.js';
import { resolveImageInput } from '../src/util/inputs.js';
import { saveMedia, extFromMime } from '../src/util/files.js';
import type { ReferenceImage, VideoGenParams } from '../src/gateways/types.js';
import { findProjectRoot } from './root.mjs';

const ROOT = findProjectRoot(import.meta.url);
const tokenOf = (f: string) => readFileSync(join(ROOT, f), 'utf8').trim();

function pickReferenceImage(): string {
  const dir = join(ROOT, 'output');
  const pngs = readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
  const robot = pngs.find((f) => /robot/i.test(f));
  const chosen = robot ?? pngs[0];
  if (!chosen) throw new Error('No image found in output/ to use as a reference.');
  return join(dir, chosen);
}

async function runVideo(gwId: 'openrouter' | 'edenai', params: VideoGenParams, label: string) {
  const logger = new Logger('none', 'logs');
  await logger.init();
  const token = tokenOf(gwId === 'openrouter' ? 'openrouter token.txt' : 'eden ai token.txt');
  const gw = createGateway(gwId, token, logger);
  console.error(`\n[${gwId}] ${params.kind} model=${params.model} provider=${params.edenProvider ?? '-'}`);
  const t = Date.now();
  const res = await gw.generateVideo!(params);
  console.error(`done in ${Math.round((Date.now() - t) / 1000)}s, modelUsed=${res.modelUsed}, cost=${res.cost ?? 'n/a'}, videos=${res.videos.length}`);
  for (const v of res.videos) {
    if (v.bytes) {
      const saved = await saveMedia(join(ROOT, 'output'), v.bytes, extFromMime(v.mimeType, 'mp4'), label);
      console.error(`  saved ${saved.path} (${(v.bytes.length / 1024 / 1024).toFixed(2)} MB)  source=${v.sourceUrl ?? '-'}`);
    } else {
      console.error(`  url-only: ${v.sourceUrl}`);
    }
  }
}

/** What a mode needs to build its job: the CLI args, the first-frame reference and the shared progress callback. */
interface JobContext {
  a1: string | undefined;
  a2: string | undefined;
  ref: ReferenceImage;
  motion: string;
  onProgress: (status: string) => void;
}
interface VideoJob {
  gwId: 'openrouter' | 'edenai';
  params: VideoGenParams;
  label: string;
}

/** mode -> job. (A mode that is not here is "unknown"; `probe-or` is handled separately — it makes no video.) */
const JOBS: Record<string, (c: JobContext) => VideoJob> = {
  'eden-i2v': (c) => ({
    gwId: 'edenai',
    label: 'eden-minimax-i2v',
    params: { kind: 'image-to-video', prompt: c.motion, model: 'MiniMax-Hailuo-02', edenProvider: 'minimax', references: [c.ref], duration: 6, resolution: '768P', fps: null, onProgress: c.onProgress },
  }),
  'or-i2v': (c) => {
    if (!c.a1) throw new Error('usage: or-i2v <model>');
    return {
      gwId: 'openrouter',
      label: 'or-i2v',
      params: { kind: 'image-to-video', prompt: c.motion, model: c.a1, references: [c.ref], duration: 5, resolution: '720p', fps: null, onProgress: c.onProgress },
    };
  },
  'eden-t2v': (c) => ({
    gwId: 'edenai',
    label: 'eden-t2v',
    params: { kind: 'text-to-video', prompt: c.motion, model: c.a1 ?? '', edenProvider: c.a2 ?? 'minimax', references: [], duration: 6, resolution: '768P', fps: null, onProgress: c.onProgress },
  }),
  'or-t2v': (c) => ({
    gwId: 'openrouter',
    label: 'or-t2v',
    params: {
      kind: 'text-to-video',
      prompt: 'a tiny cute robot painting a watercolor of mountains, flat vector style, gentle motion',
      model: c.a1 ?? '',
      references: [],
      duration: 5,
      resolution: '720p',
      fps: null,
      onProgress: c.onProgress,
    },
  }),
};

/** List OpenRouter's video models straight from the REST API (free). */
async function probeOpenRouter(): Promise<void> {
  const token = tokenOf('openrouter token.txt');
  const res = await fetch('https://openrouter.ai/api/v1/models?output_modalities=video', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { data?: Array<{ id: string; name?: string; created?: number }> };
  const data = json.data ?? [];
  console.error(`http=${res.status} video models=${data.length}`);
  for (const m of data) console.error(`  ${m.id}  ${m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : ''}`);
}

async function main() {
  const [mode, a1, a2] = process.argv.slice(2);
  if (mode === 'probe-or') return probeOpenRouter();

  const refPath = pickReferenceImage();
  console.error('reference image:', refPath);
  const ref: ReferenceImage = { ...(await resolveImageInput(refPath)), role: 'first_frame' };
  const motion = 'the little robot waves its paintbrush and paints on the canvas, gentle camera push-in, subtle ambient motion';

  const buildJob = JOBS[mode ?? ''];
  if (!buildJob) throw new Error(`unknown mode: ${mode}`);
  const job = buildJob({ a1, a2, ref, motion, onProgress: (s) => console.error('  status:', s) });
  await runVideo(job.gwId, job.params, job.label);
}

main().catch((e) => {
  console.error('VIDEO TEST ERROR:', e?.stack ?? e);
  process.exit(1);
});
