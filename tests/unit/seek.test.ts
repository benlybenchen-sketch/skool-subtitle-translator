/**
 * Regression: on real Skool, subtitles disappeared after seeking and only came back after
 * toggling CC off/on. Simulates the player behaviours that produce exactly that symptom.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { OVERLAY_HOST_ATTR } from '../../src/overlay/overlay';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';

installVTTCue();

// 20 cues, one every 30 s over 10 minutes: "Cue 0." at 0–4 s, "Cue 1." at 30–34 s, …
const ALL = () => Array.from({ length: 20 }, (_, i) => new FakeCue(i * 30, i * 30 + 4, `Cue ${i}.`));
const at = (i: number) => i * 30 + 1;

/** Streaming (HLS-like) track: only cues near the playhead are loaded; no event when flushed. */
function streamingTrack(window = 60) {
  const t = new FakeTrack('captions', 'English CC', 'en', []);
  const load = (time: number) => {
    for (const c of [...(t as any)._cues]) t.removeCue(c); // flush silently
    for (const c of ALL()) if (c.startTime >= time - window && c.startTime <= time + window) t.addCue(c);
  };
  load(0);
  return { t, load };
}

function bridge(delayMs = 0) {
  const calls: string[][] = [];
  let pending: (() => void)[] = [];
  const b: ControllerBridge & { calls: string[][]; flushDelayed: () => void } = {
    calls,
    async translate(_k, units) {
      calls.push(units.map((u) => u.text));
      if (delayMs) await new Promise<void>((r) => pending.push(r));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus() {},
    flushDelayed: () => pending.splice(0).forEach((r) => r()),
  };
  return b;
}

function setup(track: FakeTrack, opts: { delayMs?: number; autoEnableCaptions?: boolean } = {}) {
  document.body.innerHTML = '';
  const video = makeVideo(document, { tracks: [track] });
  const box = document.createElement('div');
  setRect(box, 960, 540);
  box.append(video);
  document.body.append(box);
  const br = bridge(opts.delayMs);
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: skoolNativeAdapter,
    bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, pretranslateAll: false, autoEnableCaptions: opts.autoEnableCaptions ?? true }),
    raf: () => 0,
    cancelRaf: () => undefined,
  });
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 1 });
  controllers.push(c);
  return { c, video, br, box };
}

const text = (c: SubtitleController) => c.currentOverlay!.text.vi;

/** Seek like a real player: seeking → (player work) → seeked → timeupdate. */
function seek(video: FakeVideo, t: number, playerWork?: () => void) {
  video.dispatchEvent(new Event('seeking'));
  video.currentTime = t;
  playerWork?.();
  video.dispatchEvent(new Event('seeked'));
  video.dispatchEvent(new Event('timeupdate'));
}

const controllers: SubtitleController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.destroy()); // no stale overlays/frames leaking into the next test
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
});

describe('seek recovery', () => {
  it('player sets the track to "disabled" during seek → subtitles still shown, no CC toggle needed', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL());
    const { c, video } = setup(track);
    await flush();
    seek(video, at(1));
    expect(text(c)).toBe('VI(Cue 1.)');
    // the bug: player disables the track on seek (cues → null)
    seek(video, at(3), () => (track.mode = 'disabled'));
    await flush();
    expect(text(c)).toBe('VI(Cue 3.)');
    seek(video, at(0));
    expect(text(c)).toBe('VI(Cue 0.)');
  });

  it('streaming track flushes old cues on seek → previously seen cues stay available', async () => {
    const { t, load } = streamingTrack();
    const { c, video, br } = setup(t);
    await flush();
    seek(video, at(1));
    expect(text(c)).toBe('VI(Cue 1.)');
    seek(video, at(10), () => load(at(10))); // forward 5 minutes, player flushes cues 0–2
    t.dispatchEvent(new Event('cuechange'));
    await flush();
    expect(text(c)).toBe('VI(Cue 10.)');
    seek(video, at(1), () => load(at(1))); // rewind: cached translation restored immediately
    expect(text(c)).toBe('VI(Cue 1.)');
    await flush();
    const sent = br.calls.flat();
    expect(new Set(sent).size).toBe(sent.length); // already translated cues are never requested again
  });

  it('recovers when cues arrive WITHOUT a cuechange event (self-healing on timeupdate)', async () => {
    const { t, load } = streamingTrack(10);
    const { c, video } = setup(t);
    await flush();
    seek(video, at(15), () => load(at(15))); // cues for 450 s added silently
    await flush();
    video.dispatchEvent(new Event('timeupdate'));
    await flush();
    expect(text(c)).toBe('VI(Cue 15.)');
  });

  it('player replaces the TextTrack object after seeking → listeners re-attach to the new track', async () => {
    const old = new FakeTrack('captions', 'English CC', 'en', ALL().slice(0, 5));
    const { c, video } = setup(old);
    await flush();
    seek(video, at(12), () => {
      old.mode = 'disabled';
      (video._tracks.items as FakeTrack[]).splice(0, 1);
      delete (video._tracks as any)[0];
      const fresh = new FakeTrack('captions', 'English CC', 'en', ALL());
      fresh.mode = 'showing';
      video._tracks.add(fresh); // addtrack
      (video._tracks as any)[0] = fresh;
    });
    await flush();
    expect(text(c)).toBe('VI(Cue 12.)');
    expect(c.status().captionSource).toBe('texttrack');
  });

  it('does not fight the user: re-enables a player-disabled track at most once per seek', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL().slice(0, 3));
    track.mode = 'showing'; // the user turned CC on themselves
    const modes: string[] = [];
    const { video } = setup(track, { autoEnableCaptions: false });
    await flush();
    let mode = track.mode;
    Object.defineProperty(track, 'mode', { get: () => mode, set: (m) => { modes.push(m); mode = m; } });
    seek(video, at(10), () => (track.mode = 'disabled'));
    await flush();
    for (let i = 0; i < 5; i++) video.dispatchEvent(new Event('timeupdate'));
    // user turns CC off later (not right after a seek): we must not re-enable it
    track.mode = 'disabled';
    for (let i = 0; i < 5; i++) video.dispatchEvent(new Event('timeupdate'));
    await new Promise((r) => setTimeout(r, 2700));
    video.dispatchEvent(new Event('timeupdate'));
    expect(modes.filter((m) => m === 'hidden').length).toBeLessThanOrEqual(1);
  });

  it('delayed responses for the old position never overwrite the new position', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL());
    const { c, video, br } = setup(track, { delayMs: 1 });
    seek(video, at(0));
    seek(video, at(8)); // seek while first batch still in flight
    br.flushDelayed();
    await flush();
    br.flushDelayed();
    await flush();
    seek(video, at(8));
    expect(text(c)).toBe('VI(Cue 8.)');
    seek(video, at(0));
    expect(text(c)).toBe('VI(Cue 0.)'); // late result was kept (cached), not lost
  });

  it('rapid repeated seeking (paused, 2×) → correct line, no duplicate requests, one overlay', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL());
    const { c, video, br } = setup(track);
    video.playbackRate = 2;
    for (const i of [1, 11, 2, 19, 5, 0, 12, 12, 7]) seek(video, at(i));
    await flush();
    await flush();
    seek(video, at(7));
    expect(text(c)).toBe('VI(Cue 7.)');
    const sent = br.calls.flat();
    expect(new Set(sent).size).toBe(sent.length);
    expect(document.querySelectorAll(`[${OVERLAY_HOST_ATTR}]`)).toHaveLength(1);
  });

  it('fullscreen + seeking keeps subtitles visible inside the fullscreen container', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL());
    const { c, video, box } = setup(track);
    await flush();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => box });
    document.dispatchEvent(new Event('fullscreenchange'));
    seek(video, at(9), () => (track.mode = 'disabled'));
    await flush();
    expect(c.currentOverlay!.container).toBe(box);
    expect(text(c)).toBe('VI(Cue 9.)');
  });

  it('reports when accessible captions genuinely disappear (track removed, no replacement)', async () => {
    const track = new FakeTrack('captions', 'English CC', 'en', ALL().slice(0, 2));
    const { c, video } = setup(track);
    await flush();
    seek(video, at(1), () => {
      track.mode = 'disabled';
      (video._tracks.items as FakeTrack[]).splice(0, 1);
      delete (video._tracks as any)[0];
      video._tracks.dispatchEvent(new Event('removetrack'));
    });
    await flush();
    expect(c.status().notice ?? '').toMatch(/không còn/i);
    expect(text(c)).toBe('VI(Cue 1.)'); // timestamp-accurate cues already read remain valid
    seek(video, at(15));
    expect(text(c)).toBe(''); // nothing stale shown where no caption is known
  });
});
