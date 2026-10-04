import { createHash, type Hash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { resolvePath } from '../config/paths.js';

export type BgModelKey = 'birefnet-general' | 'birefnet-massive' | 'bria-rmbg' | 'isnet-general-use' | 'ben2-base';

/** Execution providers we describe usage for (a subset of the config enum). */
export type BgExecutionProvider = 'cpu' | 'dml' | 'webgpu' | 'cuda' | 'coreml';

/** Empirically-observed resource use of a model on one execution provider. */
export interface EpUsage {
  /** Whether the model actually runs to completion on this provider (false = it errors out). */
  runs: boolean;
  /** Peak host RAM in MB (measured via scripts/ram-test.ts; rounded up a little for headroom). */
  ramMB?: number;
  /** Peak VRAM in MB on GPU providers; `'over-16gb'` when it exhausts a 16 GB card / can't fit. */
  vramMB?: number | 'over-16gb';
  /** Short human note, e.g. why it fails on this provider. */
  note?: string;
}

export interface BgModelSpec {
  key: BgModelKey;
  label: string;
  /** One-line description shown in the wizard. */
  blurb: string;
  url: string;
  filename: string;
  /** Integrity checksum + algorithm (rembg publishes md5 for BiRefNet/isnet, sha256 for bria). */
  hash: { algo: 'md5' | 'sha256'; value: string };
  approxMB: number;
  /** Per-channel ImageNet-style normalisation (after rembg's per-image-max divide). */
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  /**
   * How RGB bytes are scaled before normalisation. rembg's BiRefNet/isnet divide each
   * pixel by the per-image **max** byte value (`'imageMax'`, the default); BEN2 follows
   * torchvision's `ToTensor` (a fixed `/255`, `'div255'`). With mean=0/std=1 the two only
   * coincide when the image actually contains a 255-valued byte, so this must match the
   * model's training transform. (`birefnet.ts` reads it in preprocessing.)
   */
  scaleMode?: 'imageMax' | 'div255';
  /**
   * Optional alpha black-point lift applied AFTER the min-max stretch (a fraction in 0..1).
   * Mask values at or below this clamp to fully transparent and the remainder is rescaled to
   * [0,1] (`v' = max(0, (v-floor)/(1-floor))`). This removes the faint low-alpha background
   * haze and patch-grid seams that transformer mattes (BEN2) leave in near-uniform background
   * regions, at the cost of clipping the very faintest semi-transparent wisps. Omit / 0 = no
   * change (rembg-faithful). Overridable at runtime with the `BG_ALPHA_FLOOR` env var.
   */
  alphaFloor?: number;
  /**
   * Flip test-time augmentation: also run the horizontally-mirrored image and average the two
   * (un-mirrored) raw outputs before postprocess. Halves spatially-fixed artifacts (the Swin
   * window grid) and suppresses inconsistent low-contrast background residue, at ~2× inference
   * time. Off by default; env `BG_TTA=off` disables, `BG_TTA=flip`/`1` forces on.
   */
  tta?: boolean;
  /**
   * Confidence-hysteresis cleanup seed (the "high" threshold, 0..1). When > 0, connected mask
   * regions that never reach this confidence are dropped (see `postprocess.hysteresisCleanup`) —
   * removes floating low-confidence "ghost panel" blobs while keeping soft edges and confidently
   * segmented detached subjects. The connectivity "low" threshold is the `alphaFloor`. 0/undefined
   * = off. Env `BG_HYST_SEED` overrides (0 disables).
   */
  hysteresisSeed?: number;
  /**
   * Whether the raw model output needs a sigmoid before min-max stretch.
   * BiRefNet emits logits (sigmoid required); bria-rmbg-2.0 / isnet emit a 0..1-ish map (no sigmoid).
   * (Mirrors rembg's per-session `predict`.)
   */
  needsSigmoid: boolean;
  /**
   * BiRefNet-architecture models (incl. bria-rmbg) can't run on WebGPU as-is — their wide
   * Split/Concat exceed the per-shader storage-buffer limit. When true and the configured EP is
   * WebGPU, the runtime auto-generates + loads a cascaded `<file>-webgpu.onnx` variant (see
   * `src/bgremoval/cascade.ts`). IS-Net (isnet) runs on WebGPU directly, so it stays false.
   */
  cascadeForWebgpu?: boolean;
  /**
   * Empirical peak resource use per execution provider, measured via `scripts/ram-test.ts`
   * (Windows 11, RTX 5070 Ti 16 GB, onnxruntime-node 1.26). `ramMB` is peak host RAM; `vramMB`
   * is peak GPU memory. The RAM guard (`BiRefNetRemover.requiredFreeMB`) derives its threshold
   * from `usage[ep].ramMB`, and the wizard shows these numbers next to the user's free RAM/VRAM.
   */
  usage: Partial<Record<BgExecutionProvider, EpUsage>>;
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/**
 * rembg release assets (https://github.com/danielgatis/rembg releases, tag v0.0.0).
 *
 * `usage` is empirical (Windows 11, RTX 5070 Ti 16 GB, onnxruntime-node 1.26) via
 * `scripts/ram-test.ts`. The whole BiRefNet family (incl. BRIA RMBG-2.0, which is
 * BiRefNet-based) uses deformable-conv ASPP + wide decoder splits that DirectML
 * (alloc bug → E_OUTOFMEMORY) and WebGPU (≤16 storage buffers/shader) cannot run;
 * only the lighter IS-Net (`isnet-general-use`) runs on the GPU providers.
 */
export const BG_MODELS: Record<BgModelKey, BgModelSpec> = {
  'birefnet-general': {
    key: 'birefnet-general',
    label: 'BiRefNet general',
    blurb: 'High-quality general matting. Free for commercial use, Chinese research project.',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx',
    filename: 'birefnet-general.onnx',
    hash: { algo: 'md5', value: '7a35a0141cbbc80de11d9c9a28f52697' },
    approxMB: 928,
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    needsSigmoid: true,
    cascadeForWebgpu: true,
    usage: {
      cpu: { runs: true, ramMB: 7680 },
      dml: { runs: false, ramMB: 1536, note: 'DirectML cannot run the deformable-conv ASPP node (E_OUTOFMEMORY).' },
      webgpu: { runs: true, ramMB: 1536, note: 'Runs via an auto-generated cascaded variant (cascade-wide-ops); ~8 s.' },
    },
  },
  'birefnet-massive': {
    key: 'birefnet-massive',
    label: 'BiRefNet massive',
    blurb: 'BiRefNet trained on a larger dataset. Free for commercial use, Chinese research project.',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-massive-TR_DIS5K_TR_TEs-epoch_420.onnx',
    filename: 'birefnet-massive.onnx',
    hash: { algo: 'md5', value: '33e726a2136a3d59eb0fdf613e31e3e9' },
    approxMB: 973,
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    needsSigmoid: true,
    cascadeForWebgpu: true,
    usage: {
      cpu: { runs: true, ramMB: 7680 },
      dml: { runs: false, ramMB: 1536, note: 'DirectML cannot run a fused BiRefNet node (E_OUTOFMEMORY).' },
      webgpu: { runs: true, ramMB: 1536, note: 'Runs via an auto-generated cascaded variant (cascade-wide-ops); ~7 s.' },
    },
  },
  'bria-rmbg': {
    key: 'bria-rmbg',
    label: 'BRIA RMBG-2.0',
    blurb: 'Model for non-commercial use (CC BY-NC 4.0) from Israeli company Bria AI, state of the art for general use',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/bria-rmbg-2.0.onnx',
    filename: 'bria-rmbg-2.0.onnx',
    hash: { algo: 'sha256', value: '5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958' },
    approxMB: 977,
    mean: IMAGENET_MEAN,
    std: IMAGENET_STD,
    needsSigmoid: false,
    cascadeForWebgpu: true,
    usage: {
      cpu: { runs: true, ramMB: 7680 },
      dml: { runs: false, ramMB: 1024, note: 'DirectML cannot run a fused BiRefNet node (E_OUTOFMEMORY).' },
      webgpu: { runs: true, ramMB: 1536, note: 'Runs via an auto-generated cascaded variant (cascade-wide-ops); ~7.6 s.' },
    },
  },
  'isnet-general-use': {
    key: 'isnet-general-use',
    label: 'IS-Net general',
    blurb: 'IS-Net model — runs on GPU (DirectML and WebGPU), fast, low memory; edges a touch softer and might remove too much of the image. Commercial use allowed. Originating from UAE-Swiss-Chinese research group.',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    filename: 'isnet-general-use.onnx',
    hash: { algo: 'md5', value: 'fc16ebd8b0c10d971d3513d564d01e29' },
    approxMB: 170,
    mean: [0.5, 0.5, 0.5],
    std: [1.0, 1.0, 1.0],
    needsSigmoid: false,
    usage: {
      cpu: { runs: true, ramMB: 1280 },
      webgpu: { runs: true, ramMB: 1024, vramMB: 1408 },
      dml: { runs: true, ramMB: 1024, vramMB: 1280, note: 'Works, but the first call is very slow (DirectML kernel compilation).' },
    },
  },
  'ben2-base': {
    key: 'ben2-base',
    label: 'BEN2 Base',
    blurb: 'BEN2 confidence-guided matting — strong on hair/fine edges, competitive with/above RMBG-2.0. MIT-licensed, free for commercial use, from Prama LLC (US). Sharpest at ≤1024×1024 — it runs at a fixed 1024² internally, so larger inputs are downscaled and the mask upscaled back (some softening on big images).',
    // PramaLLC's official ONNX export. It's a MIXED-precision graph (188 fp32 + 325 fp16 weights)
    // and — importantly — its OUTPUT tensor is declared **float16**, so onnxruntime-node hands the
    // result back as a Uint16Array of raw fp16 bits. `birefnet.ts` decodes those bits to fp32
    // (`half2float`) before postprocess; reading them as floats directly (a bare `as Float32Array`)
    // miscolours the low end of the mask and min-max then amplifies it into window-grid "seams".
    url: 'https://huggingface.co/PramaLLC/BEN2/resolve/main/BEN2_Base.onnx',
    filename: 'ben2-base.onnx',
    hash: { algo: 'sha256', value: '22cea62108ff53b7ccc20f7a008bf30494228d84b1687f29ecbe76936a998101' },
    approxMB: 213, // 222_932_053 bytes
    // BEN2's onnx_run.py preprocesses with torchvision ToTensor only: fixed /255, no mean/std.
    mean: [0, 0, 0],
    std: [1, 1, 1],
    scaleMode: 'div255',
    // Post-process is plain min-max over the raw output (no sigmoid).
    needsSigmoid: false,
    // No postprocess mitigations by default. `alphaFloor` (black-point lift), `tta` (flip
    // test-time augmentation, ~2× inference) and `hysteresisSeed` (drop low-confidence blobs)
    // were originally added to fight the "seams"/haze/ghost-panels — but those were the fp16
    // output-decode bug (now fixed in birefnet.ts), not real model artifacts. With the bug gone
    // the raw mask is already clean on flat backgrounds (no halo) AND these mitigations actively
    // *erode* fine detail (alphaFloor/hysteresis thin hair wisps and ship rigging), so they cost
    // detail + time for no benefit. Verified by a sweep across hair/robot/storm/sunken-city:
    // raw == defaults on cleanliness, but raw keeps more fine structure and is ~2× faster.
    // Still env-overridable per-image if ever needed: BG_TTA, BG_ALPHA_FLOOR, BG_HYST_SEED.
    // Unlike the BiRefNet family, BEN2 runs on every provider as-is (no wide Split/Concat
    // that trips WebGPU's storage-buffer limit), so no cascade variant is needed.
    usage: {
      cpu: { runs: true, ramMB: 4096, note: 'CPU forward pass ~18 s (×2 if flip-TTA re-enabled via BG_TTA).' },
      dml: { runs: true, ramMB: 1024, vramMB: 3712, note: 'Runs on DirectML (~0.8 s/pass; ×2 if flip-TTA re-enabled).' },
      webgpu: { runs: true, ramMB: 1024, vramMB: 3840, note: 'Runs on WebGPU directly (~13 s; ×2 if flip-TTA re-enabled).' },
    },
  },
};

/** Require this much free RAM above a model's measured peak before running it. */
export const RAM_HEADROOM_MB = 512;

/**
 * Free system RAM (MB) a model needs for the given execution provider — the empirical peak host
 * RAM (`usage[ep].ramMB`) plus headroom. On CPU the whole forward pass runs in host memory
 * (~7 GB peak for the 1024² BiRefNet/bria graphs); accelerated providers keep activations on the
 * GPU and only need enough host RAM to load the weights. (Kept here, free of onnxruntime imports,
 * so health/wizard can use it without loading the ORT native addon.)
 */
/**
 * What the `executionProvider` setting means on this machine — the ONE resolution of `auto`,
 * shared by the runtime (`birefnet.ts`), the wizard and `health_status` (they used to disagree).
 * Windows → WebGPU: every model runs there (the BiRefNet family via its one-time cascaded copy),
 * while DirectML cannot run BiRefNet/bria at all and needs a ~6-min first-call compile for isnet.
 */
export function resolveExecutionProvider(setting: string, platform: string = process.platform, arch: string = process.arch): BgExecutionProvider {
  if (setting && setting !== 'auto') return setting as BgExecutionProvider;
  if (platform === 'win32') return 'webgpu';
  if (platform === 'darwin') return 'coreml';
  if (platform === 'linux' && arch === 'x64') return 'cuda';
  return 'cpu';
}

/**
 * Whether the bundled onnxruntime-node ships `ep` on this platform: CUDA only on Linux x64,
 * CoreML only on macOS, DirectML only on Windows (CPU/WebGPU: not restricted here). An
 * unavailable provider used to be "accepted" and reported as active while CPU did the work.
 */
export function providerAvailable(ep: BgExecutionProvider, platform: string = process.platform, arch: string = process.arch): boolean {
  if (ep === 'cuda') return platform === 'linux' && arch === 'x64';
  if (ep === 'coreml') return platform === 'darwin';
  if (ep === 'dml') return platform === 'win32';
  return true;
}

/**
 * The providers session creation tries, accelerator first, CPU last. A provider the bundled
 * runtime does not ship on this platform, or one this model is KNOWN not to run on
 * (`usage[ep].runs === false`, e.g. BiRefNet on DirectML), is skipped up front: ORT would
 * create the session and then fail inside `session.run()`, past the create-time CPU fallback.
 */
export function plannedProviders(
  spec: BgModelSpec,
  setting: string,
  platform: string = process.platform,
  arch: string = process.arch,
): { eps: BgExecutionProvider[]; skipped?: { ep: BgExecutionProvider; note?: string } } {
  const ep = resolveExecutionProvider(setting, platform, arch);
  if (ep === 'cpu') return { eps: ['cpu'] };
  if (!providerAvailable(ep, platform, arch)) {
    return { eps: ['cpu'], skipped: { ep, note: `the bundled onnxruntime has no ${ep} provider on ${platform}-${arch}` } };
  }
  const usage = spec.usage[ep];
  if (usage?.runs === false) return { eps: ['cpu'], skipped: { ep, ...(usage.note ? { note: usage.note } : {}) } };
  return { eps: [ep, 'cpu'] };
}

export function requiredFreeMB(spec: BgModelSpec, ep: string): number {
  const ramMB = spec.usage[ep as BgExecutionProvider]?.ramMB ?? (ep === 'cpu' ? 8192 : 2048);
  return ramMB + RAM_HEADROOM_MB;
}

export type DownloadProgress = (info: { phase: 'download' | 'verify' | 'done'; pct?: number; message: string }) => void;

/**
 * True when an already-downloaded model file looks real (skipping a re-hash of ~1 GB at every
 * startup); a truncated leftover is deleted so the caller downloads it afresh.
 */
async function hasPlausibleModelFile(spec: BgModelSpec, finalPath: string): Promise<boolean> {
  if (!existsSync(finalPath)) return false;
  const s = await stat(finalPath);
  if (s.size > spec.approxMB * 1024 * 1024 * 0.5) return true;
  await rm(finalPath).catch(() => {});
  return false;
}

/** Start the model download: the response body plus the advertised size (0 when unknown). */
async function openModelDownload(spec: BgModelSpec): Promise<{ body: import('node:stream/web').ReadableStream<Uint8Array>; total: number }> {
  const res = await fetch(spec.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Failed to download ${spec.url}: HTTP ${res.status}`);
  return { body: res.body as import('node:stream/web').ReadableStream<Uint8Array>, total: Number(res.headers.get('content-length') ?? 0) };
}

/** A pass-through stage that hashes every chunk and reports download progress every 5%. */
function createDownloadMeter(spec: BgModelSpec, total: number, hash: Hash, onProgress?: DownloadProgress): Transform {
  let downloaded = 0;
  let lastPct = -5;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      downloaded += chunk.length;
      const pct = total > 0 ? Math.floor((downloaded / total) * 100) : null; // no content-length → no progress
      if (pct !== null && pct >= lastPct + 5) {
        lastPct = pct;
        onProgress?.({ phase: 'download', pct, message: `Downloading ${spec.key}: ${pct}%` });
      }
      done(null, chunk);
    },
  });
}

/**
 * Ensure the given model's .onnx file is present locally (downloading + md5-verifying
 * if necessary). Returns the absolute path. Idempotent.
 */
export async function ensureModelFile(spec: BgModelSpec, modelsDir: string, onProgress?: DownloadProgress): Promise<string> {
  const dir = resolvePath(modelsDir);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, spec.filename);

  if (await hasPlausibleModelFile(spec, finalPath)) {
    onProgress?.({ phase: 'done', message: `Model already present (${spec.filename}).` });
    return finalPath;
  }

  onProgress?.({ phase: 'download', pct: 0, message: `Downloading ${spec.key} (~${spec.approxMB} MB)…` });
  const { body, total } = await openModelDownload(spec);

  const tmpPath = finalPath + '.part';
  const hash = createHash(spec.hash.algo);
  // Hash + progress as a pass-through stage. `pipeline` owns every stream's 'error' and
  // destroys the others: a hand-rolled write loop left a write error (ENOSPC, EACCES, the
  // target vanishing) with no listener → uncaughtException on the startup pre-warm path,
  // or a forever-pending wait for 'finish' from an errored stream.
  const meter = createDownloadMeter(spec, total, hash, onProgress);
  try {
    await pipeline(Readable.fromWeb(body), meter, createWriteStream(tmpPath));
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw new Error(`Downloading ${spec.filename} failed: ${(err as Error).message}`);
  }

  onProgress?.({ phase: 'verify', message: 'Verifying checksum…' });
  const digest = hash.digest('hex');
  if (digest !== spec.hash.value) {
    await rm(tmpPath).catch(() => {});
    throw new Error(`Checksum mismatch for ${spec.filename}: expected ${spec.hash.algo}:${spec.hash.value}, got ${digest}. Download may be corrupt.`);
  }
  await rename(tmpPath, finalPath);
  onProgress?.({ phase: 'done', message: `Downloaded and verified ${spec.filename}.` });
  return finalPath;
}
