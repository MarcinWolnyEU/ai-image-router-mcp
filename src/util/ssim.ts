/**
 * Structural Similarity (SSIM) on a single luma channel — a pure, dependency-free
 * helper used by the GIF palette-size knee search (`media/gif.ts`) to score how
 * faithfully a quantized variant reproduces the source frames.
 *
 * Computed over non-overlapping windows (default 8×8, partial windows at the right
 * and bottom edges) and averaged. This is the mean-window form (not Gaussian-
 * weighted); for relative comparison between palette sizes it is more than enough,
 * and it is cheap enough to run on every candidate. Constants are the standard
 * SSIM defaults for 8-bit data (C1=(0.01·255)², C2=(0.03·255)²).
 */
export function ssimLuma(a: Float32Array, b: Float32Array, width: number, height: number, win = 8): number {
  if (a.length !== b.length || a.length !== width * height) {
    throw new Error(`ssimLuma: size mismatch (a=${a.length}, b=${b.length}, w*h=${width * height})`);
  }
  if (width <= 0 || height <= 0) return 1;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  for (let by = 0; by < height; by += win) {
    const h = Math.min(win, height - by);
    for (let bx = 0; bx < width; bx += win) {
      const w = Math.min(win, width - bx);
      const n = w * h;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < h; y++) {
        const row = (by + y) * width + bx;
        for (let x = 0; x < w; x++) {
          const va = a[row + x]!;
          const vb = b[row + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const ssim = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += ssim;
      windows += 1;
    }
  }
  return windows ? total / windows : 1;
}
