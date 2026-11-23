/**
 * Real-Skool diagnostic: "Translated 32/32 — CC của trình phát đang tắt — dùng phụ đề đã tải".
 * 20-min Skool Native mock: English CC disabled, the user never presses CC, 32 cues initially,
 * new batches load ONLY while the track is not disabled (browser rule), and the player resets
 * the track to "disabled" now and then (per batch) — or fights every activation.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { createLessonLifecycle } from '../../src/content/lifecycle';
import { VideoDetector } from '../../src/players/detector';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import type { Settings } from '../../src/shared/types';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';

installVTTCue();

const cuesFor = (name: string, minutes: number) =>
  Array.from({ length: Math.floor((minutes * 60) / 2.8) }, (_, i) => ({ start: i * 2.8, end: i * 2.8 + 2.4, text: `${name} cue ${i}.` }));

type Behaviour = 'resets-per-batch' | 'fights-every-activation';

function skoolPlayer(video: FakeVideo, cues: ReturnType<typeof cuesFor>, behaviour: Behaviour) {
  let mode: TextTrackMode = 'disabled';
  const track = new FakeTrack('captions', 'English CC', 'en', cues.slice(0, 32).map((c) => new FakeCue(c.start, c.end, c.text)));
  Object.defineProperty(track, 'mode', {
    get: () => mode,
    set: (m: TextTrackMode) => {
      mode = m;
      if (behaviour === 'fights-every-activation' && m !== 'disabled') queueMicrotask(() => (mode = 'disabled'));
    },
  });
  Object.defineProperty(track, 'cues', { get: () => (mode === 'disabled' ? null : (track as any)._cues) });
  video._tracks.add(track);
  let loaded = 32;
  let lastReset = 0;
  return {
    track,
    tick(t: number) {
      if (mode === 'disabled') return; // a disabled track loads nothing
      while (loaded < cues.length && cues[loaded].start < t + 60) track.addCue(new FakeCue(cues[loaded].start, cues[loaded].end, cues[loaded].text)), loaded++;
      if (behaviour === 'resets-per-batch' && t - lastReset > 75) {
        lastReset = t;
        mode = 'disabled'; // Skool-like reset (e.g. per segment / internal CC state sync)
      }
    },
    get loaded() {
      return loaded;
    },
  };
}

function bridge() {
  const cache = new Map<string, string>();
  const providerCalls: string[] = [];
  const b: ControllerBridge & { providerCalls: string[] } = {
    providerCalls,
    async translate(_k, units) {
      for (const u of units) if (!cache.has(u.text)) (providerCalls.push(u.text), cache.set(u.text, `VI(${u.text})`));
      return units.map((u) => ({ id: u.id, vi: cache.get(u.text) }));
    },
    cancel() {},
    reportStatus() {},
  };
  return b;
}

let now = 0;
const realNow = Date.now;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  now = 9_000_000;
  Date.now = () => now;
});
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  Date.now = realNow;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

function app(settings: Partial<Settings>) {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/grp/classroom/c?md=one');
  const box = document.createElement('div');
  setRect(box, 960, 540);
  document.body.append(box);
  const br = bridge();
  const c = new SubtitleController({
    doc: document, isTop: true, adapter: skoolNativeAdapter, bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, ...settings }),
    raf: () => 0, cancelRaf: () => undefined, navSettleMs: 30, schedulerOptions: { now: () => now },
  });
  const det = new VideoDetector(document, skoolNativeAdapter, (cb) => setTimeout(cb, 0));
  const life = createLessonLifecycle(window, c, det);
  cleanups.push(() => (life.stop(), c.destroy()));
  return { c, br, box, life };
}

function lesson(box: HTMLElement, name: string, minutes: number, behaviour: Behaviour) {
  box.innerHTML = '';
  const video = makeVideo(document, { src: `https://video.skool.com/${name}.m3u8`, tracks: [] });
  Object.defineProperty(video, 'duration', { get: () => minutes * 60 });
  box.append(video);
  const cues = cuesFor(name, minutes);
  return { video, cues, player: skoolPlayer(video, cues, behaviour) };
}

async function play(c: SubtitleController, l: ReturnType<typeof lesson>, until?: number) {
  l.video._play();
  const missed: number[] = [];
  const end = until ?? l.cues.at(-1)!.end;
  for (let t = 0; t < end; t += 0.5) {
    l.video.currentTime = t;
    l.player.tick(t);
    now += 500;
    l.video.dispatchEvent(new Event('timeupdate'));
    await flush();
    const a = l.cues.find((x) => x.start <= t && x.end > t);
    if (a && t - a.start >= 1.4 && c.currentOverlay?.text.vi !== `VI(${a.text})`) missed.push(a.start);
  }
  return missed;
}

describe('CC off on Skool Native: continuous translation beyond the first 32 cues', () => {
  it('opt-in ON, player resets the track per batch: 20 min translated to the end, then next lesson without F5, seek + fullscreen', async () => {
    const a = app({ autoEnableCaptions: true, autoEnableCaptionsAsked: true });
    const A = lesson(a.box, 'A', 20, 'resets-per-batch');
    a.life.start();
    await flush();
    const missed = await play(a.c, A);
    expect(A.player.loaded).toBe(A.cues.length); // every batch loaded although CC was never pressed
    expect(a.c.currentTimeline!.counts().done).toBe(a.c.currentTimeline!.size); // ALL accessible cues translated
    expect(a.c.currentTimeline!.size).toBeGreaterThan(32 * 10);
    expect(missed.filter((t) => t > 120)).toEqual([]);
    expect(a.c.debugState().health).toBe('completed');
    expect(new Set(a.br.providerCalls).size).toBe(a.br.providerCalls.length); // no duplicate Gemini calls
    // seek back + fullscreen: served from memory/cache, no new calls
    const calls = a.br.providerCalls.length;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => a.box });
    document.dispatchEvent(new Event('fullscreenchange'));
    A.video._setTime(A.cues[100].start + 1);
    expect(a.c.currentOverlay!.text.vi).toBe(`VI(${A.cues[100].text})`);
    expect(a.br.providerCalls.length).toBe(calls);
    // next lesson, no F5
    history.pushState(null, '', '/grp/classroom/c?md=two');
    a.life.nav.check();
    const B = lesson(a.box, 'B', 3, 'resets-per-batch');
    await flush();
    await flush();
    const missedB = await play(a.c, B);
    expect(missedB.length).toBeLessThanOrEqual(1);
    expect(B.player.loaded).toBe(B.cues.length);
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
  }, 120_000);

  it('opt-in OFF and CC turned off mid-lesson: the one-time question is offered (not only at lesson start)', async () => {
    const a = app({});
    const A = lesson(a.box, 'A', 5, 'resets-per-batch');
    a.life.start();
    await flush();
    expect(A.player.track.mode).toBe('disabled'); // untouched without consent
    expect(a.c.status().captionsOff).toBe(true);
    // the user enables CC once, player later turns it off again → still asked (captionsOff)
    A.player.track.mode = 'showing';
    A.video.textTracks.dispatchEvent(new Event('change'));
    await play(a.c, A, 100);
    expect(A.player.track.mode).toBe('disabled');
    expect(a.c.status().captionsOff).toBe(true);
    expect(a.c.status().notice).toMatch(/Cho phép "Tự bật phụ đề tiếng Anh"/);
  }, 60_000);

  it('player that re-disables EVERY activation: bounded attempts, exact reason + Audio Mode, no invented subtitles', async () => {
    const a = app({ autoEnableCaptions: true, autoEnableCaptionsAsked: true });
    const A = lesson(a.box, 'A', 5, 'fights-every-activation');
    let sets = 0;
    const desc = Object.getOwnPropertyDescriptor(A.player.track, 'mode')!;
    Object.defineProperty(A.player.track, 'mode', { get: desc.get, set: (m) => (m === 'hidden' && sets++, desc.set!(m)) });
    a.life.start();
    await flush();
    await play(a.c, A, 200);
    expect(sets).toBeLessThanOrEqual(6);
    expect(a.c.status().notice).toMatch(/tự tắt lại phụ đề tiếng Anh ngay mỗi khi tiện ích bật.*Audio Mode/);
    expect(a.c.currentOverlay?.text.vi ?? '').toBe(''); // nothing shown where no cue is known
  }, 60_000);
});
