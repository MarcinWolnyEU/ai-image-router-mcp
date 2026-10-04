import { rawRequest } from '../util/http.js';

const BASE = 'https://api.tinify.com';

function authHeader(key: string): string {
  return 'Basic ' + Buffer.from(`api:${key}`).toString('base64');
}

function tinifyMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string; message?: string };
    return [j.error, j.message].filter(Boolean).join(': ') || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

export class TinifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TinifyError';
  }
}

/** Upload bytes to /shrink; returns the result resource URL (Location header). */
async function shrink(key: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  const res = await rawRequest(`${BASE}/shrink`, {
    method: 'POST',
    headers: { Authorization: authHeader(key) },
    body: bytes,
    signal,
    timeoutMs: 120_000,
  });
  if (res.status !== 201) {
    throw new TinifyError(`Tinify shrink failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  }
  const location = res.headers.get('location');
  if (!location) throw new TinifyError('Tinify shrink did not return a result Location.', res.status);
  return location;
}

/** Compress a PNG (or any supported image) — returns the optimised bytes (same format). */
export async function tinifyCompress(key: string, bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const url = await shrink(key, bytes, signal);
  const res = await rawRequest(url, { method: 'GET', headers: { Authorization: authHeader(key) }, signal, timeoutMs: 120_000 });
  if (!res.ok) throw new TinifyError(`Tinify download failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Compress + convert an image to another format (default image/webp) — returns the converted bytes. */
export async function tinifyConvert(key: string, bytes: Buffer, type = 'image/webp', signal?: AbortSignal): Promise<Buffer> {
  const url = await shrink(key, bytes, signal);
  const res = await rawRequest(url, {
    method: 'POST',
    headers: { Authorization: authHeader(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ convert: { type } }),
    signal,
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new TinifyError(`Tinify convert failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Quick credential check: returns the monthly Compression-Count, or throws TinifyError. */
export async function tinifyValidate(key: string, signal?: AbortSignal): Promise<number | null> {
  // A POST to /shrink with no body returns 400 (bad request) for a valid key, 401 for an invalid one.
  const res = await rawRequest(`${BASE}/shrink`, { method: 'POST', headers: { Authorization: authHeader(key) }, body: '', signal, timeoutMs: 30_000, retries: 0 });
  if (res.status === 401) throw new TinifyError('Tinify credentials are invalid.', 401);
  const count = res.headers.get('compression-count');
  return count ? Number(count) : null;
}
