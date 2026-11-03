import type { TimedUnit } from '../shared/types';
import type { UnitPayload, UnitResult } from '../shared/messages';
import type { Timeline } from '../subtitles/timeline';

export interface TranslateBridge {
  translate(videoKey: string, units: UnitPayload[], context: string[], priority?: number): Promise<UnitResult[]>;
  cancel(videoKey: string): void;
}

export interface SchedulerOptions {
  maxInFlight: number;
  /** Small first batch → fast first Vietnamese subtitle. */
  firstBatchSize: number;
  /** Normal batch size (8–12 cues recommended). */
  batchSize: number;
  batchChars: number;
  contextSize: number;
  /** Seconds behind the playhead still worth translating (just-missed lines). */
  lookBehind: number;
  /** P1 window: segments needed right now (s, scaled by playback rate). */
  nowWindow: number;
  /** P2 window (s). */
  urgentWindow: number;
  /** P3 prefetch window (s). */
  lookAhead: number;
  /** P4: translate the remaining accessible transcript in the background. */
  pretranslateAll: boolean;
  /** Request slots P4 may use, so urgent work always finds a free slot. */
  maxBackgroundInFlight: number;
  maxAttempts: number;
  retryBaseMs: number;
  now: () => number;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = {
  maxInFlight: 2,
  firstBatchSize: 4,
  batchSize: 10,
  batchChars: 1400,
  contextSize: 3,
  lookBehind: 3,
  nowWindow: 4,
  urgentWindow: 30,
  lookAhead: 90,
  pretranslateAll: true,
  maxBackgroundInFlight: 1,
  maxAttempts: 4,
  retryBaseMs: 1500,
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Priority = 1 | 2 | 3 | 4;

/**
 * Content-side translation scheduler with four priority tiers relative to the playhead:
 *  P1 needed now · P2 next 30 s · P3 next 90 s · P4 rest of the transcript (background).
 * Translation starts as soon as cues are known — never when a cue is displayed. Seeking only
 * re-prioritises; in-flight and completed work is never thrown away. Never blocks rendering.
 */
export class TranslationScheduler {
  readonly o: SchedulerOptions;
  private inFlight = 0;
  private bgInFlight = 0;
  private playhead = 0;
  private rate = 1;
  private disposed = false;
  private fatal: string | null = null;
  private retryAt = new Map<string, number>();
  private retryTimer: unknown = null;
  private enabled = true;
  private readonly startedAt: number;
  private firstResultAt: number | null = null;
  readonly sentPriorities: Priority[] = [];

  constructor(
    private timeline: Timeline,
    private readonly videoKey: string,
    private readonly bridge: TranslateBridge,
    private readonly onUpdate: (changed: TimedUnit[]) => void,
    private readonly onFatal: (msg: string) => void,
    opts: Partial<SchedulerOptions> = {},
  ) {
    this.o = { ...DEFAULT_SCHEDULER, ...opts };
    this.startedAt = this.o.now();
  }

  get fatalError(): string | null {
    return this.fatal;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  /** Captions available → first translated segment received (measured). */
  get timeToFirstMs(): number | undefined {
    return this.firstResultAt === null ? undefined : this.firstResultAt - this.startedAt;
  }

  /** Share of segments starting within the P3 window that are translated. */
  aheadCoverage(): number {
    const t = this.playhead;
    const end = t + this.o.lookAhead * Math.max(1, this.rate);
    let total = 0;
    let done = 0;
    for (const u of this.timeline.units) {
      if (u.end <= t || u.start > end) continue;
      total++;
      if (u.status === 'done') done++;
    }
    return total ? done / total : 1;
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
    for (const u of this.timeline.units)
      if (u.status === 'error') {
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
      void this.send(batch.units, batch.context, batch.priority);
    }
  }

  private eligible(u: TimedUnit, now: number): boolean {
    return u.status === 'pending' && (this.retryAt.get(u.id) ?? 0) <= now;
  }

  priorityOf(u: TimedUnit): Priority {
    const r = Math.max(1, this.rate);
    const t = this.playhead;
    if (u.start <= t + this.o.nowWindow * r && u.end > t - this.o.lookBehind) return 1;
    if (u.start <= t + this.o.urgentWindow * r && u.end > t) return 2;
    if (u.start <= t + this.o.lookAhead * r && u.end > t) return 3;
    return 4;
  }

  /** Nothing translated yet in the urgent window → use a small batch for fast first output. */
  private coldStart(): boolean {
    const t = this.playhead;
    const end = t + this.o.urgentWindow * Math.max(1, this.rate);
    for (const u of this.timeline.units) {
      if (u.start > end) break;
      if (u.end > t - this.o.lookBehind && u.status === 'done') return false;
    }
    return true;
  }

  /** Exposed for tests. */
  nextBatch(): { units: TimedUnit[]; context: string[]; priority: Priority } | null {
    const units = this.timeline.units;
    if (!units.length) return null;
    const now = this.o.now();
    const from = this.timeline.firstIndexEndingAfter(this.playhead - this.o.lookBehind);
    const horizon = this.playhead + this.o.lookAhead * Math.max(1, this.rate);
    let first = -1;
    let earliestRetry = Infinity;
    const note = (u: TimedUnit) => {
      if (u.status === 'pending') earliestRetry = Math.min(earliestRetry, this.retryAt.get(u.id) ?? Infinity);
    };
    // P1–P3: from the playhead forward, inside the prefetch window.
    for (let i = from; i < units.length && units[i].start <= horizon; i++) {
      if (this.eligible(units[i], now)) {
        first = i;
        break;
      }
      note(units[i]);
    }
    let priority: Priority = 3;
    if (first >= 0) priority = Math.min(3, this.priorityOf(units[first])) as Priority;
    else if (this.o.pretranslateAll && this.bgInFlight < this.o.maxBackgroundInFlight) {
      // P4: rest of the transcript — ahead of the window first, then what lies behind.
      const order = [...Array(units.length).keys()].filter((i) => units[i].start > horizon || i < from);
      for (const i of order) {
        if (this.eligible(units[i], now)) {
          first = i;
          priority = 4;
          break;
        }
        note(units[i]);
      }
    }
    if (first < 0) {
      if (Number.isFinite(earliestRetry)) this.armRetry(earliestRetry - now);
      return null;
    }
    const size = priority <= 2 && this.coldStart() ? this.o.firstBatchSize : this.o.batchSize;
    const batch: TimedUnit[] = [];
    let chars = 0;
    for (let i = first; i < units.length && batch.length < size; i++) {
      const u = units[i];
      if (!this.eligible(u, now)) break; // contiguous batches keep context coherent
      if (priority < 4 && u.start > horizon) break;
      if (batch.length && chars + u.text.length > this.o.batchChars) break;
      batch.push(u);
      chars += u.text.length;
    }
    const context = units.slice(Math.max(0, first - this.o.contextSize), first).map((u) => u.text);
    return { units: batch, context, priority };
  }

  private armRetry(ms: number): void {
    if (this.retryTimer) return;
    this.retryTimer = this.o.setTimer(() => {
      this.retryTimer = null;
      this.pump();
    }, Math.max(50, ms));
  }

  private async send(batch: TimedUnit[], context: string[], priority: Priority): Promise<void> {
    this.inFlight++;
    if (priority === 4) this.bgInFlight++;
    this.sentPriorities.push(priority);
    for (const u of batch) u.status = 'inflight';
    let results: UnitResult[] | null = null;
    let transportError: string | null = null;
    try {
      results = await this.bridge.translate(
        this.videoKey,
        batch.map((u) => ({ id: u.id, text: u.text })),
        context,
        priority,
      );
    } catch (e) {
      transportError = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight--;
      if (priority === 4) this.bgInFlight--;
    }
    if (this.disposed) return;
    const byId = new Map((results ?? []).map((r) => [r.id, r]));
    const changed: TimedUnit[] = [];
    for (const sent of batch) {
      // The timeline may have been rebuilt (new cues after a seek) while this was in flight:
      // apply the result to the current unit object so nothing is lost or re-requested.
      const u = this.timeline.get(sent.id) ?? sent;
      const r = byId.get(u.id);
      if (r?.vi) {
        u.vi = r.vi;
        u.status = 'done';
        this.retryAt.delete(u.id);
        if (this.firstResultAt === null) this.firstResultAt = this.o.now();
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
