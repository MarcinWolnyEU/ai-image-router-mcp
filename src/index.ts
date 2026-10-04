#!/usr/bin/env node
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runtime } from './state/runtime.js';
import { buildServer } from './server.js';
import { createHttpApp } from './http/app.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useHttp = args.includes('--http');

  try {
    await runtime.init();
  } catch (err) {
    process.stderr.write(`[ai-image-router-mcp] Startup failed: ${(err as Error).message}\n`);
    process.stderr.write('Run `npm run configure` to (re)create config.json.\n');
    process.exit(1);
  }

  // (Phase 4) Background-removal model is downloaded/initialised lazily on first use.

  process.on('SIGINT', () => void runtime.requestShutdown('SIGINT'));
  process.on('SIGTERM', () => void runtime.requestShutdown('SIGTERM'));

  if (useHttp || runtime.config.http.enabled) {
    await startHttp();
  } else {
    await startStdio();
  }

  // Pre-download / initialise the background-removal model on startup (non-blocking,
  // so the MCP handshake is never delayed by a ~930 MB download). `BG_NO_PREWARM=1` skips
  // this — used by short-lived spawns (e.g. `scripts/list-tools.ts`) that only introspect the
  // server and would otherwise needlessly load a ~970 MB ONNX session. It still loads lazily
  // on the first `remove_background` call.
  if (runtime.config.backgroundRemoval.model !== 'none' && !process.env.BG_NO_PREWARM) {
    void runtime.getRemover().catch((err) => {
      runtime.logger.error('Background-removal model init failed at startup', { error: (err as Error).message });
    });
  }
}

async function startStdio(): Promise<void> {
  const server = buildServer();
  runtime.onShutdown(async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 50);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  runtime.logger.info('MCP server started (stdio transport)');
}

async function startHttp(): Promise<void> {
  const { host, port } = runtime.config.http;
  // Auth, allowed hosts and the idle limit are read from the LIVE runtime, so `restart` applies them.
  const app = createHttpApp({
    buildServer,
    authToken: () => runtime.httpAuthToken,
    allowedHosts: () => runtime.config.http.allowedHosts,
    sessionIdleMs: runtime.config.http.sessionIdleMinutes * 60_000,
    logger: runtime.logger,
  });

  const httpServer = createServer((req, res) => {
    void app.handle(req, res).catch((err) => {
      runtime.logger.error('HTTP handler error', { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    });
  });

  runtime.onShutdown(async () => {
    await app.close();
    httpServer.close();
    setTimeout(() => process.exit(0), 50);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  runtime.logger.info(`MCP server started (Streamable HTTP) at http://${host}:${port}/mcp`, {
    auth: runtime.httpAuthToken
      ? 'bearer token required'
      : 'NONE — only loopback/IP hosts and http.allowedHosts are accepted (DNS-rebinding guard); do not expose this port publicly',
  });
}

main().catch((err) => {
  process.stderr.write(`[ai-image-router-mcp] Fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
