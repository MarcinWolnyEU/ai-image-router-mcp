/**
 * Pure mask-postprocessing helpers for the background-removal pipeline (used by `birefnet.ts`).
 * Kept separate from the ONNX session so they're unit-testable without the native addon.
 */

/**
 * Raw model output → 0..1 matte: optional sigmoid (BiRefNet emits logits), then a min-max
 * stretch (left as-is when the map is flat). Returns a new array.
 */
export function normalizeMask(raw: Float32Array, useSigmoid: boolean): Float32Array {
  const mask = new Float32Array(raw.length);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const s = useSigmoid ? 1 / (1 + Math.exp(-raw[i]!)) : raw[i]!;
    mask[i] = s;
    if (s < mn) mn = s;
    if (s > mx) mx = s;
  }
  const range = mx - mn;
  if (range > 1e-6) for (let i = 0; i < mask.length; i++) mask[i] = (mask[i]! - mn) / range;
  return mask;
}

/** 0..1 matte → uint8 alpha, applying the optional black-point lift (`floor` ≤ 0 = none). */
export function maskToAlphaBytes(mask: Float32Array, floor: number): Buffer {
  const out = Buffer.allocUnsafe(mask.length);
  for (let i = 0; i < mask.length; i++) {
    let v = mask[i]!;
    if (floor > 0) v = v <= floor ? 0 : (v - floor) / (1 - floor);
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return out;
}

/** Horizontally mirror a width×height scalar field. Returns a new array. */
export function hflipPlane(a: Float32Array, width: number, height: number): Float32Array {
  const o = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) o[row + x] = a[row + (width - 1 - x)]!;
  }
  return o;
}

/** Scratch buffers shared across every region of one `hysteresisCleanup` call (no per-region allocation). */
interface FloodWorkspace {
  visited: Uint8Array;
  /** Pixels belonging to a region that reached a seed. */
  keep: Uint8Array;
  stack: Int32Array;
  /** Pixels of the region currently being flooded. */
  comp: Int32Array;
}

/** Push pixel `j` if it is unvisited and ≥ `low` (marking it visited); returns the new stack pointer. */
function pushIfOpen(ws: FloodWorkspace, a: Float32Array, low: number, j: number, sp: number): number {
  if (ws.visited[j] || !(a[j]! >= low)) return sp; // `!(>=)`, not `<`: a NaN pixel is never open
  ws.visited[j] = 1;
  ws.stack[sp] = j;
  return sp + 1;
}

/** Push the open 4-neighbours (left, right, up, down) of pixel `i`; returns the new stack pointer. */
function pushOpenNeighbors(ws: FloodWorkspace, a: Float32Array, width: number, height: number, low: number, i: number, sp: number): number {
  const x = i % width;
  const y = (i / width) | 0;
  if (x > 0) sp = pushIfOpen(ws, a, low, i - 1, sp);
  if (x < width - 1) sp = pushIfOpen(ws, a, low, i + 1, sp);
  if (y > 0) sp = pushIfOpen(ws, a, low, i - width, sp);
  if (y < height - 1) sp = pushIfOpen(ws, a, low, i + width, sp);
  return sp;
}

/**
 * Flood the 4-connected region of pixels ≥ `low` that contains `start`, and mark the whole
 * region in `ws.keep` only if some pixel in it reaches `high`.
 */
function keepRegionIfSeeded(ws: FloodWorkspace, a: Float32Array, width: number, height: number, low: number, high: number, start: number): void {
  const { stack, comp } = ws;
  let sp = 0;
  let cp = 0;
  stack[sp++] = start;
  ws.visited[start] = 1;
  let sawSeed = false;
  while (sp > 0) {
    const i = stack[--sp]!;
    comp[cp++] = i;
    if (a[i]! >= high) sawSeed = true;
    sp = pushOpenNeighbors(ws, a, width, height, low, i, sp);
  }
  if (sawSeed) for (let k = 0; k < cp; k++) ws.keep[comp[k]!] = 1;
}

/**
 * Confidence-hysteresis cleanup. Treats the mask as 4-connected regions of pixels ≥ `low`, and
 * zeroes any whole region that never reaches a high-confidence "seed" pixel (≥ `high`). This
 * removes floating low-confidence blobs (e.g. the rectangular "ghost panels" a transformer matte
 * leaves on flat backgrounds) while preserving soft edges (connected back to the subject's solid
 * core) and any confidently-segmented detached subject. Returns a new array; input is untouched.
 *
 * Note: a genuinely detached real subject the model segmented *weakly* (peak < `high`) will be
 * dropped — that's the intended trade (it's near-unusable anyway), but callers should gate this
 * behind a per-model flag rather than apply it universally.
 */
export function hysteresisCleanup(
  a: Float32Array,
  width: number,
  height: number,
  low: number,
  high: number,
): Float32Array {
  const n = width * height;
  const ws: FloodWorkspace = { visited: new Uint8Array(n), keep: new Uint8Array(n), stack: new Int32Array(n), comp: new Int32Array(n) };
  for (let start = 0; start < n; start++) {
    if (ws.visited[start] || a[start]! < low) continue;
    keepRegionIfSeeded(ws, a, width, height, low, high, start);
  }
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = ws.keep[i] ? a[i]! : 0;
  return o;
}
