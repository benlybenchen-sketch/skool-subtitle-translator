import type { TimedUnit } from '../shared/types';
import type { UnitPayload, UnitResult } from '../shared/messages';
import type { Timeline } from '../subtitles/timeline';

export interface TranslateBridge {
  translate(videoKey: string, units: UnitPayload[], context: string[]): Promise<UnitResult[]>;
  cancel(videoKey: string): void;
}

export interface SchedulerOptions {
  maxInFlight: number;
  batchSize: number;
  batchChars: number;
  contextSize: number;
  /** Seconds behind the playhead still worth translating (just-missed lines). */
  lookBehind: number;
  /** Seconds ahead of the playhead to prefetch (scaled by playback rate). */
  lookAhead: number;
  maxAttempts: number;
  retryBaseMs: number;
  now: () => number;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = {
  maxInFlight: 2,
  batchSize: 10,
  batchChars: 1400,
  contextSize: 3,
  lookBehind: 3,
  lookAhead: 150,
  maxAttempts: 4,
  retryBaseMs: 1500,
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Content-side translation scheduler. Decides WHICH units to translate next:
 * the ones closest ahead of the playhead first (prefetch window), then nothing
 * beyond the look-ahead to avoid paying for parts of the video never watched.
 * Re-prioritises instantly after seeking. Never blocks rendering.
 */
export class TranslationScheduler {
  readonly o: SchedulerOptions;
  private inFlight = 0;
  private playhead = 0;
  private rate = 1;
  private disposed = false;
  private fatal: string | null = null;
  private retryAt = new Map<string, number>();
  private retryTimer: unknown = null;
  private enabled = true;

  constructor(
    private timeline: Timeline,
    private readonly videoKey: string,
    private readonly bridge: TranslateBridge,
    private readonly onUpdate: (changed: TimedUnit[]) => void,
    private readonly onFatal: (msg: string) => void,
    opts: Partial<SchedulerOptions> = {},
  ) {
    this.o = { ...DEFAULT_SCHEDULER, ...opts };
  }

  get fatalError(): string | null {
    return this.fatal;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  setTimeline(tl: Timeline): void {
    this.timeline = tl;
    this.pump();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.pump();
  }

  setPlayhead(t: number, rate = 1): void {
    this.playhead = Number.isFinite(t) ? t : 0;
    this.rate = rate > 0 ? rate : 1;
    this.pump();
  }

  /** Clear a fatal error (e.g. after settings change) and resume. */
  resume(): void {
    this.fatal = null;
    for (const u of this.timeline.units) if (u.status === 'error') {
      u.status = 'pending';
      u.attempts = 0;
    }
    this.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) this.o.clearTimer(this.retryTimer);
    this.bridge.cancel(this.videoKey);
  }

  pump(): void {
    while (!this.disposed && this.enabled && !this.fatal && this.inFlight < this.o.maxInFlight) {
      const batch = this.nextBatch();
      if (!batch) break;
      void this.send(batch.units, batch.context);
    }
  }

  private eligible(u: TimedUnit, now: number): boolean {
    return u.status === 'pending' && (this.retryAt.get(u.id) ?? 0) <= now;
  }

  /** Exposed for tests. */
  nextBatch(): { units: TimedUnit[]; context: string[] } | null {
    const units = this.timeline.units;
    if (!units.length) return null;
    const now = this.o.now();
    const from = this.timeline.firstIndexEndingAfter(this.playhead - this.o.lookBehind);
    const horizon = this.playhead + this.o.lookAhead * Math.max(1, this.rate);
    let first = -1;
    let earliestRetry = Infinity;
    for (let i = from; i < units.length && units[i].start <= horizon; i++) {
      const u = units[i];
      if (this.eligible(u, now)) {
        first = i;
        break;
      }
      if (u.status === 'pending') earliestRetry = Math.min(earliestRetry, this.retryAt.get(u.id) ?? Infinity);
    }
    if (first < 0) {
      if (Number.isFinite(earliestRetry)) this.armRetry(earliestRetry - now);
      return null;
    }
    const batch: TimedUnit[] = [];
    let chars = 0;
    for (let i = first; i < units.length && batch.length < this.o.batchSize && units[i].start <= horizon; i++) {
      const u = units[i];
      if (!this.eligible(u, now)) break; // keep batches contiguous for context quality
      if (batch.length && chars + u.text.length > this.o.batchChars) break;
      batch.push(u);
      chars += u.text.length;
    }
    const context = units.slice(Math.max(0, first - this.o.contextSize), first).map((u) => u.text);
    return { units: batch, context };
  }

  private armRetry(ms: number): void {
    if (this.retryTimer) return;
    this.retryTimer = this.o.setTimer(() => {
      this.retryTimer = null;
      this.pump();
    }, Math.max(50, ms));
  }

  private async send(batch: TimedUnit[], context: string[]): Promise<void> {
    this.inFlight++;
    for (const u of batch) u.status = 'inflight';
    let results: UnitResult[] | null = null;
    let transportError: string | null = null;
    try {
      results = await this.bridge.translate(
        this.videoKey,
        batch.map((u) => ({ id: u.id, text: u.text })),
        context,
      );
    } catch (e) {
      transportError = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight--;
    }
    if (this.disposed) return;
    const byId = new Map((results ?? []).map((r) => [r.id, r]));
    const changed: TimedUnit[] = [];
    for (const u of batch) {
      const r = byId.get(u.id);
      if (r?.vi) {
        u.vi = r.vi;
        u.status = 'done';
        this.retryAt.delete(u.id);
        changed.push(u);
        continue;
      }
      u.attempts++;
      if (r?.fatal) {
        u.status = 'pending';
        u.attempts = 0;
        this.fatal = r.error ?? 'Translation configuration error';
        continue;
      }
      if (u.attempts >= this.o.maxAttempts) {
        u.status = 'error';
        changed.push(u);
      } else {
        u.status = 'pending';
        this.retryAt.set(u.id, this.o.now() + this.o.retryBaseMs * 2 ** (u.attempts - 1));
      }
    }
    if (changed.length) this.onUpdate(changed);
    if (this.fatal) {
      this.onFatal(this.fatal);
      return;
    }
    if (transportError && batch.every((u) => u.status !== 'done')) {
      // background unreachable (e.g. service worker restarting): retry later
      this.armRetry(this.o.retryBaseMs);
      return;
    }
    this.pump();
  }
}
