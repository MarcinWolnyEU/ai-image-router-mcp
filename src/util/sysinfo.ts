import os from 'node:os';
import { execFile } from 'node:child_process';

export interface MemInfo {
  freeMB: number;
  totalMB: number;
}

export interface GpuInfo {
  name: string;
  freeMB: number;
  totalMB: number;
}

const toMB = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Free / total system RAM in MB. */
export function memInfo(): MemInfo {
  return { freeMB: toMB(os.freemem()), totalMB: toMB(os.totalmem()) };
}

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` (first GPU). */
export function parseNvidiaSmi(out: string): GpuInfo | null {
  const first = out.trim().split('\n')[0];
  if (!first) return null;
  const [name, total, free] = first.split(',').map((s) => s.trim());
  if (!name || !total || !free || !Number.isFinite(Number(total)) || !Number.isFinite(Number(free))) return null;
  return { name, totalMB: Number(total), freeMB: Number(free) };
}

/** Run nvidia-smi WITHOUT blocking the event loop (a sync spawn stalled every session for seconds). */
function queryNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export interface GpuProbeOptions {
  /** How long an answer (including "no GPU") is reused. Default 10 s. */
  ttlMs?: number;
  /** Returns nvidia-smi's stdout (injectable for tests). */
  query?: () => Promise<string>;
  now?: () => number;
}

/**
 * A GPU-memory probe: async, ONE query shared by concurrent callers, the answer cached for
 * `ttlMs` (free VRAM moves, but not within a health call). Resolves null when nvidia-smi is
 * absent or there's no NVIDIA GPU — treat VRAM as "unknown" then. (Only NVIDIA is queried;
 * AMD/Intel/Apple VRAM isn't reported by a portable CLI.)
 */
export function createGpuProbe(opts: GpuProbeOptions = {}): () => Promise<GpuInfo | null> {
  const ttlMs = opts.ttlMs ?? 10_000;
  const query = opts.query ?? queryNvidiaSmi;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: GpuInfo | null } | null = null;
  let inflight: Promise<GpuInfo | null> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    inflight ??= query()
      .then(parseNvidiaSmi, () => null)
      .then((value) => {
        cached = { at: now(), value };
        inflight = null;
        return value;
      });
    return inflight;
  };
}

/** The process-wide GPU probe (health_status, wizard). */
export const gpuInfo = createGpuProbe();

/** "8.5 / 31.9 GB" style string from MB values. */
export function fmtGB(usedFreeMB: number, totalMB: number): string {
  return `${(usedFreeMB / 1024).toFixed(1)} / ${(totalMB / 1024).toFixed(1)} GB`;
}
