import type { Cue } from '../shared/types';
import { cueId } from './normalize';
import { NativeTrackFallback } from '../overlay/nativeTrack';

/** Our own tracks (native fullscreen fallback) must never be read as a source. */
export const ownTracks = new WeakSet<TextTrack>();

const isOwn = (t: TextTrack) => ownTracks.has(t) || t.label === NativeTrackFallback.LABEL;

export interface TrackChoice {
  track: TextTrack;
  /** true when the language could not be confirmed as English */
  uncertain: boolean;
}

/** Pick the best English subtitle/caption track exposed by a media element. */
export function findEnglishTrack(video: HTMLMediaElement, lang = 'en'): TrackChoice | null {
  const list = video.textTracks;
  if (!list || !list.length) return null;
  const tracks: TextTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isOwn(t) && (t.kind === 'subtitles' || t.kind === 'captions')) tracks.push(t);
  }
  const want = lang.toLowerCase();
  const langOf = (t: TextTrack) => (t.language || '').toLowerCase();
  const english = tracks.filter((t) => langOf(t) === want || langOf(t).startsWith(want + '-'));
  if (english.length) {
    // Prefer human captions over auto-generated, and an already-showing track.
    english.sort(
      (a, b) =>
        Number(/auto|generated/i.test(a.label)) - Number(/auto|generated/i.test(b.label)) ||
        Number(b.mode === 'showing') - Number(a.mode === 'showing'),
    );
    return { track: english[0], uncertain: false };
  }
  const byLabel = want === 'en' ? tracks.find((t) => /english|\ben\b/i.test(t.label)) : undefined;
  if (byLabel) return { track: byLabel, uncertain: false };
  const unlabeled = tracks.filter((t) => !langOf(t));
  if (unlabeled.length === 1) return { track: unlabeled[0], uncertain: true };
  return null;
}

export function readTrackCues(track: TextTrack): Cue[] {
  const list = track.cues;
  if (!list) return [];
  const out: Cue[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as VTTCue;
    const text = typeof c.text === 'string' ? c.text : '';
    if (!text) continue;
    out.push({ id: cueId(c.startTime, c.endTime, text), start: c.startTime, end: c.endTime, text });
  }
  return out;
}

export interface TimedSource {
  readonly kind: 'texttrack' | 'manual';
  readonly label: string;
  start(onCues: (cues: Cue[]) => void, onState?: (s: 'ok' | 'disabled' | 'lost') => void): void;
  stop(): void;
}

export type TrackState = 'ok' | 'disabled' | 'lost';

/**
 * Reads cues from an HTML5 TextTrack, robust to player lifecycle changes around seeking:
 *  - Cumulative cue store: cues are only ever ADDED (keyed by time+text). Players that flush
 *    cues outside the buffer (HLS) or disable the track on seek therefore never erase subtitles
 *    that were already read for those timestamps.
 *  - Track replacement: if the player removes the track or adds a new English track object,
 *    listeners move to the new track automatically.
 *  - Self-healing: re-checks a cheap cue signature on seeked/timeupdate (≈4 Hz media events —
 *    no timers/polling), so missed `cuechange` events cannot desynchronise us.
 *  - A disabled track has no cues. Right after a seek (when players reset tracks) it is switched
 *    back to "hidden" — at most ONCE per seek. Outside that window a disabled track is treated
 *    as the user's choice and left alone.
 */
export class TextTrackSource implements TimedSource {
  readonly kind = 'texttrack' as const;
  private changedMode = false;
  private sig = '';
  private store = new Map<string, Cue>();
  private onCues: ((c: Cue[]) => void) | null = null;
  private onState: ((s: TrackState) => void) | null = null;
  private state: TrackState = 'ok';
  private trackEls: HTMLTrackElement[] = [];
  private lastSeekAt = -Infinity;
  private rehidUsedForSeek = true;
  private bound: TextTrack | null = null;
  private activatedAt = -Infinity;
  private activationRetries = 0;
  private readonly startedAt: number;
  /** Small ring log of track lifecycle events (shown in diagnostics; no caption text). */
  readonly log: string[] = [];

  static readonly SEEK_GRACE_MS = 2500;
  /** After we switch a track to "hidden", a player reverting it within this window is re-applied. */
  static readonly ACTIVATION_GRACE_MS = 3000;
  static readonly MAX_ACTIVATION_RETRIES = 2;

  constructor(
    private readonly video: HTMLMediaElement,
    public track: TextTrack,
    private readonly now: () => number = () => Date.now(),
    /** May we switch a disabled track to "hidden"? (user opt-in: autoEnableCaptions) */
    private readonly allowEnable = true,
  ) {
    this.startedAt = now();
  }

  private note(e: string): void {
    this.log.push(`+${this.now() - this.startedAt}ms ${e}`);
    if (this.log.length > 30) this.log.shift();
  }

  private activate(reason: string): void {
    this.track.mode = 'hidden';
    this.changedMode = true;
    this.activatedAt = this.now();
    this.note(`set mode=hidden (${reason})`);
  }

  get label(): string {
    return this.track.label || this.track.language || 'English';
  }

  get trackState(): TrackState {
    return this.state;
  }

  start(onCues: (cues: Cue[]) => void, onState?: (s: TrackState) => void): void {
    this.onCues = onCues;
    this.onState = onState ?? null;
    this.note(`attach "${this.track.label}" lang=${this.track.language} mode=${this.track.mode} cues=${this.track.cues?.length ?? 'null'}`);
    if (this.track.mode === 'disabled' && this.allowEnable) this.activate('auto-enable');
    this.bind(this.track);
    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('seeked', this.refresh);
    this.video.addEventListener('timeupdate', this.refresh);
    this.video.addEventListener('loadeddata', this.refresh);
    const list = this.video.textTracks;
    list?.addEventListener?.('addtrack', this.refresh);
    list?.addEventListener?.('removetrack', this.refresh);
    list?.addEventListener?.('change', this.refresh);
    this.refresh();
  }

  /**
   * Tracks that carry the SAME caption stream as the chosen one (players such as hls.js may add a
   * new TextTrack per chunk/level and keep the old one with stale cues). Matched by language +
   * normalised label, so a different English track (e.g. "English (auto)") is never mixed in.
   */
  private peers(): TextTrack[] {
    const list = this.video.textTracks;
    const out: TextTrack[] = [];
    if (!list) return out;
    const key = (t: TextTrack) => `${(t.language || '').toLowerCase()}|${(t.label || '').trim().toLowerCase()}`;
    const want = key(this.track);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if ((t.kind === 'subtitles' || t.kind === 'captions') && t.label !== NativeTrackFallback.LABEL && key(t) === want) out.push(t);
    }
    return out;
  }

  private peerSet: TextTrack[] = [];

  private bindPeers(): void {
    const peers = this.peers();
    if (peers.length === this.peerSet.length && peers.every((p, i) => p === this.peerSet[i])) return;
    for (const p of this.peerSet) if (p !== this.bound) p.removeEventListener('cuechange', this.refresh);
    for (const p of peers) if (p !== this.bound) p.addEventListener('cuechange', this.refresh);
    if (peers.length > 1 || this.peerSet.length > 1) this.note(`same-caption tracks: ${peers.length} (modes ${peers.map((p) => p.mode).join(',')})`);
    this.peerSet = peers;
  }

  /** Newest same-caption track that is not disabled (where a player puts new cues). */
  private activePeer(): TextTrack | null {
    for (let i = this.peerSet.length - 1; i >= 0; i--) if (this.peerSet[i].mode !== 'disabled') return this.peerSet[i];
    return null;
  }

  /** Last time new cues were discovered (ms clock) and the latest known cue end (s). */
  lastDiscoveryAt = 0;
  get latestCueEnd(): number {
    let m = 0;
    for (const c of this.store.values()) if (c.end > m) m = c.end;
    return m;
  }
  get storedCues(): number {
    return this.store.size;
  }
  /** Peers' state for diagnostics (no caption text). */
  trackInfo(): { label: string; mode: string; cues: number | null }[] {
    return this.peerSet.map((t) => ({ label: t.label, mode: t.mode, cues: t.cues ? t.cues.length : null }));
  }

  /** Watchdog hook: playback ran past the known cues — re-evaluate tracks from scratch. */
  rediscover(reason: string, mayReenable = false): void {
    this.note(`rediscover (${reason})`);
    this.sig = '';
    for (const p of this.peerSet) if (p !== this.bound) p.removeEventListener('cuechange', this.refresh);
    this.peerSet = [];
    // Opt-in only (autoEnableCaptions) and bounded by the caller: a track the player disabled
    // while playback ran past the known cues is switched back to "hidden" (never "showing").
    if (mayReenable && this.allowEnable && this.track.mode === 'disabled' && this.inList(this.track)) this.activate('watchdog');
    this.refresh();
  }

  private bind(track: TextTrack): void {
    this.unbind();
    this.bound = track;
    track.addEventListener('cuechange', this.refresh);
    for (const el of this.video.querySelectorAll('track')) {
      if ((el as HTMLTrackElement).track === track) {
        el.addEventListener('load', this.refresh);
        this.trackEls.push(el as HTMLTrackElement);
      }
    }
  }

  private unbind(): void {
    this.bound?.removeEventListener('cuechange', this.refresh);
    for (const p of this.peerSet) p.removeEventListener('cuechange', this.refresh);
    this.peerSet = [];
    for (const el of this.trackEls) el.removeEventListener('load', this.refresh);
    this.trackEls = [];
    this.bound = null;
  }

  private onSeeking = (): void => {
    this.lastSeekAt = this.now();
    this.rehidUsedForSeek = false;
  };

  private inList(t: TextTrack): boolean {
    const list = this.video.textTracks;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (list[i] === t) return true;
    return false;
  }

  private setState(s: TrackState): void {
    if (s === this.state) return;
    this.state = s;
    this.onState?.(s);
  }

  refresh = (): void => {
    if (!this.onCues) return;
    // 1. Track replaced/removed?
    const replacement = findEnglishTrack(this.video);
    if (!this.inList(this.track) || (replacement && replacement.track !== this.track && !this.track.cues?.length)) {
      if (replacement) {
        this.note(`track replaced → "${replacement.track.label}" mode=${replacement.track.mode}`);
        this.track = replacement.track;
        this.changedMode = false;
        if (this.track.mode === 'disabled' && this.allowEnable) this.activate('replacement');
        this.bind(this.track);
        this.sig = '';
      } else {
        if (this.state !== 'lost') this.note('track removed, no replacement');
        this.setState('lost');
        return;
      }
    }
    // 1b. Same caption stream split over several TextTracks: follow the newest active one.
    this.bindPeers();
    const active = this.activePeer();
    if (active && active !== this.track) {
      this.note(`follow newer same-caption track (mode=${active.mode}, cues=${active.cues?.length ?? 'null'})`);
      this.track = active;
      this.changedMode = false;
      this.bind(active);
      this.bindPeers();
    }
    // 2. Disabled by the player right after a seek → re-enable once (hidden: no native rendering).
    if (this.track.mode === 'disabled') {
      const justSeeked = this.now() - this.lastSeekAt < TextTrackSource.SEEK_GRACE_MS;
      const justActivated = this.now() - this.activatedAt < TextTrackSource.ACTIVATION_GRACE_MS;
      if (justSeeked && !this.rehidUsedForSeek) {
        this.rehidUsedForSeek = true;
        this.note('player disabled track after seek → re-enable once');
        this.track.mode = 'hidden';
      } else if (this.allowEnable && justActivated && this.activationRetries < TextTrackSource.MAX_ACTIVATION_RETRIES) {
        // Player reverted our activation immediately (initialisation race): re-apply, bounded.
        this.activationRetries++;
        this.activate(`player reverted, retry ${this.activationRetries}`);
      } else {
        if (this.state !== 'disabled') this.note('mode=disabled (left as is)');
        this.setState('disabled');
        return; // keep using the cues already read; never toggle CC repeatedly
      }
    }
    this.setState('ok');
    // 3. Cheap signature over all same-caption tracks; merge new cues into the cumulative store
    //    (dedupe by cue identity = start/end/text, so overlapping tracks never duplicate).
    const sources = this.peerSet.length ? this.peerSet : [this.track];
    const sig = sources
      .map((t) => {
        const l = t.cues;
        const n = l?.length ?? 0;
        return n ? `${n}|${l![0].startTime}|${l![n - 1].endTime}` : '0';
      })
      .join(';');
    if (sig === this.sig) return;
    this.sig = sig;
    const before = this.store.size;
    for (const t of sources) for (const c of readTrackCues(t)) this.store.set(c.id, c);
    if (this.store.size !== before) {
      this.lastDiscoveryAt = this.now();
      this.onCues([...this.store.values()]);
    }
  };

  stop(): void {
    this.unbind();
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('seeked', this.refresh);
    this.video.removeEventListener('timeupdate', this.refresh);
    this.video.removeEventListener('loadeddata', this.refresh);
    const list = this.video.textTracks;
    list?.removeEventListener?.('addtrack', this.refresh);
    list?.removeEventListener?.('removetrack', this.refresh);
    list?.removeEventListener?.('change', this.refresh);
    if (this.changedMode && this.track.mode === 'hidden') this.track.mode = 'disabled';
    this.onCues = null;
    this.onState = null;
  }
}

/** Cues imported by the user from a .vtt/.srt file. */
export class ManualSource implements TimedSource {
  readonly kind = 'manual' as const;
  constructor(
    private readonly cues: Cue[],
    readonly label: string,
  ) {}
  start(onCues: (cues: Cue[]) => void): void {
    onCues(this.cues);
  }
  stop(): void {}
}

/**
 * Observes caption text rendered as HTML by a player (no timing information).
 * Emits debounced, de-duplicated text — the caller translates it live.
 */
export class DomCaptionSource {
  readonly kind = 'dom' as const;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = '';

  constructor(
    private readonly doc: Document,
    private readonly selectors: string[],
    private readonly debounceMs = 350,
  ) {}

  read(): string {
    const parts: string[] = [];
    for (const sel of this.selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = this.doc.querySelectorAll(sel);
      } catch {
        continue; // invalid user selector
      }
      for (const n of nodes) {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      if (parts.length) break;
    }
    return parts.join(' ');
  }

  start(onText: (text: string) => void): void {
    const emit = () => {
      const t = this.read();
      if (t === this.last) return;
      this.last = t;
      onText(t);
    };
    this.observer = new MutationObserver(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(emit, this.debounceMs);
    });
    this.observer.observe(this.doc.body ?? this.doc.documentElement, { childList: true, subtree: true, characterData: true });
    emit();
  }

  stop(): void {
    this.observer?.disconnect();
    clearTimeout(this.timer);
    this.observer = null;
  }
}
