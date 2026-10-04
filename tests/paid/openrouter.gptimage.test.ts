/**
 * LIVE, BILLED: OpenRouter `openai/gpt-image-2.5-sunburst` through the real gateway.
 * Excluded from `npm test` (run with `npm run integration:paid`). Uses the cheapest
 * `quality:"low"` (~$0.005/image, measured 2026-09-09). Fails fast if the
 * OpenRouter token file is missing. Artifacts are saved to `output/` for inspection.
 *
 * What it pins down (all verified live on 2026-09-09):
 *  - the capability API lists quality/background/n/input_references and NO resolution;
 *  - `resolution` is not sent for this model and the native full-size output is kept;
 *  - a transparent background is refused before any request (no charge);
 *  - the result reports the image type and pixel size.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenRouterGateway } from '../../src/gateways/openrouter.js';
import { PROJECT_ROOT } from '../../src/config/paths.js';
import { DEFAULT_TOKEN_FILES } from '../../src/config/schema.js';
import { describeImage, imageInfo } from '../../src/util/files.js';

const MODEL = 'openai/gpt-image-2.5-sunburst';
const tokenPath = join(PROJECT_ROOT, DEFAULT_TOKEN_FILES.openrouter);
const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as ConstructorParameters<typeof OpenRouterGateway>[1];

describe('LIVE OpenRouter gpt-image-2.5-sunburst', () => {
  let gw: OpenRouterGateway;
  before(() => {
    assert.ok(existsSync(tokenPath), `OpenRouter token file missing: ${tokenPath}`);
    gw = new OpenRouterGateway(readFileSync(tokenPath, 'utf8').trim(), logger);
  });

  it('capability API: quality enum, background auto|opaque, no resolution tier', async () => {
    const caps = await gw.fetchImageCapabilities(MODEL);
    assert.ok(caps, 'capabilities must load');
    assert.deepEqual(gw.imageQualityLevels(MODEL)?.values, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(gw.imageBackgroundModes(MODEL)?.values, ['auto', 'opaque']);
    assert.deepEqual(gw.imageResolutions(MODEL), { values: [], source: 'api' });
    assert.ok(gw.imageAspectRatios(MODEL).values.includes('16:9'));
  });

  it('transparent background is refused before any request (nothing billed)', async () => {
    await assert.rejects(gw.generateImage({ prompt: 'a red ball', model: MODEL, background: 'transparent', quality: 'low' }), /cannot produce a transparent background/);
  });

  it('generates at native full size with quality:low; resolution tier dropped with a note; type + size reported', async () => {
    const res = await gw.generateImage({ prompt: 'A tiny flat-design orange circle on a white background, minimal', model: MODEL, aspectRatio: '1:1', resolution: '512', quality: 'low' });
    assert.equal(res.images.length, 1);
    const img = res.images[0]!;
    assert.equal(img.mimeType, 'image/png');
    const info = await imageInfo(img.bytes);
    assert.ok(info && info.width >= 1024 && info.height >= 1024, `expected a native ≥1024px render, got ${info?.width}×${info?.height}`);
    assert.ok(res.warnings?.some((w) => /"512" was not sent/.test(w)));
    assert.ok(typeof res.cost === 'number' && res.cost < 0.05, `cost ${res.cost}`);
    const outDir = join(PROJECT_ROOT, 'output');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `paid-gptimage25-sunburst-low-1x1.png`);
    writeFileSync(file, img.bytes);
    console.log(`saved ${file}: ${await describeImage(img.bytes, img.mimeType)} — cost $${res.cost}`);
  });
});
