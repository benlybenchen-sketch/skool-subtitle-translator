import type { TimedUnit } from '../shared/types';

/** One spoken Vietnamese unit, mapped to genuine source cue timing. */
export interface SpeechUnit {
  id: string;
  lesson: string;
  /** Source translation-unit ids (each derived from real cue ids). */
  sourceIds: string[];
  start: number;
  end: number;
  /** Latest time this unit may still be speaking without stepping on the next one. */
  slotEnd: number;
  /** Vietnamese text to speak (validated translation, unchanged); '' until all parts are translated. */
  text: string;
  /** passed = jumped over by a seek (not counted as missed). */
  status: 'pending' | 'preparing' | 'ready' | 'speaking' | 'played' | 'skipped' | 'passed' | 'failed';
  /** Synthesized duration at the base rate (cloud), else estimated. */
  durationSec?: number;
  audioKey?: string;
  failures: number;
}

const ENDS_SENTENCE = /[.!?…:;]["')\]]*\s*$/;

/**
 * Group short subtitle units into natural spoken units, deterministically from the English source
 * timing/text (so grouping — and therefore cached audio — never changes when translations arrive).
 */
export function buildSpeechUnits(units: readonly TimedUnit[], lesson: string, o: { maxGapSec?: number; maxDurSec?: number; maxChars?: number } = {}): Omit<SpeechUnit, 'status' | 'failures'>[] {
  const maxGap = o.maxGapSec ?? 0.35;
  const maxDur = o.maxDurSec ?? 7;
  const maxChars = o.maxChars ?? 220;
  const sorted = [...units].filter((u) => u.end > u.start).sort((a, b) => a.start - b.start);
  const groups: TimedUnit[][] = [];
  for (const u of sorted) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    const can =
      g &&
      u.start - last!.end <= maxGap &&
      u.end - g[0].start <= maxDur &&
      g.reduce((n, x) => n + x.text.length, 0) + u.text.length <= maxChars &&
      !ENDS_SENTENCE.test(last!.text);
    if (can) g.push(u);
    else groups.push([u]);
  }
  return groups.map((g, i) => {
    const next = groups[i + 1]?.[0];
    const end = g[g.length - 1].end;
    const slotEnd = next ? Math.max(end, next.start) : end + 1.5;
    const ready = g.every((x) => !!x.vi);
    return {
      id: `d:${g[0].id}+${g.length}`,
      lesson,
      sourceIds: g.map((x) => x.id),
      start: g[0].start,
      end,
      slotEnd: Math.min(slotEnd, end + 3),
      text: ready ? g.map((x) => x.vi!.trim()).join(' ').replace(/\s+/g, ' ') : '',
    };
  });
}
