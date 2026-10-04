/**
 * The GPU probe behind `health_status` (`src/util/sysinfo.ts`). It used to run
 * `execFileSync('nvidia-smi')` twice per health call — blocking the whole server (every
 * session, every in-flight job) for up to 8 s. Now: async, one query shared by concurrent
 * callers, cached for a short TTL. Uses an injected query — no nvidia-smi needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGpuProbe, parseNvidiaSmi } from '../src/util/sysinfo.js';

const LINE = 'NVIDIA GeForce RTX 4080, 16376, 14000\n';

describe('parseNvidiaSmi', () => {
  it('reads name / total / free MB from the first GPU line', () => {
    assert.deepEqual(parseNvidiaSmi(LINE + 'Second GPU, 1, 1\n'), { name: 'NVIDIA GeForce RTX 4080', totalMB: 16376, freeMB: 14000 });
  });
  it('null for empty or malformed output', () => {
    assert.equal(parseNvidiaSmi(''), null);
    assert.equal(parseNvidiaSmi('garbage'), null);
  });
});

describe('createGpuProbe', () => {
  it('concurrent callers share ONE query, and the answer is cached for the TTL', async () => {
    let calls = 0;
    let now = 0;
    const probe = createGpuProbe({
      ttlMs: 1000,
      now: () => now,
      query: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return LINE;
      },
    });
    const [a, b, c] = await Promise.all([probe(), probe(), probe()]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    now = 500;
    await probe();
    assert.equal(calls, 1, 'within the TTL → cached');
    now = 1500;
    await probe();
    assert.equal(calls, 2, 'after the TTL → re-queried');
  });

  it('a failing query (no nvidia-smi) resolves null and is cached too', async () => {
    let calls = 0;
    const probe = createGpuProbe({
      ttlMs: 1000,
      now: () => 0,
      query: async () => {
        calls++;
        throw new Error('spawn nvidia-smi ENOENT');
      },
    });
    assert.equal(await probe(), null);
    assert.equal(await probe(), null);
    assert.equal(calls, 1);
  });

  it('does not block the event loop while the query runs', async () => {
    let release!: () => void;
    const probe = createGpuProbe({ ttlMs: 0, query: () => new Promise((r) => (release = () => r(LINE))) });
    const pending = probe();
    let ticked = false;
    await new Promise<void>((r) => setImmediate(() => { ticked = true; r(); }));
    assert.ok(ticked, 'other work ran while the GPU query was outstanding');
    release();
    assert.equal((await pending)?.freeMB, 14000);
  });
});
