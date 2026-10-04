import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEADERBOARDS_DIR } from '../config/paths.js';

export type LeaderboardKind = 'text-to-image' | 'image-to-video' | 'text-to-video';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  creator: string;
  elo: number;
  released: string;
  openWeights?: boolean;
  aliases: string[];
}

export interface Leaderboard {
  leaderboard: LeaderboardKind;
  title: string;
  source: string;
  captured: string;
  models: LeaderboardEntry[];
}

const cache = new Map<LeaderboardKind, Leaderboard>();

export async function loadLeaderboard(kind: LeaderboardKind): Promise<Leaderboard> {
  const cached = cache.get(kind);
  if (cached) return cached;
  const raw = JSON.parse(await readFile(join(LEADERBOARDS_DIR, `${kind}.json`), 'utf8')) as Leaderboard;
  cache.set(kind, raw);
  return raw;
}

/** Normalise a model id/name for fuzzy comparison (drop separators + case). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_\-./:]+/g, '');
}

/**
 * Whether a normalised alias matches a normalised candidate. The alias must
 * align to the END of the candidate (exact, or candidate ends with alias).
 *
 * This is deliberately variant-aware. A provider/namespace prefix is always a
 * *prefix* (`bytedance/seedance-2.0` → `bytedanceseedance20`) and is ignored,
 * so cross-gateway ids still match. A quality variant is always a *suffix*
 * (`-fast`/`-lite`/`-pro`/`-standard`) — anchoring to the end means a base
 * alias like `seedance20` no longer matches `seedance20fast`, so each variant
 * keeps its own rank instead of all collapsing onto the highest-ranked one.
 * (List both the bare and provider-prefixed forms in `aliases`; a terser
 * candidate than the alias is matched via the bare form, not a reverse scan.)
 */
function aliasMatches(candidate: string, alias: string): boolean {
  return candidate === alias || candidate.endsWith(alias);
}

/**
 * Find the best (lowest-rank) leaderboard entry that matches a gateway model.
 */
export function matchLeaderboard(lb: Leaderboard, modelId: string, modelName?: string): LeaderboardEntry | null {
  const candidates = [norm(modelId), norm(modelName ?? '')].filter((c) => c.length > 0);
  let best: LeaderboardEntry | null = null;
  for (const entry of lb.models) {
    for (const alias of entry.aliases) {
      const a = norm(alias);
      if (a.length < 3) continue;
      const hit = candidates.some((c) => aliasMatches(c, a));
      if (hit) {
        if (!best || entry.rank < best.rank) best = entry;
        break;
      }
    }
  }
  return best;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** Human label like "3rd best text-to-image as of 2026-06-05 (Nano Banana 2)". */
export function leaderboardHint(lb: Leaderboard, entry: LeaderboardEntry): string {
  return `${ordinal(entry.rank)} best ${lb.title.toLowerCase()} as of ${lb.captured} (${entry.name})`;
}
