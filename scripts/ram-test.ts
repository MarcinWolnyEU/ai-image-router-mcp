/**
 * ram-test.ts — measure peak process RSS for a BiRefNet background-removal run,
 * so we can derive a sensible "minimum free RAM" guard per model.
 *
 *   npx tsx scripts/ram-test.ts <birefnet-general|birefnet-massive> [ep] [imagePath]
 *
 * Reports OS total/free RAM, baseline RSS, peak RSS during load+inference, and the
 * delta (≈ extra RAM the operation needs to be free). Prints a JSON line at the end.
 */
import os from 'node:os';
import { execSync } from 'node:child_process';
import { Logger } from '../src/logging/logger.js';
import { BiRefNetRemover } from '../src/bgremoval/birefnet.js';
import { resolvePath } from '../src/config/paths.js';
import { readFile } from 'node:fs/promises';
import type { BgModelKey } from '../src/bgremoval/models.js';

const gb = (b: number) => (b / 1024 ** 3).toFixed(2);

/** Per-process GPU memory (MiB) for this PID via nvidia-smi; 0 if unavailable. */
function gpuMiBForPid(pid: number): number {
  try {
    const out = execSync('nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.trim().split('\n')) {
      const [p, mem] = line.split(',').map((s) => s.trim());
      if (Number(p) === pid) return Number(mem) || 0;
    }
  } catch {
    /* nvidia-smi absent or no GPU */
  }
  return 0;
}

/** Total GPU memory used (MiB) — captures DirectX (DML/WebGPU) allocations that the
 *  per-process compute-apps query (CUDA-only) misses. 0 if nvidia-smi is unavailable. */
function gpuMiBTotalUsed(): number {
  try {
    const out = execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number(out.trim().split('\n')[0]) || 0;
  } catch {
    return 0;
  }
}

async function main() {
  const model = (process.argv[2] as BgModelKey) ?? 'birefnet-general';
  const ep = process.argv[3] ?? 'cpu';
  const image = process.argv[4] ?? 'output/2026-06-05_22-47-39_crop_bacb8c69.png';

  const logger = new Logger('none', 'logs');
  await logger.init();

  let peakRss = process.memoryUsage().rss;
  let peakGpuMiB = 0;
  const baseline = peakRss;
  const gpuBaseline = gpuMiBTotalUsed();
  let peakGpuTotal = gpuBaseline;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
    const g = gpuMiBForPid(process.pid);
    if (g > peakGpuMiB) peakGpuMiB = g;
    const t = gpuMiBTotalUsed();
    if (t > peakGpuTotal) peakGpuTotal = t;
  }, 200);

  console.error(`[ram-test] model=${model} ep=${ep}`);
  console.error(`[ram-test] os total=${gb(os.totalmem())}GB free=${gb(os.freemem())}GB baseline rss=${gb(baseline)}GB`);

  const remover = new BiRefNetRemover(model, ep, 'models', logger);
  const t0 = Date.now();
  try {
    await remover.init();
    const afterInit = process.memoryUsage().rss;
    console.error(`[ram-test] session ready ep=${remover.activeEP} rss=${gb(afterInit)}GB (+${gb(afterInit - baseline)}GB)`);
    const bytes = await readFile(resolvePath(image));
    const png = await remover.removeBackground(bytes);
    clearInterval(sampler);
    if (process.env.RAM_TEST_SAVE) {
      const { writeFile } = await import('node:fs/promises');
      const outPath = resolvePath(`output/ram-test_${model}_${remover.activeEP}.png`);
      await writeFile(outPath, png);
      console.error(`[ram-test] saved ${outPath}`);
    }
    const result = {
      ok: true,
      model,
      ep: remover.activeEP,
      seconds: ((Date.now() - t0) / 1000).toFixed(1),
      totalGB: gb(os.totalmem()),
      freeBeforeGB: gb(os.freemem()),
      baselineRssGB: gb(baseline),
      peakRssGB: gb(peakRss),
      peakDeltaGB: gb(peakRss - baseline),
      peakGpuPidMiB: peakGpuMiB,
      vramDeltaMiB: peakGpuTotal - gpuBaseline,
    };
    console.error('[ram-test] RESULT', JSON.stringify(result));
  } catch (err) {
    clearInterval(sampler);
    console.error('[ram-test] FAILED', JSON.stringify({
      ok: false, model, ep, error: (err as Error).message,
      freeBeforeGB: gb(os.freemem()), peakRssGB: gb(peakRss),
      peakGpuPidMiB: peakGpuMiB, vramDeltaMiB: peakGpuTotal - gpuBaseline,
    }));
    process.exitCode = 1;
  }
}

main();
