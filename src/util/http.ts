/**
 * Minimal fetch-based HTTP helpers shared by every gateway client.
 * No third-party HTTP libs — Node 20 global fetch + AbortSignal.
 */

export class GatewayHttpError extends Error {
  /** Caller-added context (e.g. "the job was accepted — not resubmitted"); shown by `describeError`. */
  note?: string;

  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }

  /** Best-effort extraction of a provider error message from a JSON body. */
  get providerMessage(): string {
    try {
      const j = JSON.parse(this.bodyText) as Record<string, unknown>;
      const err = j['error'];
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object' && 'message' in err) {
        return String((err as Record<string, unknown>)['message']);
      }
      if (typeof j['message'] === 'string') return j['message'] as string;
      if (typeof j['detail'] === 'string') return j['detail'] as string;
    } catch {
      /* not JSON */
    }
    return this.bodyText.slice(0, 500);
  }
}

/**
 * Diagnostic hook: every HTTP failure (non-2xx, network error, retry, or a 200
 * whose body fails to JSON-parse) is reported here so it lands in the log with
 * the RAW upstream body — otherwise only the post-processed tool error survives
 * and debugging needs a live API probe. The runtime wires this to its logger;
 * when unset (tests/harnesses) failures are simply not logged.
 */
export interface HttpFailure {
  method: string;
  url: string;
  status?: number;
  /** Raw response body (truncated) when one was read. */
  body?: string;
  /** Network/parse error message when there was no HTTP response. */
  error?: string;
  /** 0-based attempt index. */
  attempt: number;
  willRetry: boolean;
}
type HttpLogger = (f: HttpFailure) => void;
let httpLogger: HttpLogger | null = null;
export function setHttpLogger(fn: HttpLogger | null): void {
  httpLogger = fn;
}
const MAX_LOGGED_BODY = 2000;
function logHttpFailure(f: HttpFailure): void {
  if (!httpLogger) return;
  try {
    httpLogger({ ...f, ...(f.body !== undefined ? { body: f.body.slice(0, MAX_LOGGED_BODY) } : {}) });
  } catch {
    /* logging must never break a request */
  }
}

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  /** Per-request timeout. Default 120s. */
  timeoutMs?: number;
  /** External cancellation (e.g. MCP request abort). */
  signal?: AbortSignal;
  /** Max retries; which failures qualify depends on `idempotent`. Default 2. */
  retries?: number;
  /**
   * Whether re-sending after an AMBIGUOUS failure is safe. Defaults to true for
   * GET/HEAD/OPTIONS/PUT/DELETE and FALSE for POST/PATCH: a POST may start a billed
   * generation, and a timeout / 5xx / dropped connection doesn't tell us whether the
   * provider already accepted (and charged for) it. A non-idempotent request is only
   * retried when the failure proves it was NOT processed — HTTP 429, or a connection
   * that was never established (DNS failure, refused, connect timeout) — and a 200
   * whose body won't parse is reported instead of re-sent. Pass `true` for a POST
   * that is harmless to repeat (e.g. one that creates no billable work).
   */
  idempotent?: boolean;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
/** Socket error codes that prove the request never reached the server. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export function isIdempotentRequest(opts: Pick<RequestOpts, 'method' | 'idempotent'>): boolean {
  return opts.idempotent ?? IDEMPOTENT_METHODS.has((opts.method ?? 'GET').toUpperCase());
}

/**
 * True when a fetch failure proves the request was never sent. undici wraps the
 * socket error (`TypeError: fetch failed` → `cause: { code }`), and a multi-address
 * connect attempt surfaces as an `AggregateError` whose every member must qualify.
 */
export function requestNeverSent(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_CODES.has(code)) return true;
    const members = (e as { errors?: unknown }).errors;
    if (Array.isArray(members) && members.length > 0) return members.every((m) => requestNeverSent(m));
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RETRY_AFTER_MS = 30_000;
/** `Retry-After` header (delta-seconds or HTTP-date) → ms, capped; null when absent/invalid. */
export function retryAfterMs(res: { headers: { get(name: string): string | null } }, now = Date.now()): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  if (Number.isFinite(at) && at > now) return Math.min(at - now, MAX_RETRY_AFTER_MS);
  return null;
}
const backoffMs = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** 429 is always safe to retry (the request was refused); 408/5xx only when repeating is harmless. */
const isRetryableStatus = (status: number, idempotent: boolean): boolean =>
  status === 429 || (idempotent && (status === 408 || status >= 500));

/** Per-attempt abort signal: the timeout, plus the caller's own cancellation when given. */
function attemptSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  return AbortSignal.any(external ? [AbortSignal.timeout(timeoutMs), external] : [AbortSignal.timeout(timeoutMs)]);
}

/**
 * A timeout / reset on a POST is ambiguous: the provider may already be running (and billing)
 * it, so only re-send when the request provably never left.
 */
const mayRetryAfterError = (err: unknown, attempt: number, retries: number, idempotent: boolean): boolean =>
  attempt < retries && (idempotent || requestNeverSent(err));

/**
 * We discard this response and retry: log why the upstream failed (rate-limit notice, 5xx
 * detail — read from a clone so the caller's body is untouched), then wait. 429/503 may carry a
 * standard `Retry-After` (seconds) — honoured (capped) instead of guessing; otherwise
 * exponential backoff.
 */
async function backOffBeforeRetry(res: Response, ctx: { method: string; url: string; attempt: number }): Promise<void> {
  const snippet = await res.clone().text().catch(() => '');
  logHttpFailure({ ...ctx, status: res.status, body: snippet, willRetry: true });
  await delay(retryAfterMs(res) ?? backoffMs(ctx.attempt));
}

/**
 * Raw request with timeout + retry; returns the Response (caller checks status).
 * Retry policy depends on idempotency (see `RequestOpts.idempotent`): a GET retries
 * 408/429/5xx and any network error; a POST only retries 429 and never-sent errors.
 */
export async function rawRequest(url: string, opts: RequestOpts = {}): Promise<Response> {
  const { method = 'GET', headers, body, timeoutMs = 120_000, signal, retries = 2 } = opts;
  const idempotent = isIdempotentRequest(opts);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body, signal: attemptSignal(timeoutMs, signal) });
      if (!isRetryableStatus(res.status, idempotent) || attempt >= retries) return res;
      await backOffBeforeRetry(res, { method, url, attempt });
    } catch (err) {
      // If the caller's own signal aborted, do not retry — propagate.
      if (signal?.aborted) throw err;
      lastErr = err;
      const willRetry = mayRetryAfterError(err, attempt, retries, idempotent);
      logHttpFailure({ method, url, error: (err as Error).message, attempt, willRetry });
      if (!willRetry) break;
      await delay(backoffMs(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function requestText(url: string, opts: RequestOpts = {}): Promise<string> {
  const res = await rawRequest(url, opts);
  const text = await res.text();
  if (!res.ok) {
    logHttpFailure({ method: opts.method ?? 'GET', url, status: res.status, body: text, attempt: 0, willRetry: false });
    throw new GatewayHttpError(`HTTP ${res.status} ${res.statusText} for ${url}`, res.status, text, url);
  }
  return text;
}

export async function getJson<T = unknown>(url: string, opts: RequestOpts = {}): Promise<T> {
  return requestJson<T>(url, { ...opts, method: 'GET' });
}

export async function postJson<T = unknown>(
  url: string,
  jsonBody: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  return requestJson<T>(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(jsonBody),
  });
}

/**
 * Request + JSON-parse with retry. `requestText`/`rawRequest` already retry
 * network errors and 429/5xx, but a successful HTTP 200 can still carry a
 * truncated/partial body that `JSON.parse` chokes on ("Unexpected end of JSON
 * input"). For an idempotent request that is a transient failure, so re-fetch
 * with backoff rather than surfacing a cryptic parse error. A non-idempotent one
 * (a POST) is NOT re-sent: the 200 means the provider accepted it, and repeating
 * it could start — and bill — the same work twice. An empty body is treated as `{}`.
 */
async function requestJson<T = unknown>(url: string, opts: RequestOpts = {}): Promise<T> {
  const retries = isIdempotentRequest(opts) ? (opts.retries ?? 2) : 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await requestText(url, opts);
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await delay(backoffMs(attempt));
        continue;
      }
      logHttpFailure({ method: opts.method ?? 'GET', url, body: text, error: `JSON parse failed: ${(err as Error).message}`, attempt, willRetry: false });
      if (!isIdempotentRequest(opts)) {
        throw new Error(
          `Unparseable response from ${url}: ${(err as Error).message}. The request was accepted (HTTP 200) and was NOT re-sent, ` +
            `since repeating it could start and bill the same work twice. First 200 chars: ${text.slice(0, 200)}`,
        );
      }
      throw new Error(
        `Invalid JSON response from ${url} after ${retries + 1} attempt(s): ${(err as Error).message}. ` +
          `First 200 chars: ${text.slice(0, 200)}`,
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Download raw bytes (for media files / model downloads with a Bearer header etc.). */
export async function getBytes(url: string, opts: RequestOpts = {}): Promise<Buffer> {
  const res = await rawRequest(url, { ...opts, method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logHttpFailure({ method: 'GET', url, status: res.status, body: text, attempt: 0, willRetry: false });
    throw new GatewayHttpError(`HTTP ${res.status} for ${url}`, res.status, text, url);
  }
  return Buffer.from(await res.arrayBuffer());
}
