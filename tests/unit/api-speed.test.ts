/**
 * Measured (simulated) scheduling performance: API latency is expressed on the SAME simulated
 * clock as playback, so time-to-first-subtitle and missed deadlines are measured, not estimated.
 * 10-minute lesson; only ~90 s of cues exposed at first, the rest arrive in chunks.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/types';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect } from './fakes';

installVTTCue();

const STEP = 2.5;
const LESSON = 600;
const CUES = Array.from({ length: LESSON / STEP }, (_, i) => ({ start: i * STEP, end: i * STEP + 2.2, text: `Line ${i}.` }));

let now = 0;
const realNow = Date.now;
const live: SubtitleController[] = [];
beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
  live.splice(0).forEach((c) => c.destroy());
});

/** Bridge whose responses arrive `latencyMs` later on the simulated clock. */
function latencyBridge(latencyMs: number) {
  const pending: { at: number; resolve: () => void }[] = [];
  let requests = 0;
  const b: ControllerBridge & { tick: () => void; requests: () => number } = {
    async translate(_k, units) {
      requests++;
      await new Promise<void>((resolve) => pending.push({ at: now + latencyMs, resolve }));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus() {},
    tick() {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= now) pending.splice(i, 1)[0].resolve();
    },
    requests: () => requests,
  };
  return b;
}

async function run(mode: Settings['translationMode'], latencyMs: number, rate = 1) {
  document.body.innerHTML = '';
  const video = makeVideo(document, { tracks: [] });
  setRect(video, 960, 540);
  document.body.append(video);
  const track = new FakeTrack('captions', 'English', 'en', CUES.filter((c) => c.start < 90).map((c) => new FakeCue(c.start, c.end, c.text)));
  track.mode = 'showing';
  video._tracks.add(track);
  let loaded = 90;
  const br = latencyBridge(latencyMs);
  const c = new SubtitleController({
    doc: document, isTop: true, adapter: skoolNativeAdapter, bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, translationMode: mode, pretranslateAll: false }),
    raf: () => 0, cancelRaf: () => undefined, schedulerOptions: { now: () => now },
  });
  live.push(c);
  const t0 = now;
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
  video.playbackRate = rate;
  video._play();
  let firstAt: number | null = null;
  let missed = 0;
  let shown = 0;
  for (let t = 0; t < LESSON - 5; t += 0.25) {
    video.currentTime = t;
    while (t > loaded - 30 && loaded < LESSON) {
      for (const x of CUES.filter((x) => x.start >= loaded && x.start < loaded + 90)) track.addCue(new FakeCue(x.start, x.end, x.text));
      loaded += 90;
    }
    now += 250 / rate;
    br.tick();
    await flush();
    video.dispatchEvent(new Event('timeupdate'));
    const vi = c.currentOverlay!.text.vi;
    if (firstAt === null && vi.startsWith('VI(')) firstAt = now - t0;
    const a = CUES.find((x) => x.start <= t && x.end > t);
    if (a && t - a.start >= 1) {
      shown++;
      if (vi !== `VI(${a.text})`) missed++;
    }
  }
  return { timeToFirstMs: firstAt, missedPct: Math.round((missed / shown) * 1000) / 10, requests: br.requests() };
}

describe('measured scheduling performance (simulated clock)', () => {
  const results: Record<string, unknown>[] = [];
  afterAll(() => {
    console.table(results); // reported in the testing docs — measured, not invented
  });

  for (const [label, latency] of [['fast API 300 ms', 300], ['average API 1.2 s', 1200], ['slow API 4 s', 4000]] as const) {
    for (const mode of ['fast', 'balanced', 'quality'] as const) {
      it(`${mode} · ${label}`, async () => {
        const r = await run(mode, latency);
        results.push({ mode, api: label, ...r });
        expect(r.timeToFirstMs).not.toBeNull();
        expect(r.timeToFirstMs!).toBeLessThanOrEqual(latency + 500);
        expect(r.missedPct).toBeLessThan(latency >= 4000 ? 5 : 2);
      }, 60_000);
    }
  }

  it('balanced · average API at 1.5× and 2×', async () => {
    for (const rate of [1.5, 2]) {
      const r = await run('balanced', 1200, rate);
      results.push({ mode: `balanced ${rate}×`, api: 'average API 1.2 s', ...r });
      expect(r.missedPct).toBeLessThan(3);
    }
  }, 60_000);
});
