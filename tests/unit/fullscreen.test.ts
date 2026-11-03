import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { ControlPanel } from '../../src/content/panel';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect } from './fakes';

installVTTCue();

const setFs = (el: Element | null, type = 'fullscreenchange') => {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
  document.dispatchEvent(new Event(type));
};

const bridge: ControllerBridge = {
  async translate(_k, units) {
    return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
  },
  cancel() {},
  reportStatus() {},
};

/** Skool-like page: player container > video, VI control panel wired like content/index.ts. */
async function setup() {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'player-container';
  setRect(container, 960, 540);
  const video = makeVideo(document, {
    tracks: [new FakeTrack('captions', 'English CC', 'en', [new FakeCue(1, 3, 'First line.'), new FakeCue(4, 6, 'Second line.')])],
  });
  container.append(video);
  document.body.append(container);
  const settings = mergeSettings(DEFAULT_SETTINGS);
  const c = new SubtitleController({ doc: document, isTop: true, adapter: skoolNativeAdapter, bridge, settings, raf: () => 0, cancelRaf: () => undefined });
  const panel = new ControlPanel(document, settings, () => undefined, () => undefined);
  panel.mount();
  c.onOverlayContainerChange((el) => panel.follow(el));
  cleanups.push(() => {
    c.destroy();
    panel.destroy();
  });
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
  await flush();
  const overlayHost = () => document.querySelector(`[${OVERLAY_HOST_ATTR}]`)!;
  const panelHost = () => document.querySelector('[data-sst-panel]')!;
  return { c, panel, video, container, overlayHost, panelHost };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  setFs(null);
});

describe('fullscreen: VI control + subtitle overlay', () => {
  it('both move INTO the fullscreen element on enter and back to <body> on exit', async () => {
    const { container, overlayHost, panelHost, c, video } = await setup();
    video._setTime(2);
    setFs(container); // user presses F
    expect(overlayHost().parentElement).toBe(container);
    expect(panelHost().parentElement).toBe(container);
    expect(c.currentOverlay!.text.vi).toBe('VI(First line.)');
    setFs(null); // Esc
    expect(overlayHost().parentElement).toBe(document.body);
    expect(panelHost().parentElement).toBe(document.body);
  });

  it('repeated F/Esc cycles: no duplicates, sync and session preserved', async () => {
    const { container, c, video } = await setup();
    const key = c.currentVideoKey;
    for (let i = 0; i < 6; i++) {
      setFs(container);
      video._setTime(i % 2 ? 5 : 2);
      expect(c.currentOverlay!.text.vi).toBe(i % 2 ? 'VI(Second line.)' : 'VI(First line.)');
      setFs(null);
    }
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
    expect(document.querySelectorAll('[data-sst-panel]')).toHaveLength(1);
    expect(c.currentVideoKey).toBe(key); // same player/session, nothing re-detected
    expect(c.mode).toBe('caption');
    video._setTime(5);
    expect(c.currentOverlay!.text.vi).toBe('VI(Second line.)');
  });

  it('does not add event listeners on each transition (no leaks)', async () => {
    const { container } = await setup();
    const add = vi.spyOn(document, 'addEventListener');
    for (let i = 0; i < 5; i++) {
      setFs(container);
      setFs(null);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it('webkitfullscreenchange is handled too', async () => {
    const { container, overlayHost, panelHost } = await setup();
    setFs(container, 'webkitfullscreenchange');
    expect(overlayHost().parentElement).toBe(container);
    expect(panelHost().parentElement).toBe(container);
  });

  it('mounts in the fullscreen element even when the video is inside its shadow root', async () => {
    document.body.innerHTML = '';
    const host = document.createElement('skool-player');
    setRect(host, 960, 540);
    const video = makeVideo(document, { tracks: [new FakeTrack('captions', 'English', 'en', [new FakeCue(0, 5, 'Hi.')])] });
    host.attachShadow({ mode: 'open' }).append(video);
    document.body.append(host);
    const c = new SubtitleController({ doc: document, isTop: true, adapter: skoolNativeAdapter, bridge, settings: mergeSettings(DEFAULT_SETTINGS), raf: () => 0, cancelRaf: () => undefined });
    cleanups.push(() => c.destroy());
    c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
    setFs(host);
    expect(c.currentOverlay!.container).toBe(host);
  });

  it('<video> element itself fullscreen: UI stays in <body>, subtitles use the native track fallback', async () => {
    const { video, overlayHost, panelHost } = await setup();
    setFs(video);
    expect(overlayHost().parentElement).toBe(document.body);
    expect(panelHost().parentElement).toBe(document.body);
    video._setTime(2);
    const own = video._tracks.items.find((t) => t.label.includes('SST'));
    expect(own?.mode).toBe('showing');
  });

  it('custom (CSS) fullscreen without the Fullscreen API: follows the fixed, viewport-sized container', async () => {
    const { container, video, overlayHost, panelHost, c } = await setup();
    // Skool-style pseudo fullscreen: container becomes position:fixed and fills the viewport
    container.style.position = 'fixed';
    setRect(container, window.innerWidth, window.innerHeight);
    setRect(video, window.innerWidth, window.innerHeight);
    c.currentOverlay!.layout();
    expect(overlayHost().parentElement).toBe(container);
    expect(panelHost().parentElement).toBe(container);
    // exit
    container.style.position = '';
    setRect(container, 960, 540);
    setRect(video, 960, 540);
    c.currentOverlay!.layout();
    expect(overlayHost().parentElement).toBe(document.body);
    expect(panelHost().parentElement).toBe(document.body);
  });

  it('panel stays hidden in fullscreen when the user disabled it', async () => {
    const { container, panel, panelHost } = await setup();
    panel.unmount();
    setFs(container);
    expect(panelHost()).toBeNull();
  });

  it('destroy() removes the UI and its fullscreen listeners (no orphans, even with a pending layout frame)', async () => {
    const { c, panel, container } = await setup();
    window.dispatchEvent(new Event('resize')); // schedules a layout frame
    c.destroy();
    panel.destroy();
    setFs(container);
    await new Promise((r) => setTimeout(r, 40)); // let the pending frame run
    expect(document.querySelector(`[${OVERLAY_HOST_ATTR}]`)).toBeNull();
    expect(document.querySelector('[data-sst-panel]')).toBeNull();
  });
});
