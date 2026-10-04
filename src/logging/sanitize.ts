/**
 * Deep-sanitize values before they go into a log line.
 *
 * Tool inputs (e.g. `reference_images`) and outputs (`image.data`, `resource.blob`)
 * can carry base64 / data: URLs that are megabytes long. We never want those in a
 * log file verbatim, so any base64-looking string or data: URL is collapsed to its
 * first few characters plus its length: `iVBOR(...) [124576 chars]`.
 *
 * Returns a NEW structure — the original args/result are never mutated.
 */

const PREVIEW_CHARS = 5;

// Long-ish, made up only of base64 alphabet (incl. url-safe + padding) — plus LINE BREAKS,
// because MIME/PEM-style encoders wrap at 76 columns (a wrapped multi-MB blob used to land in
// the log verbatim). Still NO spaces/tabs: allowing them would collapse any long plain-text
// prompt ("A red fox running through …") into a payload preview.
const BASE64_RE = /^[A-Za-z0-9+/_=\r\n-]+$/;
// Threshold (in base64 characters, line breaks excluded) above which it's a payload, not text.
const BASE64_MIN_LEN = 64;

function truncatePayload(s: string): string {
  return `${s.slice(0, PREVIEW_CHARS)}(...) [${s.length} chars]`;
}

/** Should this string be collapsed to a preview? (data: URL or a long base64 blob.) */
export function isLargePayload(s: string): boolean {
  if (s.startsWith('data:') && s.length > 32) return true;
  if (s.length >= BASE64_MIN_LEN && BASE64_RE.test(s) && s.replace(/[\r\n]/g, '').length >= BASE64_MIN_LEN) return true;
  return false;
}

function sanitizeString(s: string): string {
  if (s.startsWith('data:')) {
    // Preserve the informative header (`data:image/png;base64,`) and truncate the payload.
    const comma = s.indexOf(',');
    if (comma > 0 && comma < 64) {
      const payload = s.slice(comma + 1);
      return `${s.slice(0, comma + 1)}${truncatePayload(payload)}`;
    }
    return truncatePayload(s);
  }
  return truncatePayload(s);
}

/** Recursively copy `value`, collapsing any large base64/data-URL strings. */
export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return isLargePayload(value) ? sanitizeString(value) : value;
  }
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForLog(v, seen));
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeForLog(v, seen);
  }
  return out;
}
