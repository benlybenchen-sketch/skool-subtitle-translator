/**
 * Fallback used when the <video> element itself is in native fullscreen: HTML
 * overlays cannot be drawn above it, but the browser still renders the video's
 * own text tracks. We add a single Vietnamese track and keep one cue in it.
 */
export class NativeTrackFallback {
  private track: TextTrack | null = null;
  private current: VTTCue | null = null;
  private key = '';

  constructor(private readonly video: HTMLVideoElement) {}

  static readonly LABEL = 'Tiếng Việt (SST)';

  get textTrack(): TextTrack | null {
    return this.track;
  }

  private ensure(): TextTrack | null {
    if (!this.track) {
      if (typeof this.video.addTextTrack !== 'function' || typeof VTTCue === 'undefined') return null;
      this.track = this.video.addTextTrack('subtitles', NativeTrackFallback.LABEL, 'vi');
    }
    if (this.track.mode !== 'showing') this.track.mode = 'showing';
    return this.track;
  }

  show(text: string | null, start: number, end: number): void {
    const key = text ? `${text}|${start}|${end}` : '';
    if (key === this.key) return;
    this.key = key;
    const tr = text ? this.ensure() : this.track;
    if (!tr) return;
    if (this.current) {
      try {
        tr.removeCue(this.current);
      } catch {
        /* already removed */
      }
      this.current = null;
    }
    if (text) {
      this.current = new VTTCue(start, Math.max(end, start + 0.5), text);
      this.current.line = -3;
      tr.addCue(this.current);
    }
  }

  disable(): void {
    this.show(null, 0, 0);
    if (this.track) this.track.mode = 'disabled';
  }
}
