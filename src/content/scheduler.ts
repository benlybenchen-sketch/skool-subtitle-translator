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
  /** P3/P4 batches (not urgent): larger → fewer requests per minute (free-tier quotas). */
  backgroundBatchSize: number;
  batchChars: number;
  contextSize: number;
  /** Seconds behind the playhead still worth translating (just-missed lines). */
  lookBehind: number;
  /** P0: the cue needed right now (or starting within this many seconds). */
  nowWindow: number;
  /** P1 window: upcoming 0–15 s (scaled by playback rate). */
  urgentWindow: number;
  /** P2 window: upcoming 15–60 s. */
  nearWindow: number;
  /** P3: remaining prefetch lookahead (mode-dependent: 45 / 90 / 120 s). */
  lookAhead: number;
  /** Non-urgent batches smaller than half a batch wait until their first cue is this close (s). */
  minLeadSec: number;
  /** P4: translate the remaining accessible transcript in the background. */
  pretranslateAll: boolean;
  /** Request slots P4 may use, so urgent work always finds a free slot. */
  maxBackgroundInFlight: number;
  maxAttempts: number;
  retryBaseMs: number;
  /** A unit that exhausted its attempts becomes eligible again after this cooldown (transient outages). */
  errorCooldownMs: number;
  /** After a fatal (configuration-classified) error, probe again after this, doubling up to fatalMaxBackoffMs. */
  fatalBackoffMs: number;
  fatalMaxBackoffMs: number;
  /** A request without an answer for this long is treated as stalled; its units are re-queued. */
  stallMs: number;
  now: () => number;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export const DEFAULT_SCHEDULER: SchedulerOptions = {
  maxInFlight: 2,
  firstBatchSize: 4,
  batchSize: 10,
  backgroundBatchSize: 20,
  batchChars: 2400,
  contextSize: 3,
  lookBehind: 3,
  nowWindow: 2,
  urgentWindow: 15,
  nearWindow: 60,
  lookAhead: 90,
  minLeadSec: 20,
  pretranslateAll: true,
  maxBackgroundInFlight: 1,
  maxAttempts: 4,
  retryBaseMs: 1500,
  errorCooldownMs: 30_000,
  fatalBackoffMs: 30_000,
  fatalMaxBackoffMs: 5 * 60_000,
  stallMs: 90_000,
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** P0 current cue · P1 0–15 s · P2 15–60 s · P3 rest of the lookahead · P4 background transcript. */
export type Priority = 0 | 1 | 2 | 3 | 4;

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
  private errorAt = new Map<string, number>();
  private fatalTimer: unknown = null;
  private fatalBackoff: number;
  private inflightBatches = new Map<number, { sentAt: number; ids: string[]; priority: Priority }>();
  private batchSeq = 0;
  lastSuccessAt: number | null = null;
  lastError: string | null = null;
  lastErrorAt: number | null = null;
  /** Background (P4) pretranslation pauses after a rate-limit/quota error to save quota. */
  private bgPausedUntil = 0;
  static readonly BG_PAUSE_AFTER_429_MS = 120_000;

  private lastOutcomeRateLimited = false;
  /** The most recent request outcome was a rate-limit / quota error (cleared by the next success). */
  get rateLimited(): boolean {
    return this.lastOutcomeRateLimited;
  }
  errorCount = 0;

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
    this.fatalBackoff = this.o.fatalBackoffMs;
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

  /** Apply new tuning (e.g. translation mode changed) without losing any state. */
  updateOptions(opts: Partial<SchedulerOptions>): void {
    Object.assign(this.o, opts);
    this.pump();
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
    if (this.fatalTimer) this.o.clearTimer(this.fatalTimer);
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
    if (u.status === 'error') {
      // Exhausted attempts are not permanent: after a cooldown the unit is retried (rate-limit
      // bursts, short outages). Fatal configuration errors are handled separately.
      if (now - (this.errorAt.get(u.id) ?? 0) < this.o.errorCooldownMs) return false;
      u.status = 'pending';
      u.attempts = 0;
    }
    return u.status === 'pending' && (this.retryAt.get(u.id) ?? 0) <= now;
  }

  /**
   * Watchdog (called on media timeupdate, cheap): release requests that never answered,
   * then refill free slots. Never cancels work that may still complete.
   */
  heal(): void {
    if (this.disposed) return;
    const now = this.o.now();
    for (const [seq, b] of this.inflightBatches) {
      if (now - b.sentAt < this.o.stallMs) continue;
      this.inflightBatches.delete(seq);
      this.inFlight--;
      if (b.priority === 4) this.bgInFlight--;
      for (const id of b.ids) {
        const u = this.timeline.get(id);
        if (u && u.status === 'inflight') u.status = 'pending';
      }
      this.lastError = 'Yêu cầu dịch không phản hồi — đã gửi lại';
    }
    this.pump();
  }

  /** Scheduler snapshot for diagnostics (no caption text). */
  debug() {
    const t = this.playhead;
    const end = t + this.o.lookAhead * Math.max(1, this.rate);
    let queued = 0;
    let latestTranslatedEnd = 0;
    for (const u of this.timeline.units) {
      if (u.status === 'done' && u.end > latestTranslatedEnd) latestTranslatedEnd = u.end;
      if ((u.status === 'pending' || u.status === 'error') && u.start <= end && u.end > t) queued++;
    }
    return {
      state: this.disposed ? 'disposed' : this.fatal ? 'fatal-backoff' : !this.enabled ? 'paused' : this.inFlight ? 'translating' : queued ? 'waiting-retry' : 'idle',
      queuedInWindow: queued,
      inFlight: this.inFlight,
      latestTranslatedEnd,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      errorCount: this.errorCount,
      fatal: this.fatal,
    };
  }

  priorityOf(u: TimedUnit): Priority {
    const r = Math.max(1, this.rate);
    const t = this.playhead;
    if (u.start <= t + this.o.nowWindow * r && u.end > t - this.o.lookBehind) return 0;
    if (u.start <= t + this.o.urgentWindow * r && u.end > t) return 1;
    if (u.start <= t + Math.min(this.o.nearWindow, this.o.lookAhead) * r && u.end > t) return 2;
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
    else if (this.o.pretranslateAll && this.bgInFlight < this.o.maxBackgroundInFlight && now >= this.bgPausedUntil) {
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
    const size = priority <= 1 && this.coldStart() ? this.o.firstBatchSize : priority >= 3 ? Math.max(this.o.batchSize, this.o.backgroundBatchSize) : this.o.batchSize;
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
    // Batching hysteresis: non-urgent work waits until it can fill at least half a batch, so a
    // rolling window does not send one newly-entering cue per request (each request repeats the
    // system prompt). Sent anyway when it gets close (< minLeadSec) or no more cues follow it.
    const lastIdx = units.indexOf(batch[batch.length - 1]);
    const moreFollow = lastIdx < units.length - 1;
    const lead = (batch[0].start - this.playhead) / Math.max(1, this.rate);
    if (priority >= 2 && batch.length < Math.ceil(size / 2) && moreFollow && lead > this.o.minLeadSec) {
      return null; // the next playhead update re-evaluates (no timer, no polling)
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
    const seq = ++this.batchSeq;
    this.inflightBatches.set(seq, { sentAt: this.o.now(), ids: batch.map((u) => u.id), priority });
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
      // If the watchdog already released this batch as stalled, its counters were adjusted.
      if (this.inflightBatches.delete(seq)) {
        this.inFlight--;
        if (priority === 4) this.bgInFlight--;
      }
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
        this.lastSuccessAt = this.o.now();
        this.lastOutcomeRateLimited = false;
        this.fatalBackoff = this.o.fatalBackoffMs;
        changed.push(u);
        continue;
      }
      u.attempts++;
      if (r?.error || transportError) {
        this.lastError = r?.error ?? transportError;
        this.lastErrorAt = this.o.now();
        this.errorCount++;
        if (/429|rate.?limit|quota/i.test(this.lastError ?? '')) {
          this.bgPausedUntil = this.o.now() + TranslationScheduler.BG_PAUSE_AFTER_429_MS;
          this.lastOutcomeRateLimited = true;
        }
      }
      if (r?.fatal) {
        u.status = 'pending';
        u.attempts = 0;
        this.fatal = r.error ?? 'Translation configuration error';
        continue;
      }
      if (u.attempts >= this.o.maxAttempts) {
        u.status = 'error';
        this.errorAt.set(u.id, this.o.now());
        changed.push(u);
      } else {
        u.status = 'pending';
        this.retryAt.set(u.id, this.o.now() + this.o.retryBaseMs * 2 ** (u.attempts - 1));
      }
    }
    if (changed.length) this.onUpdate(changed);
    if (this.fatal) {
      this.onFatal(this.fatal);
      // Auto-probe later (bounded, doubling backoff) instead of stopping for the whole lesson:
      // the "fatal" class also covers HTTP 400/404 that can be transient on real APIs.
      if (!this.fatalTimer) {
        const wait = this.fatalBackoff;
        this.fatalBackoff = Math.min(this.o.fatalMaxBackoffMs, this.fatalBackoff * 2);
        this.fatalTimer = this.o.setTimer(() => {
          this.fatalTimer = null;
          this.fatal = null;
          this.pump();
        }, wait);
      }
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
