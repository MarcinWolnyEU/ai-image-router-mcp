/**
 * Background-remover lifecycle across `restart` (runtime.reload), with a fake remover
 * injected through `runtime.removerFactory` (no ONNX session, no model download):
 *
 *  - an init still loading when a restart lands must never install its STALE session
 *    (old model/EP) over the new config — the stale one is disposed and waiters get the
 *    new config's remover;
 *  - a failing stale init must not cancel a newer in-flight init (which would let a
 *    third init start → two multi-GB sessions loading at once);
 *  - a restart RELEASES the previous session (native memory isn't freed by dropping
 *    the JS reference).
 *
 * `AIR_MCP_CONFIG` must be set before the src modules load — hence dynamic imports.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'air-remover-'));
const cfgPath = join(dir, 'config.json');
process.env.AIR_MCP_CONFIG = cfgPath;
const { runtime } = await import('../src/state/runtime.js');

function writeConfig(model: string): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      gateway: 'fal',
      token: { type: 'inline', value: 'key-id:key-secret' },
      output: { dir: join(dir, 'out') },
      logging: { policy: 'none' },
      image: { model: 'krea/v2/medium/text-to-image', async: false },
      backgroundRemoval: { model, executionProvider: 'cpu', modelsDir: join(dir, 'models') },
    }),
  );
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}
function gate(): Gate {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeRemover {
  disposed = 0;
  readonly activeEP = 'cpu';
  readonly gate = gate();
  constructor(readonly modelKey: string) {}
  init(): Promise<void> {
    return this.gate.promise;
  }
  async removeBackground(b: Buffer): Promise<Buffer> {
    return b;
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

let created: FakeRemover[] = [];
const tick = () => new Promise((r) => setTimeout(r, 5));

before(async () => {
  writeConfig('isnet-general-use');
  await runtime.init();
  runtime.removerFactory = async (modelKey) => {
    const r = new FakeRemover(modelKey);
    created.push(r);
    return r;
  };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('background remover vs restart', () => {
  it('a restart during a slow init never installs the stale session; waiters get the new model', async () => {
    created = [];
    writeConfig('isnet-general-use');
    await runtime.reload();
    const pending = runtime.getRemover();
    await tick();
    assert.equal(created.length, 1);

    writeConfig('ben2-base');
    assert.equal((await runtime.reload()).ok, true);
    created[0]!.gate.resolve(); // the OLD init finishes after the restart
    await tick();
    created[1]?.gate.resolve();

    const got = await pending;
    assert.equal(got.modelKey, 'ben2-base', 'the caller gets the remover for the CURRENT config');
    assert.equal((runtime.remover as FakeRemover | null)?.modelKey, 'ben2-base');
    assert.equal(created[0]!.disposed, 1, 'the stale session is released, not leaked');
    assert.equal(runtime.health.backgroundModelStatus, 'ready');
  });

  it('a failing stale init does not cancel the newer in-flight init (no third concurrent load)', async () => {
    created = [];
    writeConfig('isnet-general-use');
    await runtime.reload();
    const stale = runtime.getRemover().catch((e: Error) => e);
    await tick();
    writeConfig('bria-rmbg');
    await runtime.reload();
    const fresh = runtime.getRemover();
    await tick();
    assert.equal(created.length, 2);

    created[0]!.gate.reject(new Error('download aborted'));
    await tick();
    const again = runtime.getRemover();
    await tick();
    assert.equal(created.length, 2, 'the newer init is still the one in flight');
    assert.notEqual(runtime.health.backgroundModelStatus, 'error', 'a stale failure does not mark the new model as failed');

    created[1]!.gate.resolve();
    assert.equal((await fresh).modelKey, 'bria-rmbg');
    assert.equal((await again).modelKey, 'bria-rmbg');
    await stale;
  });

  it('a restart releases the previous (ready) session', async () => {
    created = [];
    writeConfig('isnet-general-use');
    await runtime.reload();
    const p = runtime.getRemover();
    await tick();
    created[0]!.gate.resolve();
    const first = (await p) as unknown as FakeRemover;
    writeConfig('ben2-base');
    await runtime.reload();
    await tick();
    assert.equal(first.disposed, 1);
    assert.equal(runtime.remover, null, 'the next call builds a session for the new config');
  });
});
