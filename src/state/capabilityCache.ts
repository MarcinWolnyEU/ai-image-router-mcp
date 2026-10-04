import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One cached answer and when it was obtained. */
export interface CacheEntry {
  at: number;
  value: unknown;
}

/** A small persistent key → value store for gateway capability lookups. */
export interface CapabilityCache {
  /** The entry for `key` (with its age) when it is younger than `maxAgeMs`, else undefined. */
  get(key: string, maxAgeMs: number): (CacheEntry & { ageMs: number }) | undefined;
  set(key: string, value: unknown): void;
}

/**
 * Capability cache persisted as one JSON file (`.cache/capabilities.json` in the project).
 * It exists so a server start does not wait on the network: stdio clients spawn a fresh
 * process per session — Vibe CLI per TOOL CALL — and each used to block in the OpenRouter
 * capability lookup (up to 12 s on a slow API). Read once, synchronously, at construction;
 * writes are atomic (temp file + rename) and best-effort — a cache that can't be read or
 * written just behaves as empty.
 */
export class FileCapabilityCache implements CapabilityCache {
  private readonly entries: Record<string, CacheEntry>;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    let entries: Record<string, CacheEntry> = {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as Record<string, CacheEntry>;
    } catch {
      /* missing or corrupt → empty */
    }
    this.entries = entries;
  }

  get(key: string, maxAgeMs: number): (CacheEntry & { ageMs: number }) | undefined {
    const e = this.entries[key];
    if (!e || typeof e.at !== 'number') return undefined;
    const ageMs = this.now() - e.at;
    return ageMs > maxAgeMs ? undefined : { ...e, ageMs };
  }

  set(key: string, value: unknown): void {
    this.entries[key] = { at: this.now(), value };
    const snapshot = JSON.stringify(this.entries, null, 2);
    const tmp = `${this.path}.tmp-${process.pid}`;
    this.pending = this.pending
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(tmp, snapshot);
        await rename(tmp, this.path);
      })
      .catch(() => {
        /* best-effort: the next start just refetches */
      });
  }

  /** Resolves once queued writes have landed (tests, shutdown). */
  flushed(): Promise<void> {
    return this.pending;
  }
}
