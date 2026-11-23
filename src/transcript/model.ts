import type { CaptionSourceKind, TimedUnit, UnitStatus } from '../shared/types';

/**
 * Unified transcript model — a VIEW over data the extension already has (the controller's
 * timeline of translation units and the TextTrack cue store), reused by the transcript panel,
 * exports and AI Study Notes. Nothing is re-translated to build it.
 */
export interface TranscriptSegment {
  /** Stable segment id (= translation unit id; derived from the source cue ids). */
  id: string;
  lessonId: string;
  start: number;
  end: number;
  en: string;
  vi?: string;
  status: UnitStatus;
  source: CaptionSourceKind | 'text';
  /** Cache metadata: translation served from the IndexedDB cache. */
  cached?: boolean;
  /** Text lessons: block type (h1…h6, p, li, oli, quote, cell, code) for structured export. */
  block?: string;
}

/**
 * complete    = the whole lesson's captions are known (caption file read, or cues reach the end)
 * partial     = some captions are known, more may exist (player loads them progressively)
 * none        = no accessible captions
 */
export type CoverageState = 'complete' | 'partial' | 'none';

export interface TranscriptCoverage {
  state: CoverageState;
  /** End of the last known English segment (s). */
  sourceUntilSec: number;
  durationSec: number | null;
  segments: number;
  translated: number;
  failed: number;
  /** Where the English transcript came from (for the UI). */
  sourceLabel?: string;
  /** Limitation / access note (e.g. signed playback → progressive only). */
  note?: string;
}

export interface Transcript {
  lessonId: string;
  title: string;
  kind: 'video' | 'text';
  segments: TranscriptSegment[];
  coverage: TranscriptCoverage;
  /** Changes whenever segments or translations change (notes record it). */
  version: string;
}

export function buildTranscript(args: {
  lessonId: string;
  title: string;
  units: readonly TimedUnit[];
  source: CaptionSourceKind | 'text';
  /** Caption file read in full (not just the currently loaded cues). */
  fullTranscript: boolean;
  durationSec: number | null;
  version: (s: string) => string;
  sourceLabel?: string;
  note?: string;
}): Transcript {
  const segments: TranscriptSegment[] = args.units.map((u) => ({
    id: u.id,
    lessonId: args.lessonId,
    start: u.start,
    end: u.end,
    en: u.text,
    vi: u.vi,
    status: u.status,
    source: args.source,
    cached: (u as TimedUnit & { cached?: boolean }).cached,
  }));
  const last = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const d = args.durationSec && Number.isFinite(args.durationSec) ? args.durationSec : null;
  // Completeness comes only from source-level evidence (whole caption file / complete VOD subtitle
  // playlist). Never from the last cue being near the end (silence at the end is normal) or counts.
  void d;
  const state: CoverageState = !segments.length ? 'none' : args.fullTranscript ? 'complete' : 'partial';
  return {
    lessonId: args.lessonId,
    title: args.title,
    kind: 'video',
    segments,
    coverage: {
      state,
      sourceUntilSec: last,
      durationSec: d,
      segments: segments.length,
      translated: segments.filter((s) => !!s.vi).length,
      failed: segments.filter((s) => s.status === 'error').length,
      sourceLabel: args.sourceLabel,
      note: args.note,
    },
    version: args.version(segments.map((s) => `${s.id}:${s.vi ? 1 : 0}`).join('|')),
  };
}

export function searchSegments(segments: TranscriptSegment[], query: string): TranscriptSegment[] {
  const q = query.trim().toLowerCase();
  if (!q) return segments;
  return segments.filter((s) => s.en.toLowerCase().includes(q) || (s.vi ?? '').toLowerCase().includes(q));
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
