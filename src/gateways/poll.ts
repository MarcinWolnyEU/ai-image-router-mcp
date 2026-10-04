/**
 * The shared shape of every gateway's "poll a remote job until it finishes" loop:
 * check the abort signal, run one status check, back off by +1 s up to a cap, give
 * up at a deadline. What counts as finished / failed / progress is the caller's
 * `step` (it reports progress, throws on a terminal failure, and returns the final
 * value once done) — each gateway's status vocabulary differs and stays with it.
 */
export interface PollLoop<R> {
  /** Total time to keep polling. */
  deadlineMs: number;
  /** First sleep between checks; grows by 1 s per round up to `maxIntervalMs`. */
  initialIntervalMs: number;
  maxIntervalMs: number;
  signal?: AbortSignal | undefined;
  /** One status check: the final value when the job is done, `undefined` to keep polling. Throw to fail. */
  step: () => Promise<R | undefined>;
  /** Message of the Error thrown when the deadline passes without a final value. */
  timeoutMessage: string;
}

/** The deadline passed without a final value (the remote job may still be running). */
export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PollTimeoutError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function pollUntil<R>(loop: PollLoop<R>): Promise<R> {
  const deadline = Date.now() + loop.deadlineMs;
  let interval = loop.initialIntervalMs;
  while (Date.now() < deadline) {
    if (loop.signal?.aborted) throw new Error('aborted');
    const done = await loop.step();
    if (done !== undefined) return done;
    await sleep(interval);
    interval = Math.min(interval + 1000, loop.maxIntervalMs);
  }
  throw new PollTimeoutError(loop.timeoutMessage);
}
