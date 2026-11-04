/** Minimal TextTrack / VTTCue / HTMLVideoElement fakes (jsdom does not implement media). */

export class FakeCue {
  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
  line: number | string = 'auto';
}

export class FakeTrack extends EventTarget {
  mode: TextTrackMode = 'disabled';
  private _cues: FakeCue[] = [];
  constructor(
    public kind: TextTrackKind,
    public label: string,
    public language: string,
    cues: FakeCue[] = [],
  ) {
    super();
    this._cues = cues;
  }
  get cues(): any {
    if (this.mode === 'disabled') return null;
    const arr: any = [...this._cues];
    return arr;
  }
  addCue(c: FakeCue) {
    this._cues.push(c);
  }
  removeCue(c: FakeCue) {
    this._cues = this._cues.filter((x) => x !== c);
  }
  /** test helper: append cues as a streaming player would */
  pushCues(cues: FakeCue[]) {
    this._cues.push(...cues);
    this.dispatchEvent(new Event('cuechange'));
  }
}

export class FakeTrackList extends EventTarget {
  items: FakeTrack[] = [];
  get length() {
    return this.items.length;
  }
  add(t: FakeTrack) {
    this.items.push(t);
    (this as any)[this.items.length - 1] = t;
    this.dispatchEvent(new Event('addtrack'));
  }
}

export interface FakeVideo extends HTMLVideoElement {
  _tracks: FakeTrackList;
  _setTime(t: number): void;
  _play(): void;
  _pause(): void;
  /** Swap the media source in place (same element), like an SPA player loading the next lesson. */
  _setSrc(src: string, tracks: FakeTrack[]): void;
}

export function makeVideo(doc: Document, opts: { width?: number; height?: number; src?: string; tracks?: FakeTrack[] } = {}): FakeVideo {
  const v = doc.createElement('video') as FakeVideo;
  const list = new FakeTrackList();
  for (const t of opts.tracks ?? []) list.add(t);
  let time = 0;
  let paused = true;
  let rate = 1;
  let curSrc = opts.src ?? 'https://video.skool.com/lesson-1.mp4?token=abc';
  Object.defineProperties(v, {
    textTracks: { get: () => list },
    currentTime: { get: () => time, set: (t: number) => (time = t), configurable: true },
    paused: { get: () => paused },
    playbackRate: {
      get: () => rate,
      set: (r: number) => {
        rate = r;
        v.dispatchEvent(new Event('ratechange'));
      },
    },
    currentSrc: { get: () => curSrc },
    addTextTrack: {
      value: (kind: TextTrackKind, label: string, language: string) => {
        const t = new FakeTrack(kind, label, language);
        list.add(t);
        return t;
      },
    },
  });
  v._tracks = list;
  v._setTime = (t: number) => {
    v.dispatchEvent(new Event('seeking'));
    time = t;
    v.dispatchEvent(new Event('seeked'));
    v.dispatchEvent(new Event('timeupdate'));
  };
  v._play = () => {
    paused = false;
    v.dispatchEvent(new Event('play'));
  };
  v._pause = () => {
    paused = true;
    v.dispatchEvent(new Event('pause'));
  };
  v._setSrc = (src, tracks) => {
    curSrc = src;
    time = 0;
    for (let i = list.items.length - 1; i >= 0; i--) delete (list as any)[i];
    list.items = [];
    list.dispatchEvent(new Event('removetrack'));
    v.dispatchEvent(new Event('emptied'));
    v.dispatchEvent(new Event('loadstart'));
    for (const t of tracks) list.add(t);
  };
  setRect(v, opts.width ?? 960, opts.height ?? 540);
  return v;
}

export function setRect(el: Element, width: number, height: number, left = 0, top = 0) {
  (el as any).getBoundingClientRect = () => ({ width, height, left, top, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
}

export function installVTTCue() {
  (globalThis as any).VTTCue = FakeCue;
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
