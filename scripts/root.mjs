// Shared helper for the dev/CI harness scripts: resolve the project root from a
// script's own location (via import.meta.url) rather than process.cwd(), so the
// scripts work no matter which directory they're invoked from (e.g. `scripts/`).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from the directory containing `metaUrl` until a `package.json` is found
 * (the project root). Falls back to the start dir if none is found.
 */
export function findProjectRoot(metaUrl) {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}
