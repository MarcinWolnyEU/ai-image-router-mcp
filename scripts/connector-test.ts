/**
 * Remote-connector smoke test — what Le Chat / Vibe do over Streamable HTTP, scripted.
 *
 *   npx tsx scripts/connector-test.ts [url] [--shutdown]
 *
 * url defaults to http://127.0.0.1:8765/mcp; pass the public tunnel URL (https://…/mcp) to test
 * the exact path Le Chat uses. The bearer token comes from $MCP_TOKEN or "mcp http token.txt".
 * Checks: unauthenticated + wrong-token requests get 401; authenticated initialize + tools/list
 * advertises the always-on tools. No generation, no cost.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const url = new URL(args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:8765/mcp');
const token = process.env.MCP_TOKEN ?? (existsSync('mcp http token.txt') ? readFileSync('mcp http token.txt', 'utf8').trim() : '');

function check(ok: boolean, msg: string): void {
  console.error(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
});
const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const anon = await fetch(url, { method: 'POST', headers: hdrs, body: initBody });
check(token ? anon.status === 401 : anon.ok, `no token → HTTP ${anon.status}${token ? ' (want 401)' : ' (auth disabled)'}`);
if (token) {
  const wrong = await fetch(url, { method: 'POST', headers: { ...hdrs, Authorization: 'Bearer nope' }, body: initBody });
  check(wrong.status === 401, `wrong token → HTTP ${wrong.status} (want 401)`);
}

const transport = new StreamableHTTPClientTransport(url, token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
const client = new Client({ name: 'air-connector-smoke', version: '1.0.0' });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.error('tools:', tools.join(', '));
check(tools.includes('generate_image') && tools.includes('health_status'), 'generate_image + health_status advertised');

if (args.includes('--shutdown')) await client.callTool({ name: 'shutdown', arguments: { reason: 'connector-test', delay_ms: 300 } });
await client.close().catch(() => {});
console.error(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED');
process.exit();
