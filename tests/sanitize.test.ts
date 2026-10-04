/**
 * Unit tests for the log sanitizer (src/logging/sanitize.ts): base64 blobs and
 * data: URLs — in tool inputs OR outputs — must collapse to `first5(...) [N chars]`
 * so log files never balloon with image/video payloads, while ordinary text and
 * structure pass through untouched.
 *
 * Run: `npm test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLargePayload, sanitizeForLog } from '../src/logging/sanitize.js';

// A real-ish base64 blob (well over the 64-char threshold).
const BLOB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('isLargePayload', () => {
  it('flags long base64 strings', () => {
    assert.equal(isLargePayload(BLOB), true);
  });
  it('flags data: URLs', () => {
    assert.equal(isLargePayload('data:image/png;base64,' + BLOB), true);
  });
  it('does not flag ordinary prompts (spaces/punctuation)', () => {
    assert.equal(isLargePayload('A red fox jumping over a fence at sunset!'), false);
  });
  it('does not flag a long prompt made only of letters, digits and spaces', () => {
    // Regression: whitespace in the base64 charset collapsed any long plain prompt.
    const prompt = 'A red fox running through tall golden grass at sunset in 4k cinematic light';
    assert.ok(prompt.length >= 64);
    assert.equal(isLargePayload(prompt), false);
  });
  it('flags base64 wrapped across lines (MIME-style 76-column \\n / \\r\\n wrapping)', () => {
    const blob = Buffer.alloc(600, 9).toString('base64');
    const lf = blob.match(/.{1,76}/g)!.join('\n');
    const crlf = blob.match(/.{1,76}/g)!.join('\r\n');
    assert.equal(isLargePayload(lf), true);
    assert.equal(isLargePayload(crlf), true);
    assert.match(String(sanitizeForLog({ image: lf })['image' as never]), /\(\.\.\.\) \[\d+ chars\]/);
  });

  it('does not flag a multi-line prompt (it has spaces), nor a run of bare newlines', () => {
    assert.equal(isLargePayload('A red fox\nrunning through\nthe snowy forest at dawn, cinematic lighting'), false);
    assert.equal(isLargePayload('\n'.repeat(200)), false);
  });

  it('does not flag short base64-charset tokens (e.g. a seed/path stem)', () => {
    assert.equal(isLargePayload('abc123'), false);
  });
  it('does not flag file paths', () => {
    assert.equal(isLargePayload('C:\\Users\\me\\out\\image.png'), false);
  });
});

describe('sanitizeForLog', () => {
  it('collapses a bare base64 blob to first5(...) + length', () => {
    assert.equal(sanitizeForLog(BLOB), `iVBOR(...) [${BLOB.length} chars]`);
  });

  it('preserves the data: URL header and truncates only the payload', () => {
    const url = 'data:image/png;base64,' + BLOB;
    assert.equal(sanitizeForLog(url), `data:image/png;base64,iVBOR(...) [${BLOB.length} chars]`);
  });

  it('leaves ordinary strings, numbers, booleans and null untouched', () => {
    assert.equal(sanitizeForLog('hello world'), 'hello world');
    assert.equal(sanitizeForLog(42), 42);
    assert.equal(sanitizeForLog(true), true);
    assert.equal(sanitizeForLog(null), null);
  });

  it('recurses into request args (reference_images mix of path + base64)', () => {
    const args = { prompt: 'a cat', reference_images: ['C:\\a.png', BLOB], seed: 7 };
    assert.deepEqual(sanitizeForLog(args), {
      prompt: 'a cat',
      reference_images: ['C:\\a.png', `iVBOR(...) [${BLOB.length} chars]`],
      seed: 7,
    });
  });

  it('recurses into a tool result, truncating image.data and resource.blob', () => {
    const result = {
      content: [
        { type: 'text', text: 'Generated 1 image.' },
        { type: 'image', data: BLOB, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x.mp4', mimeType: 'video/mp4', blob: BLOB } },
      ],
    };
    assert.deepEqual(sanitizeForLog(result), {
      content: [
        { type: 'text', text: 'Generated 1 image.' },
        { type: 'image', data: `iVBOR(...) [${BLOB.length} chars]`, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x.mp4', mimeType: 'video/mp4', blob: `iVBOR(...) [${BLOB.length} chars]` } },
      ],
    });
  });

  it('does not mutate the original input', () => {
    const args = { reference_images: [BLOB] };
    sanitizeForLog(args);
    assert.equal(args.reference_images[0], BLOB);
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a['self'] = a;
    const out = sanitizeForLog(a) as Record<string, unknown>;
    assert.equal(out['name'], 'x');
    assert.equal(out['self'], '[Circular]');
  });

  it('renders Error objects as name: message', () => {
    assert.equal(sanitizeForLog(new TypeError('boom')), 'TypeError: boom');
  });
});
