/**
 * Integration tests for `restart` (runtime.reload) correctness, over the REAL tool
 * registrations on an in-memory MCP transport (no network, no cost):
 *
 *  - reload is ATOMIC: a config that fails to apply (missing token file, empty HTTP
 *    auth secret) leaves config, gateway, tokens and auth exactly as they were;
 *  - a successful reload re-derives what was computed at registration time: the
 *    `generate_image` schema follows the new gateway, gated tools (generate_video)
 *    appear/disappear, and the client gets `notifications/tools/list_changed`;
 *  - generate_image ICO uses the LIVE gateway (not the one captured at registration)
 *    and renders square by default even when the configured default aspect is 4:3.
 *
 * `AIR_MCP_CONFIG` points `loadConfig()` at a temp file, so the real config.json is
 * never read. It must be set BEFORE the src modules load — hence dynamic imports.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import type { Gateway, ImageGenParams, ImageGenResult } from '../src/gateways/types.js';

const dir = mkdtempSync(join(tmpdir(), 'air-reload-'));
const cfgPath = join(dir, 'config.json');
process.env.AIR_MCP_CONFIG = cfgPath;
const { runtime } = await import('../src/state/runtime.js');
const { buildServer } = await import('../src/server.js');

/** Write a config file (inline tokens; no file logging; no bg model; no network on apply). */
function writeConfig(overrides: Record<string, unknown>): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      gateway: 'fal',
      token: { type: 'inline', value: 'key-id:key-secret' },
      output: { dir: join(dir, 'out'), inlinePreview: false, previewMaxBytes: 1024 },
      logging: { policy: 'none' },
      // Krea 2 exposes an aspect_ratio enum (incl. 16:9), so the schema carries `aspect_ratio`.
      image: { model: 'krea/v2/medium/text-to-image', async: false },
      backgroundRemoval: { model: 'none', executionProvider: 'cpu', modelsDir: 'models' },
      mistral: { token: { type: 'inline', value: 'mistral-key' } },
      ...overrides,
    }),
  );
}

let client: Client;
let listChanged = 0;

async function toolNames(): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}
async function imageSchemaKeys(): Promise<string[]> {
  const t = (await client.listTools()).tools.find((x) => x.name === 'generate_image')!;
  return Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
}

before(async () => {
  writeConfig({});
  await runtime.init();
  const server = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'reload-test', version: '1.0.0' });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  await server.connect(serverT);
  await client.connect(clientT);
});

after(async () => {
  await client?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime.reload is atomic', () => {
  it('a config whose token file is missing leaves the previous configuration fully active', async () => {
    const before = { config: runtime.config, gateway: runtime.gateway, token: runtime.token, auth: runtime.httpAuthToken };
    writeConfig({ gateway: 'edenai', token: { type: 'file', value: join(dir, 'no-such-token.txt') } });
    const res = await runtime.reload();
    assert.equal(res.ok, false);
    assert.match(res.message, /Token file not found.*previous configuration is still active/);
    assert.equal(runtime.config, before.config, 'config not swapped');
    assert.equal(runtime.config.gateway, 'fal');
    assert.equal(runtime.gateway, before.gateway, 'gateway not swapped');
    assert.equal(runtime.token, before.token);
    assert.equal(runtime.httpAuthToken, before.auth);
  });

  it('an HTTP auth token that resolves EMPTY fails the reload (never silently "no auth")', async () => {
    writeConfig({ http: { authToken: { type: 'inline', value: 'secret-1' } } });
    assert.equal((await runtime.reload()).ok, true);
    assert.equal(runtime.httpAuthToken, 'secret-1');

    writeConfig({ http: { authToken: { type: 'inline', value: '   ' } } });
    const res = await runtime.reload();
    assert.equal(res.ok, false);
    assert.match(res.message, /empty/i);
    assert.equal(runtime.httpAuthToken, 'secret-1', 'auth still enforced with the previous secret');
  });
});

describe('a successful reload refreshes registration-time tool state', () => {
  it('generate_image schema + gated generate_video follow the new gateway, and the client is notified', async () => {
    writeConfig({});
    assert.equal((await runtime.reload()).ok, true);
    assert.ok((await toolNames()).includes('generate_video'), 'fal supports text-to-video');
    assert.ok(!(await imageSchemaKeys()).includes('n'));
    assert.ok(!(await toolNames()).includes('remove_background'), 'no bg model → hidden');

    const notified = listChanged;
    writeConfig({ gateway: 'edenai', image: { model: 'image/generation/openai/dall-e-3', async: false } });
    assert.equal((await runtime.reload()).ok, true);
    assert.ok((await imageSchemaKeys()).includes('n'), 'Eden-only `n` appears after switching to Eden');
    assert.equal(listChanged, notified + 1, 'exactly ONE tools/list_changed per reload (several tools change; the SDK debounces them)');

    writeConfig({ gateway: 'mistral', image: { model: 'mistral-medium-latest', async: false } });
    assert.equal((await runtime.reload()).ok, true);
    assert.ok(!(await toolNames()).includes('generate_video'), 'Mistral has no text-to-video → hidden');
    assert.ok((await imageSchemaKeys()).includes('temperature'), 'Mistral sampling controls appear');
    assert.ok(!(await imageSchemaKeys()).includes('n'), 'Eden-only `n` gone again');

    writeConfig({});
    assert.equal((await runtime.reload()).ok, true);
    assert.ok((await toolNames()).includes('generate_video'), 'back on fal → generate_video listed again');
  });
});

describe('generate_image ICO uses the live gateway and renders square', () => {
  let lastParams: ImageGenParams | undefined;
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: '#3366ff' } }).png().toBuffer();
  const fake = (tiers: string[]): Gateway => ({
    id: 'openrouter',
    capabilities: {
      imageGeneration: true, textToVideo: false, imageToVideo: false, imageAspectRatioParam: true,
      imageResolutionParam: true, listsImageModels: false, listsVideoModels: false,
      multiReferenceImages: false, imageReferenceImages: false,
    },
    listImageModels: async () => ({ models: [], source: 'manual', warnings: [] }),
    imageAspectRatios: () => ({ values: ['1:1', '4:3', '16:9'], source: 'fallback' }),
    imageResolutions: () => ({ values: tiers, source: 'fallback' }),
    async generateImage(p: ImageGenParams): Promise<ImageGenResult> {
      lastParams = p;
      return { images: [{ bytes: await png(1024, 1024), mimeType: 'image/png' }], modelUsed: 'fake', raw: {} };
    },
  });

  before(() => {
    // Configured default aspect is 4:3 (the wizard default) — an icon must still be square.
    (runtime.config.image as { defaultAspectRatio: string | null }).defaultAspectRatio = '4:3';
    runtime.config.image.async = false;
  });

  it('asks the CURRENT gateway for its tiers (a restart swapped it after registration)', async () => {
    runtime.gateway = fake(['1K', '2K']); // the tool was registered against the fal gateway
    const r = (await client.callTool({ name: 'generate_image', arguments: { prompt: 'an icon', output_format: 'ico', width: 256 } })) as { isError?: boolean };
    assert.equal(r.isError, undefined);
    assert.equal(lastParams?.resolution, '1K', 'tier picked from the live gateway');
  });

  it('defaults to a square render (1:1, width = height) despite a 4:3 default', async () => {
    runtime.gateway = fake([]);
    await client.callTool({ name: 'generate_image', arguments: { prompt: 'an icon', output_format: 'ico', width: 256 } });
    assert.equal(lastParams?.aspectRatio, '1:1');
    assert.equal(lastParams?.width, 256);
    assert.equal(lastParams?.height, 256);
  });

  it('an explicit aspect_ratio is still honoured (then padded square)', async () => {
    runtime.gateway = fake([]);
    await client.callTool({ name: 'generate_image', arguments: { prompt: 'an icon', output_format: 'ico', width: 256, aspect_ratio: '16:9' } });
    assert.equal(lastParams?.aspectRatio, '16:9');
    assert.equal(lastParams?.height, 144);
  });
});
