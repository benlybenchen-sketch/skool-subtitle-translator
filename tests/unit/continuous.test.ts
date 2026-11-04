/**
 * Regression: on real Skool, Vietnamese subtitles stopped after 1–2 minutes of playback and
 * resumed only after toggling CC. 20-minute lesson mock: initially only 36 cues (~90 s) are
 * exposed; the player adds the rest in chunks as playback progresses, in different ways.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';

installVTTCue();

const DURATION = 20 * 60;
const STEP = 2.5; // one cue every 2.5 s → 36 cues ≈ 90 s, 480 cues for 20 min
const ALL = Array.from({ length: DURATION / STEP }, (_, i) => ({ start: i * STEP, end: i * STEP + 2.2, text: `Sentence ${i}.` }));
const cue = (c: (typeof ALL)[number]) => new FakeCue(c.start, c.end, c.text);

type Mode = 'append-silent' | 'append-cuechange' | 'new-track-keep-old' | 'player-disables';

/** Player mock: exposes cues in 90 s chunks, ~30 s before they are needed. */
function player(video: FakeVideo, mode: Mode) {
  let track = new FakeTrack('captions', 'English CC', 'en', ALL.slice(0, 36).map(cue));
  track.mode = 'showing'; // the user enabled English CC
  video._tracks.add(track);
  let loadedUntil = 90;
  return {
    tick(t: number) {
      while (t > loadedUntil - 30 && loadedUntil < DURATION) {
        const chunk = ALL.filter((c) => c.start >= loadedUntil && c.start < loadedUntil + 90).map(cue);
        loadedUntil += 90;
        if (mode === 'new-track-keep-old') {
          // new TextTrack per chunk; the old one stays in the list with its stale cues
          const old = track;
          track = new FakeTrack('captions', 'English CC', 'en', chunk);
          track.mode = 'showing';
          old.mode = 'hidden';
          video._tracks.add(track);
        } else if (mode === 'player-disables' && loadedUntil > 120 && loadedUntil <= 210) {
          for (const c of chunk) track.addCue(c);
          track.mode = 'disabled'; // player disables the track mid-playback (not after a seek)…
          setTimeout(() => (track.mode = 'showing'), 0); // …and its own UI state says CC is on again
        } else {
          for (const c of chunk) track.addCue(c);
          if (mode === 'append-cuechange') track.dispatchEvent(new Event('cuechange'));
        }
      }
    },
  };
}

interface BridgeOpts {
  failFirst?: number; // first N requests fail transiently
  rateLimitBurstAt?: number; // after N requests, the next 12 fail (429 burst)
  fatalOnce?: boolean; // one fatal-classified error
  delayMs?: number;
}
function bridge(o: BridgeOpts = {}) {
  const sent: string[] = [];
  let n = 0;
  const b: ControllerBridge & { sent: string[] } = {
    sent,
    async translate(_k, units) {
      n++;
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if ((o.failFirst && n <= o.failFirst) || (o.rateLimitBurstAt && n > o.rateLimitBurstAt && n <= o.rateLimitBurstAt + 12))
        return units.map((u) => ({ id: u.id, error: 'HTTP 429 (rate limited)' }));
      if (o.fatalOnce && n === 3) return units.map((u) => ({ id: u.id, error: 'HTTP 400', fatal: true }));
      sent.push(...units.map((u) => u.text));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus() {},
  };
  return b;
}

let now = 0;
const realNow = Date.now;
beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
});
const controllers: SubtitleController[] = [];
afterEach(() => {
  Date.now = realNow;
  controllers.splice(0).forEach((c) => c.destroy());
});

function setup(mode: Mode, bo: BridgeOpts = {}) {
  document.body.innerHTML = '';
  const box = document.createElement('div');
  setRect(box, 960, 540);
  const video = makeVideo(document, { tracks: [] });
  box.append(video);
  document.body.append(box);
  const p = player(video, mode);
  const br = bridge(bo);
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: skoolNativeAdapter,
    bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, pretranslateAll: true }),
    raf: () => 0,
    cancelRaf: () => undefined,
    schedulerOptions: { retryBaseMs: 200, fatalBackoffMs: 300, now: () => now },
  });
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
  controllers.push(c);
  return { c, video, p, br, box };
}

/** Plays the lesson in 0.5 s steps (wall clock advances 0.5 s / rate). Returns cues shown untranslated. */
async function play(s: ReturnType<typeof setup>, rate = 1, until = DURATION) {
  const { c, video, p } = s;
  video.playbackRate = rate;
  video._play();
  const missed: number[] = [];
  for (let t = 0; t < until; t += 0.5) {
    video.currentTime = t;
    p.tick(t);
    now += 500 / rate;
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    const active = ALL.find((x) => x.start <= t && x.end > t);
    if (active && t - active.start >= 1.2) {
      // half-way into the cue the Vietnamese text must be on screen
      if (c.currentOverlay!.text.vi !== `VI(${active.text})`) {
        missed.push(active.start);
      }
    }
  }
  return missed;
}

describe('continuous translation for a whole 20-minute lesson', () => {
  for (const mode of ['append-silent', 'append-cuechange', 'new-track-keep-old', 'player-disables'] as Mode[]) {
    it(`translates beyond the first 90 s and up to the end (${mode})`, async () => {
      const s = setup(mode);
      const missed = await play(s);
      expect(missed.filter((t) => t > 120)).toEqual([]); // nothing lost after the first 2 minutes
      expect(missed.length).toBeLessThanOrEqual(1);
      expect(s.c.currentTimeline!.size).toBe(ALL.length);
      expect(new Set(s.br.sent).size).toBe(s.br.sent.length); // no duplicate API calls
    }, 60_000);
  }

  it('2× playback with appended cues', async () => {
    const s = setup('append-silent');
    const missed = await play(s, 2);
    expect(missed.filter((t) => t > 120)).toEqual([]);
  }, 60_000);

  it('recovers from a burst of rate-limit failures (no permanent gaps)', async () => {
    const s = setup('append-silent', { rateLimitBurstAt: 6 });
    const missed = await play(s);
    expect(missed.filter((t) => t > 300)).toEqual([]);
  }, 60_000);

  it('recovers after a single fatal-classified error (auto-probe, no settings change needed)', async () => {
    const s = setup('append-silent', { fatalOnce: true });
    const missed = await play(s);
    expect(missed.filter((t) => t > 300)).toEqual([]);
  }, 60_000);

  it('slow Gemini responses still keep up', async () => {
    const s = setup('append-silent', { delayMs: 1 });
    const missed = await play(s, 1, 600);
    expect(missed.filter((t) => t > 120)).toEqual([]);
  }, 60_000);

  it('seek forward/back, fullscreen and one overlay during a long session', async () => {
    const s = setup('append-cuechange');
    await play(s, 1, 400);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => s.box });
    document.dispatchEvent(new Event('fullscreenchange'));
    s.video._setTime(101.5);
    expect(s.c.currentOverlay!.text.vi).toBe('VI(Sentence 40.)');
    s.video._setTime(351.5);
    expect(s.c.currentOverlay!.text.vi).toBe('VI(Sentence 140.)');
    expect(s.c.currentOverlay!.container).toBe(s.box);
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
  }, 60_000);

  it('reports when the player genuinely stops providing cues (no invented subtitles)', async () => {
    document.body.innerHTML = '';
    const video = makeVideo(document, { tracks: [] });
    setRect(video, 960, 540);
    document.body.append(video);
    const t = new FakeTrack('captions', 'English CC', 'en', ALL.slice(0, 36).map(cue));
    t.mode = 'showing';
    video._tracks.add(t);
    const c = new SubtitleController({ doc: document, isTop: true, adapter: skoolNativeAdapter, bridge: bridge(), settings: mergeSettings(DEFAULT_SETTINGS), raf: () => 0, cancelRaf: () => undefined, schedulerOptions: { now: () => now } });
    c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
    controllers.push(c);
    video._play();
    for (let x = 0; x < 200; x += 0.5) {
      video.currentTime = x;
      now += 500;
      video.dispatchEvent(new Event('timeupdate'));
      await flush();
    }
    expect(c.currentOverlay!.text.vi).toBe('');
    expect(c.status().notice ?? '').toMatch(/ngừng cung cấp phụ đề mới/);
    const d = c.debugState();
    expect(d.latestCueEndSec).toBeCloseTo(89.7, 1);
    expect(d.transcriptComplete).toBe(false);
  }, 60_000);
});
