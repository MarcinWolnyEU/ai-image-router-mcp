/** Validate the Streamable HTTP transport (and the shutdown tool). */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text').map((c) => c.text).join('\n');
}

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8765/mcp');
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: 'air-mcp-http-smoke', version: '1.0.0' });
await client.connect(transport);
console.error('connected over HTTP to', url.href);

const tools = await client.listTools();
console.error('HTTP TOOLS:', tools.tools.map((t) => t.name).join(', '));

const health = await client.callTool({ name: 'health_status', arguments: {} });
console.error('health line:', textOf(health.content).split('\n')[1]);

console.error('calling shutdown…');
const sd = await client.callTool({ name: 'shutdown', arguments: { reason: 'http smoke test', delay_ms: 400 } });
console.error('shutdown:', textOf(sd.content));

await client.close().catch(() => {});
console.error('OK (server will exit shortly)');
process.exit(0);
