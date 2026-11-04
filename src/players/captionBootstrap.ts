import { findEnglishTrack, isOwn } from '../subtitles/sources';

/**
 * Skool Native caption bootstrap — makes English captions available WITHOUT the user clicking
 * CC → English, after the user opted in (settings.autoEnableCaptions).
 *
 * Methods, tried in order, each at most once per lesson (bounded, no toggling loops):
 *   1. texttrack-hidden  English TextTrack exists → mode "hidden" (done by TextTrackSource);
 *                        verified by cues actually arriving during playback.
 *   2. media-chrome      the player is built on media-chrome (<media-controller>, used by Mux
 *                        Player): its documented `mediashowsubtitlesrequest` event selects the
 *                        track through the player's own state, exactly like its CC menu.
 *   3. native-ui         open the player's own captions control (found semantically by role /
 *                        aria-label / title / tag, inside the player's open shadow roots — never
 *                        by coordinates) and choose the English option once; menu closed with
 *                        Escape (the CC button is never clicked a second time, so captions are
 *                        never switched OFF by us).
 *
 * State machine (idempotent; one instance per lesson video):
 *   WAITING_FOR_PLAYER → PLAYER_READY → ACTIVATING_ENGLISH → VERIFYING_CAPTIONS → TRANSLATING
 *   → MONITORING, or FAILED(reason). IDLE = not opted in (only observes and logs).
 *
 * Diagnostics are metadata only: track kind/language/label/mode/cue count/last cue end,
 * control role/aria/tag, timings. No caption text, no URLs.
 */
export type BootstrapState =
  | 'IDLE'
  | 'WAITING_FOR_PLAYER'
  | 'PLAYER_READY'
  | 'ACTIVATING_ENGLISH'
  | 'VERIFYING_CAPTIONS'
  | 'TRANSLATING'
  | 'MONITORING'
  | 'FAILED';

export type BootstrapMethod = 'texttrack-hidden' | 'media-chrome' | 'native-ui';

export interface TrackSnapshot {
  kind: string;
  lang: string;
  label: string;
  mode: string;
  cues: number | null;
  lastCueEnd: number | null;
}

export interface BootstrapEvent {
  atMs: number;
  event: string;
  state: BootstrapState;
  /** Who changed the tracks: our own action (within 1.5 s) or the page/user. */
  by?: 'extension' | 'external';
  videoTime?: number;
  tracks?: TrackSnapshot[];
  detail?: string;
}

export interface ControlInfo {
  tag: string;
  role: string | null;
  label: string;
  hasPopup: string | null;
  expanded: string | null;
  pressed: string | null;
  checked: string | null;
}

export interface BootstrapOptions {
  enabled: boolean;
  lang?: string;
  /** Playing time without English cues before escalating to the next method. */
  verifyMs?: number;
  /** Wait after play for the player to create its tracks before using its UI. */
  trackGraceMs?: number;
  /** Wait for a captions menu to render after opening it. */
  menuWaitMs?: number;
  /** Hide the player's own English rendering after WE selected English (Vietnamese only). */
  hideNativeRendering?: boolean;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
}

export interface BootstrapCallbacks {
  /** Tracks/modes changed — the controller re-attaches its caption source when needed. */
  onTracksChanged?: () => void;
  onState?: (s: BootstrapState, reason?: string) => void;
}

const CC_WORDS = /\b(captions?|subtitles?|closed[ -]?captions?|cc)\b|phụ đề/i;
const EN_WORDS = /\benglish\b|^\s*en(\b|-)|tiếng anh/i;
const OFF_WORDS = /\b(off|none|disabled?)\b|tắt|không/i;
const CONTROL_SEL = 'button, [role="button"], [role="menuitem"], [role="switch"], [aria-haspopup], media-captions-button, media-captions-menu-button, media-subtitles-button';
const OPTION_SEL = '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"], [role="radio"], li, button, label';
const MAX_NODES = 6000;

const attr = (e: Element, n: string) => e.getAttribute(n);
function labelOf(e: Element): string {
  return (attr(e, 'aria-label') || attr(e, 'title') || attr(e, 'data-title') || attr(e, 'data-tooltip') || (e.textContent ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80);
}
function visible(e: Element): boolean {
  if (e.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const v = e.ownerDocument.defaultView;
  const cs = v?.getComputedStyle?.(e as HTMLElement);
  if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
  return !e.closest('[data-sst-panel],[data-sst-overlay],[data-sst-learning]');
}

/** Elements matching `sel` in `root` and every open shadow root below it (bounded). */
export function deepQueryAll(root: ParentNode, sel: string): Element[] {
  const out: Element[] = [];
  let n = 0;
  const visit = (r: ParentNode) => {
    for (const e of r.querySelectorAll('*')) {
      if (++n > MAX_NODES) return;
      if (e.matches(sel)) out.push(e);
      const sr = (e as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) visit(sr);
    }
  };
  visit(root);
  return out;
}

/** The player around the video: its shadow roots up to the document, plus the nearest light-DOM player container. */
export function playerScopes(video: Element): ParentNode[] {
  const scopes: ParentNode[] = [];
  let node: Node = video;
  for (let i = 0; i < 12; i++) {
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      scopes.push(root);
      node = root.host;
    } else break;
  }
  // Light-DOM container: climb from the outermost host while the box stays about the player size.
  const top = node as Element;
  let container: Element = top;
  const area = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width * r.height;
  };
  const base = area(top) || 1;
  for (let p = top.parentElement, i = 0; p && p !== p.ownerDocument.body && i < 4; p = p.parentElement, i++) {
    if (area(p) > base * 1.8 && area(top) > 0) break;
    container = p;
  }
  scopes.push(container);
  return scopes;
}

export class CaptionBootstrap {
  private st: BootstrapState;
  private reason: string | undefined;
  private readonly t0: number;
  private readonly now: () => number;
  private readonly setT: NonNullable<BootstrapOptions['setTimeout']>;
  private readonly clearT: NonNullable<BootstrapOptions['clearTimeout']>;
  private readonly tried = new Set<BootstrapMethod>();
  private method: BootstrapMethod | null = null;
  private lastOwnActionAt = -Infinity;
  private verifyPlayedMs = 0;
  private lastTick: number | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private cleanups: (() => void)[] = [];
  private styleEl: HTMLStyleElement | null = null;
  private disposed = false;
  private hasPlayed = false;
  private busy = false;
  private nativeAttempts = 0;
  readonly log: BootstrapEvent[] = [];
  controls: ControlInfo[] = [];

  static readonly MAX_NATIVE_ATTEMPTS = 2;

  constructor(
    private readonly video: HTMLMediaElement,
    private opts: BootstrapOptions,
    private readonly cb: BootstrapCallbacks = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeout ?? ((f, ms) => setTimeout(f, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h));
    this.t0 = this.now();
    this.st = 'WAITING_FOR_PLAYER';
  }

  get media(): HTMLMediaElement {
    return this.video;
  }

  get state(): BootstrapState {
    return this.st;
  }
  get failureReason(): string | undefined {
    return this.reason;
  }
  get activeMethod(): BootstrapMethod | null {
    return this.method;
  }

  private lang(): string {
    return this.opts.lang ?? 'en';
  }

  snapshot(): TrackSnapshot[] {
    const out: TrackSnapshot[] = [];
    const list = this.video.textTracks;
    for (let i = 0; i < (list?.length ?? 0); i++) {
      const t = list[i];
      if (isOwn(t)) continue;
      const cues = t.cues;
      let last: number | null = null;
      if (cues?.length) last = Math.round(cues[cues.length - 1].endTime * 10) / 10;
      out.push({ kind: t.kind, lang: t.language, label: (t.label || '').slice(0, 40), mode: t.mode, cues: cues ? cues.length : null, lastCueEnd: last });
    }
    return out;
  }

  private record(event: string, extra: Partial<BootstrapEvent> = {}): void {
    this.log.push({ atMs: this.now() - this.t0, event, state: this.st, videoTime: Math.round((this.video.currentTime || 0) * 10) / 10, ...extra });
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  private set(s: BootstrapState, reason?: string): void {
    if (this.st === s && this.reason === reason) return;
    this.st = s;
    this.reason = reason;
    this.record(`state → ${s}`, reason ? { detail: reason } : {});
    this.cb.onState?.(s, reason);
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(this.setT(() => !this.disposed && fn(), ms));
  }

  start(): void {
    const v = this.video;
    const on = (t: EventTarget | undefined | null, ev: string, fn: () => void) => {
      if (!t?.addEventListener) return;
      t.addEventListener(ev, fn);
      this.cleanups.push(() => t.removeEventListener(ev, fn));
    };
    this.record('start', { tracks: this.snapshot() });
    on(v, 'loadedmetadata', () => this.onReady('loadedmetadata'));
    on(v, 'play', () => this.onPlay());
    on(v, 'playing', () => this.onPlay());
    on(v, 'timeupdate', () => this.tick());
    on(v, 'pause', () => (this.lastTick = null));
    const list = v.textTracks;
    const trackEv = (name: string) => () => {
      const by = this.now() - this.lastOwnActionAt < 1500 ? 'extension' : 'external';
      this.record(name, { by, tracks: this.snapshot() });
      this.cb.onTracksChanged?.();
      this.evaluate(name);
    };
    on(list, 'addtrack', trackEv('addtrack'));
    on(list, 'removetrack', trackEv('removetrack'));
    on(list, 'change', trackEv('trackchange'));
    if (v.readyState >= 1) this.onReady('already-ready');
    if (!v.paused) this.onPlay();
  }

  setEnabled(enabled: boolean): void {
    if (this.opts.enabled === enabled) return;
    this.opts = { ...this.opts, enabled };
    this.record(enabled ? 'opt-in enabled' : 'opt-in disabled');
    if (enabled && (this.st === 'IDLE' || this.st === 'FAILED')) {
      this.tried.clear();
      this.nativeAttempts = 0;
      this.set(this.video.readyState >= 1 || this.hasPlayed ? 'PLAYER_READY' : 'WAITING_FOR_PLAYER');
      this.evaluate('opt-in');
    }
  }

  private onReady(why: string): void {
    if (this.st === 'WAITING_FOR_PLAYER') {
      this.set('PLAYER_READY', why);
      this.evaluate(why);
    }
  }

  private onPlay(): void {
    const first = !this.hasPlayed;
    this.hasPlayed = true;
    this.lastTick = this.now();
    if (this.st === 'WAITING_FOR_PLAYER') this.set('PLAYER_READY', 'play');
    if (first) {
      this.record('first play', { tracks: this.snapshot() });
      // Players often create their caption tracks only after the stream starts: give them a moment.
      this.later(this.opts.trackGraceMs ?? 1500, () => this.evaluate('after-play-grace'));
    }
    this.evaluate('play');
  }

  private english(): TextTrack | null {
    return findEnglishTrack(this.video, this.lang())?.track ?? null;
  }

  private working(t: TextTrack | null): boolean {
    return !!t && t.mode !== 'disabled' && !!t.cues && t.cues.length > 0;
  }

  /** Playback-time accounting for verification (paused time does not count). */
  private tick(): void {
    const now = this.now();
    if (!this.video.paused) {
      if (this.lastTick !== null && this.st === 'VERIFYING_CAPTIONS') this.verifyPlayedMs += Math.min(1000, now - this.lastTick);
      this.lastTick = now;
    }
    this.evaluate('timeupdate');
  }

  /** Central decision step; safe to call any time (idempotent). */
  evaluate(why: string): void {
    if (this.disposed || this.busy) return;
    const en = this.english();
    const ok = this.working(en);
    switch (this.st) {
      case 'WAITING_FOR_PLAYER':
        return;
      case 'IDLE':
      case 'FAILED':
        if (ok) this.succeed(why);
        return;
      case 'TRANSLATING':
      case 'MONITORING':
        if (!ok && en?.mode === 'disabled' && this.hasPlayed) this.monitorLoss();
        return;
      case 'VERIFYING_CAPTIONS':
        if (ok) return this.succeed(why);
        if (this.verifyPlayedMs >= (this.opts.verifyMs ?? 8000)) {
          this.record(`verify timeout (${this.method})`, { tracks: this.snapshot() });
          this.next(`${this.method}: no English cues after ${Math.round(this.verifyPlayedMs / 1000)} s of playback`);
        }
        return;
      case 'PLAYER_READY':
      case 'ACTIVATING_ENGLISH':
        if (ok) return this.succeed(why);
        if (!this.opts.enabled) {
          this.set('IDLE', en ? 'english track present, not enabled (no opt-in)' : 'no English track yet (no opt-in)');
          return;
        }
        if (this.st === 'PLAYER_READY') this.next(why);
        return;
    }
  }

  private succeed(why: string): void {
    const en = this.english();
    this.record(`english captions working (${this.method ?? 'already'})`, { detail: why, tracks: this.snapshot() });
    if (en && en.mode === 'showing' && this.method && this.method !== 'texttrack-hidden') this.hideNative();
    this.set('TRANSLATING');
    this.later(5000, () => this.st === 'TRANSLATING' && this.set('MONITORING'));
    this.cb.onTracksChanged?.();
  }

  /** Track turned off after it worked: re-run the player's own selection once (bounded). */
  private lossPending = false;
  private monitorLoss(): void {
    if (this.lossPending) return;
    if (this.nativeAttempts >= CaptionBootstrap.MAX_NATIVE_ATTEMPTS || !this.opts.enabled) return;
    const at = this.now();
    this.lossPending = true;
    this.later(5000, () => {
      this.lossPending = false;
      const en = this.english();
      if ((this.st === 'MONITORING' || this.st === 'TRANSLATING') && en?.mode === 'disabled' && this.now() - at >= 4900) {
        this.record('captions disabled during playback → re-activate once', { tracks: this.snapshot() });
        this.tried.delete('native-ui');
        this.tried.delete('media-chrome');
        this.set('PLAYER_READY', 'captions lost');
        this.evaluate('captions lost');
      }
    });
  }

  /** The caption source says the player keeps reverting "hidden" → go straight to the player's own UI. */
  escalate(reason: string): void {
    if (!this.opts.enabled || this.disposed) return;
    this.record(`escalate: ${reason}`, { tracks: this.snapshot() });
    this.tried.add('texttrack-hidden');
    if (this.st === 'VERIFYING_CAPTIONS' || this.st === 'PLAYER_READY' || this.st === 'TRANSLATING' || this.st === 'MONITORING') this.next(reason);
  }

  private next(why: string): void {
    const en = this.english();
    const order: BootstrapMethod[] = ['texttrack-hidden', 'media-chrome', 'native-ui'];
    for (const m of order) {
      if (this.tried.has(m)) continue;
      if (m === 'texttrack-hidden' && !en) continue;
      if (m === 'media-chrome' && (!en || !this.mediaController())) continue;
      if (m === 'native-ui') {
        if (this.nativeAttempts >= CaptionBootstrap.MAX_NATIVE_ATTEMPTS) continue;
        // Without a track yet, wait until playback started + grace (tracks may still appear).
        if (!en && !this.hasPlayed) {
          this.set('PLAYER_READY', 'waiting for Play before using the player controls');
          return;
        }
      }
      this.tried.add(m);
      void this.run(m, why);
      return;
    }
    this.set('FAILED', this.failureText(why));
  }

  private failureText(why: string): string {
    if (!this.controls.length && this.tried.has('native-ui')) return `cc-control-not-found (${why})`;
    return why;
  }

  private async run(m: BootstrapMethod, why: string): Promise<void> {
    this.method = m;
    this.set('ACTIVATING_ENGLISH', `${m} (${why})`);
    this.busy = true;
    let ok = true;
    let detail = '';
    try {
      if (m === 'texttrack-hidden') {
        const en = this.english();
        if (en && en.mode === 'disabled') {
          this.lastOwnActionAt = this.now();
          en.mode = 'hidden';
        }
        detail = 'mode=hidden';
      } else if (m === 'media-chrome') {
        ok = this.mediaChromeShow();
        detail = ok ? 'mediashowsubtitlesrequest dispatched' : 'no media-controller';
      } else {
        this.nativeAttempts++;
        const r = await this.nativeUi();
        ok = r.ok;
        detail = r.detail;
      }
    } catch (e) {
      ok = false;
      detail = (e as Error).message;
    } finally {
      this.busy = false;
    }
    this.record(`${m}: ${ok ? 'done' : 'failed'} — ${detail}`, { tracks: this.snapshot() });
    if (this.disposed) return;
    if (!ok) return this.next(`${m}: ${detail}`);
    this.verifyPlayedMs = 0;
    this.set('VERIFYING_CAPTIONS', m);
    this.cb.onTracksChanged?.();
    this.evaluate('after ' + m);
  }

  // ---- media-chrome (Mux Player etc.) -------------------------------------------------------

  private mediaController(): Element | null {
    let node: Node | null = this.video;
    for (let i = 0; node && i < 40; i++) {
      if (node instanceof Element && node.localName === 'media-controller') return node;
      const parent: Node | null = (node as Element).parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null);
      node = parent;
    }
    return null;
  }

  private mediaChromeShow(): boolean {
    const mc = this.mediaController();
    const en = this.english();
    if (!mc || !en) return false;
    const detail = en.label ? `${en.language}:${encodeURIComponent(en.label)}` : en.language;
    this.lastOwnActionAt = this.now();
    mc.dispatchEvent(new CustomEvent('mediashowsubtitlesrequest', { detail, bubbles: true, composed: true }));
    return true;
  }

  // ---- the player's own captions control ----------------------------------------------------

  private info(e: Element): ControlInfo {
    return {
      tag: e.localName,
      role: attr(e, 'role'),
      label: labelOf(e),
      hasPopup: attr(e, 'aria-haspopup'),
      expanded: attr(e, 'aria-expanded'),
      pressed: attr(e, 'aria-pressed'),
      checked: attr(e, 'aria-checked'),
    };
  }

  /** CC controls of THIS player (semantic match; our own UI excluded). */
  findCcControls(): Element[] {
    const found = new Set<Element>();
    for (const scope of playerScopes(this.video)) {
      for (const e of deepQueryAll(scope, CONTROL_SEL)) {
        const l = labelOf(e);
        const tagHit = /caption|subtitle/i.test(e.localName);
        if ((tagHit || (CC_WORDS.test(l) && l.length <= 60)) && visible(e)) found.add(e);
      }
    }
    const list = [...found];
    // Menu openers first (they lead to a language choice), then plain toggles.
    const isMenu = (e: Element) => !!attr(e, 'aria-haspopup') || attr(e, 'aria-expanded') !== null || /menu/i.test(e.localName);
    list.sort((a, b) => Number(isMenu(b)) - Number(isMenu(a)));
    return list;
  }

  private findEnglishOptions(exclude: Element): Element[] {
    const scopes = [...playerScopes(this.video), this.video.ownerDocument];
    const seen = new Set<Element>();
    const out: Element[] = [];
    for (const s of scopes)
      for (const e of deepQueryAll(s, OPTION_SEL)) {
        if (seen.has(e) || e === exclude || exclude.contains(e)) continue;
        seen.add(e);
        const l = labelOf(e);
        if (l.length > 50 || !EN_WORDS.test(l) || OFF_WORDS.test(l) || !visible(e)) continue;
        out.push(e);
      }
    // Prefer explicit menu roles and human captions over auto-generated ones; innermost element.
    const rank = (e: Element) => (/menuitemradio|option|radio|menuitemcheckbox/.test(attr(e, 'role') ?? '') ? 0 : 1) + (/auto|generated|tự động/i.test(labelOf(e)) ? 2 : 0);
    return out.filter((e) => !out.some((o) => o !== e && e.contains(o))).sort((a, b) => rank(a) - rank(b));
  }

  private press(e: Element): void {
    this.lastOwnActionAt = this.now();
    const win = e.ownerDocument.defaultView ?? window;
    const init: MouseEventInit = { bubbles: true, composed: true, cancelable: true, button: 0 };
    const PE = (win as Window & { PointerEvent?: typeof PointerEvent }).PointerEvent;
    if (PE) e.dispatchEvent(new PE('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    e.dispatchEvent(new win.MouseEvent('mousedown', init));
    if (PE) e.dispatchEvent(new PE('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
    e.dispatchEvent(new win.MouseEvent('mouseup', init));
    if (typeof (e as HTMLElement).click === 'function') (e as HTMLElement).click();
    else e.dispatchEvent(new win.MouseEvent('click', init));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.later(ms, r));
  }

  private async nativeUi(): Promise<{ ok: boolean; detail: string }> {
    const controls = this.findCcControls();
    this.controls = controls.slice(0, 6).map((c) => this.info(c));
    this.record('cc controls found', { detail: JSON.stringify(this.controls) });
    if (!controls.length) return { ok: false, detail: 'cc-control-not-found' };
    const btn = controls[0];
    const on = attr(btn, 'aria-pressed') === 'true' || attr(btn, 'aria-checked') === 'true';
    const isMenu = !!attr(btn, 'aria-haspopup') || attr(btn, 'aria-expanded') !== null || /menu/i.test(btn.localName);
    // A pressed toggle means captions are already ON in the player: clicking would turn them OFF.
    if (on && !isMenu) return { ok: false, detail: 'cc toggle already on — not clicked (would turn captions off)' };
    if (attr(btn, 'aria-expanded') !== 'true') this.press(btn);
    await this.wait(this.opts.menuWaitMs ?? 600);
    if (this.disposed) return { ok: false, detail: 'disposed' };
    const options = this.findEnglishOptions(btn);
    if (!options.length) {
      if (isMenu) {
        this.closeMenu(btn);
        // Some "menu" buttons are really toggles: if a working English track appeared, fine.
        return this.working(this.english()) ? { ok: true, detail: 'menu opened, captions turned on by the player' } : { ok: false, detail: 'english-option-not-found' };
      }
      return { ok: true, detail: `toggle pressed (${this.info(btn).label})` };
    }
    const opt = options[0];
    if (attr(opt, 'aria-checked') !== 'true' && attr(opt, 'aria-selected') !== 'true') this.press(opt);
    await this.wait(Math.min(150, this.opts.menuWaitMs ?? 150));
    this.closeMenu(btn);
    return { ok: true, detail: `english option selected (${this.info(opt).role ?? this.info(opt).tag})` };
  }

  /** Close a menu that is still open — Escape only; the CC button is never clicked again. */
  private closeMenu(btn: Element): void {
    if (attr(btn, 'aria-expanded') !== 'true') return;
    const win = btn.ownerDocument.defaultView ?? window;
    const ev = () => new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true });
    const focused = (btn.getRootNode() as Document | ShadowRoot).activeElement;
    (focused ?? btn).dispatchEvent(ev());
    btn.dispatchEvent(ev());
  }

  // ---- native rendering of the English cues --------------------------------------------------

  /** After WE selected English (mode "showing"), hide the player's English text so only Vietnamese shows. */
  private hideNative(): void {
    if (this.opts.hideNativeRendering === false || this.styleEl) return;
    const root = this.video.getRootNode() as Document | ShadowRoot;
    const doc = this.video.ownerDocument;
    const s = doc.createElement('style');
    s.setAttribute('data-sst-cue-hide', '');
    s.textContent = 'video::cue{opacity:0!important;visibility:hidden!important;color:transparent!important;background:transparent!important;text-shadow:none!important;outline:none!important}';
    (root instanceof ShadowRoot ? root : doc.head ?? doc.documentElement).appendChild(s);
    this.styleEl = s;
    this.record('native English rendering hidden (::cue)');
  }

  diagnostics() {
    return {
      state: this.st,
      reason: this.reason,
      method: this.method,
      tried: [...this.tried],
      nativeAttempts: this.nativeAttempts,
      optIn: this.opts.enabled,
      hasPlayed: this.hasPlayed,
      mediaChrome: !!this.mediaController(),
      ccControls: this.controls,
      nativeHidden: !!this.styleEl,
      tracksNow: this.snapshot(),
      events: this.log.slice(-40),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach((t) => this.clearT(t));
    this.timers = [];
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
    this.styleEl?.remove();
    this.styleEl = null;
  }
}
