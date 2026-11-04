import type { Cue } from '../shared/types';
import { parseSubtitleFile } from './parse';
import { cueId } from './normalize';

/**
 * Complete English captions from the player's own HLS subtitle rendition (RFC 8216
 * EXT-X-MEDIA TYPE=SUBTITLES) — the same public playlist and WebVTT segments the player requests
 * while playing, read all at once so the whole transcript is available without watching.
 *
 * Only used when the user explicitly allowed it, and only for a PUBLIC playlist the page itself
 * exposes (e.g. a Mux Player `playback-id` without a playback token, or an unsigned .m3u8 src).
 * Signed / tokenised playback is NOT used (no token reuse, no access-control bypass); the caller
 * falls back to progressive cue collection and says why.
 */
export type PlaylistFinding =
  | { kind: 'public'; url: string; provider: 'mux' | 'hls' }
  | { kind: 'signed'; provider: 'mux' | 'hls' }
  | { kind: 'none' };

const MUX_ID = /^[A-Za-z0-9]{10,}$/;
const TOKEN_ATTRS = ['playback-token', 'tokens', 'token', 'drm-token', 'playback-tokens'];

/** Look at the media element and its custom-element hosts (Mux Player / mux-video) for a public playlist. */
export function findPlaylist(media: Element): PlaylistFinding {
  const chain: Element[] = [];
  let n: Node | null = media;
  for (let i = 0; n && i < 30; i++) {
    if (n instanceof Element) chain.push(n);
    const parent: Node | null = (n as Element).parentElement ?? (n.getRootNode() instanceof ShadowRoot ? (n.getRootNode() as ShadowRoot).host : null);
    n = parent;
  }
  for (const el of chain) {
    const id = el.getAttribute('playback-id') ?? ((el as unknown as { playbackId?: string }).playbackId || null);
    if (id && MUX_ID.test(id.split('?')[0])) {
      const signed = TOKEN_ATTRS.some((a) => el.hasAttribute(a)) || /[?&]token=/.test(id) || !!(el as unknown as { tokens?: { playback?: string } }).tokens?.playback;
      return signed ? { kind: 'signed', provider: 'mux' } : { kind: 'public', url: `https://stream.mux.com/${id.split('?')[0]}.m3u8`, provider: 'mux' };
    }
    const src = el.getAttribute('src');
    if (src && /^https:\/\/[^\s]+\.m3u8(\?|$)/i.test(src)) {
      return /[?&](token|signature|sig|policy|key-pair-id|expires|exp)=/i.test(src) ? { kind: 'signed', provider: 'hls' } : { kind: 'public', url: src, provider: 'hls' };
    }
  }
  return { kind: 'none' };
}

interface MediaTag {
  type: string;
  language: string;
  name: string;
  uri: string;
  autoselect: boolean;
}

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

export function parseMasterSubtitles(master: string, baseUrl: string): MediaTag[] {
  return master
    .split(/\r?\n/)
    .filter((l) => l.startsWith('#EXT-X-MEDIA:'))
    .map((l) => attrs(l.slice(13)))
    .filter((a) => a.TYPE === 'SUBTITLES' && a.URI)
    .map((a) => ({ type: a.TYPE, language: (a.LANGUAGE ?? '').toLowerCase(), name: a.NAME ?? '', uri: new URL(a.URI, baseUrl).href, autoselect: a.AUTOSELECT === 'YES' }));
}

export function pickEnglish(tags: MediaTag[], lang = 'en'): MediaTag | null {
  const en = tags.filter((t) => t.language === lang || t.language.startsWith(lang + '-') || (!t.language && /english/i.test(t.name)));
  en.sort((a, b) => Number(/auto|generated/i.test(a.name)) - Number(/auto|generated/i.test(b.name)));
  return en[0] ?? null;
}

export function parseMediaPlaylist(text: string, baseUrl: string): { segments: string[]; ended: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments: string[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXTINF')) {
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) segments.push(new URL(uri, baseUrl).href);
  }
  return { segments, ended: lines.includes('#EXT-X-ENDLIST') };
}

/**
 * WebVTT segment → cues on the media timeline. X-TIMESTAMP-MAP=MPEGTS:<90 kHz>,LOCAL:<time>
 * maps segment-local time to stream time; `base` is the stream's first MPEGTS (media time 0).
 */
export function segmentCues(vtt: string, baseMpegts: number | null): { cues: Cue[]; mpegts: number | null } {
  const m = /X-TIMESTAMP-MAP=([^\r\n]+)/.exec(vtt);
  let shift = 0;
  let mpegts: number | null = null;
  if (m) {
    mpegts = Number(/MPEGTS[:=](\d+)/.exec(m[1])?.[1]);
    const local = /LOCAL[:=]([\d:.]+)/.exec(m[1])?.[1] ?? '00:00:00.000';
    const p = local.split(':').map(Number);
    const localSec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    if (Number.isFinite(mpegts)) shift = (mpegts - (baseMpegts ?? mpegts)) / 90000 - localSec;
  }
  const cues = parseSubtitleFile(vtt).map((c) => {
    const start = Math.round((c.start + shift) * 1000) / 1000;
    const end = Math.round((c.end + shift) * 1000) / 1000;
    return { ...c, start, end, id: cueId(start, end, c.text) };
  });
  return { cues, mpegts: Number.isFinite(mpegts) ? mpegts : null };
}

export interface HlsCaptionResult {
  cues: Cue[];
  complete: boolean;
  segments: number;
  failedSegments: number;
  label: string;
}

/** Read the whole English subtitle rendition (bounded: ≤ 2000 segments, 4 in parallel, 10 s timeout each). */
export async function fetchHlsCaptions(
  url: string,
  o: { lang?: string; fetchImpl?: typeof fetch; maxSegments?: number; signal?: AbortSignal } = {},
): Promise<HlsCaptionResult> {
  const f = o.fetchImpl ?? fetch;
  const get = async (u: string) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const r = await f(u, { credentials: 'omit', signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  };
  const master = await get(url);
  const tag = pickEnglish(parseMasterSubtitles(master, url), o.lang ?? 'en');
  if (!tag) throw new Error('Playlist has no English subtitle rendition');
  const media = parseMediaPlaylist(await get(tag.uri), tag.uri);
  const segs = media.segments.slice(0, o.maxSegments ?? 2000);
  const texts: (string | null)[] = new Array(segs.length).fill(null);
  let next = 0;
  let failed = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, segs.length) }, async () => {
      while (next < segs.length) {
        const i = next++;
        try {
          texts[i] = await get(segs[i]);
        } catch {
          failed++;
        }
      }
    }),
  );
  let base: number | null = null;
  const byId = new Map<string, Cue>();
  for (const t of texts) {
    if (t === null) continue;
    if (base === null) base = /MPEGTS:(\d+)/.exec(t) ? Number(/MPEGTS:(\d+)/.exec(t)![1]) : null;
    for (const c of segmentCues(t, base).cues) byId.set(c.id, c); // cues repeated across segments collapse
  }
  const cues = [...byId.values()].sort((a, b) => a.start - b.start);
  return { cues, complete: media.ended && failed === 0 && segs.length === media.segments.length && cues.length > 0, segments: segs.length, failedSegments: failed, label: tag.name || 'English' };
}

/**
 * Timing check against cues the player itself delivered: the median offset of matching cue texts
 * must be ~0 (or is corrected when consistent). Without ≥ 3 matches the file is not trusted for
 * timing (no unverified timestamps).
 */
export function verifyAlignment(file: Cue[], player: Cue[]): { ok: boolean; offset: number; matches: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const byText = new Map<string, number[]>();
  for (const c of player) (byText.get(norm(c.text)) ?? byText.set(norm(c.text), []).get(norm(c.text))!).push(c.start);
  const diffs: number[] = [];
  for (const c of file) {
    const starts = byText.get(norm(c.text));
    if (!starts) continue;
    const best = starts.reduce((b, s) => (Math.abs(s - c.start) < Math.abs(b - c.start) ? s : b), starts[0]);
    diffs.push(best - c.start);
  }
  if (diffs.length < 3) return { ok: false, offset: 0, matches: diffs.length };
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const consistent = diffs.filter((d) => Math.abs(d - median) < 0.25).length / diffs.length >= 0.8;
  return { ok: consistent, offset: Math.abs(median) < 0.05 ? 0 : median, matches: diffs.length };
}
