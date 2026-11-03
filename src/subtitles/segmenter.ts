import type { Cue, Unit } from '../shared/types';
import { hash53 } from '../shared/hash';

export interface SegmenterOptions {
  /** Merge fragments at all. */
  merge: boolean;
  /** Max silence gap (s) between cues that may be merged. */
  maxGap: number;
  /** Max duration (s) of a merged unit. */
  maxDuration: number;
  /** Max characters of a merged unit. */
  maxChars: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  merge: true,
  maxGap: 0.8,
  maxDuration: 7.5,
  maxChars: 170,
};

const SENTENCE_END = /[.!?…]["')\]]?$/;
const SOFT_END = /[,;:]$/;

/**
 * Combine short consecutive caption fragments into sentence-like translation
 * units. Each unit records the IDs of the cues it covers so the mapping from
 * original subtitles to translated subtitles stays stable.
 */
export function segmentCues(cues: readonly Cue[], opts: Partial<SegmenterOptions> = {}): Unit[] {
  const o = { ...DEFAULT_SEGMENTER, ...opts };
  const units: Unit[] = [];
  let cur: { cues: Cue[]; text: string } | null = null;

  const flush = () => {
    if (!cur) return;
    const ids = cur.cues.map((c) => c.id);
    units.push({
      id: 'u' + hash53(ids.join('|')),
      start: cur.cues[0].start,
      end: cur.cues[cur.cues.length - 1].end,
      text: cur.text,
      cueIds: ids,
    });
    cur = null;
  };

  for (const cue of cues) {
    if (!cur) {
      cur = { cues: [cue], text: cue.text };
    } else {
      const last = cur.cues[cur.cues.length - 1];
      const gap = cue.start - last.end;
      const combined = cur.text + ' ' + cue.text;
      const duration = cue.end - cur.cues[0].start;
      const canMerge =
        o.merge &&
        !SENTENCE_END.test(cur.text) &&
        gap <= o.maxGap &&
        duration <= o.maxDuration &&
        combined.length <= o.maxChars &&
        // after a comma, only merge when the current unit is still short
        (!SOFT_END.test(cur.text) || cur.text.length < 60);
      if (canMerge) {
        cur.cues.push(cue);
        cur.text = combined;
      } else {
        flush();
        cur = { cues: [cue], text: cue.text };
      }
    }
  }
  flush();
  return units;
}
