/** Phase 5A: instant full transcript (45-minute lesson, 900 cues), honest partial coverage, cached reopen. */
import { fetchHlsCaptions, findPlaylist, parseMasterSubtitles, parseMediaPlaylist, segmentCues, verifyAlignment } from '../../src/subtitles/hlsCaptions';
import { TranscriptStore, mergeRecords } from '../../src/transcript/store';
import { cueId } from '../../src/subtitles/normalize';
import { installVTTCue } from './fakes';

installVTTCue();

const DURATION = 45 * 60;
const N = 900; // one cue every 3 s
const cueText = (i: number) => `Lesson sentence number ${i} about market research.`;
const ts = (s: number) => new Date(s * 1000).toISOString().slice(11, 23);

/** Mock public HLS: master → English subtitle playlist → 270 WebVTT segments of 10 s (cues repeated at boundaries). */
function hlsServer(o: { failSegment?: number; noEnglish?: boolean } = {}) {
  const requests: string[] = [];
  const segs = DURATION / 10;
  const f = (async (url: string) => {
    requests.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('.m3u8') && u.pathname.split('/').length === 2)
      return new Response(`#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${o.noEnglish ? 'Français' : 'English'}",LANGUAGE="${o.noEnglish ? 'fr' : 'en'}",AUTOSELECT=YES,URI="subs/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"\nlow.m3u8\n`);
    if (u.pathname.endsWith('subs/en.m3u8'))
      return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + Array.from({ length: segs }, (_, i) => `#EXTINF:10.0,\nseg${i}.vtt`).join('\n') + '\n#EXT-X-ENDLIST\n');
    const m = /seg(\d+)\.vtt$/.exec(u.pathname);
    if (m) {
      const k = Number(m[1]);
      if (k === o.failSegment) return new Response('nope', { status: 500 });
      const body = ['WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000', ''];
      for (let i = 0; i < N; i++) {
        const s = i * 3 + 0.5;
        if (s + 2.5 < k * 10 || s >= k * 10 + 10) continue; // cues overlapping the segment (repeated in neighbours)
        body.push(`${ts(s)} --> ${ts(s + 2.5)}`, cueText(i), '');
      }
      return new Response(body.join('\n'));
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, requests };
}

describe('HLS subtitle rendition (RFC 8216)', () => {
  it('parses master/media playlists and WebVTT segments with X-TIMESTAMP-MAP', () => {
    const tags = parseMasterSubtitles('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="en",URI="a/en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="x"\n', 'https://s.test/p.m3u8');
    expect(tags).toEqual([{ type: 'SUBTITLES', language: 'en', name: 'English', uri: 'https://s.test/a/en.m3u8', autoselect: false }]);
    expect(parseMediaPlaylist('#EXTINF:10,\n1.vtt\n#EXTINF:10,\n2.vtt\n#EXT-X-ENDLIST', 'https://s.test/a/en.m3u8')).toEqual({ segments: ['https://s.test/a/1.vtt', 'https://s.test/a/2.vtt'], ended: true });
    const { cues } = segmentCues('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 900000);
    expect(cues[0]).toMatchObject({ start: 11, end: 12, text: 'Hi', id: cueId(11, 12, 'Hi') });
  });

  it('reads all 900 cues of a 45-minute lesson at once; repeated boundary cues collapse; complete only with ENDLIST and no failures', async () => {
    const { f } = hlsServer();
    const r = await fetchHlsCaptions('https://stream.mux.com/abcdefghij12.m3u8', { fetchImpl: f });
    expect(r.cues).toHaveLength(N);
    expect(r.complete).toBe(true);
    expect(r.cues[899]).toMatchObject({ start: 2697.5, text: cueText(899) });
    const bad = await fetchHlsCaptions('https://stream.mux.com/abcdefghij12.m3u8', { fetchImpl: hlsServer({ failSegment: 5 }).f });
    expect(bad.complete).toBe(false);
    expect(bad.failedSegments).toBe(1);
    expect((await fetchHlsCaptions('https://stream.mux.com/abcdefghij12.m3u8', { fetchImpl: hlsServer({ noEnglish: true }).f })).noEnglish).toBe(true);
  });

  it('public vs signed playback: signed/tokenised playlists are never used', () => {
    document.body.innerHTML = '<mux-player id="a" playback-id="abcdefghij12"><video></video></mux-player><mux-player id="b" playback-id="abcdefghij12" playback-token="eyJ..."><video></video></mux-player><div id="c" src="https://cdn.test/v.m3u8?token=x"><video></video></div><video id="d"></video>';
    const v = (id: string) => (id === 'd' ? document.getElementById('d')! : document.getElementById(id)!.querySelector('video')!);
    expect(findPlaylist(v('a'))).toEqual({ kind: 'public', url: 'https://stream.mux.com/abcdefghij12.m3u8', provider: 'mux' });
    expect(findPlaylist(v('b'))).toEqual({ kind: 'signed', provider: 'mux' });
    expect(findPlaylist(v('c'))).toEqual({ kind: 'signed', provider: 'hls' });
    expect(findPlaylist(v('d'))).toEqual({ kind: 'none' });
  });

  it('timing is verified against cues the player delivered (≥ 3 matches), consistent offsets corrected', () => {
    const file = [0, 1, 2, 3].map((i) => ({ id: 'f' + i, start: i * 3, end: i * 3 + 2, text: cueText(i) }));
    expect(verifyAlignment(file, []).ok).toBe(false);
    expect(verifyAlignment(file, file.map((c) => ({ ...c })))).toMatchObject({ ok: true, offset: 0 });
    expect(verifyAlignment(file, file.map((c) => ({ ...c, start: c.start + 10 })))).toMatchObject({ ok: true, offset: 10 });
    expect(verifyAlignment(file, file.map((c, i) => ({ ...c, start: c.start + (i % 2 ? 7 : -4) }))).ok).toBe(false);
  });
});

describe('lesson store', () => {
  it('merge never downgrades a complete transcript and never drops a known translation', () => {
    const a = mergeRecords(null, { lessonId: 'L', complete: true, source: 'hls', cues: [{ id: 'c1', start: 1, end: 2, text: 'A' }], units: [{ id: 'u1', start: 1, end: 2, en: 'A', vi: 'Á' }] });
    const b = mergeRecords(a, { lessonId: 'L', complete: false, source: 'texttrack', cues: [{ id: 'c2', start: 3, end: 4, text: 'B' }], units: [{ id: 'u1', start: 1, end: 2, en: 'A' }, { id: 'u2', start: 3, end: 4, en: 'B' }] });
    expect(b.complete).toBe(true);
    expect(b.source).toBe('hls');
    expect(b.cues.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(b.units[0].vi).toBe('Á');
    expect(b.translated).toBe(1);
  });
  it('persists across instances (service worker restart), lists, deletes; offline-saved records survive clear()', async () => {
    const name = 'tx-' + Math.random();
    await new TranscriptStore({ dbName: name }).put({ lessonId: 'A', title: 'A', cues: [], units: [] });
    await new TranscriptStore({ dbName: name }).put({ lessonId: 'B', title: 'B', cues: [], units: [], savedOffline: true });
    const s = new TranscriptStore({ dbName: name });
    expect((await s.list()).map((r) => r.lessonId).sort()).toEqual(['A', 'B']);
    expect(await s.clear(false)).toBe(1);
    expect((await s.list()).map((r) => r.lessonId)).toEqual(['B']);
    await s.delete('B');
    expect(await s.list()).toEqual([]);
  });
});

