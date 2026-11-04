/**
 * Regression: (1) CC had to be clicked before translation started; (2) after switching lessons
 * inside Skool Classroom translation only resumed after F5.
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

const lessonTrack = (name: string, mode: TextTrackMode = 'disabled') => {
  const t = new FakeTrack('captions', 'English CC', 'en', [0, 1, 2, 3].map((i) => new FakeCue(i * 10, i * 10 + 5, `${name} line ${i}.`)));
  t.mode = mode;
  return t;
};

/** Background-like bridge: translation cache + provider-call counter + optional delay. */
function bridge() {
  const cache = new Map<string, string>();
  const providerCalls: string[] = [];
  const cancels: string[] = [];
  let hold = false;
  let held: (() => void)[] = [];
  const b: ControllerBridge & { providerCalls: string[]; cancels: string[]; hold: (h: boolean) => void } = {
    providerCalls,
    cancels,
    hold: (h) => {
      hold = h;
      if (!h) held.splice(0).forEach((r) => r());
    },
    async translate(_k, units) {
      const miss = units.filter((u) => !cache.has(u.text));
      providerCalls.push(...miss.map((u) => u.text));
      if (hold) await new Promise<void>((r) => held.push(r));
      for (const u of miss) cache.set(u.text, `VI(${u.text})`);
      return units.map((u) => ({ id: u.id, vi: cache.get(u.text) }));
    },
    cancel(k) {
      cancels.push(k);
    },
    reportStatus() {},
  };
  return b;
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

function mount(settings: Partial<Settings> = {}, firstTrack = lessonTrack('A')) {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/grp/classroom/course1?md=lessonA');
  const box = document.createElement('div');
  setRect(box, 960, 540);
  const video = makeVideo(document, { src: 'https://video.skool.com/a.m3u8', tracks: [firstTrack] });
  box.append(video);
  document.body.append(box);
  const br = bridge();
  const s = mergeSettings({ ...DEFAULT_SETTINGS, pretranslateAll: false, ...settings });
  const c = new SubtitleController({ doc: document, isTop: true, adapter: skoolNativeAdapter, bridge: br, settings: s, raf: () => 0, cancelRaf: () => undefined, navSettleMs: 50, captionGraceMs: 20 });
  const det = new VideoDetector(document, skoolNativeAdapter, (cb) => setTimeout(cb, 0));
  const life = createLessonLifecycle(window, c, det);
  life.start();
  cleanup.push(() => {
    life.stop();
    c.destroy();
  });
  return { c, video, br, box, life, settings: s };
}

const vi = (c: SubtitleController) => c.currentOverlay?.text.vi ?? '';
const goto = (life: ReturnType<typeof createLessonLifecycle>, md: string) => {
  history.pushState(null, '', `/grp/classroom/course1?md=${md}`);
  life.nav.check(); // what the Navigation API / tabs.onUpdated signal triggers
};
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await flush();
};

describe('automatic English caption initialisation', () => {
  it('opt-in OFF (default): a disabled English track is left untouched and reported', async () => {
    const t = lessonTrack('A');
    const { c, br } = mount({}, t);
    await tick();
    expect(t.mode).toBe('disabled');
    expect(br.providerCalls).toHaveLength(0);
    expect(c.status()).toMatchObject({ captionsOff: true });
    expect(c.status().notice).toMatch(/CC đang tắt/);
  });

  it('opt-in OFF: translation starts by itself as soon as the user turns CC on (no reload)', async () => {
    const t = lessonTrack('A');
    const { c, video, br } = mount({}, t);
    await tick();
    t.mode = 'showing';
    video.textTracks.dispatchEvent(new Event('change'));
    await tick();
    expect(br.providerCalls.length).toBeGreaterThan(0);
    video._setTime(1);
    expect(vi(c)).toBe('VI(A line 0.)');
  });

  it('opt-in ON: disabled track switched to "hidden" (no duplicate English rendering) and translated before playback', async () => {
    const t = lessonTrack('A');
    const { c, video, br } = mount({ autoEnableCaptions: true }, t);
    await tick();
    expect(t.mode).toBe('hidden');
    expect(br.providerCalls).toEqual(['A line 0.', 'A line 1.', 'A line 2.', 'A line 3.']); // video still at 0 s, paused
    video._setTime(21);
    expect(vi(c)).toBe('VI(A line 2.)');
  });

  it('opt-in ON: player immediately reverting to "disabled" is re-applied (bounded), then left alone', async () => {
    const t = lessonTrack('A');
    let mode: TextTrackMode = 'disabled';
    const sets: string[] = [];
    Object.defineProperty(t, 'mode', { get: () => mode, set: (m) => { sets.push(m); mode = m; } });
    const { video } = mount({ autoEnableCaptions: true }, t);
    for (let i = 0; i < 6; i++) {
      mode = 'disabled'; // player fights back every time
      video.dispatchEvent(new Event('timeupdate'));
    }
    expect(sets.filter((m) => m === 'hidden').length).toBe(3); // initial + 2 retries, never more
  });

  it('English cues that load asynchronously are picked up', async () => {
    const t = new FakeTrack('captions', 'English CC', 'en', []);
    t.mode = 'showing';
    const { c, video } = mount({}, t);
    await tick();
    t.pushCues([new FakeCue(0, 4, 'Late cue.')]);
    await tick();
    video._setTime(1);
    expect(vi(c)).toBe('VI(Late cue.)');
  });

  it('auto-start OFF: waits for "Bắt đầu dịch", then starts', async () => {
    const { c, br } = mount({ autoEnableCaptions: true, autoStart: false });
    await tick();
    expect(c.mode).toBe('paused');
    expect(br.providerCalls).toHaveLength(0);
    c.startSession();
    await tick();
    expect(br.providerCalls.length).toBeGreaterThan(0);
  });
});

describe('Skool SPA lesson navigation (no F5)', () => {
  it('A → B with the SAME <video> element reused: B is detected and translated automatically', async () => {
    const { c, video, life } = mount({ autoEnableCaptions: true });
    await tick();
    video._setTime(1);
    expect(vi(c)).toBe('VI(A line 0.)');
    const keyA = c.currentVideoKey;
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    expect(c.currentVideoKey).not.toBe(keyA);
    video._setTime(11);
    expect(vi(c)).toBe('VI(B line 1.)');
  });

  it('reused element whose source changes LATE: old lesson cues are never attributed to the new lesson', async () => {
    const { c, video, life, br } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB'); // URL first …
    await tick();
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]); // … media later (within settle window)
    await tick();
    video._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
    expect(br.providerCalls.filter((t) => t.startsWith('A')).length).toBe(4); // A translated once, never again
  });

  it('switching while a translation is in flight: stale response is cancelled and never shown', async () => {
    const { c, video, life, br } = mount({ autoEnableCaptions: true });
    br.hold(true);
    await tick();
    const keyA = c.currentVideoKey!;
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    br.hold(false);
    await tick(5);
    expect(br.cancels).toContain(keyA);
    video._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
  });

  it('rapid switching A → B → C → D: only the last lesson is active, one overlay', async () => {
    const { c, video, life } = mount({ autoEnableCaptions: true });
    for (const name of ['B', 'C', 'D']) {
      goto(life, `lesson${name}`);
      video._setSrc(`https://video.skool.com/${name}.m3u8`, [lessonTrack(name)]);
    }
    await tick(5);
    video._setTime(31);
    expect(vi(c)).toBe('VI(D line 3.)');
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
  });

  it('returning to a previously translated lesson reuses cached translations (no provider calls)', async () => {
    const { c, video, life, br } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    const calls = br.providerCalls.length;
    goto(life, 'lessonA');
    video._setSrc('https://video.skool.com/a.m3u8', [lessonTrack('A')]);
    await tick();
    expect(br.providerCalls.length).toBe(calls);
    video._setTime(1);
    expect(vi(c)).toBe('VI(A line 0.)');
  });

  it('browser Back / Forward (popstate) re-initialise the right lesson', async () => {
    const { c, video, life } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    history.replaceState(null, '', '/grp/classroom/course1?md=lessonA'); // what Back does to the URL
    window.dispatchEvent(new PopStateEvent('popstate'));
    video._setSrc('https://video.skool.com/a.m3u8', [lessonTrack('A')]);
    await tick();
    video._setTime(1);
    expect(vi(c)).toBe('VI(A line 0.)');
  });

  it('media element REPLACED during navigation (unmount + remount)', async () => {
    const { c, box, life } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB');
    box.innerHTML = '';
    const v2 = makeVideo(document, { src: 'https://video.skool.com/b.m3u8', tracks: [lessonTrack('B')] });
    box.append(v2);
    await tick(5);
    v2._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
  });

  it('no duplicate listeners: the old lesson video no longer drives the overlay', async () => {
    const { c, box, life } = mount({ autoEnableCaptions: true });
    const oldVideo = box.querySelector('video') as FakeVideo;
    await tick();
    goto(life, 'lessonB');
    box.innerHTML = '';
    const v2 = makeVideo(document, { src: 'https://video.skool.com/b.m3u8', tracks: [lessonTrack('B')] });
    box.append(v2);
    await tick(5);
    v2._setTime(1);
    oldVideo._setTime(21); // events from the detached old element must be ignored
    expect(vi(c)).toBe('VI(B line 0.)');
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
  });

  it('settings (Gemini provider) are untouched by navigation', async () => {
    const gem = { provider: { kind: 'gemini' as const, endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', temperature: 0.2 }, autoEnableCaptions: true };
    const { video, life, settings } = mount(gem);
    const snapshot = JSON.stringify(settings);
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  it('seek and fullscreen still work after switching lessons', async () => {
    const { c, video, life, box } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => box });
    document.dispatchEvent(new Event('fullscreenchange'));
    video._setTime(31);
    expect(vi(c)).toBe('VI(B line 3.)');
    video._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
    expect(c.currentOverlay!.container).toBe(box);
  });

  it('auto-init on navigation OFF: new lesson waits for "Bắt đầu dịch"', async () => {
    const { c, video, life } = mount({ autoEnableCaptions: true, autoInitOnNavigation: false });
    await tick();
    goto(life, 'lessonB');
    video._setSrc('https://video.skool.com/b.m3u8', [lessonTrack('B')]);
    await tick();
    expect(c.mode).toBe('paused');
    c.startSession();
    await tick();
    video._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
  });
});

describe('navigation race (real-Skool report: switching lessons "sometimes" needed F5)', () => {
  it('old <video> still mounted at navigation, new one appears during the settle wait → stays on the NEW video', async () => {
    const { c, box, life } = mount({ autoEnableCaptions: true });
    await tick();
    goto(life, 'lessonB'); // old element still in the DOM → controller waits (navSettleMs)
    await new Promise((r) => setTimeout(r, 10));
    box.innerHTML = '';
    const v2 = makeVideo(document, { src: 'https://video.skool.com/b.m3u8', tracks: [lessonTrack('B')] });
    box.append(v2); // new lesson player mounts a moment later
    await new Promise((r) => setTimeout(r, 120)); // past the settle timeout of the stale wait
    await tick();
    v2._setTime(1);
    expect(vi(c)).toBe('VI(B line 0.)');
  });
});
