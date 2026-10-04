/**
 * Validate local BiRefNet background removal (downloads the model on first run).
 *   npx tsx scripts/bg-test.ts [birefnet-general|birefnet-massive] [inputFileInOutput]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../src/logging/logger.js';
import { BiRefNetRemover } from '../src/bgremoval/birefnet.js';
import { saveMedia } from '../src/util/files.js';
import type { BgModelKey } from '../src/bgremoval/models.js';
import { findProjectRoot } from './root.mjs';

const ROOT = findProjectRoot(import.meta.url);
const model = (process.argv[2] as BgModelKey) ?? 'birefnet-general';
const logger = new Logger('none', 'logs');
await logger.init();

const remover = new BiRefNetRemover(model, 'auto', 'models', logger);
console.error(`init ${model} (downloads ~930 MB if missing)…`);
await remover.init((p) => console.error('  ', p.phase, p.pct ?? '', p.message));
console.error('execution provider:', remover.activeEP);

const dir = join(ROOT, 'output');
const pick = process.argv[3] ?? readdirSync(dir).find((f) => /leaf/i.test(f) && /\.(png|jpe?g)$/i.test(f));
if (!pick) throw new Error('no input image found');
const input = readFileSync(join(dir, pick));
console.error('input:', pick, input.length, 'bytes');

const t = Date.now();
const png = await remover.removeBackground(input);
console.error(`removeBackground done in ${Date.now() - t} ms -> ${png.length} bytes`);
const saved = await saveMedia(dir, png, 'png', `nobg-${model}`);
console.error('saved', saved.path);
