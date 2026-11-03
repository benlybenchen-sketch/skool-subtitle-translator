import { TranslationScheduler, type TranslateBridge } from '../../src/content/scheduler';
import { Timeline } from '../../src/subtitles/timeline';
import type { Unit } from '../../src/shared/types';
import { flush } from './fakes';

const units = (n: number, spacing = 5): Unit[] =>
  Array.from({ length: n }, (_, i) => ({ id: 'u' + i, start: i * spacing, end: i * spacing + 4, text: `line ${i}`, cueIds: ['c' + i] }));

function mkBridge(impl?: (texts: string[]) => any) {
  const calls: string[][] = [];
  const b: TranslateBridge & { calls: string[][]; cancelled: string[] } = {
    calls,
    cancelled: [],
    async translate(_k, us) {
      calls.push(us.map((u) => u.text));
      if (impl) return impl(us.map((u) => u.text)).map ? impl(us.map((u) => u.text)) : impl(us.map((u) => u.text));
      return us.map((u) => ({ id: u.id, vi: 'vi ' + u.text }));
    },
    cancel(k) {
      this.cancelled.push(k);
    },
  };
  return b;
}

describe('TranslationScheduler (prefetch & prioritisation)', () => {
  it('translates the units around the playhead first', async () => {
    const tl = new Timeline(units(100));
    const b = mkBridge();
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { batchSize: 5, maxInFlight: 1, lookAhead: 20, pretranslateAll: false });
    s.setPlayhead(250);
    await flush();
    expect(b.calls[0][0]).toBe('line 49'); // lookBehind 3s → unit at 245–249 is still relevant
    expect(b.calls.flat()).not.toContain('line 0');
  });

  it('only prefetches within the look-ahead window (cost control)', async () => {
    const tl = new Timeline(units(100));
    const b = mkBridge();
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { batchSize: 50, lookAhead: 30, pretranslateAll: false });
    s.setPlayhead(0);
    await new Promise((r) => setTimeout(r, 10));
    const done = tl.units.filter((u) => u.status === 'done').length;
    expect(done).toBe(7); // starts 0..30s
  });

  it('scales the look-ahead with playback speed', async () => {
    const tl = new Timeline(units(100));
    const b = mkBridge();
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { batchSize: 50, lookAhead: 30, pretranslateAll: false });
    s.setPlayhead(0, 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(tl.units.filter((u) => u.status === 'done').length).toBe(13); // 0..60s
  });

  it('re-prioritises after a seek', async () => {
    const tl = new Timeline(units(100));
    const b = mkBridge();
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { batchSize: 2, maxInFlight: 1, lookAhead: 10 });
    s.setPlayhead(0);
    await flush();
    s.setPlayhead(400);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.calls.some((c) => c.includes('line 80'))).toBe(true);
  });

  it('sends preceding lines as context', async () => {
    const tl = new Timeline(units(10));
    const ctxs: string[][] = [];
    const b: TranslateBridge = {
      async translate(_k, us, context) {
        ctxs.push(context);
        return us.map((u) => ({ id: u.id, vi: 'x' }));
      },
      cancel() {},
    };
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { batchSize: 2, maxInFlight: 1, contextSize: 2 });
    s.setPlayhead(20); // look-behind 3s → first unit is "line 3" (15–19s)
    await flush();
    expect(ctxs[0]).toEqual(['line 1', 'line 2']);
  });

  it('retries failed units with backoff, then marks them as errors', async () => {
    let now = 0;
    const timers: (() => void)[] = [];
    const tl = new Timeline(units(1));
    const b = mkBridge(() => [{ id: 'u0', error: 'temporary' }]);
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, {
      maxAttempts: 3,
      now: () => now,
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => undefined,
    });
    s.setPlayhead(0);
    for (let i = 0; i < 5; i++) {
      await flush();
      now += 100_000;
      timers.shift()?.();
    }
    expect(b.calls).toHaveLength(3);
    expect(tl.units[0].status).toBe('error');
  });

  it('stops on fatal configuration errors (e.g. missing consent) instead of hammering', async () => {
    const tl = new Timeline(units(20));
    const fatal = vi.fn();
    const b = mkBridge((texts) => texts.map((_t, i) => ({ id: 'u' + i, error: 'consent required', fatal: true })));
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, fatal, { batchSize: 3 });
    s.setPlayhead(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.calls.length).toBeLessThanOrEqual(2); // at most the batches already in flight
    expect(fatal).toHaveBeenCalledWith('consent required');
    expect(s.fatalError).toBe('consent required');
    const n = b.calls.length;
    s.setPlayhead(5);
    await new Promise((r) => setTimeout(r, 10));
    expect(b.calls.length).toBe(n); // no further requests until resume()
    s.resume();
    await flush();
    expect(b.calls.length).toBeGreaterThan(n);
  });

  it('recovers when the background worker was restarting (transport error)', async () => {
    let fail = true;
    const timers: (() => void)[] = [];
    const tl = new Timeline(units(1));
    const b: TranslateBridge = {
      async translate(_k, us) {
        if (fail) throw new Error('Could not establish connection. Receiving end does not exist.');
        return us.map((u) => ({ id: u.id, vi: 'ok' }));
      },
      cancel() {},
    };
    let now = 0;
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, { now: () => now, setTimer: (cb) => timers.push(cb), clearTimer: () => undefined });
    s.setPlayhead(0);
    await flush();
    fail = false;
    now += 60_000;
    timers.shift()?.();
    await flush();
    expect(tl.units[0].vi).toBe('ok');
  });

  it('dispose() cancels background work and ignores late results', async () => {
    const tl = new Timeline(units(3));
    let resolve!: (v: any) => void;
    const b: TranslateBridge & { cancelled: string[] } = {
      cancelled: [],
      translate: () => new Promise((r) => (resolve = r)),
      cancel(k) {
        this.cancelled.push(k);
      },
    };
    const s = new TranslationScheduler(tl, 'video-x', b, () => undefined, () => undefined, { maxInFlight: 1 });
    s.setPlayhead(0);
    s.dispose();
    resolve([{ id: 'u0', vi: 'late' }]);
    await flush();
    expect(b.cancelled).toEqual(['video-x']);
    expect(tl.units[0].vi).toBeUndefined();
  });
});

describe('priority tiers (speed-first pretranslation)', () => {
  const mk = (opts = {}) => {
    const tl = new Timeline(units(60, 5)); // 300 s of cues every 5 s
    const sent: { texts: string[]; priority?: number }[] = [];
    let release: (() => void)[] = [];
    const b: TranslateBridge = {
      translate: (_k, us, _c, priority) =>
        new Promise((resolve) => {
          sent.push({ texts: us.map((u) => u.text), priority });
          release.push(() => resolve(us.map((u) => ({ id: u.id, vi: 'vi ' + u.text }))));
        }),
      cancel() {},
    };
    const s = new TranslationScheduler(tl, 'v', b, () => undefined, () => undefined, opts);
    const drain = async () => {
      for (let i = 0; i < 200 && release.length; i++) {
        const r = release;
        release = [];
        r.forEach((f) => f());
        await flush();
      }
    };
    return { tl, s, sent, drain, releaseAll: () => release.splice(0).forEach((f) => f()) };
  };

  it('first request is a small P1 batch at the playhead (fast first subtitle)', () => {
    const { s, sent } = mk();
    s.setPlayhead(0);
    expect(sent[0].priority).toBe(1);
    expect(sent[0].texts).toEqual(['line 0', 'line 1', 'line 2', 'line 3']); // firstBatchSize 4
  });

  it('starts translating before playback reaches a cue, covering the 90 s window first', async () => {
    const { tl, s, sent, drain } = mk({ pretranslateAll: false });
    s.setPlayhead(0);
    await drain();
    // nothing played yet, but every cue starting within 90 s is already translated
    expect(tl.units.filter((u) => u.start <= 90).every((u) => u.status === 'done')).toBe(true);
    expect(tl.units.some((u) => u.start > 90 && u.status === 'done')).toBe(false);
    expect(sent.map((x) => x.priority).slice(0, 3)).toEqual([1, 2, 3]); // 0–19 s, 20–69 s, 70 s+
    expect(s.aheadCoverage()).toBe(1);
  });

  it('then translates the rest of the transcript in the background (P4, one slot max)', async () => {
    const { tl, s, sent, drain } = mk();
    s.setPlayhead(0);
    await drain();
    expect(tl.counts().done).toBe(60);
    const p4 = sent.filter((x) => x.priority === 4);
    expect(p4.length).toBeGreaterThan(0);
    // P4 only starts once every cue of the 90 s window has been dispatched
    let lastWindowReq = -1;
    sent.forEach((x, i) => {
      if (x.texts.some((t) => Number(t.split(' ')[1]) * 5 <= 90)) lastWindowReq = i;
    });
    expect(sent.findIndex((x) => x.priority === 4)).toBeGreaterThan(lastWindowReq);
  });

  it('never sends a cue twice (no duplicate requests)', async () => {
    const { s, sent, drain } = mk();
    s.setPlayhead(0);
    s.setPlayhead(0);
    s.setPlayhead(100);
    await drain();
    const all = sent.flatMap((x) => x.texts);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(60);
  });

  it('seeking re-prioritises: the next request targets the new position with P1', async () => {
    const { s, sent, releaseAll } = mk();
    s.setPlayhead(0);
    s.setPlayhead(200); // seek while two requests are in flight
    releaseAll(); // in-flight results for 0 s are kept, not cancelled
    await flush();
    const afterSeek = sent.slice(2);
    expect(afterSeek[0].priority).toBe(1);
    expect(afterSeek[0].texts[0]).toBe('line 39'); // unit at 195–199 s (look-behind 3 s)
  });

  it('keeps completed translations after seeking away and back', async () => {
    const { tl, s, drain } = mk({ pretranslateAll: false });
    s.setPlayhead(0);
    await drain();
    const first = tl.units[0].vi;
    s.setPlayhead(250);
    await drain();
    s.setPlayhead(0);
    expect(tl.units[0].vi).toBe(first);
    expect(s.nextBatch()?.priority ?? 0).not.toBe(1); // nothing to redo at 0 s
  });

  it('measures time to first translated segment', async () => {
    let now = 1000;
    const tl = new Timeline(units(3));
    const s = new TranslationScheduler(tl, 'v', mkBridge(), () => undefined, () => undefined, { now: () => now });
    now = 1350;
    s.setPlayhead(0);
    await flush();
    expect(s.timeToFirstMs).toBe(350);
  });
});
