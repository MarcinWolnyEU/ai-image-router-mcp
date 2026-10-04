/**
 * The Streamable HTTP transport (`src/http/app.ts`) over a real node:http server on an
 * ephemeral port, with a one-tool McpServer. Raw `http.request` (not fetch) so tests can
 * forge the `Host` header, exactly as a DNS-rebinding browser page would. No network.
 *
 *  - while NO auth token is set, a request whose Host/Origin is a foreign domain is refused
 *    (a rebinding page could otherwise drive every tool, e.g. read local files as base64);
 *    loopback names, IP literals and `allowedHosts` pass;
 *  - with a token, a tunnel's public hostname works and the token decides;
 *  - body cap (413), malformed JSON (400 / -32700), unknown session (404), idle expiry, and a
 *    multi-byte UTF-8 character split across two TCP chunks survives intact.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp, type HttpApp } from '../src/http/app.js';

const logger = { info() {}, warn() {}, error() {} };
let auth: string | null = null;
let allowedHosts: string[] = [];
let app: HttpApp;
let server: Server;
let port = 0;
let clock = 0;

function buildServer(): McpServer {
  const s = new McpServer({ name: 'http-test', version: '1.0.0' });
  s.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
  return s;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
/** Send a request; `chunks` are written separately (to split a body at a chosen byte). */
function send(opts: { method?: string; headers?: Record<string, string>; chunks?: Buffer[] }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: opts.method ?? 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    (async () => {
      for (const c of opts.chunks ?? []) {
        req.write(c);
        await new Promise((r) => setTimeout(r, 15)); // separate TCP chunks
      }
      req.end();
    })();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const json = (v: unknown) => [Buffer.from(JSON.stringify(v))];
/** The JSON-RPC message in a reply that may be plain JSON or an SSE `data:` event. */
function rpc(r: Reply): { result?: any; error?: { code: number; message: string } } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const data = r.body.split(/\r?\n/).find((l) => l.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : r.body);
}
async function initialize(headers: Record<string, string> = {}): Promise<string> {
  const r = await send({ headers, chunks: json(INIT) });
  assert.equal(r.status, 200, r.body);
  const sid = r.headers['mcp-session-id'] as string;
  await send({ headers: { ...headers, 'mcp-session-id': sid }, chunks: json({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return sid;
}

before(async () => {
  app = createHttpApp({ buildServer, authToken: () => auth, allowedHosts: () => allowedHosts, logger, maxBodyBytes: 4096, sessionIdleMs: 1000, sweepIntervalMs: 0, now: () => clock });
  server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (a && typeof a === 'object') port = a.port;
});

after(async () => {
  await app.close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  auth = null;
  allowedHosts = [];
  clock = 0;
});

describe('DNS-rebinding / cross-site guard (no auth token)', () => {
  it('refuses a foreign Host — a rebinding page reaching 127.0.0.1 through its own domain', async () => {
    const before = app.sessions.size;
    const r = await send({ headers: { host: `evil.example:${port}` }, chunks: json(INIT) });
    assert.equal(r.status, 403);
    assert.match(rpc(r).error?.message ?? '', /Host "evil\.example/);
    assert.equal(app.sessions.size, before, 'no session was created');
  });

  it('refuses a cross-site Origin, and the opaque "null" origin', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      const r = await send({ headers: { origin }, chunks: json(INIT) });
      assert.equal(r.status, 403, origin);
    }
  });

  it('accepts loopback names and IP literals', async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`]) {
      const r = await send({ headers: { host }, chunks: json(INIT) });
      assert.equal(r.status, 200, `${host}: ${r.body}`);
    }
    const local = await send({ headers: { origin: `http://localhost:${port}` }, chunks: json(INIT) });
    assert.equal(local.status, 200);
  });

  it('accepts a configured allowedHosts name', async () => {
    allowedHosts = ['studio.lan'];
    const r = await send({ headers: { host: 'studio.lan:8765' }, chunks: json(INIT) });
    assert.equal(r.status, 200, r.body);
  });

  it('with an auth token, a tunnel hostname works and the token decides', async () => {
    auth = 's3cret';
    const ok = await send({ headers: { host: 'abc.trycloudflare.com', authorization: 'Bearer s3cret' }, chunks: json(INIT) });
    assert.equal(ok.status, 200, ok.body);
    const bad = await send({ headers: { host: 'abc.trycloudflare.com', authorization: 'Bearer nope' }, chunks: json(INIT) });
    assert.equal(bad.status, 401);
  });
});

describe('request hygiene', () => {
  it('a body over the cap is a 413', async () => {
    const r = await send({ chunks: [Buffer.from(JSON.stringify({ ...INIT, pad: 'x'.repeat(8000) }))] });
    assert.equal(r.status, 413);
  });

  it('malformed JSON is a 400 parse error (-32700), not a 500', async () => {
    const r = await send({ chunks: [Buffer.from('{"jsonrpc":"2.0", nope')] });
    assert.equal(r.status, 400);
    assert.equal(rpc(r).error?.code, -32700);
  });

  it('an unknown session id is a 404 (the client re-initializes)', async () => {
    const r = await send({ headers: { 'mcp-session-id': 'no-such-session' }, chunks: json({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(r.status, 404);
  });

  it('a multi-byte UTF-8 character split across two chunks arrives intact', async () => {
    const sid = await initialize();
    const call = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'żółw 🐢' } } }));
    const at = call.indexOf(Buffer.from('🐢')) + 2; // split INSIDE the 4-byte emoji
    const r = await send({ headers: { 'mcp-session-id': sid }, chunks: [call.subarray(0, at), call.subarray(at)] });
    assert.equal(r.status, 200, r.body);
    assert.equal(rpc(r).result?.content?.[0]?.text, 'żółw 🐢');
  });
});

describe('session expiry', () => {
  it('a session idle past the limit is closed; its id then gets a 404', async () => {
    const sid = await initialize();
    assert.ok(app.sessions.has(sid));
    clock = 500;
    await send({ headers: { 'mcp-session-id': sid }, chunks: json({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) });
    clock = 1200; // 700 ms since this session's last request — still within the 1000 ms limit
    await app.sweep(); // (sessions left idle by earlier tests are closed here)
    assert.ok(app.sessions.has(sid), 'a recently used session survives the sweep');
    clock = 2600;
    assert.ok((await app.sweep()) >= 1);
    assert.equal(app.sessions.has(sid), false);
    const r = await send({ headers: { 'mcp-session-id': sid }, chunks: json({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) });
    assert.equal(r.status, 404);
  });
});
