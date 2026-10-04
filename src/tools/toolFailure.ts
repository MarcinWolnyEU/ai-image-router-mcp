import { errorResult, type ToolResult } from './helpers.js';

/**
 * An expected, user-facing failure raised from deep inside a tool's pipeline (a validation or
 * verification step). The tool's entry point converts it to `errorResult(message)` — the same
 * reply the step would have returned directly — while any OTHER error keeps propagating to the
 * handler's catch (health-recorded, `describeError`-formatted).
 */
export class ToolFailure extends Error {}

/** Run a tool pipeline; a `ToolFailure` becomes an error reply, anything else is rethrown. */
export async function failuresAsErrorResult(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ToolFailure) return errorResult(err.message);
    throw err;
  }
}
