/** Known Whisper hallucinations on silence/music. */
const HALLUCINATIONS = [
  /^thanks? (you )?for watching[.!]*$/i,
  /^thank you[.!]*$/i,
  /^please subscribe.*$/i,
  /^subtitles? by .*$/i,
  /^\[?(music|applause|silence|blank_audio)\]?$/i,
  /^you$/i,
  /^\.+$/,
];

export function isLikelyHallucination(text: string, rms: number): boolean {
  const t = text.trim();
  if (!t) return true;
  return rms < 0.02 && HALLUCINATIONS.some((re) => re.test(t));
}

export interface LiveSegment {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

/**
 * Turns per-chunk STT text into display segments:
 * - holds very short fragments without terminal punctuation and joins them
 *   with the next chunk (avoids translating "and so" on its own)
 * - removes words repeated across a chunk boundary
 * - filters common silence hallucinations
 */
export class LiveSegmentAssembler {
  private seq = 0;
  private pending: LiveSegment | null = null;
  private lastWords: string[] = [];

  constructor(
    private readonly minWords = 4,
    private readonly maxHoldSec = 3,
  ) {}

  push(text: string, startSec: number, endSec: number, rms = 1): LiveSegment[] {
    let t = text.replace(/\s+/g, ' ').trim();
    if (isLikelyHallucination(t, rms)) return this.pending && endSec - this.pending.startSec > this.maxHoldSec ? this.flush() : [];
    t = this.dropOverlap(t);
    if (!t) return [];
    const out: LiveSegment[] = [];
    let seg: LiveSegment;
    if (this.pending) {
      seg = { ...this.pending, text: `${this.pending.text} ${t}`, endSec };
      this.pending = null;
    } else seg = { id: '', text: t, startSec, endSec };

    const words = seg.text.split(' ').length;
    const complete = /[.!?…]["')\]]?$/.test(seg.text);
    if (!complete && words < this.minWords && endSec - seg.startSec < this.maxHoldSec) {
      this.pending = seg;
      return out;
    }
    seg.id = `live-${++this.seq}`;
    this.remember(seg.text);
    out.push(seg);
    return out;
  }

  /** Emit any held fragment (on timeout or stop). */
  flush(): LiveSegment[] {
    if (!this.pending) return [];
    const seg = { ...this.pending, id: `live-${++this.seq}` };
    this.pending = null;
    this.remember(seg.text);
    return [seg];
  }

  get hasPending(): boolean {
    return !!this.pending;
  }

  private remember(text: string): void {
    this.lastWords = text.split(' ').slice(-8);
  }

  private dropOverlap(text: string): string {
    const words = text.split(' ');
    const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
    for (let k = Math.min(6, this.lastWords.length, words.length - 1); k >= 2; k--) {
      const tail = this.lastWords.slice(-k).map(norm).join(' ');
      const head = words.slice(0, k).map(norm).join(' ');
      if (tail === head) return words.slice(k).join(' ');
    }
    return text;
  }
}
