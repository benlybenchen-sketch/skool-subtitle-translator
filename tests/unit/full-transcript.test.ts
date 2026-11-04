/**
 * Critical fix: complete transcript WITHOUT playback or seeking.
 * A 45-minute lesson (900 cues) that has never been played: the playhead stays at 00:00, play()
 * is never called, only subtitle playlists/segments are requested, and the whole lesson is
 * translated and exportable. Mock network — not proof of real-Skool behaviour.
 */
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { mergeRecords, type LessonRecord } from '../../src/transcript/store';
import { exportTranscript } from '../../src/transcript/export';
import { acquireFullTranscript, discoverCaptionSources } from '../../src/subtitles/fullTranscript';
import { parseSubtitleFile } from '../../src/subtitles/parse';
import { FakeTrack, flush, installVTTCue, makeVideo } from './fakes';

installVTTCue();

const DURATION = 45 * 60;
const text = (i: number, tag = 'A') => `Lesson ${tag} sentence ${i} about the research framework.`;
const ts = (s: number) => new Date(s * 1000).toISOString().slice(11, 23);
const MASTER = (tag: string) => `https://stream.cdn.test/v/${tag}.m3u8?token=page-issued-playback-token`;

interface ServerOpts {
  tag?: string;
  cues?: number;
  failSegment?: number;
  noEnglish?: boolean;
  live?: boolean;
  status?: number;
  cors?: boolean;
  discontinuity?: boolean;
  lastCueAt?: number;
}
function server(o: ServerOpts = {}) {
  const tag = o.tag ?? 'A';
  const n = o.cues ?? 900;
  const step = (o.lastCueAt ?? DURATION - 3) / n;
  const requests: string[] = [];
  const segs = DURATION / 10;
  const f = (async (url: string) => {
    requests.push(url);
    if (o.cors) throw new TypeError('Failed to fetch');
    if (o.status) return new Response('', { status: o.status });
    const u = new URL(url);
    if (u.pathname === `/v/${tag}.m3u8`)
      return new Response(`#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="${o.noEnglish ? 'Deutsch' : 'English CC'}",LANGUAGE="${o.noEnglish ? 'de' : 'en'}",URI="subs/en.m3u8?token=t"\n#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="s"\nv720.m3u8?token=t\n`);
    if (u.pathname === `/v/subs/en.m3u8`)
      return new Response('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:10\n' + Array.from({ length: segs }, (_, i) => `${o.discontinuity && i === 100 ? '#EXT-X-DISCONTINUITY\n' : ''}#EXTINF:10.0,\nseg${i}.vtt?token=t`).join('\n') + (o.live ? '\n' : '\n#EXT-X-ENDLIST\n'));
    const m = /\/v\/subs\/seg(\d+)\.vtt$/.exec(u.pathname);
    if (m) {
      const k = Number(m[1]);
      if (k === o.failSegment) return new Response('', { status: 503 });
      const body = ['WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000', ''];
      for (let i = 0; i < n; i++) {
        const s = Math.round((i * step + 0.5) * 1000) / 1000;
        if (s + 2 < k * 10 || s >= k * 10 + 10) continue;
        body.push(`${ts(s)} --> ${ts(s + 2)}`, text(i, tag), '');
      }
      return new Response(body.join('\n'));
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, requests, master: MASTER(tag) };
}

const perfWith = (names: string[]) => ({ getEntriesByType: (t: string) => (t === 'resource' ? names.map((name) => ({ name }) as PerformanceEntry) : []) });

function memStore(initial?: LessonRecord) {
  const data = new Map<string, LessonRecord>();
  if (initial) data.set(initial.lessonId, initial);
  return { data, get: async (id: string) => data.get(id) ?? null, put: async (r: Partial<LessonRecord> & { lessonId: string }) => void data.set(r.lessonId, mergeRecords(data.get(r.lessonId) ?? null, r)) };
}

function setup(o: { srv?: ReturnType<typeof server>; perf?: string[]; store?: ReturnType<typeof memStore>; failTranslate?: (t: string) => boolean; tag?: string } = {}) {
  document.body.innerHTML = '';
  const track = new FakeTrack('subtitles', 'English CC', 'en', []); // CC off, nothing loaded yet
  const video = makeVideo(document, { tracks: [track], src: `blob:https://www.skool.com/${o.tag ?? 'A'}` });
  Object.defineProperty(video, 'duration', { value: DURATION, configurable: true });
  let playCalls = 0;
  let timeWrites = 0;
  video.play = (() => ((playCalls++), Promise.resolve())) as any;
  let t = 0;
  Object.defineProperty(video, 'currentTime', { get: () => t, set: (v: number) => ((timeWrites++), (t = v)), configurable: true });
  document.body.append(video);
  const calls: string[][] = [];
  const bridge: ControllerBridge = {
    async translate(_k, units) {
      calls.push(units.map((u) => u.text));
      return units.map((u) => (o.failTranslate?.(u.text) ? { id: u.id, error: 'HTTP 503' } : { id: u.id, vi: `VI: ${u.text}` }));
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
    lessonTitle: () => `Lesson ${o.tag ?? 'A'}`,
    fetchImpl: o.srv?.f,
    perf: perfWith(o.perf ?? (o.srv ? [o.srv.master, 'https://stream.cdn.test/v/v720/seg0.ts?token=t'] : [])),
    settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: false, mergeFragments: false }),
  });
  c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 960 * 540 });
  return { c, video, calls, store, plays: () => playCalls, timeWrites: () => timeWrites };
}
const settle = async (ms = 30) => {
  for (let i = 0; i < 6; i++) await flush();
  await new Promise((r) => setTimeout(r, ms));
};
const waitFor = async (cond: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await settle(20);
  return cond();
};

const live: SubtitleController[] = [];
afterEach(() => live.splice(0).forEach((c) => c.destroy()));

describe('acceptance: untouched 45-minute lesson, playhead at 00:00', () => {
  it('complete source transcript without playback, all segments verified, whole lesson translated, full Vietnamese SRT matches the source', async () => {
    const srv = server();
    const { c, video, calls, plays, timeWrites, store } = setup({ srv });
    live.push(c);
    expect(await waitFor(() => c.transcriptEvidence?.complete === true)).toBe(true);
    const ev = c.transcriptEvidence!;
    expect(ev).toMatchObject({ sourceType: 'hls-vod', complete: true, endList: true, expectedSegments: 270, retrievedSegments: 270, missingSegments: [], uniqueCues: 900, timing: 'hls-timestamp-map' });
    expect(JSON.stringify(ev)).not.toContain('token'); // no signed URL in diagnostics
    expect(c.debugState().fullTranscript.candidates[0]).toEqual({ kind: 'hls-master', host: 'stream.cdn.test' });
    // only subtitle playlists/segments — never video/audio
    expect(srv.requests.some((u) => /\.ts(\?|$)|v720\.m3u8/.test(u))).toBe(false);
    expect(await waitFor(() => c.transcript('x')!.coverage.translated === 900, 10_000)).toBe(true);
    const t = c.transcript('x')!;
    expect(t.coverage.state).toBe('complete');
    // playhead untouched, never played
    expect(video.currentTime).toBe(0);
    expect(plays()).toBe(0);
    expect(timeWrites()).toBe(0);
    // no subtitle block sent twice
    const sent = calls.flat();
    expect(new Set(sent).size).toBe(sent.length);
    // the exported SRT contains every source cue, in order, with its genuine timing
    const srt = exportTranscript(t, 'srt', 'vi');
    const parsed = parseSubtitleFile(srt.content);
    expect(parsed).toHaveLength(900);
    expect(parsed[0].text).toBe(`VI: ${text(0)}`);
    expect(parsed[899].text).toBe(`VI: ${text(899)}`);
    expect(Math.abs(parsed[450].start - (450 * ((DURATION - 3) / 900) + 0.5))).toBeLessThan(0.01);
    // saved with its evidence (reopen → instant)
    c.destroy();
    const rec = [...store.data.values()][0];
    expect(rec.complete).toBe(true);
    expect(rec.evidence?.complete).toBe(true);
    expect(rec.translated).toBe(900);
  }, 30_000);

  it('long silence at the end: complete VOD source with the last cue at 40:00 of 45:00 → COMPLETE (no duration threshold)', async () => {
    const { c } = setup({ srv: server({ cues: 400, lastCueAt: 40 * 60 }) });
    live.push(c);
    expect(await waitFor(() => c.transcriptEvidence?.complete === true)).toBe(true);
    expect(c.transcript('x')!.coverage.state).toBe('complete');
    expect(c.transcriptEvidence!.lastCueSec!).toBeLessThan(40 * 60 + 5);
  });

  it('subtitle playlist errors: a segment fails (after a retry) → PARTIAL with the missing segment listed, never complete', async () => {
    const { c } = setup({ srv: server({ failSegment: 42 }) });
    live.push(c);
    expect(await waitFor(() => c.transcriptEvidence !== null && c.transcriptEvidence.sourceType === 'hls-vod')).toBe(true);
    const ev = c.transcriptEvidence!;
    expect(ev).toMatchObject({ complete: false, expectedSegments: 270, retrievedSegments: 269, missingSegments: [42] });
    expect(c.transcript('x')!.coverage.state).toBe('partial');
    expect(c.transcript('x')!.coverage.note).toMatch(/Thiếu 1\/270 phân đoạn/);
  });

  it('live / unfinished playlist (no ENDLIST) → not complete', async () => {
    const { c } = setup({ srv: server({ live: true }) });
    live.push(c);
    expect(await waitFor(() => c.transcriptEvidence?.sourceType === 'hls-vod')).toBe(true);
    expect(c.transcriptEvidence!.complete).toBe(false);
  });

  it('discontinuity and no player cues to confirm timing → not used as complete (no unverified timestamps)', async () => {
    const { c } = setup({ srv: server({ discontinuity: true }) });
    live.push(c);
    await waitFor(() => c.transcriptEvidence !== null);
    await settle(50);
    expect(c.transcriptEvidence!.complete).toBe(false);
    expect(c.transcript('x')?.coverage.state ?? 'none').not.toBe('complete');
  });

  it('video without English subtitles → exact limitation', async () => {
    const { c } = setup({ srv: server({ noEnglish: true }) });
    live.push(c);
    expect(await waitFor(() => /không có phụ đề tiếng Anh/.test(c.transcriptEvidence?.reason ?? ''))).toBe(true);
    expect(c.transcriptEvidence!.complete).toBe(false);
  });

  it('caption source requiring access the extension does not have (403 / CORS) → reported, not bypassed', async () => {
    const a = setup({ srv: server({ status: 403 }) });
    live.push(a.c);
    expect(await waitFor(() => a.c.transcriptEvidence?.errorCategory === 'http-403')).toBe(true);
    expect(a.c.transcriptEvidence!.reason).toMatch(/từ chối|403/);
    a.c.destroy();
    const b = setup({ srv: server({ cors: true }) });
    live.push(b.c);
    expect(await waitFor(() => b.c.transcriptEvidence?.errorCategory === 'network-or-cors')).toBe(true);
  });

  it('no complete caption resource loaded by the page → honest fallback; acquisition runs once the player loads its playlist (still no playback)', async () => {
    const srv = server();
    const names: string[] = [];
    document.body.innerHTML = '';
    const { c, video } = setup({ srv, perf: names });
    live.push(c);
    await settle();
    expect(c.transcriptEvidence).toMatchObject({ sourceType: 'none', complete: false });
    expect(c.transcriptEvidence!.reason).toMatch(/chưa nạp playlist/);
    names.push(srv.master); // the player initialises and loads its manifest
    await c.acquireFromPlayer();
    expect(await waitFor(() => c.transcriptEvidence?.complete === true)).toBe(true);
    expect(video.currentTime).toBe(0);
  });

  it('standalone WebVTT caption file loaded by the page → complete source', async () => {
    const vtt = 'WEBVTT\n\n' + Array.from({ length: 30 }, (_, i) => `${ts(i * 5 + 1)} --> ${ts(i * 5 + 4)}\nFile cue ${i}.\n`).join('\n');
    const f = (async () => new Response(vtt)) as unknown as typeof fetch;
    const r = await acquireFullTranscript(discoverCaptionSources(perfWith(['https://cdn.test/captions/en.vtt']), null), { fetchImpl: f });
    expect(r.evidence).toMatchObject({ sourceType: 'caption-file', complete: true, uniqueCues: 30, timing: 'file' });
    // HLS segment-style names are never mistaken for a whole file
    expect(discoverCaptionSources(perfWith(['https://cdn.test/subs/seg12.vtt', 'https://cdn.test/subs/fileSequence3.webvtt']), null)).toEqual([]);
  });
});

describe('cache, resume, consecutive lessons', () => {
  it('fully cached lesson (with evidence) → instant complete EN + VI, zero network and translation requests', async () => {
    const first = setup({ srv: server() });
    await waitFor(() => first.c.transcript('x')?.coverage.translated === 900, 12_000);
    first.c.destroy();
    const saved = [...first.store.data.values()][0];
    const srv = server();
    const again = setup({ srv, store: memStore(saved) });
    live.push(again.c);
    expect(await waitFor(() => again.c.transcript('x')?.segments.length === 900)).toBe(true);
    const t = again.c.transcript('x')!;
    expect(t.coverage.state).toBe('complete');
    expect(t.coverage.translated).toBe(900);
    await settle(80);
    expect(again.calls).toEqual([]);
    expect(srv.requests).toEqual([]);
  }, 30_000);

  it('records saved without completeness evidence are not trusted as complete', async () => {
    const old = mergeRecords(null, { lessonId: 'x', complete: true, source: 'old heuristic', cues: [{ id: 'c1', start: 1, end: 2, text: 'Hi' }], units: [] });
    const { c } = setup({ store: { data: new Map(), get: async () => old, put: async () => undefined } as any, perf: [] });
    live.push(c);
    await settle(60);
    expect(c.transcript('x')?.coverage.state).toBe('partial');
  });

  it('interrupted translation resumes: only the untranslated remainder is requested after reopening', async () => {
    let fail = true;
    const first = setup({ srv: server(), failTranslate: (t) => fail && /sentence (\d*[13579]) /.test(t) });
    await waitFor(() => first.c.transcript('x')?.coverage.translated === 450, 12_000);
    first.c.destroy(); // Chrome closed mid-way
    fail = false;
    const saved = [...first.store.data.values()][0];
    expect(saved.translated).toBe(450);
    const again = setup({ srv: server(), store: memStore(saved) });
    live.push(again.c);
    expect(await waitFor(() => again.c.transcript('x')?.coverage.translated === 900, 12_000)).toBe(true);
    expect(again.calls.flat()).toHaveLength(450);
  }, 40_000);

  it('consecutive lessons (SPA, no F5): each gets its own complete transcript, nothing mixed', async () => {
    const a = setup({ srv: server({ tag: 'A' }), tag: 'A' });
    live.push(a.c);
    expect(await waitFor(() => a.c.transcriptEvidence?.complete === true)).toBe(true);
    a.c.reset();
    history.pushState({}, '', '/g/classroom/c?md=lesson-B');
    const srvB = server({ tag: 'B', cues: 300 });
    document.body.innerHTML = '';
    const track = new FakeTrack('subtitles', 'English CC', 'en', []);
    const vb = makeVideo(document, { tracks: [track], src: 'blob:https://www.skool.com/B' });
    Object.defineProperty(vb, 'duration', { value: DURATION, configurable: true });
    document.body.append(vb);
    (a.c as any).env.fetchImpl = srvB.f;
    (a.c as any).env.perf = perfWith([srvB.master]);
    a.c.setTarget({ kind: 'video', el: vb, provider: 'skool-native', area: 960 * 540 });
    expect(await waitFor(() => a.c.transcriptEvidence?.complete === true && a.c.transcript('x')!.segments.length === 300)).toBe(true);
    expect(a.c.transcript('x')!.segments.every((s) => s.en.includes('Lesson B'))).toBe(true);
  }, 30_000);
});

describe('SPA safety', () => {
  it('only caption resources loaded for the current lesson are candidates; sources of other lessons are never reused', () => {
    const perf = { getEntriesByType: () => [{ name: 'https://cdn.test/old/lesson1.vtt', startTime: 100 }, { name: 'https://cdn.test/new/LESSON2.m3u8', startTime: 5000 }] as PerformanceEntry[] };
    expect(discoverCaptionSources(perf, null, { since: 4000 }).map((c) => c.url)).toEqual(['https://cdn.test/new/LESSON2.m3u8']);
    expect(discoverCaptionSources(perf, null, { exclude: new Set(['https://cdn.test/old/lesson1.vtt']) }).map((c) => c.kind)).toEqual(['hls-master']);
  });
});
