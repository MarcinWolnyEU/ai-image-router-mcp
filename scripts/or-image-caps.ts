/**
 * Print what an OpenRouter image model ACTUALLY accepts, from the live capability
 * API (`GET /api/v1/images/models/{id}/endpoints` → `supported_parameters`), the
 * same record the gateway uses to build requests. No generation, no cost.
 *
 *   npx tsx scripts/or-image-caps.ts openai/gpt-image-2.5-sunburst [more model ids…]
 *   npx tsx scripts/or-image-caps.ts --list          # every image model + its params
 *
 * Reads the key from `openrouter token.txt` (or OPENROUTER_API_KEY).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';
import { DEFAULT_TOKEN_FILES } from '../src/config/schema.js';
import { getJson } from '../src/util/http.js';
import { parseImageModelEndpoints, type ImageParamDescriptor } from '../src/gateways/openrouterImages.js';

const BASE = 'https://openrouter.ai/api/v1';
const key = process.env['OPENROUTER_API_KEY'] ?? readFileSync(join(PROJECT_ROOT, DEFAULT_TOKEN_FILES.openrouter), 'utf8').trim();
const headers = { Authorization: `Bearer ${key}` };

const fmt = (d: ImageParamDescriptor): string => (d.type === 'enum' ? d.values.join(' | ') : d.type === 'range' ? `${d.min}..${d.max}` : 'yes');

async function show(model: string): Promise<void> {
  const json = await getJson<unknown>(`${BASE}/images/models/${model}/endpoints`, { headers, retries: 0 });
  const caps = parseImageModelEndpoints(model, json);
  if (!caps) {
    console.log(`${model}: no endpoint records`);
    return;
  }
  console.log(`\n${model}  (providers: ${caps.providers.join(', ') || '?'}; streaming: ${caps.supportsStreaming}; passthrough: ${caps.passthrough.join(', ') || '-'})`);
  const keys = Object.keys(caps.params).sort();
  const width = Math.max(...keys.map((k) => k.length), 10);
  for (const k of keys) console.log(`  ${k.padEnd(width)}  ${fmt(caps.params[k]!)}`);
  for (const k of ['resolution', 'size', 'quality', 'background', 'output_format', 'seed']) {
    if (!(k in caps.params)) console.log(`  ${k.padEnd(width)}  (not advertised${k === 'size' || k === 'output_format' ? ' — may still be forwarded to the provider' : ''})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--list') {
    const data = await getJson<{ data: Array<{ id: string; supported_parameters?: Record<string, unknown> }> }>(`${BASE}/images/models`, { headers, retries: 0 });
    for (const m of data.data) {
      const keys = Object.keys(m.supported_parameters ?? {}).sort();
      console.log(`${m.id.padEnd(48)} ${keys.join(', ')}`);
    }
    return;
  }
  for (const m of args) await show(m);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
