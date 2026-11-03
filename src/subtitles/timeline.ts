import type { TimedUnit, Unit } from '../shared/types';

/** Sorted collection of translation units with O(log n) time lookup. */
export class Timeline {
  readonly units: TimedUnit[];
  private readonly byId = new Map<string, TimedUnit>();

  constructor(units: readonly Unit[], previous?: Timeline) {
    this.units = [...units]
      .sort((a, b) => a.start - b.start)
      .map((u) => {
        const old = previous?.get(u.id);
        return old && old.text === u.text
          ? { ...u, vi: old.vi, status: old.status === 'inflight' ? 'pending' : old.status, attempts: old.attempts }
          : { ...u, status: 'pending' as const, attempts: 0 };
      });
    for (const u of this.units) this.byId.set(u.id, u);
  }

  get(id: string): TimedUnit | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.units.length;
  }

  /** Index of the last unit whose start <= t (or -1). */
  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.units.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.units[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Unit active at playback time t (tolerance absorbs timeupdate jitter). */
  activeAt(t: number, tolerance = 0.04): TimedUnit | null {
    const i = this.indexAtOrBefore(t + tolerance);
    if (i < 0) return null;
    // Overlapping cues: walk back a little to find one that still covers t.
    for (let j = i; j >= 0 && j >= i - 3; j--) {
      const u = this.units[j];
      if (u.start <= t + tolerance && u.end > t) return u;
    }
    return null;
  }

  /** First index whose end is after t (start of the "upcoming" window). */
  firstIndexEndingAfter(t: number): number {
    const i = Math.max(0, this.indexAtOrBefore(t));
    for (let j = Math.max(0, i - 3); j < this.units.length; j++) if (this.units[j].end > t) return j;
    return this.units.length;
  }

  counts(): { total: number; done: number; failed: number } {
    let done = 0;
    let failed = 0;
    for (const u of this.units) {
      if (u.status === 'done') done++;
      else if (u.status === 'error') failed++;
    }
    return { total: this.units.length, done, failed };
  }
}
