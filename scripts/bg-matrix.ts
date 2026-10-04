/**
 * Run the 5 finegrain test images through ONE background-removal model.
 *   npx tsx scripts/bg-matrix.ts <modelKey> <outDir> [ep]
 * Writes <outDir>/<sameBasename>.png for each input. One process per model keeps GPU/host
 * memory clean between the big BiRefNet/bria sessions.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../src/logging/logger.js';
import { BiRefNetRemover } from '../src/bgremoval/birefnet.js';
import type { BgModelKey } from '../src/bgremoval/models.js';

const model = process.argv[2] as BgModelKey;
const outDir = process.argv[3]!;
const ep = process.argv[4] ?? 'webgpu';
if (!model || !outDir) throw new Error('usage: bg-matrix.ts <modelKey> <outDir> [ep]');

const DOCS = 'V:/MCP/finegrain-box-segmenter-onnyx/docs';
const IMAGES = [
  '01-flyaway-hair-portrait.png',
  '02-refraction-glass-straw.png',
  '03-oilpaint-rooster-flowers.png',
  '04-isometric-sunken-city-battle.png',
  '05-2d-panda-burger-crowns.png',
];

const logger = new Logger('none', 'logs');
await logger.init();
mkdirSync(outDir, { recursive: true });

const remover = new BiRefNetRemover(model, ep, 'models', logger);
console.error(`[${model}] init on ${ep} (downloads if missing)…`);
await remover.init((p) => console.error('  ', p.phase, p.pct ?? '', p.message));
console.error(`[${model}] active EP = ${remover.activeEP}`);

for (const name of IMAGES) {
  const input = readFileSync(join(DOCS, name));
  const t = Date.now();
  const png = await remover.removeBackground(input);
  writeFileSync(join(outDir, name), png);
  console.error(`[${model}] ${name} -> ${png.length} B in ${Date.now() - t} ms`);
}
console.error(`[${model}] DONE -> ${outDir}`);
