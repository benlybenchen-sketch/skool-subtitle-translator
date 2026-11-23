/**
 * Regression: real Skool lesson evidence — media is playing and captions are visible, but
 * document.querySelectorAll('video').length === 0, there are 2 <audio> elements and 3 iframes
 * from js.stripe.com, and open shadow roots contain no <video>.
 */
import { detect, deepQueryAll, findPlayerAnchor } from '../../src/players/detector';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { collectDiagnostics } from '../../src/content/diagnostics';
import { checkBackends } from '../../src/translation/health';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { FakeCue, FakeTrack, FakeTrackList, flush, installVTTCue, setRect } from './fakes';

installVTTCue();

function fakeAudio(opts: { playing?: boolean; duration?: number; tracks?: FakeTrack[] } = {}): HTMLAudioElement {
  const a = document.createElement('audio');
  const list = new FakeTrackList();
  for (const t of opts.tracks ?? []) list.add(t);
  let time = 0;
  Object.defineProperties(a, {
    paused: { get: () => !opts.playing },
    duration: { get: () => opts.duration ?? NaN },
    currentTime: { get: () => time, set: (t: number) => (time = t) },
    textTracks: { get: () => list },
    currentSrc: { get: () => 'blob:https://www.skool.com/abc' },
  });
  setRect(a, 0, 0);
  return a;
}

function skoolLikePage(audios: HTMLAudioElement[]) {
  document.body.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const f = document.createElement('iframe');
    f.src = `https://js.stripe.com/v3/m-outer-${i}.html`;
    setRect(f, 0, 0);
    document.body.append(f);
  }
  const player = document.createElement('div');
  player.className = 'styled__VideoPlayerWrapper-abc';
  setRect(player, 854, 480, 100, 120);
  document.body.append(player, ...audios);
  return player;
}

function bridge() {
  const statuses: any[] = [];
  const b: ControllerBridge & { statuses: any[]; calls: number } = {
    statuses,
    calls: 0,
    async translate(_k, units) {
      this.calls++;
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus(s) {
      statuses.push(s);
    },
  };
  return b;
}

const live: SubtitleController[] = [];
afterEach(() => live.splice(0).forEach((c) => c.destroy()));
const mkController = (br: ControllerBridge) => {
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: skoolNativeAdapter,
    bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true }),
    captionGraceMs: 10,
    raf: () => 0,
    cancelRaf: () => undefined,
  });
  live.push(c);
  return c;
};

describe('Skool page without an accessible <video>', () => {
  it('ignores Stripe iframes, finds no video, and picks a player-shaped anchor', () => {
    const player = skoolLikePage([fakeAudio(), fakeAudio()]);
    const r = detect(document, skoolNativeAdapter);
    expect(r.videos).toHaveLength(0);
    expect(r.audios).toHaveLength(2);
    expect(r.embeds).toHaveLength(0);
    expect(r.primary).toBeNull(); // paused short audio clips are not treated as the lesson
    expect(r.anchor).toBe(player);
  });

  it('uses a playing <audio> element as a media target (time source) when present', () => {
    const lesson = fakeAudio({ playing: true, duration: 900 });
    skoolLikePage([fakeAudio(), lesson]);
    const r = detect(document, skoolNativeAdapter);
    expect(r.primary).toMatchObject({ kind: 'media', el: lesson });
  });

  it('still reports status (so the popup can explain) and offers Audio Mode', async () => {
    skoolLikePage([fakeAudio(), fakeAudio()]);
    const br = bridge();
    const c = mkController(br);
    const r = detect(document, skoolNativeAdapter);
    c.setTarget(r.primary, r.anchor);
    c.setDetectionInfo({ embeds: [], videos: r.videos.length, audios: r.audios.length });
    c.announce();
    await new Promise((res) => setTimeout(res, 300));
    const s = br.statuses.at(-1);
    expect(s).toMatchObject({ targetKind: null, videoElements: 0, audioElements: 2, pageAnchor: true, captionState: 'unavailable', mode: 'waiting-audio' });
  });

  it('Audio Mode renders a page-level Vietnamese overlay positioned over the player anchor', () => {
    const player = skoolLikePage([fakeAudio(), fakeAudio()]);
    const c = mkController(bridge());
    const r = detect(document, skoolNativeAdapter);
    c.setTarget(r.primary, r.anchor);
    c.setAudioState(true, true);
    c.onLiveSegment({ id: 'live-1', en: 'Welcome to the lesson.', vi: 'Chào mừng đến với bài học.', final: true });
    const ov = c.currentOverlay!;
    expect(ov.text.vi).toBe('Chào mừng đến với bài học.');
    ov.layout();
    const root = ov.host.shadowRoot!.querySelector('.root') as HTMLElement;
    expect(root.style.width).toBe('854px');
    expect(root.style.top).toBe('120px');
    expect(root.classList.contains('hidden')).toBe(false);
    expect(c.mode).toBe('audio');
    void player;
  });

  it('page-level overlay falls back to the viewport when no anchor exists', () => {
    document.body.innerHTML = '';
    const c = mkController(bridge());
    c.setTarget(null, null);
    c.setAudioState(true, true);
    c.onLiveSegment({ id: 'x', en: 'Hi', vi: 'Xin chào', final: true });
    const ov = c.currentOverlay!;
    expect(ov.pageLevel).toBe(true);
    ov.layout();
    const root = ov.host.shadowRoot!.querySelector('.root') as HTMLElement;
    expect(root.style.width).toBe(`${window.innerWidth}px`);
    expect(ov.text.vi).toBe('Xin chào');
  });

  it('Caption Mode stays preferred: an <audio> with an English track drives synced captions', async () => {
    const track = new FakeTrack('captions', 'English', 'en', [new FakeCue(1, 3, 'First line.'), new FakeCue(4, 6, 'Second line.')]);
    const lesson = fakeAudio({ tracks: [track] });
    skoolLikePage([lesson]);
    const c = mkController(bridge());
    const r = detect(document, skoolNativeAdapter);
    expect(r.primary?.kind).toBe('media');
    c.setTarget(r.primary, r.anchor);
    await flush();
    lesson.currentTime = 5;
    lesson.dispatchEvent(new Event('timeupdate'));
    expect(c.mode).toBe('caption');
    expect(c.currentOverlay!.text.vi).toBe('VI(Second line.)');
  });
});

describe('open vs closed shadow DOM', () => {
  it('finds <video> inside open shadow roots but cannot (and does not try to) see closed ones', () => {
    document.body.innerHTML = '';
    const open = document.createElement('x-open');
    open.attachShadow({ mode: 'open' }).append(document.createElement('video'));
    const closed = document.createElement('x-closed');
    closed.attachShadow({ mode: 'closed' }).append(document.createElement('video'));
    document.body.append(open, closed);
    expect(deepQueryAll(document, 'video')).toHaveLength(1);
  });
});

describe('diagnostics', () => {
  it('reports accessible media, iframes and possible closed-shadow hosts without page text', () => {
    skoolLikePage([fakeAudio(), fakeAudio({ playing: true, duration: 600 })]);
    const host = document.createElement('mux-player');
    setRect(host, 854, 480);
    document.body.append(host);
    const r = detect(document, skoolNativeAdapter);
    const d = collectDiagnostics(document, r, { mode: 'waiting-audio', captionState: 'unavailable', captionSource: null, targetKind: 'media' } as any);
    expect(d.videoLight).toBe(0);
    expect(d.audioLight).toBe(2);
    expect(d.iframes.map((i) => i.host)).toEqual(['js.stripe.com', 'js.stripe.com', 'js.stripe.com']);
    expect(d.media[1]).toMatchObject({ tag: 'audio', paused: false, src: 'blob: (MediaSource stream)' });
    expect(d.customElementsWithoutOpenShadow).toEqual([{ tag: 'mux-player', size: '854x480' }]);
    expect(JSON.stringify(d)).not.toMatch(/m-outer/); // no full iframe URLs
  });

  it('findPlayerAnchor skips whole-page wrappers', () => {
    document.body.innerHTML = '';
    const page = document.createElement('div');
    page.className = 'video-page';
    setRect(page, window.innerWidth, window.innerHeight);
    document.body.append(page);
    expect(findPlayerAnchor(document)).toBeNull();
  });
});

describe('backend health (popup: "translation backend unavailable")', () => {
  const s = (p: any = {}, stt: any = {}) =>
    mergeSettings({ ...DEFAULT_SETTINGS, provider: { ...DEFAULT_SETTINGS.provider, ...p }, stt: { ...DEFAULT_SETTINGS.stt, ...stt } });
  it('local backend down → unreachable; up → ready', async () => {
    const down = await checkBackends(s(), {}, { hasPermission: async () => true, fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as any });
    expect(down.translation.state).toBe('unreachable');
    const up = await checkBackends(s(), {}, { hasPermission: async () => true, fetchImpl: (async () => new Response('{}')) as any });
    expect(up.translation.state).toBe('ready');
    expect(up.stt.state).toBe('ready');
  });
  it('remote providers: consent, permission and key are checked without calling paid APIs', async () => {
    const fetchImpl = vi.fn();
    const remote = s({ kind: 'openai', endpoint: 'https://api.openai.com/v1' });
    expect((await checkBackends(remote, {}, { hasPermission: async () => true, fetchImpl })).translation.state).toBe('no-consent');
    const consented = mergeSettings({ ...remote, consent: { remoteTranslation: true, remoteAudio: false } });
    expect((await checkBackends(consented, {}, { hasPermission: async () => false, fetchImpl })).translation.state).toBe('no-permission');
    expect((await checkBackends(consented, {}, { hasPermission: async () => true, fetchImpl })).translation.state).toBe('no-key');
    expect((await checkBackends(consented, { translationApiKey: 'k' }, { hasPermission: async () => true, fetchImpl })).translation.state).toBe('configured');
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('openai'), expect.anything());
  });
});
