/**
 * LIVE, BILLED contract test: fal reference-image (image_style_references) generation.
 *
 * Krea 2 is the only wired fal image family whose text-to-image endpoint accepts image
 * conditioning, via `image_style_references[]` whose item shape is `{ image_url, strength? }`
 * (NOT `{ url }` — a bug we fixed). This drives the real FalGateway.generateImage with a
 * reference on BOTH Krea sizes and asserts the request body uses the correct `image_url` key
 * and that generation succeeds.
 *
 * Run: `npm run integration:paid`. Requires a live fal token. Saves artifacts to `output/`.
 * Excluded from `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { createGateway } from '../../src/gateways/registry.js';
import type { Logger } from '../../src/logging/logger.js';
import { DEFAULT_TOKEN_FILES } from '../../src/config/schema.js';
import { buildFalImageInput } from '../../src/gateways/fal.js';
import { resolveReferenceImages } from '../../src/util/inputs.js';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'output');
const token = process.env.FAL_TOKEN ?? readFileSync(DEFAULT_TOKEN_FILES.fal, 'utf8').trim();
if (!token) throw new Error('fal token missing; set FAL_TOKEN or create "fal ai token.txt"');

// The reference-capable fal image models (from the per-model spec map).
const REF_MODELS = ['krea/v2/medium/text-to-image', 'krea/v2/large/text-to-image'];

const logger = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

describe('fal.ai live reference-image generation (billed)', () => {
  it('maps reference_images to image_style_references[{image_url}] and generates on every Krea model', async () => {
    await mkdir(OUT_DIR, { recursive: true });

    // A real reference image (256×256 PNG).
    const refPng = await sharp({
      create: { width: 256, height: 256, channels: 4, background: { r: 42, g: 157, b: 143, alpha: 1 } },
    }).png().toBuffer();
    const refPath = join(OUT_DIR, 'ref-256.png');
    await writeFile(refPath, refPng);

    // Resolve through the real tool path (local path → bytes) and verify the field mapping.
    const { references } = await resolveReferenceImages([refPath]);

    for (const model of REF_MODELS) {
      // Unit-level: the emitting request uses image_url, never url.
      const body = buildFalImageInput({ model, prompt: 'x', references } as never);
      const refs = body['image_style_references'] as { image_url: string }[];
      assert.equal(refs.length, 1);
      assert.ok(refs[0]!.image_url, 'must carry image_url');
      assert.ok(!('url' in refs[0]! as object), 'must not use the wrong `url` key');

      // Live: generate with the reference.
      const gw = createGateway('fal', token, logger);
      const t0 = Date.now();
      const res = await gw.generateImage({
        prompt: 'same flat minimal logo style, a bold blue rounded-square icon with a white checkmark, no text, centered',
        model,
        aspectRatio: '1:1',
        resolution: null,
        references,
      });
      assert.ok(res.images.length > 0, `${model} returned no images: ${JSON.stringify(res.raw).slice(0, 200)}`);
      assert.equal(res.images[0]!.mimeType, 'image/png');

      // Save the artifact for inspection.
      const out = join(OUT_DIR, `paid-fal-ref-${model.split('/').join('-')}-${Date.now()}.png`);
      await writeFile(out, res.images[0]!.bytes);
      assert.ok(existsSync(out));
      // eslint-disable-next-line no-console
      console.log(`✅ ${model}: ${res.images[0]!.mimeType} ${res.images[0]!.bytes.length} bytes (${Date.now() - t0}ms)\n   ${out}`);
    }
  });
});
