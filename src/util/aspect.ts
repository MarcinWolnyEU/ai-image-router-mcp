const RATIO_RE = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/;

/** Parse an aspect ratio string ("4:3", "16:9", "2.35:1", "9:19.5") to a w/h ratio; 1 for missing/unparseable. */
export function aspectRatioValue(ratio: string | null | undefined): number {
  if (!ratio) return 1;
  const m = RATIO_RE.exec(ratio.trim());
  if (!m) return 1;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return h > 0 ? w / h : 1;
}

/**
 * The ratio from `candidates` closest to `target` (w/h), compared on a log scale so 2:1 and
 * 1:2 are equally far from 1:1. Unparseable candidates ("auto") are skipped; null when none remain.
 */
export function nearestAspectRatio(target: number, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!RATIO_RE.test(c.trim())) continue; // "auto" etc.
    const dist = Math.abs(Math.log(aspectRatioValue(c) / target));
    if (dist < bestDist) [best, bestDist] = [c, dist];
  }
  return best;
}
