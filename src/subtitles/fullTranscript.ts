import type { Cue } from '../shared/types';
import { parseSubtitleFile } from './parse';
import { fetchHlsCaptions, findPlaylist } from './hlsCaptions';
import { isImageRefCue } from './normalize';

/**
 * FullTranscriptAcquisitionService — the complete English captions of a lesson, independent of
 * playback (no play, no seek, no playhead change).
 *
 * Why it is needed: HLS players (hls.js-style) add subtitle cues to the TextTrack only for the
 * subtitle fragments they buffer around `currentTime`, so `TextTrack.cues` grows only while
 * playing/seeking. The complete subtitle rendition is listed in the HLS playlist the player has
 * ALREADY loaded for this viewer. Reading that playlist and its WebVTT segments is the same
 * standard (RFC 8216) request the player itself makes for this lesson — only subtitle playlists and
 * subtitle segments are requested, never video/audio.
 *
 * Sources (in order): the page's already-loaded caption resources (Resource Timing: subtitle /
 * master playlists, standalone .vtt/.srt files), then public Mux Player playback ids. Nothing is
 * guessed or constructed; URLs are never logged (diagnostics show host and kind only).
 */
export type SourceKind = 'hls-master' | 'hls-subtitles' | 'caption-file' | 'mux-public';

export interface CaptionCandidate {
  kind: SourceKind;
  url: string;
  host: string;
}

export interface TranscriptEvidence {
  /** Strategy that produced the transcript. */
  sourceType: 'cache' | 'caption-file' | 'hls-vod' | 'track-file' | 'progressive' | 'manual' | 'none';
  /** Source-level proof that the WHOLE lesson's captions were obtained. */
  complete: boolean;
  /** Why (not) complete — shown in the UI and diagnostics. */
  reason: string;
  host?: string;
  endList?: boolean;
  playlistType?: string | null;
  expectedSegments?: number;
  retrievedSegments?: number;
  missingSegments?: number[];
  discontinuities?: number;
  playlistDurationSec?: number;
  uniqueCues: number;
  firstCueSec: number | null;
  lastCueSec: number | null;
  /** How timestamps are trusted: HLS timestamp map (standard), verified against player cues, or native file times. */
  timing: 'player-verified' | 'hls-timestamp-map' | 'file' | 'unknown';
  error?: string;
  errorCategory?: 'network-or-cors' | 'http-403' | 'http-404' | 'http-other' | 'no-english' | 'not-subtitles' | 'parse' | 'none';
  checkedAt: number;
}

const PLAYLIST = /\.m3u8(\?|#|$)/i;
const CAPTION_FILE = /\.(vtt|webvtt|srt)(\?|#|$)/i;
/** Thumbnail / storyboard / chapter tracks (WebVTT that is NOT speech), e.g. Mux image.mux.com/…/storyboard.vtt. */
const NOT_CAPTIONS = /storyboard|thumbnail|thumbs|sprite|preview|chapters?|keyframes?/i;
/** Segment-style caption names (part of an HLS rendition, not a standalone file). */
const SEGMENT_NAME = /(seg|segment|chunk|frag|fileSequence|part)[-_]?\d+|\/\d+\.(vtt|webvtt)(\?|$)/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

/** Caption resources the page has already requested (Resource Timing API — same document as the player). */
export function discoverCaptionSources(
  perf: Pick<Performance, 'getEntriesByType'> | undefined,
  media: Element | null,
  o: { since?: number; exclude?: Set<string> } = {},
): CaptionCandidate[] {
  const out: CaptionCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: SourceKind, url: string) => {
    if (seen.has(url) || o.exclude?.has(url) || !/^https:\/\//.test(url)) return;
    seen.add(url);
    out.push({ kind, url, host: hostOf(url) });
  };
  // SPA: the timeline also holds resources of previous lessons → only those loaded for this lesson
  const names = (perf?.getEntriesByType?.('resource') ?? []).filter((e) => !o.since || (e.startTime ?? 0) >= o.since).map((e) => e.name);
  // Subtitle playlists first (if the player already selected one), then masters.
  const playlists = names.filter((n) => PLAYLIST.test(n));
  for (const n of playlists) if (/subtitle|subs|caption|text|webvtt|vtt/i.test(new URL(n).pathname)) add('hls-subtitles', n);
  for (const n of playlists) add('hls-master', n);
  const files = names.filter((n) => CAPTION_FILE.test(n) && !SEGMENT_NAME.test(n) && !NOT_CAPTIONS.test(n) && !/(^|\.)image\.mux\.com$/i.test(hostOf(n)));
  for (const n of files) add('caption-file', n);
  if (media) {
    const f = findPlaylist(media);
    if (f.kind === 'public') add('mux-public', f.url);
  }
  return out;
}

function categorize(e: unknown): TranscriptEvidence['errorCategory'] {
  const status = (e as { status?: number })?.status;
  if (status === 403 || status === 401) return 'http-403';
  if (status === 404) return 'http-404';
  if (status) return 'http-other';
  if (e instanceof TypeError || (e as Error)?.name === 'AbortError') return 'network-or-cors';
  if (/subtitle (playlist|track)/i.test((e as Error)?.message ?? '')) return 'not-subtitles';
  return 'parse';
}

const range = (cues: Cue[]) => ({ uniqueCues: cues.length, firstCueSec: cues.length ? cues[0].start : null, lastCueSec: cues.length ? Math.max(...cues.map((c) => c.end)) : null });

export interface AcquisitionResult {
  cues: Cue[];
  evidence: TranscriptEvidence;
  label: string;
}

/**
 * Try every candidate until one yields a source-level complete transcript. A partial result is
 * returned only if nothing complete was found (with the exact reason).
 */
export async function acquireFullTranscript(
  candidates: CaptionCandidate[],
  o: { lang?: string; fetchImpl?: typeof fetch; durationSec?: number | null; now?: () => number; signal?: AbortSignal } = {},
): Promise<AcquisitionResult> {
  const now = o.now ?? Date.now;
  const f = o.fetchImpl ?? fetch;
  let best: AcquisitionResult | null = null;
  let lastErr: { error: string; category: TranscriptEvidence['errorCategory']; host: string } | null = null;
  for (const c of candidates) {
    try {
      if (c.kind === 'caption-file') {
        const r = await f(c.url, { credentials: 'omit', signal: o.signal });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        const raw = parseSubtitleFile(await r.text());
        // A thumbnail/storyboard WebVTT has image references instead of speech → not captions.
        const images = raw.filter((c) => isImageRefCue(c.text)).length;
        if (raw.length && images / raw.length > 0.3) throw new Error('not a subtitle track (thumbnail/storyboard)');
        const cues = raw.filter((c) => !isImageRefCue(c.text)).sort((a, b) => a.start - b.start);
        if (!cues.length) throw new Error('empty caption file');
        // A standalone WebVTT/SRT file is the whole track by definition (not a fragment).
        const res: AcquisitionResult = { cues, label: 'tệp phụ đề của bài', evidence: { sourceType: 'caption-file', complete: true, reason: 'Tệp phụ đề WebVTT/SRT hoàn chỉnh của bài (không phải phân đoạn).', host: c.host, timing: 'file', ...range(cues), checkedAt: now() } };
        return res;
      }
      const r = await fetchHlsCaptions(c.url, { lang: o.lang, fetchImpl: f, signal: o.signal });
      if (r.noEnglish) {
        lastErr = { error: 'Playlist không có phụ đề tiếng Anh.', category: 'no-english', host: c.host };
        continue;
      }
      const evidence: TranscriptEvidence = {
        sourceType: 'hls-vod',
        complete: r.complete,
        reason: r.complete
          ? `Playlist phụ đề VOD hoàn chỉnh (ENDLIST) — đã tải đủ ${r.retrievedSegments}/${r.expectedSegments} phân đoạn.`
          : !r.endList
            ? 'Playlist phụ đề chưa kết thúc (không có ENDLIST) — có thể là luồng trực tiếp; không thể khẳng định đầy đủ.'
            : `Thiếu ${r.expectedSegments - r.retrievedSegments}/${r.expectedSegments} phân đoạn phụ đề (tải lỗi).`,
        host: c.host,
        endList: r.endList,
        playlistType: r.playlistType,
        expectedSegments: r.expectedSegments,
        retrievedSegments: r.retrievedSegments,
        missingSegments: r.missingSegments,
        discontinuities: r.discontinuities,
        playlistDurationSec: r.playlistDurationSec,
        timing: r.discontinuities ? 'unknown' : 'hls-timestamp-map',
        ...range(r.cues),
        checkedAt: now(),
      };
      // Plausibility (not a completeness test): cue times must lie inside the media.
      if (o.durationSec && evidence.lastCueSec !== null && evidence.lastCueSec > o.durationSec + 2) {
        evidence.complete = false;
        evidence.timing = 'unknown';
        evidence.reason = 'Mốc thời gian phụ đề vượt quá thời lượng video — không dùng làm bản đầy đủ.';
      }
      const res: AcquisitionResult = { cues: r.cues, evidence, label: r.label };
      if (evidence.complete) return res;
      if (!best || r.cues.length > best.cues.length) best = res;
    } catch (e) {
      lastErr = { error: (e as Error).message, category: categorize(e), host: c.host };
    }
  }
  if (best) return best;
  return {
    cues: [],
    label: '',
    evidence: {
      sourceType: 'none',
      complete: false,
      reason: !candidates.length
        ? 'Trang chưa nạp playlist hoặc tệp phụ đề nào mà tiện ích đọc được (trình phát có thể chỉ nạp khi bấm Play).'
        : lastErr?.category === 'no-english'
          ? 'Video không có phụ đề tiếng Anh trong playlist.'
          : lastErr?.category === 'http-403'
            ? 'Máy chủ từ chối tải phụ đề ngoài trình phát (403) — tiện ích không vượt quyền truy cập.'
            : lastErr?.category === 'network-or-cors'
              ? 'Không đọc được nguồn phụ đề (mạng hoặc chính sách CORS của máy chủ) — tiện ích không xin thêm quyền truy cập.'
              : `Không đọc được nguồn phụ đề (${lastErr?.error ?? 'không rõ'}).`,
      host: lastErr?.host,
      uniqueCues: 0,
      firstCueSec: null,
      lastCueSec: null,
      timing: 'unknown',
      error: lastErr?.error,
      errorCategory: lastErr?.category ?? 'none',
      checkedAt: now(),
    },
  };
}
