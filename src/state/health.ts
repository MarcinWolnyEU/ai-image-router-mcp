/** Live (in-memory) health state, distinct from the persisted wizard diagnostics. */

export interface RuntimeErrorEntry {
  time: string;
  where: string;
  message: string;
}

export type BackgroundModelStatus = 'disabled' | 'pending' | 'downloading' | 'ready' | 'error';

export class HealthState {
  startedAt = Date.now();
  reloadedAt: number | null = null;
  activeExecutionProvider: string | null = null;
  backgroundModelStatus: BackgroundModelStatus = 'disabled';
  backgroundModelError: string | null = null;
  lastImageAt: number | null = null;
  lastVideoAt: number | null = null;
  generationCount = 0;

  private errors: RuntimeErrorEntry[] = [];

  recordError(where: string, message: string): void {
    this.errors.push({ time: new Date().toISOString(), where, message });
    if (this.errors.length > 100) this.errors.shift();
  }

  recentErrors(n = 20): RuntimeErrorEntry[] {
    return this.errors.slice(-n);
  }

  markReloaded(): void {
    this.reloadedAt = Date.now();
  }

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}
