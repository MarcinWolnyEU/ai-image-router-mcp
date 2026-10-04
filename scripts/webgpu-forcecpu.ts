/**
 * webgpu-forcecpu.ts — iteratively discover the minimal set of nodes that must be pinned
 * to CPU (via the WebGPU EP `forceCpuNodeNames` option) for a BiRefNet/bria model to run on
 * WebGPU, and time the result. Each WebGPU run that hits the storage-buffer limit names one
 * offending node; we add it and retry until the graph runs (or we give up).
 *
 *   npx tsx scripts/webgpu-forcecpu.ts [model] [image]
 *
 * Prints per-iteration progress and a final { forced:[...], createMs, runMs } summary, and (with
 * RAM_TEST_SAVE=1) dumps the cutout so the result can be eyeballed.
 */
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { BG_MODELS, ensureModelFile, type BgModelKey } from '../src/bgremoval/models.js';
import { resolvePath } from '../src/config/paths.js';

const SIZE = 1024;

async function preprocess(input: Buffer, mean: readonly number[], std: readonly number[]): Promise<ort.Tensor> {
  const plane = SIZE * SIZE;
  const rgb = await sharp(input).removeAlpha().resize(SIZE, SIZE, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
  let maxByte = 1;
  for (let i = 0; i < rgb.length; i++) if (rgb[i]! > maxByte) maxByte = rgb[i]!;
  const inv = 1 / Math.max(maxByte, 1e-6);
  const chw = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    chw[p] = (rgb[p * 3]! * inv - mean[0]!) / std[0]!;
    chw[plane + p] = (rgb[p * 3 + 1]! * inv - mean[1]!) / std[1]!;
    chw[2 * plane + p] = (rgb[p * 3 + 2]! * inv - mean[2]!) / std[2]!;
  }
  return new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]);
}

/** The accelerator EP config for this iteration. */
function accelProvider(forced: Set<string>): ort.InferenceSession.ExecutionProviderConfig {
  // forceCpuNodeNames must be omitted when empty (an empty value is rejected downstream).
  const epName = process.env.EP ?? 'webgpu'; // override to test the same (cascaded) model on dml/cuda/etc.
  const vm = process.env.WEBGPU_VALIDATION; // 'basic' | 'full' | 'wgpuOnly' | 'disabled'
  const isWebgpu = epName === 'webgpu';
  return {
    name: epName,
    ...(isWebgpu && forced.size > 0 ? { forceCpuNodeNames: [...forced] } : {}),
    ...(isWebgpu && vm ? { validationMode: vm } : {}),
  } as ort.InferenceSession.ExecutionProviderConfig;
}

/** Dump the (sigmoid'd if needed, min-max stretched) mask of the first output as a PNG so it can be eyeballed. */
async function saveMask(out: Float32Array, needsSigmoid: boolean, modelKey: string): Promise<void> {
  const plane = SIZE * SIZE;
  let mn = Infinity, mx = -Infinity;
  const m = new Float32Array(plane);
  for (let i = 0; i < plane; i++) { const s = needsSigmoid ? 1 / (1 + Math.exp(-out[i]!)) : out[i]!; m[i] = s; if (s < mn) mn = s; if (s > mx) mx = s; }
  const r = mx - mn;
  const u8 = Buffer.allocUnsafe(plane);
  for (let i = 0; i < plane; i++) u8[i] = Math.max(0, Math.min(255, Math.round(((r > 1e-6 ? (m[i]! - mn) / r : m[i]!)) * 255)));
  const png = await sharp(u8, { raw: { width: SIZE, height: SIZE, channels: 1 } }).png().toBuffer();
  const p = resolvePath(`output/forcecpu_${modelKey}.png`);
  await writeFile(p, png);
  console.error(`[forcecpu] saved mask ${p}`);
}

interface Timing { createMs: number; runMs: number }

/**
 * Create a session with the current forced set and run it once. `onSuccess` sees the first output
 * before the session is released (the data lives in native memory); the ~1 GB session is ALWAYS released, so a
 * failed iteration doesn't leak into the next (else OOM).
 */
async function runOnce(modelPath: string, tensor: ort.Tensor, forced: Set<string>, onSuccess: (t: Timing, out: Float32Array) => Promise<void>): Promise<void> {
  let session: ort.InferenceSession | undefined;
  try {
    const t0 = Date.now();
    session = await ort.InferenceSession.create(modelPath, { executionProviders: [accelProvider(forced), 'cpu'] });
    const createMs = Date.now() - t0;
    const inputName = session.inputNames[0]!;
    const t1 = Date.now();
    const outputs = await session.run({ [inputName]: tensor });
    const runMs = Date.now() - t1;
    await onSuccess({ createMs, runMs }, outputs[session.outputNames[0]!]!.data as Float32Array);
  } finally {
    await session?.release();
  }
}

/**
 * Each WebGPU failure names one offending node: add it to the forced-CPU set so the next iteration can retry.
 * Returns false when there is nothing left to try (no node named, or the named node is already forced).
 */
function pinOffendingNode(msg: string, forced: Set<string>, iter: number): boolean {
  const node = msg.match(/Name:'([^']+)'/)?.[1];
  if (!node) { console.error('[forcecpu] FAIL (no node name): ' + msg.slice(0, 300)); return false; }
  if (forced.has(node)) { console.error(`[forcecpu] STUCK on ${node} (already forced): ${msg.slice(0, 200)}`); return false; }
  forced.add(node);
  console.error(`[forcecpu] iter ${iter}: +${node} (total ${forced.size})`);
  return true;
}

async function main() {
  const modelKey = (process.argv[2] as BgModelKey) ?? 'birefnet-massive';
  const image = process.argv[3] ?? 'output/2026-06-07_11-26-19_a-serene-anchored-luxury-sailing-yacht-r_70df1c83.png';
  const spec = BG_MODELS[modelKey];
  const modelPath = process.env.MODEL_PATH ? resolvePath(process.env.MODEL_PATH) : await ensureModelFile(spec, 'models');
  const tensor = await preprocess(await readFile(resolvePath(image)), spec.mean, spec.std);

  // Optional: pre-seed the forced set (comma-separated node names) to test a known set in a
  // fresh process — rules out cross-iteration WebGPU device-state bleed.
  const forced = new Set<string>(process.env.FORCED_SEED ? process.env.FORCED_SEED.split(',').filter(Boolean) : []);
  if (forced.size) console.error(`[forcecpu] seeded ${forced.size} forced nodes`);

  const onSuccess = async ({ createMs, runMs }: Timing, out: Float32Array) => {
    console.error(`[forcecpu] SUCCESS forced=${forced.size} createMs=${createMs} runMs=${runMs}`);
    console.error('[forcecpu] RESULT ' + JSON.stringify({ ok: true, model: modelKey, forcedCount: forced.size, createMs, runMs, forced: [...forced] }));
    if (process.env.RAM_TEST_SAVE) await saveMask(out, spec.needsSigmoid, modelKey);
  };

  const MAX_ITERS = 80;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    try {
      await runOnce(modelPath, tensor, forced, onSuccess);
      return;
    } catch (e) {
      if (!pinOffendingNode((e as Error).message, forced, iter)) return;
    }
  }
  console.error(`[forcecpu] gave up after ${MAX_ITERS} iters; forced=${[...forced].length}`);
}

main();
