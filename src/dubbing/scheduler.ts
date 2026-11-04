import type { TimedUnit } from '../shared/types';
import { percentile } from '../shared/util';
import { estimateSpeechSec } from '../tts/providers';
import { buildSpeechUnits, type SpeechUnit } from './units';

/** Output device for speech (chrome.tts or the offscreen cloud-audio player, via the background). */
export interface DubSink {
  readonly kind: 'chrome' | 'cloud';
  /** Cloud: synthesize ahead of time (prefetch). Chrome TTS synthesizes on speak. */
  prepare?(u: { id: string; text: string }): Promise<{ key: string; durationSec: number }>;
  /** Start speaking. `speed` multiplies the base rate (fit to the time slot). Events via handleEvent. */
  speak(u: SpeechUnit, speed: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Can a paused utterance continue exactly (cloud audio) or must it restart (chrome.tts)? */
  readonly canResume: boolean;
}

export interface DubSchedulerOptions {
  baseRate: number;
  maxSpeedup: number;
  maxDelaySec: number;
  latePolicy: 'skip' | 'delay';
  lookaheadSec: number;
  prefetchConcurrency: number;
  /** Start a unit this early (s of media time) to absorb output latency. */
  leadSec: number;
  /** Consecutive failures before `onFatal`. */
  maxConsecutiveFailures: number;
  now: () => number;
}

export const DEFAULT_DUB_OPTIONS: DubSchedulerOptions = {
  baseRate: 1,
  maxSpeedup: 1.35,
  maxDelaySec: 2.5,
  latePolicy: 'skip',
  lookaheadSec: 60,
  prefetchConcurrency: 2,
  leadSec: 0.12,
  maxConsecutiveFailures: 3,
  now: () => Date.now(),
};

export interface DubStats {
  segmentsTotal: number;
  spoken: number;
  skipped: number;
  late: number;
  rateAdjusted: number;
  failed: number;
  prepareRequests: number;
  firstSpeechMs: number | null;
  medianDelayMs: number | null;
  p95DelayMs: number | null;
  lateSpeechSec: number;
  bufferedAheadSec: number;
}

/**
 * Dubbing scheduler — the video's playback clock is the only timeline.
 * - One utterance at a time (never overlapping), started when the playhead reaches the unit.
 * - Speed fitted into the unit's slot (≤ maxSpeedup × base rate); otherwise the next unit waits,
 *   and anything later than `maxDelaySec` is skipped (latePolicy 'skip') — no ever-growing queue.
 * - Seek: current speech stopped, units at/after the new position become speakable again,
 *   prepared audio is kept.
 * - Every callback carries the unit id; `dispose()` invalidates everything (lesson switch).
 */
export class DubbingScheduler {
  readonly o: DubSchedulerOptions;
  private units: SpeechUnit[] = [];
  private byId = new Map<string, SpeechUnit>();
  private current: { u: SpeechUnit; startedAt: number; paused: boolean; restartOnResume: boolean; expectedMs: number; pausedMs: number; pausedAt: number | null } | null = null;
  private inflight = 0;
  private disposed = false;
  private consecutiveFailures = 0;
  private playingSince: number | null = null;
  private firstSpeechMs: number | null = null;
  private readonly delays: number[] = [];
  private stats = { spoken: 0, skipped: 0, late: 0, rateAdjusted: 0, failed: 0, prepareRequests: 0, lateSpeechSec: 0, eventTimeouts: 0 };
  private t = 0;
  private rate = 1;
  private playing = false;
  private sig = '';
  lastError: string | undefined;

  constructor(
    private readonly sink: DubSink,
    private readonly lesson: string,
    opts: Partial<DubSchedulerOptions> = {},
    private readonly cb: { onFatal?: (error: string) => void; onChange?: () => void } = {},
  ) {
    this.o = { ...DEFAULT_DUB_OPTIONS, ...opts };
  }

  /** Feed the latest translation timeline (cheap when nothing changed). */
  setUnits(units: readonly TimedUnit[]): void {
    if (this.disposed) return;
    const sig = `${units.length}|${units.filter((u) => u.vi).length}|${units[0]?.id ?? ''}|${units.at(-1)?.id ?? ''}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const next = buildSpeechUnits(units, this.lesson);
    const map = new Map<string, SpeechUnit>();
    this.units = next.map((n) => {
      const old = this.byId.get(n.id);
      const u: SpeechUnit = old && old.text === n.text ? old : { ...n, status: 'pending', failures: 0 };
      if (old && old.text !== n.text && old === this.current?.u) this.stopCurrent(); // retranslated while speaking
      u.start = n.start;
      u.end = n.end;
      u.slotEnd = n.slotEnd;
      if (u.status === 'pending' && u.text && this.sink.kind === 'chrome') u.status = 'ready';
      map.set(u.id, u);
      return u;
    });
    this.byId = map;
    this.pump();
  }

  get speaking(): SpeechUnit | null {
    return this.current?.u ?? null;
  }

  // ---- playback events ----------------------------------------------------------------------

  play(t: number, rate: number): void {
    this.playing = true;
    this.playingSince ??= this.o.now();
    this.t = t;
    this.rate = rate;
    const c = this.current;
    if (c?.paused) {
      if (c.restartOnResume) {
        c.u.status = 'ready';
        this.current = null;
      } else {
        c.paused = false;
        if (c.pausedAt !== null) c.pausedMs += this.o.now() - c.pausedAt;
        c.pausedAt = null;
        this.sink.resume();
      }
    }
    this.tick(t, true, rate);
  }

  pause(): void {
    this.playing = false;
    const c = this.current;
    if (!c || c.paused) return;
    c.paused = true;
    c.pausedAt = this.o.now();
    if (this.sink.canResume) this.sink.pause();
    else {
      // cannot resume precisely → stop now, speak the unit again from its start on resume
      c.restartOnResume = true;
      this.sink.stop();
    }
  }

  /** Seek: obsolete speech stopped; units from the new position can be spoken (again). */
  seek(t: number): void {
    this.stopCurrent();
    this.t = t;
    for (const u of this.units) {
      if (u.end >= t - 0.2 && (u.status === 'played' || u.status === 'skipped')) u.status = u.text && (this.sink.kind === 'chrome' || u.audioKey) ? 'ready' : 'pending';
    }
    this.pump();
    if (this.playing) this.tick(t, true, this.rate);
  }

  ratechange(rate: number): void {
    this.rate = rate; // next units are fitted with the new rate; the current one keeps going
  }

  ended(): void {
    this.playing = false;
    this.stopCurrent();
  }

  private stopCurrent(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (c.u.status === 'speaking') c.u.status = 'ready';
    this.sink.stop();
  }

  // ---- main step (timeupdate / animation frame) ---------------------------------------------

  tick(t: number, playing: boolean, rate: number): void {
    if (this.disposed) return;
    this.t = t;
    this.rate = rate || 1;
    this.playing = playing;
    this.pump();
    if (!playing) return;
    const c = this.current;
    if (c && !c.paused && this.o.now() - c.startedAt - c.pausedMs > c.expectedMs * 1.6 + 4000) {
      // The end event never came (service worker restarted, output device lost): do not stay stuck.
      this.stats.eventTimeouts++;
      c.u.status = 'played';
      this.current = null;
      this.sink.stop();
    } else if (c) {
      // Obsolete (jumped away without a seek event): stop.
      if (!c.paused && (t < c.u.start - 1.5 || t > c.u.slotEnd + this.o.maxDelaySec + (c.u.durationSec ?? estimateSpeechSec(c.u.text, this.o.baseRate)) + 2)) this.stopCurrent();
      else return;
    }
    for (const u of this.units) {
      if (u.start > t + this.o.leadSec) break;
      if (u.status === 'played' || u.status === 'skipped' || u.status === 'failed') continue;
      const lateSec = t - u.start;
      const delayPolicy = this.o.latePolicy === 'delay';
      const limit = delayPolicy ? this.o.maxDelaySec * 2 : this.o.maxDelaySec;
      if (lateSec > limit || t > u.slotEnd + (delayPolicy ? this.o.maxDelaySec : 0.2)) {
        u.status = 'skipped';
        this.stats.skipped++;
        continue;
      }
      if (u.status !== 'ready') return; // wait for translation / audio of the next due unit
      this.start(u, t);
      return;
    }
  }

  private start(u: SpeechUnit, t: number): void {
    const dur = u.durationSec ?? estimateSpeechSec(u.text, this.o.baseRate);
    const from = Math.max(t, u.start);
    const windowWall = Math.max(0.3, (u.slotEnd - from) / this.rate);
    let speed = 1;
    if (dur > windowWall) {
      speed = Math.min(this.o.maxSpeedup, dur / windowWall);
      this.stats.rateAdjusted++;
    }
    const delay = Math.max(0, (t - u.start) / this.rate) * 1000;
    this.delays.push(delay);
    if (this.delays.length > 2000) this.delays.shift();
    if (delay > 300) {
      this.stats.late++;
      this.stats.lateSpeechSec += delay / 1000;
    }
    u.status = 'speaking';
    this.current = { u, startedAt: this.o.now(), paused: false, restartOnResume: false, expectedMs: (dur / speed) * 1000, pausedMs: 0, pausedAt: null };
    this.sink.speak(u, speed);
  }

  /** Sink events (chrome.tts / offscreen player), already filtered by lesson token. */
  handleEvent(segId: string, kind: 'start' | 'end' | 'error' | 'interrupted', error?: string): void {
    if (this.disposed) return;
    const u = this.byId.get(segId);
    if (!u) return;
    if (kind === 'start') {
      if (this.firstSpeechMs === null && this.playingSince !== null) this.firstSpeechMs = this.o.now() - this.playingSince;
      this.consecutiveFailures = 0;
      return;
    }
    if (this.current?.u !== u) return; // stale (already stopped / replaced)
    if (kind === 'interrupted') return; // our own stop()
    this.current = null;
    if (kind === 'end') {
      u.status = 'played';
      this.stats.spoken++;
      this.consecutiveFailures = 0;
    } else {
      u.status = 'failed';
      this.fail(error ?? 'TTS error');
    }
    this.cb.onChange?.();
    if (this.playing) this.tick(this.t, true, this.rate);
  }

  private fail(error: string): void {
    this.stats.failed++;
    this.lastError = error;
    if (++this.consecutiveFailures >= this.o.maxConsecutiveFailures) this.cb.onFatal?.(error);
  }

  // ---- prefetch (cloud) ---------------------------------------------------------------------

  private pump(): void {
    const prepare = this.sink.prepare?.bind(this.sink);
    if (!prepare || this.disposed) return;
    const horizon = this.t + this.o.lookaheadSec;
    for (const u of this.units) {
      if (this.inflight >= this.o.prefetchConcurrency) return;
      if (u.start > horizon) return;
      if (u.status !== 'pending' || !u.text || u.end < this.t - 0.2 || u.failures >= 2) continue;
      u.status = 'preparing';
      this.inflight++;
      this.stats.prepareRequests++;
      const text = u.text;
      void prepare({ id: u.id, text })
        .then((r) => {
          if (this.disposed || u.text !== text) return;
          u.audioKey = r.key;
          u.durationSec = r.durationSec || undefined;
          u.status = 'ready';
        })
        .catch((e: Error) => {
          if (this.disposed) return;
          u.failures++;
          u.status = 'pending';
          this.fail(e.message);
        })
        .finally(() => {
          this.inflight--;
          if (this.disposed) return;
          this.cb.onChange?.();
          this.pump();
          if (this.playing && !this.current) this.tick(this.t, true, this.rate);
        });
    }
  }

  // ---- status -------------------------------------------------------------------------------

  snapshot(): DubStats {
    let buffered = 0;
    for (const u of this.units) {
      if (u.end < this.t) continue;
      if (u.status === 'pending' || u.status === 'preparing' || u.status === 'failed') break;
      buffered = u.end - this.t;
    }
    return {
      segmentsTotal: this.units.length,
      ...this.stats,
      firstSpeechMs: this.firstSpeechMs,
      medianDelayMs: this.delays.length ? Math.round(percentile(this.delays, 50)) : null,
      p95DelayMs: this.delays.length ? Math.round(percentile(this.delays, 95)) : null,
      bufferedAheadSec: Math.max(0, Math.round(buffered)),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stopCurrent();
    this.sink.stop();
    this.units = [];
    this.byId.clear();
  }
}
