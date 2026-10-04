import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { checkRequestOrigin, isHttpRequestAuthorized } from '../util/httpAuth.js';

type Log = { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void; error(msg: string, meta?: Record<string, unknown>): void };

export interface HttpAppOptions {
  /** A fresh McpServer for each session (tool registration is per connection). */
  buildServer: () => McpServer;
  /** The shared secret, or null when auth is off. Read per request, so a `restart` applies. */
  authToken: () => string | null;
  /** Extra hostnames accepted while auth is off (config `http.allowedHosts`). Read per request. */
  allowedHosts: () => string[];
  logger: Log;
  /** Largest accepted request body. Default 64 MiB (inline base64 media rides in tool args). */
  maxBodyBytes?: number;
  /** Close a session after this long without a request; an open SSE stream keeps it alive. Default 30 min. */
  sessionIdleMs?: number;
  /** How often idle sessions are swept. Default 60 s. 0 = never (tests call `sweep()`). */
  sweepIntervalMs?: number;
  now?: () => number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  /** Open GET (SSE) streams — a listening client is alive even without new requests. */
  openStreams: number;
}

export interface HttpApp {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Live sessions by id (read-only use). */
  readonly sessions: ReadonlyMap<string, unknown>;
  /** Close sessions idle past the limit; returns how many were closed. */
  sweep(): Promise<number>;
  /** Close every session and stop the sweeper. */
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Read a JSON body: chunks are collected as BYTES and decoded once (decoding per chunk turned a
 * multi-byte UTF-8 character split across two chunks into U+FFFD), capped at `maxBytes` (413),
 * and malformed JSON is a 400 / -32700 parse error rather than a 500.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, -32600, `Request body too large (${declared} bytes; limit ${maxBytes}).`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, -32600, `Request body too large (over ${maxBytes} bytes).`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new HttpError(400, -32700, `Parse error: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The Streamable HTTP request handler (`/mcp`). Per request: path → Host/Origin guard (only
 * while auth is off: the DNS-rebinding protection) → shared-secret auth → session routing.
 * Sessions expire after `sessionIdleMs` without a request (the map used to grow forever);
 * an unknown session id is a 404, per the MCP spec, so clients re-initialize.
 */
export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024 * 1024;
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const closeSession = async (id: string, s: Session): Promise<void> => {
    sessions.delete(id);
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  };

  const sweep = async (): Promise<number> => {
    let closed = 0;
    for (const [id, s] of [...sessions]) {
      if (s.openStreams === 0 && now() - s.lastSeen > idleMs) {
        opts.logger.info('HTTP session expired (idle)', { session: id, idleMinutes: Math.round((now() - s.lastSeen) / 60_000) });
        await closeSession(id, s);
        closed++;
      }
    }
    return closed;
  };

  const interval = opts.sweepIntervalMs ?? 60_000;
  const timer = interval > 0 ? setInterval(() => void sweep(), interval) : null;
  timer?.unref();

  /**
   * Host/Origin guard (only while auth is off: the DNS-rebinding protection), then shared-secret
   * auth. Sends the refusal itself and returns false when the request must not proceed.
   */
  const passesGuards = (req: IncomingMessage, res: ServerResponse): boolean => {
    const authToken = opts.authToken();
    const refused = checkRequestOrigin(req.headers, { authEnabled: authToken !== null, allowedHosts: opts.allowedHosts() });
    if (refused) {
      opts.logger.warn('HTTP request refused (DNS-rebinding / cross-site guard)', { reason: refused, method: req.method, remote: req.socket.remoteAddress });
      sendJsonRpcError(res, 403, -32000, `Forbidden: ${refused}. Without http.authToken only loopback/IP hosts and http.allowedHosts are accepted.`);
      return false;
    }
    // Shared-secret auth (config.http.authToken). Checked on EVERY request, not just initialize —
    // a leaked session id alone must not grant access. Plain 401 without an OAuth challenge:
    // Le Chat then offers Bearer / API-key entry instead of trying OAuth discovery.
    if (!isHttpRequestAuthorized(req.headers, authToken)) {
      opts.logger.warn('HTTP request rejected: missing/invalid bearer token', { method: req.method, url: req.url ?? '', remote: req.socket.remoteAddress });
      sendJsonRpcError(res, 401, -32001, 'Unauthorized: send Authorization: Bearer <token>');
      return false;
    }
    return true;
  };

  /** A new session: a fresh server + transport, registered once the transport assigns its id. */
  const startSession = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const server = opts.buildServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server, lastSeen: now(), openStreams: 0 });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const handlePost = async (req: IncomingMessage, res: ServerResponse, existing: Session | undefined): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof HttpError) return sendJsonRpcError(res, err.status, err.rpcCode, err.message);
      throw err;
    }
    if (existing) return existing.transport.handleRequest(req, res, body);
    if (!isInitializeRequest(body)) return sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID');
    return startSession(req, res, body);
  };

  /** GET (the SSE stream) and DELETE (end the session) both need an existing session. */
  const handleSessionRequest = async (req: IncomingMessage, res: ServerResponse, existing: Session | undefined): Promise<void> => {
    if (!existing) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing session ID');
      return;
    }
    if (req.method === 'GET') {
      existing.openStreams += 1;
      res.once('close', () => {
        existing.openStreams = Math.max(0, existing.openStreams - 1);
        existing.lastSeen = now();
      });
    }
    await existing.transport.handleRequest(req, res);
  };

  /** Look up the request's session (404 when it names an unknown one) and dispatch by HTTP method. */
  const routeToSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !existing) {
      // Unknown/expired session: 404 tells a spec-compliant client to start a new one.
      sendJsonRpcError(res, 404, -32001, 'Session not found (it expired or the server restarted) — re-initialize.');
      return;
    }
    if (existing) existing.lastSeen = now();

    if (req.method === 'POST') return handlePost(req, res, existing);
    if (req.method === 'GET' || req.method === 'DELETE') return handleSessionRequest(req, res, existing);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!(req.url ?? '').startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. Use the /mcp endpoint.');
      return;
    }
    if (!passesGuards(req, res)) return;
    await routeToSession(req, res);
  };

  return {
    handle,
    sessions,
    sweep,
    async close() {
      if (timer) clearInterval(timer);
      for (const [id, s] of [...sessions]) await closeSession(id, s);
    },
  };
}
