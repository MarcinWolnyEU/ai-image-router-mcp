/**
 * List all MCP tools exposed by the ai-image-router-mcp server.
 *
 * By default this spawns the server over **stdio** (no running server needed,
 * free — same boot path as `mcp-test.ts`) and prints its `tools/list`. Pass
 * `--http [url]` to instead connect to an already-running Streamable-HTTP server
 * (`npm start -- --http`; default url http://127.0.0.1:8765/mcp).
 *
 * Usage:
 *   npx tsx scripts/list-tools.ts                 name, description + parameter list (default)
 *   npx tsx scripts/list-tools.ts --names         just tool names, one per line
 *   npx tsx scripts/list-tools.ts --json          full JSON (name, description, inputSchema)
 *   npx tsx scripts/list-tools.ts --http [url]    connect to a running HTTP server
 *   npx tsx scripts/list-tools.ts --help
 *
 * Env:
 *   BUILT=1           run dist/index.js instead of tsx src/index.ts (stdio mode only)
 *   NO_COLOR          disable ANSI color
 *   FORCE_COLOR       force ANSI color even when not a TTY
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { findProjectRoot } from './root.mjs';

// Project root, derived from this script's own location (not cwd), so the server
// subprocess resolves `src/index.ts` / `dist/index.js` regardless of the CWD.
const ROOT = findProjectRoot(import.meta.url);

type Mode = 'table' | 'names' | 'json';

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  description?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

const HELP = `List all MCP tools exposed by the ai-image-router-mcp server.

Usage:
  npx tsx scripts/list-tools.ts                 name, description + parameter list (default)
  npx tsx scripts/list-tools.ts --names         just tool names, one per line
  npx tsx scripts/list-tools.ts --json          full JSON (name, description, inputSchema)
  npx tsx scripts/list-tools.ts --http [url]    connect to a running HTTP server (default http://127.0.0.1:8765/mcp)
  npx tsx scripts/list-tools.ts --help

Env:
  BUILT=1   run dist/index.js instead of tsx src/index.ts (stdio mode only)
  NO_COLOR / FORCE_COLOR   control ANSI color`;

function parseArgs(argv: string[]): { mode: Mode; http: URL | null } {
  let mode: Mode = 'table';
  let http: URL | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--names':
        mode = 'names';
        break;
      case '--json':
        mode = 'json';
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      case '--http': {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          http = new URL(next);
          i++;
        } else {
          http = new URL('http://127.0.0.1:8765/mcp');
        }
        break;
      }
      default:
        console.error(`unknown option: ${a}\n`);
        console.error(HELP);
        process.exit(2);
    }
  }
  return { mode, http };
}

function makeTransport(http: URL | null): Transport {
  if (http) return new StreamableHTTPClientTransport(http);
  const built = process.env['BUILT'] === '1';
  return new StdioClientTransport({
    command: built ? 'node' : process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: built ? ['dist/index.js'] : ['tsx', 'src/index.ts'],
    cwd: ROOT,
    // We only introspect the tool list — tell the server not to pre-load the ~970 MB
    // background-removal ONNX model. Merge the SDK's default env so PATH/etc. survive.
    env: { ...getDefaultEnvironment(), BG_NO_PREWARM: '1' },
  });
}

// --- table rendering (ported from the FoxMCP list-tools.sh) ---

function typesOf(s: JsonSchema | undefined): string[] {
  if (!s || typeof s !== 'object') return [];
  const out: string[] = [];
  const t = s.type;
  if (Array.isArray(t)) out.push(...t);
  else if (typeof t === 'string') out.push(t);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    for (const sub of s[key] ?? []) out.push(...typesOf(sub));
  }
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const x of out) {
    if (!seen.has(x)) {
      seen.add(x);
      uniq.push(x);
    }
  }
  return uniq;
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return 'any';
}

function fmtDefault(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function collapse(s: string | undefined): string {
  return (s ?? '').split(/\s+/).filter(Boolean).join(' ');
}

function colorOn(): boolean {
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR']) return true;
  return Boolean(process.stdout.isTTY);
}

/** ANSI styling for the table (all empty strings when colour is off). */
interface Palette {
  RESET: string;
  BOLD: string;
  C_SEG: string;
  C_REQ: string;
  tcol: (typeName: string) => string;
}

function makePalette(): Palette {
  const USE_COLOR = colorOn();
  const sgr = (code: string): string => (USE_COLOR ? `[${code}m` : '');
  const RESET = sgr('0');
  const BOLD = sgr('1');
  const C_SEG = sgr('38;5;245'); // the (...) segment punctuation — gray
  const C_REQ = sgr('38;5;88'); // "required" — dark red
  // A distinct dark shade per JSON type (no reds); a default is painted in its own type's color.
  const TYPE_CODES: Record<string, string> = {
    string: '38;5;240', // dark gray
    integer: '38;5;25', // deep blue
    number: '38;5;31', // dark teal
    boolean: '38;5;28', // dark green
    null: '38;5;96', // mauve
    array: '38;5;94', // amber/brown
    object: '38;5;60', // slate blue
  };
  const tcol = (name: string): string => sgr(TYPE_CODES[name] ?? '38;5;245');
  return { RESET, BOLD, C_SEG, C_REQ, tcol };
}

/** One "  - name (types, required, default: x) description" line. */
function renderParam(pname: string, pschema: JsonSchema, isRequired: boolean, pal: Palette): string {
  const { RESET, C_SEG, C_REQ, tcol } = pal;
  const tys = typesOf(pschema);
  const types = (tys.length ? tys : ['any']).map((ty) => `${tcol(ty)}${ty}${C_SEG}`).join('||');
  const seg = [types];
  if (isRequired) seg.push(`${C_REQ}required${C_SEG}`);
  if ('default' in pschema) {
    const dv = pschema.default;
    seg.push(`default: ${tcol(jsonTypeOf(dv))}${fmtDefault(dv)}${C_SEG}`);
  }
  const pdesc = collapse(pschema.description);
  let line = `  - ${pname} ${C_SEG}(${seg.join(', ')})${RESET}`;
  if (pdesc) line += ` ${pdesc}`;
  return line;
}

/** A tool's heading (name + wrapped description) followed by one line per parameter. */
function renderTool(t: ToolInfo, index: number, nameWidth: number, pal: Palette): void {
  const contIndent = ' '.repeat(4 + nameWidth + 2); // align under the description column: "##  " + name + pad + "  "
  const lines = (t.description ?? '').trim().split(/\r?\n/);
  const first = lines[0] ?? '';
  if (index) console.log();
  const pad = ' '.repeat(nameWidth - t.name.length);
  console.log(`##  ${pal.BOLD}${t.name}${pal.RESET}${pad}  ${first}`);
  for (const cont of lines.slice(1)) console.log(contIndent + cont);

  const schema = t.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  for (const [pname, raw] of Object.entries(schema.properties ?? {})) {
    console.log(renderParam(pname, raw ?? {}, required.has(pname), pal));
  }
}

function renderTable(tools: ToolInfo[]): void {
  const pal = makePalette();
  const width = tools.reduce((m, t) => Math.max(m, t.name.length), 0);
  tools.forEach((t, i) => renderTool(t, i, width, pal));

  console.error(`\n${tools.length} tools`);
}

async function main(): Promise<void> {
  const { mode, http } = parseArgs(process.argv.slice(2));
  const transport = makeTransport(http);
  const client = new Client({ name: 'air-mcp-list-tools', version: '1.0.0' });

  try {
    await client.connect(transport);
  } catch (e) {
    const where = http ? `HTTP server at ${http.href}` : 'spawned stdio server';
    console.error(`error: could not connect to ${where}`);
    console.error(`  ${(e as Error).name}: ${(e as Error).message}`);
    if (http) console.error(`  is the server up?  npm start -- --http`);
    process.exit(1);
  }

  const { tools: raw } = await client.listTools();
  const tools = (raw as ToolInfo[]).slice().sort((a, b) => a.name.localeCompare(b.name));

  if (mode === 'names') {
    for (const t of tools) console.log(t.name);
  } else if (mode === 'json') {
    console.log(
      JSON.stringify(
        tools.map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null })),
        null,
        2,
      ),
    );
  } else {
    renderTable(tools);
  }

  await client.close().catch(() => {});
}

main().catch((e) => {
  console.error('LIST-TOOLS ERROR:', (e as Error)?.stack ?? e);
  process.exit(1);
});
