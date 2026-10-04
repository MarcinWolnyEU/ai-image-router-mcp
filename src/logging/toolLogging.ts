import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { sanitizeForLog } from './sanitize.js';
import { normalizeResultForClients } from '../tools/helpers.js';

/** The request/session ids of an MCP call, when the SDK supplied them. */
function requestContext(extra: unknown): Record<string, unknown> {
  const e = (extra ?? {}) as Record<string, unknown>;
  const ctx: Record<string, unknown> = {};
  if (e['requestId'] !== undefined) ctx['requestId'] = e['requestId'];
  if (e['sessionId'] !== undefined) ctx['sessionId'] = e['sessionId'];
  return ctx;
}

function logToolResponse(toolName: string, start: number, result: unknown, ctx: Record<string, unknown>): void {
  const isError = !!(result && typeof result === 'object' && (result as Record<string, unknown>)['isError'] === true);
  const meta = {
    tool: toolName,
    durationMs: Date.now() - start,
    isError,
    result: sanitizeForLog(result),
    ...ctx,
  };
  // A tool that caught its own failure returns { isError: true } rather than
  // throwing — log it at `error` level so severity isn't lost.
  if (isError) runtime.logger?.error(`tool:response ${toolName}`, meta);
  else runtime.logger?.info(`tool:response ${toolName}`, meta);
}

function logToolThrow(toolName: string, start: number, err: unknown, ctx: Record<string, unknown>): void {
  runtime.logger?.error(`tool:response ${toolName} (threw)`, {
    tool: toolName,
    durationMs: Date.now() - start,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    ...ctx,
  });
}

/**
 * Monkey-patch `server.registerTool` so EVERY tool call is logged uniformly,
 * without touching the individual tool handlers:
 *
 *  - `tool:request  <name>` — the tool name + the full (sanitized) request args.
 *  - `tool:response <name>` — duration, `isError`, and the full (sanitized) result.
 *  - on a thrown error      — logged at `error` and re-thrown unchanged.
 *
 * "Sanitized" means base64 blobs / data: URLs (in inputs OR outputs) are collapsed
 * to `first5(...) [N chars]` so logs never balloon with image/video payloads.
 *
 * It also applies `normalizeResultForClients` (client-compat fix-ups) to every result.
 *
 * Call this on a fresh server BEFORE any tools are registered.
 */
export function instrumentToolLogging(server: McpServer): void {
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const original = target.registerTool.bind(server);

  target.registerTool = (name: unknown, config: unknown, handler: unknown): unknown => {
    if (typeof handler !== 'function') return original(name, config, handler);
    const toolName = typeof name === 'string' ? name : String(name);
    const fn = handler as (args: unknown, extra: unknown) => unknown;

    const wrapped = async (args: unknown, extra: unknown): Promise<unknown> => {
      const start = Date.now();
      const ctx = requestContext(extra);
      runtime.logger?.info(`tool:request ${toolName}`, { tool: toolName, args: sanitizeForLog(args), ...ctx });
      try {
        const result = normalizeResultForClients(await fn(args, extra));
        logToolResponse(toolName, start, result, ctx);
        return result;
      } catch (err) {
        logToolThrow(toolName, start, err, ctx);
        throw err;
      }
    };

    return original(name, config, wrapped);
  };
}
