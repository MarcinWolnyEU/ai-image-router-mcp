import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing package.json is found. */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** Absolute path to the project root (works from both `src/` via tsx and `dist/`). */
export const PROJECT_ROOT = findProjectRoot(here);

/** Join one or more segments onto the project root. */
export function fromRoot(...segments: string[]): string {
  return join(PROJECT_ROOT, ...segments);
}

/** Resolve a possibly-relative path against the project root. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

export const CONFIG_PATH = process.env.AIR_MCP_CONFIG
  ? resolvePath(process.env.AIR_MCP_CONFIG)
  : fromRoot('config.json');

export const DATA_DIR = fromRoot('data');
/** Persisted gateway capability lookups (git-ignored), so a server start needn't wait on the network. */
export const CAPABILITY_CACHE_PATH = fromRoot('.cache', 'capabilities.json');
export const LEADERBOARDS_DIR = join(DATA_DIR, 'leaderboards');
export const ASPECT_RATIOS_PATH = join(DATA_DIR, 'aspect-ratios.json');
