/**
 * Background-removal model download (`ensureModelFile`) over a stubbed `fetch` — no network.
 * The write side used to be an unpiped `createWriteStream`: a write error (ENOSPC/EACCES,
 * or the target vanishing) raised while the loop awaited the next chunk had NO listener,
 * became an uncaughtException and killed the server — on the startup pre-warm path.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureModelFile, type BgModelSpec } from '../src/bgremoval/models.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BYTES = Buffer.alloc(256 * 1024, 7);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const spec = (hash = md5(BYTES)): BgModelSpec =>
  ({ key: 'isnet-general-use', filename: 'fake-model.onnx', url: 'https://models.invalid/fake-model.onnx', hash: { algo: 'md5', value: hash }, approxMB: 1 }) as unknown as BgModelSpec;

function serve(body: Buffer): void {
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })) as typeof fetch;
}

describe('ensureModelFile', () => {
  it('downloads, verifies the checksum and renames into place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    serve(BYTES);
    const path = await ensureModelFile(spec(), dir);
    assert.equal(path, join(dir, 'fake-model.onnx'));
    assert.ok(readFileSync(path).equals(BYTES));
    assert.equal(existsSync(`${path}.part`), false);
  });

  it('a WRITE failure rejects cleanly (no uncaught stream error that would kill the server)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    mkdirSync(join(dir, 'fake-model.onnx.part')); // the temp target is a directory → the write stream errors
    serve(BYTES);
    await assert.rejects(ensureModelFile(spec(), dir), /fake-model\.onnx/);
    assert.equal(existsSync(join(dir, 'fake-model.onnx')), false);
  });

  it('a checksum mismatch rejects and leaves no partial file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    serve(BYTES);
    await assert.rejects(ensureModelFile(spec('0'.repeat(32)), dir), /Checksum mismatch/);
    assert.equal(existsSync(join(dir, 'fake-model.onnx.part')), false);
    assert.equal(existsSync(join(dir, 'fake-model.onnx')), false);
  });
});
