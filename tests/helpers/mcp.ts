/**
 * Shared harness for the tests that drive the REAL tool handlers over an in-memory MCP
 * transport (no process spawn, no network, no cost) with a fake gateway:
 *
 *   const h = await startMcpHarness({ gateway: makeFakeGateway({ ... }), clientName: 'x', tmpPrefix: 'air-x-' });
 *   const r = await h.call('generate_image', { prompt: 'a fox' });
 *   assert.match(textOf(r), /…/);
 *   await h.close();               // in after(): closes the client, removes the temp out dir, restores `runtime`
 *
 * Not a `*.test.ts` file, so `node --test` never treats it as a test; it is imported by them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runtime } from '../../src/state/runtime.js';
import { buildServer } from '../../src/server.js';
import { configSchema, type AppConfig, type GatewayId } from '../../src/config/schema.js';
import type { Gateway, GatewayCapabilities } from '../../src/gateways/types.js';

/** One block of a tool result. Open-ended on purpose: tests probe `uri` / `name` / `data` / `_meta`… freely. */
export interface ContentBlock {
  type: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
export interface CallResult {
  content: ContentBlock[];
  isError?: boolean;
}

export const SILENT_LOGGER = { info() {}, error() {}, warn() {}, debug() {} } as unknown as typeof runtime.logger;

/** A tool result's text blocks, newline-joined. */
export const textOf = (r: { content?: ContentBlock[] }): string =>
  (r.content ?? []).map((c) => c.text ?? '').filter(Boolean).join('\n');

/** All `resource_link` blocks of a tool result. */
export const linksOf = (r: { content?: ContentBlock[] }): ContentBlock[] => (r.content ?? []).filter((c) => c.type === 'resource_link');

/** The first `resource_link` block of a tool result, if any. */
export const linkOf = (r: { content?: ContentBlock[] }): ContentBlock | undefined => linksOf(r)[0];

/** `file:///C:/out/a%20b.png` → `C:/out/a b.png` (a leading slash is dropped only before a drive letter). */
export const uriToPath = (uri: string): string => decodeURIComponent(uri.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * A capability matrix with everything off except `imageGeneration`, overridden per test.
 * (Spelling out all nine booleans in every test file was most of the old duplication.)
 */
export function fakeCapabilities(over: Partial<GatewayCapabilities> = {}): GatewayCapabilities {
  return {
    imageGeneration: true,
    textToVideo: false,
    imageToVideo: false,
    imageAspectRatioParam: false,
    imageResolutionParam: false,
    listsImageModels: false,
    listsVideoModels: false,
    multiReferenceImages: false,
    imageReferenceImages: false,
    ...over,
  };
}

/**
 * A fake gateway. Defaults: id `openrouter`, no model lists, `generateImage` throws "not used".
 * Pass any `Gateway` member to override it; `capabilities` is merged over `fakeCapabilities()`.
 */
export function makeFakeGateway(over: Partial<Omit<Gateway, 'capabilities'>> & { capabilities?: Partial<GatewayCapabilities> } = {}): Gateway {
  const { capabilities, ...rest } = over;
  return {
    id: 'openrouter',
    capabilities: fakeCapabilities(capabilities),
    listImageModels: async () => ({ models: [], source: 'manual', warnings: [] }),
    async generateImage() {
      throw new Error('not used');
    },
    ...rest,
  };
}

export interface McpHarnessOptions {
  gateway: Gateway;
  /** Name the MCP client announces (shows up nowhere but failure traces). */
  clientName: string;
  /** Prefix of the temp output dir. */
  tmpPrefix: string;
  /** `config.gateway` (default `openrouter`). */
  gatewayId?: GatewayId;
  /** Merged over `{ model: 'fake/model', async: false }` as `config.image`. */
  image?: Record<string, unknown>;
  /** `config.output.inlinePreview` / `previewMaxBytes` (default off / 1024). */
  inlinePreview?: boolean;
  previewMaxBytes?: number;
  /** Use this output dir instead of a fresh temp dir (the harness then does not delete it). */
  outDir?: string;
  /** Extra top-level `config` keys (e.g. `mistral`). */
  extraConfig?: Record<string, unknown>;
}

export interface McpHarness {
  outDir: string;
  client: Client;
  server: ReturnType<typeof buildServer>;
  /** Call a tool; the result is NOT typed beyond `CallResult` (tests assert on its shape). */
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  /** Close the client, remove a harness-created out dir, and put the `runtime` singleton back. */
  close(): Promise<void>;
}

/** Install `gateway` + a validated config into the `runtime` singleton, build the real server, connect a client to it. */
export async function startMcpHarness(opts: McpHarnessOptions): Promise<McpHarness> {
  const saved = { gateway: runtime.gateway, config: runtime.config, logger: runtime.logger };
  const ownsOutDir = opts.outDir === undefined;
  const outDir = opts.outDir ?? (await mkdtemp(join(tmpdir(), opts.tmpPrefix)));

  runtime.gateway = opts.gateway;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime as any).config = configSchema.parse({
    gateway: opts.gatewayId ?? 'openrouter',
    token: { type: 'inline', value: 'fake' },
    output: { dir: outDir, inlinePreview: opts.inlinePreview ?? false, previewMaxBytes: opts.previewMaxBytes ?? 1024 },
    image: { model: 'fake/model', async: false, ...opts.image },
    backgroundRemoval: { model: 'none', executionProvider: 'cpu', modelsDir: 'models' },
    ...opts.extraConfig,
  }) as AppConfig;
  runtime.tinifyToken = null;
  runtime.logger = SILENT_LOGGER;

  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: opts.clientName, version: '1.0.0' });
  // The server must be listening first — the client's initialize is routed to it.
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    outDir,
    client,
    server,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallResult,
    async close() {
      await client.close().catch(() => {});
      if (ownsOutDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
      runtime.gateway = saved.gateway;
      runtime.config = saved.config;
      runtime.logger = saved.logger;
      runtime.tinifyToken = null;
    },
  };
}
