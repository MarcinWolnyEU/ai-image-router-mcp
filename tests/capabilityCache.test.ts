/**
 * Startup no longer waits on the network for OpenRouter's per-model capabilities. Every stdio
 * spawn (Vibe CLI spawns one PER TOOL CALL) used to block up to 12 s in `prepare()`; now the
 * answer is persisted (`src/state/capabilityCache.ts`) and a later start uses it instantly,
 * refreshing in the background when it is getting old. Stubbed `fetch`, temp cache file.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCapabilityCache } from '../src/state/capabilityCache.js';
import { OpenRouterGateway } from '../src/gateways/openrouter.js';
import type { Logger } from '../src/logging/logger.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MODEL = 'openai/gpt-image-2.5';
const ENDPOINTS = { id: MODEL, endpoints: [{ provider_name: 'OpenAI', supported_parameters: { quality: { type: 'enum', values: ['low', 'high'] } } }] };
let fetches = 0;
function stubEndpoints(): void {
  fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify(ENDPOINTS), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'air-caps-')), 'capabilities.json');
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('FileCapabilityCache', () => {
  it('persists entries across instances and honours a max age', async () => {
    const file = tmpFile();
    let now = 1000;
    const a = new FileCapabilityCache(file, () => now);
    a.set('k', { v: 1 });
    await a.flushed();
    const b = new FileCapabilityCache(file, () => now);
    assert.deepEqual(b.get('k', 60_000)?.value, { v: 1 });
    now = 1000 + 61_000;
    assert.equal(b.get('k', 60_000), undefined, 'older than the max age → a miss');
  });

  it('a corrupt or missing file is an empty cache, never an error', () => {
    const file = tmpFile();
    writeFileSync(file, '{not json');
    assert.equal(new FileCapabilityCache(file).get('k', 1e9), undefined);
    assert.equal(new FileCapabilityCache(join(tmpdir(), 'no-such-dir-air', 'x.json')).get('k', 1e9), undefined);
  });
});

describe('OpenRouterGateway.prepare with a capability cache', () => {
  it('a cold start fetches once and stores the answer', async () => {
    stubEndpoints();
    const cache = new FileCapabilityCache(tmpFile());
    const gw = new OpenRouterGateway('k', logger);
    await gw.prepare({ imageModel: MODEL, cache });
    assert.equal(fetches, 1);
    assert.ok(cache.get(`openrouter:image-caps:${MODEL}`, 1e9));
  });

  it('a warm start answers from the cache with NO network call', async () => {
    const file = tmpFile();
    stubEndpoints();
    const first = new FileCapabilityCache(file);
    await new OpenRouterGateway('k', logger).prepare({ imageModel: MODEL, cache: first });
    await first.flushed();

    stubEndpoints();
    const gw = new OpenRouterGateway('k', logger);
    await gw.prepare({ imageModel: MODEL, cache: new FileCapabilityCache(file) });
    assert.equal(fetches, 0, 'startup did not touch the network');
    assert.deepEqual(gw.imageQualityLevels(MODEL)?.values, ['low', 'high'], 'the model-specific schema is available immediately');
  });

  it('an aging entry is used at once and refreshed in the background for the next start', async () => {
    const file = tmpFile();
    let now = 0;
    stubEndpoints();
    const seed = new FileCapabilityCache(file, () => now);
    await new OpenRouterGateway('k', logger).prepare({ imageModel: MODEL, cache: seed });
    await seed.flushed();

    now = 2 * 60 * 60_000; // two hours later: still valid, but due for a refresh
    stubEndpoints();
    const cache = new FileCapabilityCache(file, () => now);
    const gw = new OpenRouterGateway('k', logger);
    await gw.prepare({ imageModel: MODEL, cache });
    assert.ok(gw.imageQualityLevels(MODEL), 'answered from the cache');
    await settle();
    assert.equal(fetches, 1, 'one background refresh');
    assert.equal(cache.get(`openrouter:image-caps:${MODEL}`, 1e9)?.at, now, 'the refreshed answer was stored');
  });
});
