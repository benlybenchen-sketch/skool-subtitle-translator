/**
 * Skool Native automatic CC activation (CaptionBootstrap + controller).
 * The fake players below model the plausible real-world behaviours (they are NOT Skool's code):
 *  menu-creates-track  no English TextTrack until CC → English is chosen in the player's menu (state C)
 *  enforced            track exists but the player re-disables any mode change it did not make (state D)
 *  hidden-ok           track exists disabled; "hidden" makes cues load (state A, earlier real evidence)
 *  toggle              a single CC toggle button (aria-pressed), no language menu
 *  media-chrome        <media-controller> selecting tracks on `mediashowsubtitlesrequest`
 *  no-controls         player without any captions control
 *  trusted-only        player ignores synthetic (untrusted) clicks
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { CaptionBootstrap } from '../../src/players/captionBootstrap';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/types';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, setRect, type FakeVideo } from './fakes';

installVTTCue();

type Variant = 'menu-creates-track' | 'enforced' | 'hidden-ok' | 'toggle' | 'media-chrome' | 'no-controls' | 'trusted-only';

const LESSON_SEC = 600;
/** Cue every 5 s; the player streams them in 60 s batches ahead of the playhead. */
const allCues = (prefix: string) => Array.from({ length: LESSON_SEC / 5 }, (_, i) => new FakeCue(i * 5 + 0.5, i * 5 + 4, `${prefix} sentence number ${i}.`));

class FakeSkoolPlayer {
  host: HTMLElement;
  root: ShadowRoot;
  video: FakeVideo;
  track: FakeTrack | null = null;
  selected = false;
  ccClicks = 0;
  optionClicks = 0;
  menuOpen = false;
  ccBtn: HTMLElement | null = null;
  menu: HTMLElement | null = null;
  private loadedUntil = 0;
  private readonly cues: FakeCue[];

  constructor(
    doc: Document,
    public variant: Variant,
    prefix = 'Lesson A',
    opts: { captionsInitiallyOn?: boolean } = {},
  ) {
    this.cues = allCues(prefix);
    this.host = doc.createElement('skool-player');
    this.root = this.host.attachShadow({ mode: 'open' });
    const wrap = doc.createElement(variant === 'media-chrome' ? 'media-controller' : 'div');
    wrap.className = 'player-wrap';
    this.video = makeVideo(doc, { src: `https://stream.skool.test/${prefix}.m3u8` });
    Object.defineProperty(this.video, 'duration', { value: LESSON_SEC, configurable: true });
    Object.defineProperty(this.video, 'readyState', { value: 1, configurable: true });
    wrap.append(this.video);
    setRect(this.host, 960, 540);
    setRect(wrap, 960, 540);
    if (variant !== 'menu-creates-track') this.createTrack(opts.captionsInitiallyOn ? 'showing' : 'disabled');
    if (opts.captionsInitiallyOn) this.selected = true;
    if (variant === 'media-chrome') {
      wrap.addEventListener('mediashowsubtitlesrequest', (e) => {
        const d = String((e as CustomEvent).detail);
        if (d.startsWith('en')) this.select();
      });
    }
    if (variant !== 'no-controls' && variant !== 'media-chrome') this.buildControls(doc, wrap, !!opts.captionsInitiallyOn);
    this.root.append(wrap);
    this.video.addEventListener('timeupdate', () => this.stream());
  }

  private createTrack(mode: TextTrackMode): void {
    const t = new FakeTrack('subtitles', 'English CC', 'en');
    let m: TextTrackMode = mode;
    let playerWrite = false;
    Object.defineProperty(t, 'mode', {
      get: () => m,
      set: (v: TextTrackMode) => {
        m = v;
        this.video._tracks.dispatchEvent(new Event('change'));
        if (this.variant === 'enforced' && !playerWrite && !this.selected) {
          // the player's internal state says "captions off": it reverts foreign changes at once
          playerWrite = true;
          m = 'disabled';
          playerWrite = false;
          this.video._tracks.dispatchEvent(new Event('change'));
        }
      },
    });
    (t as any)._playerSet = (v: TextTrackMode) => {
      playerWrite = true;
      t.mode = v;
      playerWrite = false;
    };
    this.track = t;
    this.video._tracks.add(t);
  }

  /** What selecting English in the player's own menu does. */
  select(): void {
    this.selected = true;
    if (!this.track) this.createTrack('showing');
    else (this.track as any)._playerSet('showing');
    this.stream();
  }

  /** Only a selected (or, for hidden-ok, any non-disabled) track receives cue batches. */
  stream(): void {
    const t = this.track;
    if (!t || t.mode === 'disabled') return;
    if (!this.selected && this.variant !== 'hidden-ok') return;
    const until = Math.min(LESSON_SEC, this.video.currentTime + 60);
    if (until <= this.loadedUntil) return;
    for (const c of this.cues) if (c.startTime >= this.loadedUntil && c.startTime < until) t.addCue(c);
    this.loadedUntil = until;
    t.dispatchEvent(new Event('cuechange'));
  }

  private buildControls(doc: Document, wrap: Element, on: boolean): void {
    const bar = doc.createElement('div');
    bar.className = 'controls';
    const play = Object.assign(doc.createElement('button'), { textContent: '▶' });
    play.setAttribute('aria-label', 'Play');
    const cc = doc.createElement('button');
    cc.setAttribute('aria-label', 'Captions');
    if (this.variant === 'toggle') cc.setAttribute('aria-pressed', on ? 'true' : 'false');
    else {
      cc.setAttribute('aria-haspopup', 'menu');
      cc.setAttribute('aria-expanded', 'false');
    }
    cc.addEventListener('click', (e) => {
      if (this.variant === 'trusted-only' && !e.isTrusted) return;
      this.ccClicks++;
      if (this.variant === 'toggle') {
        const now = cc.getAttribute('aria-pressed') !== 'true';
        cc.setAttribute('aria-pressed', String(now));
        if (now) this.select();
        else {
          this.selected = false;
          (this.track as any)?._playerSet('disabled');
        }
        return;
      }
      this.menuOpen = !this.menuOpen;
      cc.setAttribute('aria-expanded', String(this.menuOpen));
      menu.hidden = !this.menuOpen;
    });
    const menu = doc.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const [label, value] of [['Off', 'off'], ['English', 'en']]) {
      const item = Object.assign(doc.createElement('div'), { textContent: label });
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(value === 'off' ? !on : on));
      item.addEventListener('click', (e) => {
        if (this.variant === 'trusted-only' && !e.isTrusted) return;
        this.optionClicks++;
        if (value === 'en') this.select();
        else {
          this.selected = false;
          (this.track as any)?._playerSet('disabled');
        }
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', () => undefined);
    wrap.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape' && this.menuOpen) {
        this.menuOpen = false;
        cc.setAttribute('aria-expanded', 'false');
        menu.hidden = true;
      }
    });
    bar.append(play, cc, menu);
    wrap.append(bar);
    this.ccBtn = cc;
    this.menu = menu;
  }
}

// ---- harness --------------------------------------------------------------------------------

let clock = 0;
const live: SubtitleController[] = [];
afterEach(() => {
  live.splice(0).forEach((c) => c.destroy());
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function bridge() {
  const calls: string[][] = [];
  const b: ControllerBridge & { calls: string[][] } = {
    calls,
    async translate(_k, units) {
      calls.push(units.map((u) => u.text));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus() {},
  };
  return b;
}

function setup(variant: Variant, o: { settings?: Partial<Settings>; prefix?: string; captionsInitiallyOn?: boolean } = {}) {
  const player = new FakeSkoolPlayer(document, variant, o.prefix, { captionsInitiallyOn: o.captionsInitiallyOn });
  document.body.append(player.host);
  const br = bridge();
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: skoolNativeAdapter,
    bridge: br,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true, autoEnableCaptionsAsked: true, ...o.settings }),
    captionGraceMs: 10,
    raf: () => 0,
    cancelRaf: () => undefined,
    bootstrapOptions: { verifyMs: 2000, trackGraceMs: 10, menuWaitMs: 5, now: () => clock },
  });
  live.push(c);
  c.setTarget({ kind: 'video', el: player.video, provider: 'skool-native', area: 960 * 540 });
  return { player, c, br };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Advance playback (and the bootstrap clock) in 0.5 s steps. */
async function playFor(v: FakeVideo, sec: number) {
  for (let i = 0; i < sec * 2; i++) {
    clock += 500;
    (v as any)._t = (v.currentTime || 0) + 0.5 * (v.playbackRate || 1);
    v.currentTime = (v as any)._t;
    v.dispatchEvent(new Event('timeupdate'));
    if (i % 4 === 0) await flush();
  }
  await wait(20);
}
const viNow = (c: SubtitleController) => c.currentOverlay?.text.vi ?? '';
/** Vietnamese line shown in the middle of the cue around the current position (cues have gaps). */
const viAt = (c: SubtitleController) => {
  const v = (c as any).target?.el as FakeVideo | undefined;
  if (v) {
    const t = Math.floor(v.currentTime / 5) * 5 + 2;
    v.currentTime = t;
    v.dispatchEvent(new Event('timeupdate'));
  }
  return viNow(c);
};
const diag = (c: SubtitleController) => c.debugState().captionBootstrap!;

async function pressPlayAndWait(p: FakeSkoolPlayer, c: SubtitleController, sec = 6) {
  p.video._play();
  await wait(40);
  await playFor(p.video, sec);
  void c;
}

describe('Skool Native CC bootstrap — user opted in, never clicks CC', () => {
  it('C: no English track until CC → English in the player menu → menu used once, Vietnamese starts', async () => {
    const { player, c } = setup('menu-creates-track');
    expect(player.track).toBeNull();
    await pressPlayAndWait(player, c);
    expect(player.track).not.toBeNull();
    expect(player.ccClicks).toBe(1); // opened the menu once; never clicked again
    expect(player.optionClicks).toBe(1);
    expect(player.menuOpen).toBe(false); // closed with Escape
    expect(viAt(c)).toMatch(/^VI\(Lesson A sentence number \d+\.\)$/);
    const d = diag(c);
    expect(['TRANSLATING', 'MONITORING']).toContain(d.state);
    expect(d.method).toBe('native-ui');
    expect(d.ccControls[0]).toMatchObject({ label: 'Captions', hasPopup: 'menu' });
    // English rendered by the player is hidden: only Vietnamese shows
    expect(player.root.querySelector('style[data-sst-cue-hide]')).not.toBeNull();
    expect(JSON.stringify(d)).not.toContain('sentence number'); // no caption text in diagnostics
  });

  it('D: track exists but the player reverts "hidden" → escalates to the player menu, keeps the playback position', async () => {
    const { player, c } = setup('enforced');
    player.video.currentTime = 120;
    await pressPlayAndWait(player, c, 8);
    expect(player.selected).toBe(true);
    expect(player.ccClicks).toBe(1);
    expect(player.video.currentTime).toBeGreaterThan(120); // never restarted
    expect(viAt(c)).toMatch(/^VI\(/);
    expect(diag(c).tried).toEqual(expect.arrayContaining(['texttrack-hidden', 'native-ui']));
  });

  it('A: disabled track where "hidden" works → no player UI interaction at all', async () => {
    const { player, c } = setup('hidden-ok');
    await pressPlayAndWait(player, c);
    expect(player.ccClicks).toBe(0);
    expect(player.track!.mode).toBe('hidden');
    expect(viAt(c)).toMatch(/^VI\(/);
    expect(diag(c).method).toBe('texttrack-hidden');
    expect(player.root.querySelector('style[data-sst-cue-hide]')).toBeNull();
  });

  it('media-chrome player: selection through mediashowsubtitlesrequest, no clicks', async () => {
    const { player, c } = setup('media-chrome');
    // its track exists but cues only load once the player itself selected it
    (player as any).variant = 'media-chrome';
    await pressPlayAndWait(player, c, 12);
    expect(player.selected).toBe(true);
    expect(viAt(c)).toMatch(/^VI\(/);
    expect(diag(c).tried).toContain('media-chrome');
  });

  it('toggle-style CC button: pressed once', async () => {
    const { player, c } = setup('toggle', {});
    // make "hidden" useless for this player so the toggle is needed
    (player as any).variant = 'toggle';
    await pressPlayAndWait(player, c, 12);
    expect(player.ccClicks).toBe(1);
    expect(player.ccBtn!.getAttribute('aria-pressed')).toBe('true');
    expect(viAt(c)).toMatch(/^VI\(/);
  });

  it('captions already ON in the player: nothing is clicked (never turned OFF)', async () => {
    const { player, c } = setup('toggle', { captionsInitiallyOn: true });
    await pressPlayAndWait(player, c);
    expect(player.ccClicks).toBe(0);
    expect(player.ccBtn!.getAttribute('aria-pressed')).toBe('true');
    expect(player.track!.mode).toBe('showing');
    expect(viAt(c)).toMatch(/^VI\(/);
  });

  it('captions arrive in successive batches → translation continues to the end (not stuck at the first cues)', async () => {
    const { player, c, br } = setup('menu-creates-track');
    player.video._play();
    await wait(40);
    await playFor(player.video, 60);
    await playFor(player.video, 240);
    await playFor(player.video, 290);
    expect(player.video.currentTime).toBeGreaterThan(580);
    expect(viAt(c)).toMatch(/^VI\(Lesson A sentence number 11\d\.\)$/);
    const sent = new Set(br.calls.flat());
    expect(sent.size).toBeGreaterThan(100); // ≈120 cues in the lesson, not only the first batch
    expect(player.ccClicks).toBe(1);
  });

  it('2× playback, seeking forward and backward after activation', async () => {
    const { player, c } = setup('menu-creates-track');
    player.video.playbackRate = 2;
    await pressPlayAndWait(player, c, 6);
    player.video._setTime(300);
    await playFor(player.video, 3);
    expect(viAt(c)).toMatch(/^VI\(Lesson A sentence number 6\d\.\)$/);
    player.video._setTime(30);
    await playFor(player.video, 2);
    expect(viAt(c)).toMatch(/^VI\(Lesson A sentence number [67]\.\)$/);
    expect(player.ccClicks).toBe(1);
  });

  it('fullscreen changes do not re-run activation', async () => {
    const { player, c } = setup('menu-creates-track');
    await pressPlayAndWait(player, c);
    document.dispatchEvent(new Event('fullscreenchange'));
    await playFor(player.video, 4);
    expect(player.ccClicks).toBe(1);
    expect(viAt(c)).toMatch(/^VI\(/);
  });
});

describe('lesson switching (SPA, no F5)', () => {
  it('new lesson → its own bootstrap runs automatically; old listeners disposed', async () => {
    const a = setup('menu-creates-track', { prefix: 'Lesson A' });
    await pressPlayAndWait(a.player, a.c);
    expect(viAt(a.c)).toMatch(/Lesson A/);
    history.pushState({}, '', '/g/classroom/x?md=lesson-b');
    a.c.reset();
    a.player.host.remove();
    const b = new FakeSkoolPlayer(document, 'menu-creates-track', 'Lesson B');
    document.body.append(b.host);
    a.c.setTarget({ kind: 'video', el: b.video, provider: 'skool-native', area: 960 * 540 });
    await pressPlayAndWait(b, a.c);
    expect(b.ccClicks).toBe(1);
    expect(viAt(a.c)).toMatch(/^VI\(Lesson B/);
    // old player untouched afterwards
    await playFor(a.player.video, 4);
    expect(a.player.ccClicks).toBe(1);
  });

  it('rapid switching A→B→C: only the current lesson is activated; no stale clicks', async () => {
    const { c } = setup('menu-creates-track', { prefix: 'Lesson A' });
    const players: FakeSkoolPlayer[] = [];
    for (const name of ['Lesson B', 'Lesson C']) {
      c.reset();
      const p = new FakeSkoolPlayer(document, 'menu-creates-track', name);
      document.body.append(p.host);
      players.push(p);
      c.setTarget({ kind: 'video', el: p.video, provider: 'skool-native', area: 960 * 540 });
    }
    const [b, last] = players;
    b.video._play(); // stale lesson playing in the background must not be touched
    await pressPlayAndWait(last, c);
    expect(b.ccClicks).toBe(0);
    expect(last.ccClicks).toBe(1);
    expect(viAt(c)).toMatch(/^VI\(Lesson C/);
  });
});

describe('bounded, honest failure', () => {
  it('no captions control in the player → FAILED with a clear reason, nothing clicked', async () => {
    const { player, c } = setup('no-controls');
    // track exists but never gets cues (player state off, and no UI)
    (player as any).variant = 'enforced';
    await pressPlayAndWait(player, c, 12);
    const d = diag(c);
    expect(d.state).toBe('FAILED');
    expect(String(d.reason)).toMatch(/cc-control-not-found|no English cues/);
    expect(c.status().notice).toMatch(/Không tự bật được phụ đề tiếng Anh/);
  });

  it('player ignores synthetic clicks → reported as failure after bounded attempts (no infinite retries)', async () => {
    const { player, c } = setup('trusted-only');
    (player as any).variant = 'trusted-only';
    await pressPlayAndWait(player, c, 30);
    await playFor(player.video, 30);
    const d = diag(c);
    expect(d.state).toBe('FAILED');
    expect(d.nativeAttempts).toBeLessThanOrEqual(CaptionBootstrap.MAX_NATIVE_ATTEMPTS);
    expect(c.status().notice).toMatch(/CC → English/);
  });

  it('player controls change unexpectedly (CC button removed after the first menu use) → no crash, bounded', async () => {
    const { player, c } = setup('menu-creates-track');
    await pressPlayAndWait(player, c);
    player.ccBtn!.remove();
    // captions turned off by the player later
    (player.track as any)._playerSet('disabled');
    player.selected = false;
    await playFor(player.video, 12);
    const d = diag(c);
    expect(['FAILED', 'ACTIVATING_ENGLISH', 'VERIFYING_CAPTIONS', 'PLAYER_READY', 'MONITORING', 'TRANSLATING']).toContain(d.state);
    expect(d.nativeAttempts).toBeLessThanOrEqual(CaptionBootstrap.MAX_NATIVE_ATTEMPTS);
  });

  it('repeated evaluation never re-clicks once captions work', async () => {
    const { player, c } = setup('menu-creates-track');
    await pressPlayAndWait(player, c);
    for (let i = 0; i < 20; i++) player.video._tracks.dispatchEvent(new Event('change'));
    await playFor(player.video, 20);
    expect(player.ccClicks).toBe(1);
    expect(player.optionClicks).toBe(1);
  });
});

describe('consent', () => {
  it('not opted in: the player is never touched; the one-time question is shown when the player has a CC control', async () => {
    const { player, c } = setup('menu-creates-track', { settings: { autoEnableCaptions: false, autoEnableCaptionsAsked: false } });
    await pressPlayAndWait(player, c);
    expect(player.ccClicks).toBe(0);
    expect(diag(c).state).toBe('IDLE');
    expect(c.status().captionsOff).toBe(true);
  });

  it('opting in later activates without reload', async () => {
    const s = mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: false });
    const { player, c } = setup('menu-creates-track', { settings: { autoEnableCaptions: false } });
    await pressPlayAndWait(player, c);
    c.updateSettings({ ...s, autoEnableCaptions: true, autoEnableCaptionsAsked: true });
    await playFor(player.video, 6);
    expect(player.ccClicks).toBe(1);
    expect(viAt(c)).toMatch(/^VI\(/);
  });

  it('user selects English manually (no opt-in) → picked up immediately, nothing else clicked', async () => {
    const { player, c } = setup('menu-creates-track', { settings: { autoEnableCaptions: false } });
    await pressPlayAndWait(player, c);
    player.select();
    await playFor(player.video, 3);
    expect(viAt(c)).toMatch(/^VI\(/);
    expect(diag(c).events.some((e: any) => e.event === 'addtrack' && e.by === 'external')).toBe(true);
  });
});
