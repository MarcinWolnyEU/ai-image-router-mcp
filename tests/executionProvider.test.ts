/**
 * The ONE `auto` execution-provider resolution shared by the runtime (`birefnet.ts`), the
 * wizard and `health_status` (`src/bgremoval/models.ts`). They used to disagree on Windows —
 * the wizard said WebGPU, the runtime opened DirectML — so the WebGPU cascade never fired
 * under `auto` and BiRefNet/bria crashed on DML. Pure, no ONNX session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BG_MODELS, plannedProviders, resolveExecutionProvider } from '../src/bgremoval/models.js';

describe('resolveExecutionProvider (auto)', () => {
  it('Windows → webgpu (every model runs there; DirectML cannot run BiRefNet/bria)', () => {
    assert.equal(resolveExecutionProvider('auto', 'win32', 'x64'), 'webgpu');
  });

  it('macOS → coreml, Linux x64 → cuda, anything else → cpu', () => {
    assert.equal(resolveExecutionProvider('auto', 'darwin', 'arm64'), 'coreml');
    assert.equal(resolveExecutionProvider('auto', 'linux', 'x64'), 'cuda');
    assert.equal(resolveExecutionProvider('auto', 'linux', 'arm64'), 'cpu');
    assert.equal(resolveExecutionProvider('auto', 'freebsd', 'x64'), 'cpu');
  });

  it('an explicit provider passes through unchanged', () => {
    assert.equal(resolveExecutionProvider('dml', 'win32', 'x64'), 'dml');
    assert.equal(resolveExecutionProvider('cpu', 'win32', 'x64'), 'cpu');
  });
});

describe('plannedProviders (what init tries, in order)', () => {
  it('auto + birefnet-general on Windows tries WebGPU first — so the cascaded variant is used — then CPU', () => {
    const plan = plannedProviders(BG_MODELS['birefnet-general'], 'auto', 'win32', 'x64');
    assert.deepEqual(plan.eps, ['webgpu', 'cpu']);
    assert.equal(plan.skipped, undefined);
  });

  it('a provider the model is KNOWN not to run on is skipped up front (no create-then-crash in session.run)', () => {
    const plan = plannedProviders(BG_MODELS['birefnet-general'], 'dml', 'win32', 'x64');
    assert.deepEqual(plan.eps, ['cpu']);
    assert.equal(plan.skipped?.ep, 'dml');
    assert.match(plan.skipped?.note ?? '', /deformable-conv/);
  });

  it('a provider the bundled runtime does not ship on this platform is replaced by CPU (cuda/coreml on Windows)', () => {
    for (const ep of ['cuda', 'coreml'] as const) {
      const plan = plannedProviders(BG_MODELS['isnet-general-use'], ep, 'win32', 'x64');
      assert.deepEqual(plan.eps, ['cpu'], ep);
      assert.equal(plan.skipped?.ep, ep);
      assert.match(plan.skipped?.note ?? '', /no .* provider on win32-x64/);
    }
    assert.deepEqual(plannedProviders(BG_MODELS['isnet-general-use'], 'dml', 'linux', 'x64').eps, ['cpu'], 'DirectML is Windows-only');
    assert.deepEqual(plannedProviders(BG_MODELS['isnet-general-use'], 'auto', 'darwin', 'arm64').eps[0], 'coreml');
  });

  it('a provider the model runs on is kept (isnet on DirectML); cpu stays a single-entry chain', () => {
    assert.deepEqual(plannedProviders(BG_MODELS['isnet-general-use'], 'dml', 'win32', 'x64').eps, ['dml', 'cpu']);
    assert.deepEqual(plannedProviders(BG_MODELS['ben2-base'], 'cpu', 'win32', 'x64').eps, ['cpu']);
  });
});
