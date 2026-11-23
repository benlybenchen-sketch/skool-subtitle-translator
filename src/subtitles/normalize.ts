import type { Cue } from '../shared/types';
import { hash53 } from '../shared/hash';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&lrm;': '',
  '&rlm;': '',
};

/** Strip WebVTT/HTML markup, speaker tags, inline timestamps and entities. */
/** Image references of thumbnail/storyboard tracks (e.g. "abc.jpg#xywh=0,0,249,140") — never speech. */
export const IMAGE_REF = /\S*\.(?:jpe?g|png|webp|gif|avif)(?:\?\S*)?(?:#xywh=[\d.,]+)?|\S*#xywh=[\d.,]+/gi;

export function isImageRefCue(text: string): boolean {
  return /#xywh=|^\s*\S+\.(?:jpe?g|png|webp|gif|avif)(?:\?\S*)?\s*$/i.test(text);
}

export function cleanCueText(raw: string): string {
  let t = raw;
  t = t.replace(IMAGE_REF, ' '); // storyboard thumbnails leaking into a caption source
  t = t.replace(/<\d{2}:\d{2}[:.\d]*>/g, ''); // inline karaoke timestamps
  t = t.replace(/<v(?:\.[^\s>]+)?\s+([^>]+)>/gi, ''); // <v Speaker>
  t = t.replace(/<\/?[a-z][^>]*>/gi, ''); // <c>, <i>, <b>, <font ...>
  t = t.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
  t = t.replace(/\{\\[^}]*\}/g, ''); // SSA override tags sometimes found in SRT
  t = t.replace(/^\s*-\s+/gm, ''); // dialog dashes
  t = t.replace(/\[(?:music|applause|laughter|silence|inaudible)\]/gi, '');
  t = t.replace(/[♪♫]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function cueId(start: number, end: number, text: string): string {
  return `c${Math.round(start * 1000).toString(36)}_${Math.round(end * 1000).toString(36)}_${hash53(text)}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Clean, sort and deduplicate cues.
 * - drops empty cues
 * - merges identical consecutive cues that touch/overlap (common in HLS segments)
 * - removes "rolling caption" repetition where a cue repeats the previous cue's
 *   text as a prefix (auto-generated captions)
 */
export function normalizeCues(input: readonly Cue[]): Cue[] {
  const cleaned = input
    .map((c) => ({ ...c, text: cleanCueText(c.text) }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Cue[] = [];
  for (const cue of cleaned) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = norm(prev.text);
      const b = norm(cue.text);
      const touching = cue.start <= prev.end + 0.05;
      if (a === b && touching) {
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
      // Rolling captions: "hello everyone" then "hello everyone welcome to" → keep the new tail only.
      if (touching && a && b.startsWith(a + ' ')) {
        const prevWords = prev.text.split(' ').length;
        const tail = cue.text.split(' ').slice(prevWords).join(' ');
        if (tail) {
          const start = Math.max(cue.start, prev.end);
          if (cue.end > start) out.push({ id: cueId(start, cue.end, tail), start, end: cue.end, text: tail });
          continue;
        }
      }
      // Exact duplicate already present (overlapping duplicate tracks)
      if (a === b && cue.start < prev.end) continue;
    }
    out.push({ ...cue, id: cue.id || cueId(cue.start, cue.end, cue.text) });
  }
  return out;
}
