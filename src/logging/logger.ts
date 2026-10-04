import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePath } from '../config/paths.js';

export type LoggingPolicy = 'none' | 'today' | 'persistent-daily';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
  meta?: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? `${val.name}: ${val.message}` : val));
  } catch {
    return String(v);
  }
}

/**
 * Logs always go to STDERR (stdout is reserved for the MCP protocol on stdio).
 * File logging follows the policy:
 *  - none             → stderr only
 *  - today            → logs/<YYYY-MM-DD>.log, older day-files pruned on init
 *  - persistent-daily → logs/<YYYY-MM-DD>.log, kept forever (rolls at midnight)
 */
export class Logger {
  private ring: LogEntry[] = [];
  private minLevel: LogLevel;

  constructor(
    private policy: LoggingPolicy,
    private dir: string,
    opts: { ringSize?: number; minLevel?: LogLevel } = {},
  ) {
    this.ringSize = opts.ringSize ?? 250;
    this.minLevel = opts.minLevel ?? 'info';
    this.dir = resolvePath(dir);
  }

  private ringSize: number;

  async init(): Promise<void> {
    if (this.policy === 'none') return;
    await mkdir(this.dir, { recursive: true }).catch(() => {});
    if (this.policy === 'today') {
      const today = `${this.day()}.log`;
      const files = await readdir(this.dir).catch(() => [] as string[]);
      for (const f of files) {
        if (/^\d{4}-\d{2}-\d{2}\.log$/.test(f) && f !== today) {
          await rm(join(this.dir, f)).catch(() => {});
        }
      }
    }
  }

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private emit(level: LogLevel, msg: string, meta?: unknown): void {
    const entry: LogEntry = { time: new Date().toISOString(), level, msg, ...(meta !== undefined ? { meta } : {}) };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.shift();

    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${msg}${meta !== undefined ? ' ' + safeJson(meta) : ''}\n`;
    process.stderr.write(line);
    if (this.policy !== 'none') {
      void appendFile(join(this.dir, `${this.day()}.log`), line).catch(() => {});
    }
  }

  debug(msg: string, meta?: unknown): void {
    this.emit('debug', msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.emit('info', msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.emit('warn', msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.emit('error', msg, meta);
  }

  recent(n = 25): LogEntry[] {
    return this.ring.slice(-n);
  }

  get loggingPolicy(): LoggingPolicy {
    return this.policy;
  }
}
