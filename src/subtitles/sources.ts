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
export function findEnglishTrack(video: HTMLMediaElement): TrackChoice | null {
  const list = video.textTracks;
  if (!list || !list.length) return null;
  const tracks: TextTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isOwn(t) && (t.kind === 'subtitles' || t.kind === 'captions')) tracks.push(t);
  }
  const lang = (t: TextTrack) => (t.language || '').toLowerCase();
  const english = tracks.filter((t) => lang(t) === 'en' || lang(t).startsWith('en-'));
  if (english.length) {
    // Prefer human captions over auto-generated, and an already-showing track.
    english.sort(
      (a, b) =>
        Number(/auto|generated/i.test(a.label)) - Number(/auto|generated/i.test(b.label)) ||
        Number(b.mode === 'showing') - Number(a.mode === 'showing'),
    );
    return { track: english[0], uncertain: false };
  }
  const byLabel = tracks.find((t) => /english|\ben\b/i.test(t.label));
  if (byLabel) return { track: byLabel, uncertain: false };
  const unlabeled = tracks.filter((t) => !lang(t));
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
  start(onCues: (cues: Cue[]) => void): void;
  stop(): void;
}

/**
 * Reads cues from an HTML5 TextTrack. A disabled track has no cues, so it is
 * switched to "hidden" (loaded but not rendered by the browser). Players that
 * stream captions (HLS) add cues over time; we re-read on cuechange/load.
 */
export class TextTrackSource implements TimedSource {
  readonly kind = 'texttrack' as const;
  private changedMode = false;
  private lastCount = -1;
  private onCues: ((c: Cue[]) => void) | null = null;
  private trackEls: HTMLTrackElement[] = [];

  constructor(
    private readonly video: HTMLMediaElement,
    readonly track: TextTrack,
  ) {}

  get label(): string {
    return this.track.label || this.track.language || 'English';
  }

  start(onCues: (cues: Cue[]) => void): void {
    this.onCues = onCues;
    if (this.track.mode === 'disabled') {
      this.track.mode = 'hidden';
      this.changedMode = true;
    }
    this.track.addEventListener('cuechange', this.refresh);
    this.video.addEventListener('seeked', this.refresh);
    this.video.addEventListener('loadeddata', this.refresh);
    for (const el of this.video.querySelectorAll('track')) {
      if ((el as HTMLTrackElement).track === this.track) {
        el.addEventListener('load', this.refresh);
        this.trackEls.push(el as HTMLTrackElement);
      }
    }
    this.refresh();
  }

  refresh = (): void => {
    const cues = this.track.cues;
    const count = cues?.length ?? 0;
    if (count === this.lastCount) return;
    this.lastCount = count;
    this.onCues?.(readTrackCues(this.track));
  };

  stop(): void {
    this.track.removeEventListener('cuechange', this.refresh);
    this.video.removeEventListener('seeked', this.refresh);
    this.video.removeEventListener('loadeddata', this.refresh);
    for (const el of this.trackEls) el.removeEventListener('load', this.refresh);
    this.trackEls = [];
    if (this.changedMode && this.track.mode === 'hidden') this.track.mode = 'disabled';
    this.onCues = null;
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
