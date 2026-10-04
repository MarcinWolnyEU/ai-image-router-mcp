/**
 * Unit tests for the in-memory generation job store (src/state/generationJobs.ts):
 * the submit → poll-by-`job_id` primitive that decouples a slow image/video
 * generation from the MCP call that submitted it. The store is pass-through; the
 * async orchestration itself lives on `runtime` (needs a live gateway), so we
 * test put/get + prune.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationJobStore, retainedBytes, type GenerationJob } from '../src/state/generationJobs.js';

function job(id: string, status: GenerationJob['status'], ts: number): GenerationJob {
  return { id, gateway: 'openrouter', model: 'x', kind: 'image', status, createdAt: ts, updatedAt: ts };
}

describe('GenerationJobStore', () => {
  it('round-trips a job by id and reports a miss for an unknown id', () => {
    const store = new GenerationJobStore();
    const j = job('abc', 'in-progress', 1);
    store.put(j);
    assert.equal(store.get('abc')?.status, 'in-progress');
    assert.equal(store.get('def'), undefined);
  });

  it('keeps the newest finished jobs and drops the oldest once the cap is exceeded', () => {
    const store = new GenerationJobStore();
    // 205 completed jobs (well over the 200 cap) + one active job.
    for (let i = 0; i < 205; i++) store.put(job(`done-${i}`, 'completed', i));
    store.put(job('active', 'in-progress', 10000));

    // The active job (newest, never pruned) survives.
    assert.equal(store.get('active')?.status, 'in-progress');
    // The earliest finished job was pruned; the latest finished job survives.
    assert.equal(store.get('done-0'), undefined);
    assert.equal(store.get('done-204')?.status, 'completed');
  });
});

describe('GenerationJobStore payload bounds (TTL + memory budget)', () => {
  const MB = 1024 * 1024;
  /** A completed job holding `mb` MiB of raw image bytes (not yet saved anywhere). */
  function heavy(id: string, mb: number, finishedAt: number): GenerationJob {
    return {
      ...job(id, 'completed', finishedAt),
      finishedAt,
      result: { images: [{ bytes: Buffer.alloc(mb * MB), mimeType: 'image/png' }], modelUsed: 'm', raw: {} },
    };
  }
  /** The same, after its render failed and the raw output was rescued to disk. */
  function rescued(id: string, mb: number, finishedAt: number): GenerationJob {
    return { ...heavy(id, mb, finishedAt), renderError: 'disk hiccup', rescuedFiles: [`/out/${id}-unsaved-1.png`] };
  }

  it('NEVER releases an unsaved raw result (render failed, nothing on disk) — past the TTL or the budget', () => {
    let now = 0;
    const store = new GenerationJobStore({ finishedTtlMs: 10, maxRetainedBytes: 1, now: () => now });
    const j = { ...heavy('paid', 2, 0), renderError: 'fitSquare: cannot upscale' };
    store.put(j);
    now = 10 * 60 * 60_000;
    const after = store.get('paid')!;
    assert.ok(after.result, 'the only copy of a paid generation must survive both bounds');
    assert.equal(after.released, undefined);
  });

  it('never deletes an unsaved job to satisfy the job-count cap', () => {
    const store = new GenerationJobStore({ maxJobs: 2, now: () => 0 });
    store.put(heavy('unsaved', 1, 0));
    for (let i = 1; i <= 5; i++) store.put({ ...job(`done-${i}`, 'completed', i), finishedAt: i });
    assert.ok(store.get('unsaved')?.result, 'kept until rendered or rescued');
    assert.equal(store.get('done-1'), undefined, 'saved jobs still make room');
  });

  it('a RESCUED raw result (already on disk) may be released, keeping the rescue paths', () => {
    let now = 0;
    const store = new GenerationJobStore({ finishedTtlMs: 10, now: () => now });
    store.put(rescued('r', 1, 0));
    now = 100;
    const after = store.get('r')!;
    assert.equal(after.result, undefined);
    assert.match(after.released ?? '', /after the job finished/);
    assert.deepEqual(after.rescuedFiles, ['/out/r-unsaved-1.png']);
  });

  it('retainedBytes counts raw media plus base64 in the rendered reply', () => {
    const j = heavy('a', 1, 0);
    j.rendered = { content: [{ type: 'image', data: 'x'.repeat(100), mimeType: 'image/png' }, { type: 'text', text: 'hi' }] };
    assert.equal(retainedBytes(j), MB + 100);
  });

  it('releases a finished job’s payload after the TTL, keeping its text + file links and saying why', () => {
    let now = 0;
    const store = new GenerationJobStore({ finishedTtlMs: 1000, now: () => now });
    const j = heavy('a', 1, 0);
    j.rendered = {
      content: [
        { type: 'text', text: 'Generated 1 image(s). #1: /out/a.png' },
        { type: 'resource_link', uri: 'file:///out/a.png', name: 'a.png' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    };
    store.put(j);
    now = 500;
    assert.ok(store.get('a')?.result, 'within the TTL the payload is kept');
    now = 1500;
    const after = store.get('a')!;
    assert.equal(after.result, undefined, 'raw bytes released');
    assert.match(after.released ?? '', /after the job finished/);
    const types = after.rendered!.content.map((b) => b.type);
    assert.deepEqual(types, ['text', 'resource_link', 'text'], 'inline image dropped, links kept, note appended');
    assert.equal(retainedBytes(after), 0);
  });

  it('releases the OLDEST payloads first once the memory budget is exceeded; active jobs are never touched', () => {
    const store = new GenerationJobStore({ maxRetainedBytes: 3 * MB, now: () => 0 });
    const active: GenerationJob = { ...job('active', 'in-progress', 0) };
    store.put(active);
    store.put(rescued('old', 2, 1));
    store.put(rescued('mid', 2, 2));
    store.put(rescued('new', 1, 3));
    assert.equal(store.get('old')?.result, undefined, 'oldest released');
    assert.match(store.get('old')?.released ?? '', /memory budget/);
    assert.ok(store.get('mid')?.result, 'newer payloads kept once under budget');
    assert.ok(store.get('new')?.result);
    assert.equal(store.get('active')?.status, 'in-progress');
  });

  it('does not release a payload whose render is in flight (it is about to reach disk)', () => {
    let now = 0;
    const store = new GenerationJobStore({ finishedTtlMs: 10, now: () => now });
    const j = heavy('a', 1, 0);
    j.renderInFlight = new Promise(() => {});
    store.put(j);
    now = 100;
    assert.ok(store.get('a')?.result, 'kept while rendering');
  });
});
