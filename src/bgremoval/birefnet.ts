import { existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import type { Logger } from '../logging/logger.js';
import { BG_MODELS, type BgModelSpec, type BgModelKey, type DownloadProgress, ensureModelFile, plannedProviders, requiredFreeMB } from './models.js';
import { hflipPlane, hysteresisCleanup, maskToAlphaBytes, normalizeMask } from './postprocess.js';
import { decodeOrientedRgb, type OrientedRgb } from './preprocess.js';
import { memInfo } from '../util/sysinfo.js';

const SIZE = 1024;

const gb = (mb: number) => (mb / 1024).toFixed(1);

/** Decode one IEEE-754 half-precision (fp16) bit pattern to a JS number. */
function half2float(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024); // subnormal / zero
  if (exp === 0x1f) return frac ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/**
 * Read an ONNX output tensor's data as a Float32Array, decoding fp16 if necessary.
 * Some BEN2 exports (e.g. PramaLLC's `BEN2_Base.onnx`) declare a **float16 output**, which
 * onnxruntime-node returns as a `Uint16Array` of raw fp16 bits — casting that straight to
 * `Float32Array` reads the bit patterns as integers (a 0..1 mask becomes 0..15360), and the
 * downstream min-max stretch amplifies the mangled low end into visible window-grid "seams".
 * So decode by the tensor's declared type, not by a blind cast.
 */
function tensorToFloat32(tensor: { type: string; data: unknown }): Float32Array {
  const data = tensor.data;
  if (data instanceof Float32Array) return data;
  if (tensor.type === 'float16' && data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = half2float(data[i]!);
    return out;
  }
  // Any other numeric typed array (incl. a real Float16Array on Node ≥22, whose values are
  // already decoded) — copy through; `from` reads the element values, not the raw bytes.
  return Float32Array.from(data as ArrayLike<number>);
}

/**
 * Local background removal with rembg's BiRefNet ONNX models.
 * Pre/post-processing mirrors rembg exactly (1024² stretch, per-image-max scaling,
 * ImageNet normalisation, sigmoid + min-max, mask as alpha).
 */
export class BiRefNetRemover {
  private session: ort.InferenceSession | null = null;
  private inputName = 'input_image';
  private outputName = 'output_image';
  activeEP = 'cpu';
  readonly modelKey: BgModelKey;
  private readonly spec: BgModelSpec;

  constructor(
    modelKey: BgModelKey,
    private readonly epSetting: string,
    private readonly modelsDir: string,
    private readonly logger: Logger,
  ) {
    this.modelKey = modelKey;
    this.spec = BG_MODELS[modelKey];
  }

  /**
   * Release the native session (weights, arena, GPU buffers — 1–4 GB). Dropping the JS
   * reference alone leaves it alive until V8 happens to collect the small wrapper.
   */
  async dispose(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await s.release();
  }

  /** Throw a clear, actionable error when free RAM is below what `ep` needs. */
  private assertEnoughRam(ep: string): void {
    // Escape hatch: os.freemem() understates reclaimable cache, so allow power users to override.
    if (process.env.BG_RAM_CHECK === 'off') return;
    const need = requiredFreeMB(this.spec, ep);
    const free = memInfo().freeMB;
    if (free >= need) return;
    throw new Error(
      `Background removal model "${this.modelKey}" needs about ${gb(need)} GB of free RAM to run on the ` +
        `${ep.toUpperCase()} execution provider, but only ${gb(free)} GB is currently free. ` +
        `Free up memory (close other apps), or in configuration (\`npm run configure\`) pick a lighter ` +
        `background-removal model — or set it to "none" — then restart the MCP server.`,
    );
  }

  async init(onProgress?: DownloadProgress): Promise<void> {
    const spec = this.spec;
    let modelPath = await ensureModelFile(spec, this.modelsDir, onProgress);

    // Shared resolution of `auto` (models.ts) — the same answer the wizard and health_status give.
    const plan = plannedProviders(spec, this.epSetting);
    if (plan.skipped) {
      this.logger.warn(`"${this.modelKey}" cannot run on the ${plan.skipped.ep} execution provider; using CPU instead`, { note: plan.skipped.note });
    }
    const eps = plan.eps;
    // WebGPU can't run the BiRefNet family as-is (wide Split/Concat exceed the per-shader buffer
    // limit). Transparently swap in a cascaded variant — generating it once if needed — so GPU
    // background removal works end-to-end.
    if (eps[0] === 'webgpu' && spec.cascadeForWebgpu) {
      modelPath = await this.ensureCascadedModel(modelPath, onProgress);
    }
    // Pre-flight RAM check against the provider we're about to try (the CPU fallback below
    // needs much more host RAM than an accelerator, so re-checked there if it triggers).
    this.assertEnoughRam(eps[0]!);
    // logSeverityLevel: 3 (Error) silences onnxruntime's native stderr noise on load —
    // "Removing initializer …" (CleanUnusedInitializers), "Some nodes were not assigned to
    // the preferred EP", lenient shape-merge notices. These bypass our Logger and are benign;
    // real load/run failures are level Error and still surface (and we catch+log them ourselves).
    try {
      this.session = await ort.InferenceSession.create(modelPath, { executionProviders: eps, logSeverityLevel: 3 });
      this.activeEP = eps[0]!;
      this.logger.info('BiRefNet ONNX session ready', { model: this.modelKey, executionProvider: this.activeEP });
    } catch (err) {
      this.logger.warn(`Execution provider "${eps[0]}" failed; falling back to CPU`, { error: (err as Error).message });
      this.assertEnoughRam('cpu'); // CPU needs far more host RAM than the accelerator we just tried
      this.session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], logSeverityLevel: 3 });
      this.activeEP = 'cpu';
    }
    this.inputName = this.session.inputNames[0] ?? 'input_image';
    this.outputName = this.session.outputNames[0] ?? 'output_image';
  }

  /**
   * Ensure a WebGPU-runnable (cascaded) copy of the model exists next to the original
   * (`<file>-webgpu.onnx`), generating it once via graph surgery. Returns its path.
   */
  private async ensureCascadedModel(modelPath: string, onProgress?: DownloadProgress): Promise<string> {
    const cascadedPath = modelPath.replace(/\.onnx$/i, '-webgpu.onnx');
    if (!existsSync(cascadedPath)) {
      this.logger.info('Preparing WebGPU-compatible (cascaded) model — one-time', { model: this.modelKey });
      onProgress?.({ phase: 'verify', message: 'Preparing WebGPU-compatible model (one-time)…' });
      const { cascadeWideOps } = await import('./cascade.js');
      const r = await cascadeWideOps(modelPath, cascadedPath);
      this.logger.info('WebGPU model ready', { model: this.modelKey, file: cascadedPath, ...r });
    }
    return cascadedPath;
  }

  /**
   * One forward pass: preprocess (RGB → 1024² stretch → scale → normalise → NCHW), run the
   * session, return the raw 1024² output. When `flop` is set, the input is horizontally mirrored
   * and the output is mirrored back, so the result aligns with the un-flipped image (for TTA).
   */
  private async infer(src: OrientedRgb, flop: boolean): Promise<Float32Array> {
    const plane = SIZE * SIZE;
    let pipe = sharp(src.data, { raw: { width: src.width, height: src.height, channels: 3 } }).resize(SIZE, SIZE, { kernel: 'lanczos3', fit: 'fill' });
    if (flop) pipe = pipe.flop();
    const rgb = await pipe.raw().toBuffer();
    // Scale: rembg's BiRefNet/isnet divide by the per-image max byte; BEN2 uses a fixed /255
    // (torchvision ToTensor). These differ unless the image actually contains a 255 byte.
    let inv: number;
    if (this.spec.scaleMode === 'div255') {
      inv = 1 / 255;
    } else {
      let maxByte = 1;
      for (let i = 0; i < rgb.length; i++) if (rgb[i]! > maxByte) maxByte = rgb[i]!;
      inv = 1 / Math.max(maxByte, 1e-6);
    }
    const mean = this.spec.mean;
    const std = this.spec.std;
    const chw = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) {
      chw[p] = (rgb[p * 3]! * inv - mean[0]) / std[0];
      chw[plane + p] = (rgb[p * 3 + 1]! * inv - mean[1]) / std[1];
      chw[2 * plane + p] = (rgb[p * 3 + 2]! * inv - mean[2]) / std[2];
    }
    const session = this.session;
    if (!session) throw new Error('The background-removal session was released (the server was restarted) — please retry.');
    const outputs = await session.run({ [this.inputName]: new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]) });
    // Decode by declared dtype — a float16 output comes back as a Uint16Array of fp16 bits.
    const raw = tensorToFloat32(outputs[this.outputName]!);
    return flop ? hflipPlane(raw, SIZE, SIZE) : raw;
  }

  /** Returns a PNG (RGBA) with the background removed. */
  async removeBackground(input: Buffer): Promise<Buffer> {
    this.assertEnoughRam(this.activeEP); // RAM may have dropped since the session was created
    // Decode once, AS DISPLAYED (EXIF orientation applied): the output PNG carries no EXIF,
    // so unrotated pixels would turn a portrait phone photo into a sideways cutout.
    const src = await decodeOrientedRgb(input);
    const alpha = this.postprocess(await this.forwardPass(src));
    return composeRgba(src, await resizeMask(alpha, src.width, src.height));
  }

  /**
   * Forward pass with optional flip test-time augmentation: TTA averages the raw output of the
   * image and its mirror, halving spatially-fixed artifacts (the Swin window grid) and
   * suppressing inconsistent low-contrast residue. Env `BG_TTA` (off/0/none/false ↔ flip/1/on)
   * overrides the per-model default.
   */
  private async forwardPass(src: OrientedRgb): Promise<Float32Array> {
    const ttaEnv = process.env.BG_TTA;
    const tta = ttaEnv != null && ttaEnv !== '' ? !/^(0|off|none|false)$/i.test(ttaEnv) : !!this.spec.tta;
    const raw = await this.infer(src, false);
    if (tta) {
      const rawFlip = await this.infer(src, true);
      for (let i = 0; i < raw.length; i++) raw[i] = (raw[i]! + rawFlip[i]!) / 2;
    }
    return raw;
  }

  /**
   * Raw output → uint8 alpha at model resolution: (optional sigmoid → min-max stretch) →
   * hysteresis → black-point lift. BiRefNet emits logits (sigmoid first); bria-rmbg-2.0 / BEN2
   * emit a probability-like map (no sigmoid).
   */
  private postprocess(raw: Float32Array): Buffer {
    let mask = normalizeMask(raw, this.spec.needsSigmoid);
    // Alpha black-point lift: clamp low-alpha noise to 0 and rescale the rest, to kill the faint
    // background haze transformer mattes leave on flat backgrounds. Env `BG_ALPHA_FLOOR` overrides.
    const floor = Math.max(0, Math.min(0.99, envNumber('BG_ALPHA_FLOOR', this.spec.alphaFloor ?? 0)));
    // Confidence-hysteresis cleanup: drop connected regions that never reach a high-confidence
    // seed (removes floating "ghost panel" blobs while keeping soft edges connected to the
    // subject). Connectivity threshold ("low") is the floor. Env `BG_HYST_SEED` overrides.
    const seed = Math.max(0, Math.min(1, envNumber('BG_HYST_SEED', this.spec.hysteresisSeed ?? 0)));
    if (seed > 0) mask = hysteresisCleanup(mask, SIZE, SIZE, Math.max(floor, 0.02), seed);
    return maskToAlphaBytes(mask, floor);
  }
}

/** A numeric env override; `fallback` when the variable is unset or empty. */
function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  return v != null && v !== '' ? Number(v) : fallback;
}

/**
 * Resize the SIZE² alpha back to the original dimensions. NOTE: sharp processes in sRGB,
 * so a 1-channel raw input comes back as 3 channels — read with the real stride.
 */
async function resizeMask(alpha: Buffer, width: number, height: number): Promise<{ data: Buffer; stride: number }> {
  const { data, info } = await sharp(alpha, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, stride: info.channels };
}

/** RGBA PNG = the oriented RGB the model saw + the mask as alpha. */
function composeRgba(src: OrientedRgb, mask: { data: Buffer; stride: number }): Promise<Buffer> {
  const { width, height } = src;
  const pixels = width * height;
  const rgba = Buffer.allocUnsafe(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    rgba[p * 4] = src.data[p * 3]!;
    rgba[p * 4 + 1] = src.data[p * 3 + 1]!;
    rgba[p * 4 + 2] = src.data[p * 3 + 2]!;
    rgba[p * 4 + 3] = mask.data[p * mask.stride]!;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
