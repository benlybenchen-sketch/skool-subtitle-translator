/** Phase 5A: instant full transcript (45-minute lesson, 900 cues), honest partial coverage, cached reopen. */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { fetchHlsCaptions, findPlaylist, parseMasterSubtitles, parseMediaPlaylist, segmentCues, verifyAlignment } from '../../src/subtitles/hlsCaptions';
import { TranscriptStore, mergeRecords, type LessonRecord } from '../../src/transcript/store';
import { cueId } from '../../src/subtitles/normalize';
import { hash53 } from '../../src/shared/hash';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo } from './fakes';

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
    await expect(fetchHlsCaptions('https://stream.mux.com/abcdefghij12.m3u8', { fetchImpl: hlsServer({ noEnglish: true }).f })).rejects.toThrow(/no English/);
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

// ---- controller acceptance ----------------------------------------------------------------------

function memStore(initial?: LessonRecord) {
  const data = new Map<string, LessonRecord>();
  if (initial) data.set(initial.lessonId, initial);
  return {
    data,
    async get(id: string) {
      return data.get(id) ?? null;
    },
    async put(r: Partial<LessonRecord> & { lessonId: string }) {
      data.set(r.lessonId, mergeRecords(data.get(r.lessonId) ?? null, r));
    },
  };
}

function setup(o: { cues: number; mux?: 'public' | 'signed' | null; store?: ReturnType<typeof memStore>; fetchImpl?: typeof fetch; allowFull?: boolean }) {
  document.body.innerHTML = '';
  const cues = Array.from({ length: o.cues }, (_, i) => new FakeCue(i * 3 + 0.5, i * 3 + 3, cueText(i)));
  const track = new FakeTrack('subtitles', 'English', 'en', cues);
  track.mode = 'showing';
  const video = makeVideo(document, { tracks: [track], src: 'blob:https://www.skool.com/x' });
  Object.defineProperty(video, 'duration', { value: DURATION, configurable: true });
  const host = document.createElement('mux-player');
  if (o.mux) host.setAttribute('playback-id', 'abcdefghij12');
  if (o.mux === 'signed') host.setAttribute('playback-token', 'eyJhbGciOi');
  host.append(video);
  document.body.append(host);
  const calls: string[][] = [];
  const bridge: ControllerBridge = {
    async translate(_k, units) {
      calls.push(units.map((u) => u.text));
      return units.map((u) => ({ id: u.id, vi: `VI(${u.text})` }));
    },
    cancel() {},
    reportStatus() {},
  };
  const store = o.store ?? memStore();
  const c = new SubtitleController({
    doc: document,
    isTop: true,
    adapter: skoolNativeAdapter,
    bridge,
    captionGraceMs: 10,
    raf: () => 0,
    cancelRaf: () => undefined,
    lessonStore: store,
    lessonTitle: () => '45-minute lesson',
    fetchImpl: o.fetchImpl,
    settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true, fullTranscriptFromPlayer: !!o.allowFull, mergeFragments: false }),
  });
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 960 * 540 });
  return { c, video, calls, store };
}
const settle = async (ms = 40) => {
  for (let i = 0; i < 6; i++) await flush();
  await new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 6; i++) await flush();
};
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await settle(20);
  return cond();
};

describe('instant full transcript — acceptance', () => {
  const live: SubtitleController[] = [];
  afterEach(() => live.splice(0).forEach((c) => c.destroy()));

  it('A: complete public caption playlist → full 45-min English transcript without playback; first cues translated first; result cached', async () => {
    const hls = hlsServer();
    const { c, calls, store } = setup({ cues: 40, mux: 'public', fetchImpl: hls.f, allowFull: true });
    live.push(c);
    expect(await waitFor(() => (c.transcript('x')?.segments.length ?? 0) >= N)).toBe(true);
    const t = c.transcript('x')!;
    expect(t.coverage.state).toBe('complete');
    expect(t.coverage.sourceLabel).toMatch(/playlist phụ đề công khai/);
    expect(t.segments).toHaveLength(N); // the 40 player cues and the file merge without duplicates
    expect(calls[0]).toContain(cueText(0)); // playback-first priority
    expect(await waitFor(() => (c.transcript('x')!.coverage.translated ?? 0) === N, 8000)).toBe(true);
    const sent = calls.flat();
    expect(new Set(sent).size).toBe(sent.length); // no subtitle block sent twice
    c.destroy(); // flushes the save
    const rec = store.data.get(hash53((c as any).videoKey ?? '') ) ?? [...store.data.values()][0];
    expect(rec.complete).toBe(true);
    expect(rec.translated).toBe(N);
  }, 20_000);

  it('B: only 40 cues and no complete source → truthful partial transcript, never 100 %', async () => {
    const { c } = setup({ cues: 40, mux: null, allowFull: true });
    live.push(c);
    await settle();
    await waitFor(() => c.transcript('x')!.coverage.translated === 40);
    const t = c.transcript('x')!;
    expect(t.coverage.state).toBe('partial');
    expect(t.coverage.translated).toBe(40);
    expect(t.coverage.sourceUntilSec).toBeLessThan(130);
    expect(t.coverage.note).toMatch(/không công bố playlist phụ đề công khai/);
  });

  it('B2: signed playback → playlist not touched, limitation stated', async () => {
    const hls = hlsServer();
    const { c } = setup({ cues: 40, mux: 'signed', fetchImpl: hls.f, allowFull: true });
    live.push(c);
    await settle();
    expect(hls.requests).toEqual([]);
    expect(c.transcript('x')!.coverage.note).toMatch(/có chữ ký/);
    expect(c.transcript('x')!.coverage.state).toBe('partial');
  });

  it('not permitted (default) → no playlist request at all', async () => {
    const hls = hlsServer();
    const { c } = setup({ cues: 40, mux: 'public', fetchImpl: hls.f, allowFull: false });
    live.push(c);
    await settle();
    expect(hls.requests).toEqual([]);
  });

  it('C: fully cached lesson → complete English + Vietnamese immediately, zero translation requests', async () => {
    // build a cached record the way a previous visit would have saved it
    const first = setup({ cues: 40, mux: 'public', fetchImpl: hlsServer().f, allowFull: true });
    await waitFor(() => first.c.transcript('x')!.coverage.translated === N, 10_000);
    first.c.destroy();
    const saved = [...first.store.data.values()][0];
    expect(saved.complete && saved.translated === N).toBe(true);
    const again = setup({ cues: 0, mux: null, store: memStore(saved), allowFull: false });
    live.push(again.c);
    expect(await waitFor(() => again.c.transcript('x')?.segments.length === N)).toBe(true);
    const t = again.c.transcript('x')!;
    expect(t.coverage.state).toBe('complete');
    expect(t.coverage.translated).toBe(N);
    await settle(100);
    expect(again.calls).toEqual([]); // no API calls for a fully cached lesson
  }, 30_000);
});
