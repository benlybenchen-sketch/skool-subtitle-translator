/**
 * V3 acceptance simulation: open lesson → press Play → Vietnamese until the end → next lesson,
 * with no CC clicks and no F5. One-time consent is given in the VI panel.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { ControlPanel } from '../../src/content/panel';
import { createLessonLifecycle } from '../../src/content/lifecycle';
import { VideoDetector } from '../../src/players/detector';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import type { Settings, TabStatus } from '../../src/shared/types';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';

installVTTCue();

const lessonCues = (name: string, minutes: number, step = 2.5) =>
  Array.from({ length: Math.floor((minutes * 60) / step) }, (_, i) => ({ start: i * step, end: i * step + 2.2, text: `${name} sentence ${i}.` }));

/** Skool-like player: English track starts DISABLED (user never clicks CC); cues arrive in 90 s chunks. */
function attachPlayer(video: FakeVideo, cues: ReturnType<typeof lessonCues>, opts: { replaceAt?: number } = {}) {
  let track = new FakeTrack('captions', 'English', 'en', cues.filter((c) => c.start < 90).map((c) => new FakeCue(c.start, c.end, c.text)));
  track.mode = 'disabled';
  video._tracks.add(track);
  let loaded = 90;
  const last = cues.at(-1)!.end;
  return {
    get track() {
      return track;
    },
    tick(t: number) {
      while (t > loaded - 30 && loaded < last) {
        const chunk = cues.filter((c) => c.start >= loaded && c.start < loaded + 90).map((c) => new FakeCue(c.start, c.end, c.text));
        loaded += 90;
        if (track.mode === 'disabled') continue; // a disabled track receives no cues (browser rule)
        if (opts.replaceAt && loaded > opts.replaceAt && loaded <= opts.replaceAt + 90) {
          const mode = track.mode;
          track = new FakeTrack('captions', 'English', 'en', chunk);
          track.mode = mode;
          video._tracks.add(track);
        } else for (const c of chunk) track.addCue(c);
      }
    },
  };
}

function backgroundBridge(o: { slowMs?: number; failEvery?: number } = {}) {
  const cache = new Map<string, string>();
  const providerCalls: string[] = [];
  let n = 0;
  const b: ControllerBridge & { providerCalls: string[] } = {
    providerCalls,
    async translate(_k, units) {
      n++;
      if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
      if (o.failEvery && n % o.failEvery === 0) return units.map((u) => ({ id: u.id, error: 'TypeError: Failed to fetch' })); // network blip
      const miss = units.filter((u) => !cache.has(u.text));
      providerCalls.push(...miss.map((u) => u.text));
      for (const u of miss) cache.set(u.text, `VI(${u.text})`);
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
  now = 5_000_000;
  Date.now = () => now;
});
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  Date.now = realNow;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

function app(bridgeOpts = {}) {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/grp/classroom/course?md=A');
  let settings: Settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    provider: { kind: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', temperature: 0.2 },
    consent: { remoteTranslation: true, remoteAudio: false },
  });
  const box = document.createElement('div');
  setRect(box, 960, 540);
  document.body.append(box);
  const br = backgroundBridge(bridgeOpts);
  const c = new SubtitleController({ doc: document, isTop: true, adapter: skoolNativeAdapter, bridge: br, settings, raf: () => 0, cancelRaf: () => undefined, navSettleMs: 50, schedulerOptions: { now: () => now, retryBaseMs: 100 } });
  const panel = new ControlPanel(document, settings, (patch) => {
    settings = mergeSettings({ ...settings, ...patch }); // = saveSettings → storage.onChanged
    c.updateSettings(settings);
    panel.setSettings(settings);
  }, () => undefined);
  panel.mount();
  const det = new VideoDetector(document, skoolNativeAdapter, (cb) => setTimeout(cb, 0));
  const life = createLessonLifecycle(window, c, det);
  cleanups.push(() => {
    life.stop();
    c.destroy();
    panel.destroy();
  });
  const pushStatus = () => panel.setStatus({ tabId: 1, isSkool: true, primaryFrameId: 0, frames: [{ ...c.status(), frameId: 0 }], audio: { active: false, chunks: 0, droppedChunks: 0 } } as TabStatus);
  return { c, br, box, life, panel, pushStatus, get settings() { return settings; } };
}

function newLesson(box: HTMLElement, name: string, minutes: number, opts = {}) {
  box.innerHTML = '';
  const video = makeVideo(document, { src: `https://video.skool.com/${name}.m3u8`, tracks: [] });
  Object.defineProperty(video, 'duration', { get: () => minutes * 60 });
  box.append(video);
  const cues = lessonCues(name, minutes);
  return { video, cues, player: attachPlayer(video, cues, opts) };
}

async function watch(c: SubtitleController, l: ReturnType<typeof newLesson>, rate = 1, fromSec = 0) {
  l.video.playbackRate = rate;
  l.video._play();
  const missed: number[] = [];
  const end = l.cues.at(-1)!.end;
  for (let t = fromSec; t < end; t += 0.5) {
    l.video.currentTime = t;
    l.player.tick(t);
    now += 500 / rate;
    l.video.dispatchEvent(new Event('timeupdate'));
    await flush();
    const a = l.cues.find((x) => x.start <= t && x.end > t);
    if (a && t - a.start >= 1.2 && c.currentOverlay?.text.vi !== `VI(${a.text})`) missed.push(a.start);
  }
  return missed;
}

describe('V3: open → Play → Vietnamese to the end → next lesson (no CC, no F5)', () => {
  it('Lesson A (20 min, CC off, one-time consent) → Lesson B (async) → Lesson C = back to A (cached)', async () => {
    const a = app({ slowMs: 1, failEvery: 9 });
    const A = newLesson(a.box, 'A', 20, { replaceAt: 400 });
    a.life.start();
    await flush();
    await flush();
    // CC is off and nobody opted in yet → the VI panel asks ONCE, visibly (auto-expanded)
    a.pushStatus();
    const consent = document.querySelector('[data-sst-panel]')!.shadowRoot!.querySelector('[data-a="consent-yes"]') as HTMLElement;
    expect(consent).toBeTruthy();
    consent.click();
    expect(a.settings.autoEnableCaptions && a.settings.autoEnableCaptionsAsked).toBe(true);
    await flush();
    expect(A.player.track.mode).toBe('hidden'); // activated for reading, no native English rendering
    const missedA = await watch(a.c, A);
    expect(missedA.filter((t) => t > 120)).toEqual([]); // continuous past 2 min, to the end
    expect(missedA.length).toBeLessThanOrEqual(2);
    expect(a.c.debugState()).toMatchObject({ health: 'completed', transcriptComplete: true });
    a.pushStatus();
    expect(document.querySelector('[data-sst-panel]')!.shadowRoot!.querySelector('[data-a="consent-yes"]')).toBeNull(); // never asked again

    // Lesson B: SPA navigation, new player + track appear asynchronously, CC off again
    history.pushState(null, '', '/grp/classroom/course?md=B');
    a.life.nav.check();
    await new Promise((r) => setTimeout(r, 5));
    const B = newLesson(a.box, 'B', 5);
    await flush();
    await flush();
    expect(B.player.track.mode).toBe('hidden'); // consent remembered: no CC click, no prompt
    const missedB = await watch(a.c, B);
    expect(missedB.length).toBeLessThanOrEqual(1);

    // Lesson C: back to A → cached translations, zero new provider calls
    const callsBefore = a.br.providerCalls.length;
    history.pushState(null, '', '/grp/classroom/course?md=A');
    a.life.nav.check();
    const A2 = newLesson(a.box, 'A', 20);
    await flush();
    await flush();
    const missedC = await watch(a.c, A2, 2, 0);
    expect(a.br.providerCalls.length).toBe(callsBefore);
    expect(missedC.filter((t) => t > 10)).toEqual([]);

    // no duplicate requests over the whole session, one overlay, Gemini settings intact
    expect(new Set(a.br.providerCalls).size).toBe(a.br.providerCalls.length);
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
    expect(a.settings.provider.model).toBe('gemini-3.5-flash-lite');
    expect(a.settings.consent.remoteTranslation).toBe(true);
  }, 120_000);

  it('60-minute lesson at 2× with seeking and fullscreen keeps translating', async () => {
    const a = app();
    a.panel.setSettings(a.settings);
    const L = newLesson(a.box, 'L', 60);
    a.c.updateSettings(mergeSettings({ ...a.settings, autoEnableCaptions: true, autoEnableCaptionsAsked: true }));
    a.life.start();
    await flush();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => a.box });
    document.dispatchEvent(new Event('fullscreenchange'));
    const missed = await watch(a.c, L, 2);
    expect(missed.filter((t) => t > 120)).toEqual([]);
    L.video._setTime(1800.5); // seek back to the middle → cached, instant
    expect(a.c.currentOverlay!.text.vi).toBe('VI(L sentence 720.)');
    expect(a.c.currentOverlay!.container).toBe(a.box);
  }, 120_000);

  it('answering "Không" is respected: no activation, never asked again', async () => {
    const a = app();
    const A = newLesson(a.box, 'A', 2);
    a.life.start();
    await flush();
    a.pushStatus();
    (document.querySelector('[data-sst-panel]')!.shadowRoot!.querySelector('[data-a="consent-no"]') as HTMLElement).click();
    await flush();
    expect(A.player.track.mode).toBe('disabled');
    a.pushStatus();
    expect(document.querySelector('[data-sst-panel]')!.shadowRoot!.querySelector('[data-a="consent-yes"]')).toBeNull();
    expect(a.c.status().captionsOff).toBe(true);
  });
});
