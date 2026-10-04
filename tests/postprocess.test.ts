/**
 * Unit tests for the background-removal mask postprocessing helpers
 * (src/bgremoval/postprocess.ts): horizontal flip and confidence-hysteresis cleanup.
 *
 * Run: `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hflipPlane, hysteresisCleanup } from '../src/bgremoval/postprocess.js';

describe('hflipPlane', () => {
  it('mirrors columns within each row', () => {
    // 3×2 field: row0 = [1,2,3], row1 = [4,5,6]
    const a = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const f = hflipPlane(a, 3, 2);
    assert.deepEqual([...f], [3, 2, 1, 6, 5, 4]);
  });
  it('is its own inverse', () => {
    const a = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    assert.deepEqual([...hflipPlane(hflipPlane(a, 2, 2), 2, 2)], [...a]);
  });
});

describe('hysteresisCleanup', () => {
  const low = 0.08;
  const high = 0.5;
  // Derive the expected array from the input's own float32 values (zeroing the dropped indices),
  // so kept pixels compare exactly and we don't trip on float32-vs-double rounding (0.4 etc.).
  const expectDropped = (a: Float32Array, dropped: number[]): number[] => {
    const e = Float32Array.from(a);
    for (const i of dropped) e[i] = 0;
    return [...e];
  };

  it('keeps a region with a high-confidence seed and its connected soft tail', () => {
    // 4×1: a strong pixel (1.0) with a fading-but-connected tail down to ~low.
    const a = Float32Array.from([1.0, 0.4, 0.1, 0.0]);
    const out = hysteresisCleanup(a, 4, 1, low, high);
    assert.deepEqual([...out], expectDropped(a, [])); // all ≥low pixels connect to the seed → kept
  });

  it('drops a disconnected region that never reaches the seed', () => {
    // 5×1: strong blob [1.0,0.6] | gap (0) | weak ghost blob [0.3,0.3]
    const a = Float32Array.from([1.0, 0.6, 0.0, 0.3, 0.3]);
    const out = hysteresisCleanup(a, 5, 1, low, high);
    assert.deepEqual([...out], expectDropped(a, [3, 4])); // ghost blob has no seed → zeroed
  });

  it('keeps a disconnected region that DOES reach the seed', () => {
    const a = Float32Array.from([1.0, 0.0, 0.9, 0.2]);
    const out = hysteresisCleanup(a, 4, 1, low, high);
    assert.deepEqual([...out], expectDropped(a, [])); // second blob peaks ≥high → kept
  });

  it('treats connectivity as 4-connected (diagonal gap is not connected)', () => {
    // 2×2: seed at (0,0), weak pixel at (1,1) diagonally — only diagonal touch, below-low elsewhere.
    //   [1.0, 0.0]
    //   [0.0, 0.3]
    const a = Float32Array.from([1.0, 0.0, 0.0, 0.3]);
    const out = hysteresisCleanup(a, 2, 2, low, high);
    assert.deepEqual([...out], expectDropped(a, [3])); // (1,1) not 4-connected to the seed → dropped
  });
});
