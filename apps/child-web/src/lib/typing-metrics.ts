import type { TypingMetrics } from '@ijime/api-types';

export const LONG_PAUSE_MS = 3000;

export class TypingMetricsTracker {
  private keyCount = 0;
  private deleteCount = 0;
  private longPauseCount = 0;
  private firstKeyAt: number | null = null;
  private lastKeyAt: number | null = null;
  private composing = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  compositionStart(): void {
    this.composing = true;
  }

  compositionEnd(): void {
    this.composing = false;
  }

  key(kind: 'char' | 'delete'): void {
    const t = this.now();
    if (this.firstKeyAt === null) this.firstKeyAt = t;
    if (this.lastKeyAt !== null && t - this.lastKeyAt > LONG_PAUSE_MS) this.longPauseCount += 1;
    this.lastKeyAt = t;
    this.keyCount += 1;
    if (kind === 'delete' && !this.composing) this.deleteCount += 1;
  }

  snapshot(): TypingMetrics {
    const t = this.now();
    return {
      keyCount: this.keyCount,
      deleteCount: this.deleteCount,
      composeMs: this.firstKeyAt === null ? 0 : Math.max(0, t - this.firstKeyAt),
      longPauseCount: this.longPauseCount,
    };
  }

  reset(): void {
    this.keyCount = 0;
    this.deleteCount = 0;
    this.longPauseCount = 0;
    this.firstKeyAt = null;
    this.lastKeyAt = null;
    this.composing = false;
  }
}
