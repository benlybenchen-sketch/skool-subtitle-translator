import type { DubListenMode } from '../shared/types';

/** Attribute on the media element holding the user's own audio state while we changed it. */
export const PREV_ATTR = 'data-sst-dub-prev';

interface Prev {
  muted: boolean;
  volume: number;
}

/**
 * Original lesson audio while dubbing.
 * Strategy 1 (preferred): the media element itself — `muted` / `volume` (the tab stays audible,
 *   so nothing else in the tab and no other tab is affected).
 * Strategy 2 (fallback, no accessible media element): tab-level mute through the background; the
 *   Vietnamese voice is played outside the tab (chrome.tts / offscreen document) so it stays audible.
 * The user's previous state is stored on the element (attribute) so it can be restored even after an
 * unexpected extension restart (`recoverMedia` on next initialisation).
 */
export class OriginalAudio {
  private prev: Prev | null = null;
  private ours = false;
  private tabMuted = false;
  private userOverride = false;
  private readonly onVolume = () => {
    if (this.ours) return;
    // The user (or the player UI) changed the volume while dubbing: respect it, do not fight.
    if (this.prev) this.userOverride = true;
  };

  constructor(
    private readonly media: HTMLMediaElement | null,
    private readonly tabMute: (mute: boolean) => Promise<unknown> = async () => undefined,
  ) {
    media?.addEventListener('volumechange', this.onVolume);
  }

  get strategy(): 'element' | 'tab' | 'none' {
    if (this.media && this.prev && !this.userOverride) return 'element';
    if (this.tabMuted) return 'tab';
    return 'none';
  }

  get overriddenByUser(): boolean {
    return this.userOverride;
  }

  private set(fn: () => void): void {
    this.ours = true;
    try {
      fn();
    } finally {
      // volumechange is dispatched asynchronously
      setTimeout(() => (this.ours = false), 0);
    }
  }

  /** Apply a listening mode. 'original' restores. `mixVolume` = share of the user's volume in "mix". */
  apply(mode: DubListenMode, mixVolume: number): void {
    if (mode === 'original') return void this.restore();
    const m = this.media;
    if (!m) {
      if (!this.tabMuted && mode === 'vi') {
        this.tabMuted = true;
        void this.tabMute(true);
      }
      return;
    }
    if (this.userOverride) return;
    if (!this.prev) {
      this.prev = { muted: m.muted, volume: m.volume };
      m.setAttribute(PREV_ATTR, JSON.stringify(this.prev));
    }
    const p = this.prev;
    this.set(() => {
      if (mode === 'vi') m.muted = true;
      else {
        m.muted = p.muted;
        m.volume = Math.max(0, Math.min(1, p.volume * mixVolume));
      }
    });
  }

  /** Put the user's audio back exactly as it was. Safe to call repeatedly. */
  restore(): void {
    const m = this.media;
    if (m && this.prev) {
      const p = this.prev;
      if (!this.userOverride)
        this.set(() => {
          m.muted = p.muted;
          m.volume = p.volume;
        });
      m.removeAttribute(PREV_ATTR);
    }
    this.prev = null;
    this.userOverride = false;
    if (this.tabMuted) {
      this.tabMuted = false;
      void this.tabMute(false);
    }
  }

  dispose(): void {
    this.restore();
    this.media?.removeEventListener('volumechange', this.onVolume);
  }
}

/** A previous session died without restoring (extension reloaded/crashed): restore from the attribute. */
export function recoverMedia(media: HTMLMediaElement): boolean {
  const raw = media.getAttribute(PREV_ATTR);
  if (!raw) return false;
  try {
    const p = JSON.parse(raw) as Prev;
    media.muted = !!p.muted;
    if (typeof p.volume === 'number') media.volume = Math.max(0, Math.min(1, p.volume));
  } catch {
    /* malformed → leave as is */
  }
  media.removeAttribute(PREV_ATTR);
  return true;
}
