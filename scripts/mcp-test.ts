/**
 * Spawns the MCP server over stdio and exercises it as a real client.
 *   npx tsx scripts/mcp-test.ts          # boot + tools/list + health_status (free)
 *   npx tsx scripts/mcp-test.ts --gen    # also call generate_image (costs money)
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findProjectRoot } from './root.mjs';

// Project root (from this script's location, not cwd) for the server subprocess + output dir.
const ROOT = findProjectRoot(import.meta.url);

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** Call one tool and print its outcome (header, isError, content types, text) to stderr. */
async function runTool(client: Client, title: string, name: string, args: Record<string, unknown>): Promise<void> {
  console.error(`\n--- ${title} ---`);
  const res = await client.callTool({ name, arguments: args });
  console.error('isError:', res.isError, '| content:', (res.content as Array<{ type: string }>).map((c) => c.type).join(', '));
  console.error(textOf(res.content));
}

/** First file in `output/` whose name matches `name` and `ext` (a previous run's artifact to feed the tools). */
const outputFile = (name: RegExp, ext: RegExp): string => join(ROOT, 'output', readdirSync('output').find((f) => name.test(f) && ext.test(f))!);

async function connect(): Promise<Client> {
  const built = process.env['BUILT'] === '1';
  const transport = new StdioClientTransport({
    command: built ? 'node' : process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: built ? ['dist/index.js'] : ['tsx', 'src/index.ts'],
    cwd: ROOT,
  });
  const client = new Client({ name: 'air-mcp-smoke-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function main() {
  const client = await connect();

  const tools = await client.listTools();
  console.error('TOOLS:', tools.tools.map((t) => t.name).join(', '));

  const health = await client.callTool({ name: 'health_status', arguments: {} });
  console.error('\nHEALTH (first 600 chars):\n' + textOf(health.content).slice(0, 600));

  const restart = await client.callTool({ name: 'restart', arguments: {} });
  console.error('\nRESTART:\n' + textOf(restart.content).split('\n').slice(0, 2).join('\n'));

  const flag = (f: string) => process.argv.includes(f);

  if (flag('--bg')) {
    await runTool(client, 'remove_background', 'remove_background', { image: outputFile(/leaf/i, /\.(png|jpe?g)$/i), inline_preview: false });
  }
  if (flag('--crop')) {
    await runTool(client, 'crop_media (image)', 'crop_media', { image: outputFile(/robot/i, /\.png$/i), left: 300, top: 150, width: 450, height: 450, inline_preview: false });
  }
  // `wait:true` forces the synchronous path even though async is now the default.
  if (flag('--webp')) {
    await runTool(client, 'generate_image output_format=webp (Tinify)', 'generate_image', {
      prompt: 'a simple flat blue circle centered on a white background',
      output_format: 'webp',
      inline_preview: false,
      wait: true,
    });
  }
  if (flag('--gen')) {
    await runTool(client, 'generate_image', 'generate_image', { prompt: 'a single red maple leaf centered on a white background, minimalist', inline_preview: false, wait: true });
  }

  await client.close();
  console.error('\nOK');
}

main().catch((e) => {
  console.error('MCP TEST ERROR:', e?.stack ?? e);
  process.exit(1);
});
