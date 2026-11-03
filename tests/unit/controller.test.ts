import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter, youtubeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/types';
import type { Target } from '../../src/players/detector';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import { NativeTrackFallback } from '../../src/overlay/nativeTrack';

installVTTCue();

const CUES = () => [
  new FakeCue(1, 3, 'Welcome back to the course.'),
  new FakeCue(4, 6, 'Open Shopify.'),
  new FakeCue(8, 10, 'Set the budget to $50.'),
];

function bridge(delayMs = 0) {
  const calls: { videoKey: string; texts: string[]; context: string[] }[] = [];
  const statuses: any[] = [];
  const b: ControllerBridge & { calls: typeof calls; statuses: any[]; cancels: string[] } = {
    calls,
    statuses,
    cancels: [],
    async translate(videoKey, units, context) {
      calls.push({ videoKey, texts: units.map((u) => u.text), context });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel(k) {
      this.cancels.push(k);
    },
    reportStatus(s) {
      statuses.push(s);
    },
  };
  return b;
}

function setup(opts: { settings?: Partial<Settings>; tracks?: FakeTrack[]; delayMs?: number; adapter?: any } = {}) {
  document.body.innerHTML = '';
  const track = new FakeTrack('subtitles', 'English', 'en', CUES());
  const video = makeVideo(document, { tracks: opts.tracks ?? [track] });
  document.body.append(video);
  const br = bridge(opts.delayMs);
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...opts.settings });
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: opts.adapter ?? skoolNativeAdapter,
    bridge: br,
    settings,
    captionGraceMs: 10,
    raf: () => 0,
    cancelRaf: () => undefined,
  });
  const target: Target = { kind: 'video', el: video, provider: 'skool-native', area: 960 * 540 };
  return { c, video, track, br, target, settings };
}

const overlayText = (c: SubtitleController) => c.currentOverlay!.text;

describe('Caption Mode (TextTrack)', () => {
  it('reads English cues, translates and renders synchronized Vietnamese', async () => {
    const { c, video, track, br, target } = setup();
    c.setTarget(target);
    await flush();
    expect(track.mode).toBe('hidden'); // enabled for reading, not rendered natively
    expect(br.calls[0].texts).toEqual(['Welcome back to the course.', 'Open Shopify.', 'Set the budget to $50.']);
    video._setTime(2);
    expect(overlayText(c).vi).toBe('VI(Welcome back to the course.)');
    video._setTime(3.5); // gap between cues
    expect(overlayText(c).vi).toBe('');
    video._setTime(5);
    expect(overlayText(c).vi).toBe('VI(Open Shopify.)');
    expect(c.mode).toBe('caption');
  });

  it('stays in sync after seeking backwards and forwards', async () => {
    const { c, video, target } = setup();
    c.setTarget(target);
    await flush();
    video._setTime(9);
    expect(overlayText(c).vi).toBe('VI(Set the budget to $50.)');
    video._setTime(1.5);
    expect(overlayText(c).vi).toBe('VI(Welcome back to the course.)');
  });

  it('pause/resume and playback-rate changes keep correct text', async () => {
    const { c, video, target } = setup();
    c.setTarget(target);
    await flush();
    video._play();
    video._setTime(4.5);
    video._pause();
    expect(overlayText(c).vi).toBe('VI(Open Shopify.)');
    video.playbackRate = 2;
    video._play();
    video._setTime(8.5);
    expect(overlayText(c).vi).toBe('VI(Set the budget to $50.)');
  });

  it('shows dimmed English while a translation is still pending (slow network)', async () => {
    const { c, video, target } = setup({ delayMs: 50 });
    c.setTarget(target);
    video._setTime(2);
    expect(overlayText(c).vi).toBe('Welcome back to the course.'); // fallback text
    await new Promise((r) => setTimeout(r, 70));
    video._setTime(2.1);
    expect(overlayText(c).vi).toBe('VI(Welcome back to the course.)');
  });

  it('bilingual mode shows both languages', async () => {
    const { c, video, target } = setup({ settings: { displayMode: 'bilingual' } });
    c.setTarget(target);
    await flush();
    video._setTime(5);
    expect(overlayText(c)).toEqual({ vi: 'VI(Open Shopify.)', en: 'Open Shopify.' });
  });

  it('picks up cues streamed in later (HLS) without duplicating requests', async () => {
    const track = new FakeTrack('captions', 'English', 'en-US', [new FakeCue(1, 2, 'First.')]);
    const { c, video, br, target } = setup({ tracks: [track] });
    c.setTarget(target);
    await flush();
    track.pushCues([new FakeCue(3, 4, 'Second.')]);
    await flush();
    const all = br.calls.flatMap((x) => x.texts);
    expect(all).toEqual(['First.', 'Second.']);
    video._setTime(3.5);
    expect(overlayText(c).vi).toBe('VI(Second.)');
  });

  it('upgrades to a text track that is added after the video', async () => {
    const { c, video, br, target } = setup({ tracks: [] });
    c.setTarget(target);
    video._tracks.add(new FakeTrack('subtitles', 'English', 'en', CUES()));
    await flush();
    expect(br.calls.length).toBeGreaterThan(0);
    video._setTime(2);
    expect(overlayText(c).vi).toContain('VI(');
  });
});

describe('missing captions → Audio Mode offer', () => {
  it('reports unavailable captions and waits for Audio Mode', async () => {
    const { c, target, br } = setup({ tracks: [new FakeTrack('subtitles', 'Deutsch', 'de', CUES())] });
    c.setTarget(target);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.mode).toBe('waiting-audio');
    expect(br.calls).toHaveLength(0);
    const last = br.statuses[br.statuses.length - 1];
    expect(last.captionState).toBe('unavailable');
  });

  it('translates DOM-rendered captions live (YouTube CC style)', async () => {
    const { c, target, br } = setup({ tracks: [], adapter: youtubeAdapter });
    const box = document.createElement('div');
    box.className = 'ytp-caption-window-container';
    document.body.append(box);
    c.setTarget(target);
    box.innerHTML = '<span class="ytp-caption-segment">Hello from YouTube</span>';
    await new Promise((r) => setTimeout(r, 450));
    expect(br.calls[0].texts).toEqual(['Hello from YouTube']);
    expect(overlayText(c).vi).toBe('VI(Hello from YouTube)');
    expect(c.status().captionSource).toBe('dom');
  });
});

describe('duplicate prevention & mode exclusivity', () => {
  it('creates exactly one overlay per controller, even when the target is set repeatedly', () => {
    const { c, target } = setup();
    c.setTarget(target);
    c.setTarget(target);
    c.setTarget({ ...target });
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
  });

  it('Audio Mode suspends caption rendering and caption requests', async () => {
    const { c, video, target, br } = setup();
    c.setTarget(target);
    await flush();
    c.setAudioState(true, true);
    video._setTime(2);
    expect(overlayText(c).vi).toBe('');
    c.onLiveSegment({ id: 'live-1', en: 'Live words', final: false });
    expect(overlayText(c).vi).toBe('Live words');
    c.onLiveSegment({ id: 'live-1', en: 'Live words', vi: 'Lời nói trực tiếp', final: true });
    expect(overlayText(c).vi).toBe('Lời nói trực tiếp');
    const before = br.calls.length;
    c.setAudioState(false, false);
    video._setTime(5);
    expect(overlayText(c).vi).toBe('VI(Open Shopify.)');
    expect(br.calls.length).toBe(before);
  });

  it('non-primary frames ignore live segments', () => {
    const { c, target } = setup();
    c.setTarget(target);
    c.setAudioState(true, false);
    c.onLiveSegment({ id: 'x', en: 'should not show', final: false });
    expect(overlayText(c).vi).toBe('');
  });

  it('translation OFF hides the overlay', async () => {
    const { c, target, settings } = setup();
    c.setTarget(target);
    c.updateSettings({ ...settings, enabled: false });
    expect(c.mode).toBe('off');
  });
});

describe('lesson navigation', () => {
  it('reset() clears state and cancels in-flight translation for the old lesson', async () => {
    const { c, video, target, br } = setup();
    c.setTarget(target);
    await flush();
    const key = c.currentVideoKey!;
    c.reset();
    expect(br.cancels).toContain(key);
    expect(c.currentTimeline).toBeNull();
    // new lesson video
    const v2 = makeVideo(document, { src: 'https://video.skool.com/lesson-2.mp4', tracks: [new FakeTrack('subtitles', 'English', 'en', [new FakeCue(0, 2, 'Lesson two.')])] });
    document.body.append(v2);
    c.setTarget({ kind: 'video', el: v2, provider: 'skool-native', area: 1 });
    await flush();
    expect(c.currentVideoKey).not.toBe(key);
    v2._setTime(1);
    expect(overlayText(c).vi).toBe('VI(Lesson two.)');
    video._setTime(2); // old video no longer drives the overlay
    expect(overlayText(c).vi).toBe('VI(Lesson two.)');
  });
});

describe('fullscreen', () => {
  const setFs = (el: Element | null) => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  afterEach(() => setFs(null));

  it('moves the overlay into the fullscreen player container', async () => {
    const { c, video, target } = setup();
    const container = document.createElement('div');
    setRect(container, 1920, 1080);
    container.append(video);
    document.body.append(container);
    c.setTarget(target);
    setFs(container);
    expect(c.currentOverlay!.container).toBe(container);
    setFs(null);
    expect(c.currentOverlay!.container).toBe(document.body);
  });

  it('falls back to a native text track when the <video> itself is fullscreen', async () => {
    const { c, video, target } = setup();
    c.setTarget(target);
    await flush();
    setFs(video);
    video._setTime(2);
    const own = video._tracks.items.find((t) => t.label === NativeTrackFallback.LABEL)!;
    expect(own).toBeDefined();
    expect(own.mode).toBe('showing');
    expect(own.cues[0].text).toBe('VI(Welcome back to the course.)');
    setFs(null);
    video._setTime(2.2);
    expect(own.mode).toBe('disabled');
    expect(overlayText(c).vi).toBe('VI(Welcome back to the course.)');
  });

  it('never reads its own fallback track as an English source', async () => {
    const { c, video, target, br } = setup({ tracks: [] });
    video.addTextTrack('subtitles', NativeTrackFallback.LABEL, 'vi');
    c.setTarget(target);
    await new Promise((r) => setTimeout(r, 30));
    expect(br.calls).toHaveLength(0);
  });
});

describe('manual subtitle import', () => {
  it('uses imported cues instead of missing captions', async () => {
    const { c, video, target } = setup({ tracks: [] });
    c.setTarget(target);
    c.onManualCues([{ id: 'm1', start: 0, end: 2, text: 'Imported line.' }], 'lesson.vtt');
    await flush();
    video._setTime(1);
    expect(overlayText(c).vi).toBe('VI(Imported line.)');
    expect(c.status().captionSource).toBe('manual');
  });
});

export type { FakeVideo };
