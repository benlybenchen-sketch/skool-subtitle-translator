import { buildTranscript, fmtClock, searchSegments, type Transcript, type TranscriptSegment } from '../../src/transcript/model';
import { exportFileName, exportTranscript, toMarkdown, toSrt, toTxt, toVtt } from '../../src/transcript/export';
import { LearningPanel, type LearningSource } from '../../src/content/learningPanel';
import { createVideoSource, lessonTitle } from '../../src/content/learningSource';
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { TimedUnit } from '../../src/shared/types';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo } from './fakes';

installVTTCue();

const unit = (id: string, start: number, end: number, text: string, vi?: string): TimedUnit =>
  ({ id, start, end, text, vi, status: vi ? 'done' : 'pending', cueIds: [id] }) as unknown as TimedUnit;

function tx(units: TimedUnit[], o: { full?: boolean; duration?: number | null; title?: string } = {}): Transcript {
  return buildTranscript({
    lessonId: 'L1',
    title: o.title ?? 'Bài 1: Giới thiệu',
    units,
    source: 'texttrack',
    fullTranscript: !!o.full,
    durationSec: o.duration ?? null,
    version: (s) => String(s.length) + s.slice(-8),
  });
}

describe('transcript model', () => {
  it('coverage: complete only with source-level evidence (never from the last cue being near the end)', () => {
    const u = [unit('a', 1, 3, 'Hello', 'Xin chào'), unit('b', 4, 6, 'World')];
    expect(tx([]).coverage.state).toBe('none');
    expect(tx(u).coverage.state).toBe('partial');
    expect(tx(u, { duration: 600 }).coverage.state).toBe('partial');
    expect(tx(u, { duration: 6.5 }).coverage.state).toBe('partial'); // cues reach the end, but no proof of a complete source
    expect(tx(u, { full: true, duration: 60 }).coverage.state).toBe('complete'); // complete source, silence at the end
    expect(tx(u, { full: true, duration: 600 }).coverage.state).toBe('complete');
    const c = tx(u).coverage;
    expect([c.segments, c.translated, c.sourceUntilSec]).toEqual([2, 1, 6]);
  });

  it('version changes when a translation arrives', () => {
    const a = tx([unit('a', 1, 3, 'Hello')]).version;
    const b = tx([unit('a', 1, 3, 'Hello', 'Xin chào')]).version;
    expect(a).not.toBe(b);
  });

  it('search matches English and Vietnamese, case-insensitive', () => {
    const t = tx([unit('a', 1, 3, 'Open Shopify', 'Mở Shopify'), unit('b', 4, 6, 'Set budget', 'Đặt ngân sách')]);
    expect(searchSegments(t.segments, 'shopify').map((s) => s.id)).toEqual(['a']);
    expect(searchSegments(t.segments, 'NGÂN').map((s) => s.id)).toEqual(['b']);
    expect(searchSegments(t.segments, '  ')).toHaveLength(2);
  });

  it('formats clock times', () => {
    expect(fmtClock(5)).toBe('0:05');
    expect(fmtClock(65.9)).toBe('1:05');
    expect(fmtClock(3725)).toBe('1:02:05');
  });
});

describe('transcript export', () => {
  const t = tx(
    [
      unit('b', 4.25, 6.5, 'Set the budget to $50.', 'Đặt ngân sách 50 $.'),
      unit('a', 1, 3.004, 'Welcome back.', 'Chào mừng trở lại.'),
      unit('c', 3725.5, 3727, 'Not yet translated.'),
    ],
    { full: true },
  );

  it('SRT: sequence numbers, HH:MM:SS,mmm, sorted, Unicode preserved', () => {
    const srt = toSrt(t, 'vi');
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:03,004\nChào mừng trở lại.\n\n2\n00:00:04,250 --> 00:00:06,500\nĐặt ngân sách 50 $.\n');
    const bi = toSrt(t, 'bi');
    expect(bi).toContain('3\n01:02:05,500 --> 01:02:07,000\nNot yet translated.\n');
    expect(bi).toContain('Welcome back.\nChào mừng trở lại.');
  });

  it('VTT: header and dot milliseconds', () => {
    const vtt = toVtt(t, 'en');
    expect(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.004\nWelcome back.\n')).toBe(true);
  });

  it('drops exact duplicates and never invents timing for invalid segments', () => {
    const d = tx([unit('a', 1, 2, 'Hi', 'Chào'), unit('a2', 1, 2, 'Hi', 'Chào'), unit('z', 5, 5, 'Zero', 'Không'), unit('o', 1.5, 3, 'Overlap', 'Chồng')]);
    const srt = toSrt(d, 'vi');
    expect(srt.match(/-->/g)).toHaveLength(2); // duplicate and zero-length dropped, overlap kept
    expect(srt).not.toContain('Không');
    expect(srt).toContain('00:00:01,500 --> 00:00:03,000');
  });

  it('TXT and Markdown include timestamps; Markdown marks PARTIAL', () => {
    expect(toTxt(t, 'vi')).toBe('[0:01] Chào mừng trở lại.\n[0:04] Đặt ngân sách 50 $.\n');
    const p = tx([unit('a', 1, 2, 'Hi')]);
    const md = toMarkdown(p, 'bi');
    expect(md).toContain('PARTIAL');
    expect(md).toContain('**[0:01]** Hi\n> _(chưa dịch)_');
  });

  it('file names: language suffix, PARTIAL marker, unsafe characters removed', () => {
    expect(exportFileName(t, 'srt', 'vi')).toBe('Bài 1 Giới thiệu-vi-PARTIAL.srt'); // one segment not translated yet
    expect(exportFileName(t, 'srt', 'en')).toBe('Bài 1 Giới thiệu-en.srt'); // English source is complete
    const p = tx([unit('a', 1, 2, 'Hi')], { title: 'A/B: "x"?' });
    expect(exportFileName(p, 'srt', 'bi')).toBe('A B x-bilingual-PARTIAL.srt');
    expect(exportTranscript(p, 'md', 'bi').name).toMatch(/-PARTIAL\.md$/);
  });

  it('SRT/VTT are refused for text lessons (no timestamps)', () => {
    const text: Transcript = { ...t, kind: 'text' };
    expect(() => exportTranscript(text, 'srt', 'vi')).toThrow();
    expect(exportTranscript(text, 'txt', 'vi').content).toBe('Chào mừng trở lại.\n\nĐặt ngân sách 50 $.\n');
  });
});

describe('learning panel', () => {
  const t = tx([unit('a', 1, 3, 'Open Shopify', 'Mở Shopify'), unit('b', 4, 6, 'Set budget', 'Đặt ngân sách')], { full: true });

  it('renders rows, filters by search, seeks on timestamp click, highlights active row', () => {
    document.body.innerHTML = '';
    const seeks: number[] = [];
    let active: ((id: string | null) => void) | null = null;
    const src: LearningSource = { kind: () => 'video', transcript: () => t, seek: (s) => seeks.push(s), onActive: (cb) => ((active = cb), () => (active = null)) };
    const p = new LearningPanel(document, src);
    p.show('transcript');
    const root = document.querySelector('[data-sst-learning]')!.shadowRoot!;
    expect(root.querySelectorAll('.row')).toHaveLength(2);
    const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'ngân';
    search.dispatchEvent(new Event('input'));
    expect([...root.querySelectorAll<HTMLElement>('.row')].map((r) => r.dataset.id)).toEqual(['b']);
    root.querySelector<HTMLButtonElement>('.row .t')!.click();
    expect(seeks).toEqual([4]);
    active!('b');
    expect(root.querySelector('.row.active')?.getAttribute('data-id')).toBe('b');
    p.destroy();
    expect(document.querySelector('[data-sst-learning]')).toBeNull();
    expect(active).toBeNull();
  });

  it('export tab downloads locally without calling any translation API', () => {
    document.body.innerHTML = '';
    const created: Blob[] = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = ((b: Blob) => (created.push(b), 'blob:x')) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => undefined;
    const clicks: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicks.push(this.download);
    };
    const complete = vi.fn();
    const p = new LearningPanel(document, { kind: () => 'video', transcript: () => t, completeTranslations: complete });
    p.show('export');
    const root = document.querySelector('[data-sst-learning]')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('button.primary')!.click();
    expect(clicks).toEqual(['Bài 1 Giới thiệu-vi.srt']);
    expect(created[0].type).toContain('charset=utf-8');
    expect(complete).not.toHaveBeenCalled();
    p.destroy();
    HTMLAnchorElement.prototype.click = origClick;
    URL.createObjectURL = origCreate;
  });

  it('lesson title comes from the main heading, not extension UI', () => {
    document.body.innerHTML = '<nav><h1>Community</h1></nav><main><h1> Lesson  3 </h1></main>';
    expect(lessonTitle(document)).toBe('Lesson 3');
  });
});

describe('controller transcript (cached data, no extra API calls)', () => {
  it('builds the transcript from translated units and exports without re-translating', async () => {
    document.body.innerHTML = '<main><h1>Ads 101</h1></main>';
    const track = new FakeTrack('subtitles', 'English', 'en', [new FakeCue(1, 3, 'Welcome back to the course.'), new FakeCue(4, 6, 'Open Shopify.')]);
    const video = makeVideo(document, { tracks: [track] });
    document.body.append(video);
    let calls = 0;
    const bridge: ControllerBridge = {
      async translate(_k, units) {
        calls++;
        return units.map((u) => ({ id: u.id, vi: `VI(${u.text})`, cached: true }));
      },
      cancel() {},
      reportStatus() {},
    };
    const c = new SubtitleController({
      doc: document,
      isTop: true,
      adapter: skoolNativeAdapter,
      bridge,
      settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true }),
      captionGraceMs: 10,
      raf: () => 0,
      cancelRaf: () => undefined,
    });
    c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 960 * 540 });
    await flush();
    const before = calls;
    const src = createVideoSource(document, c, null);
    const t = src.transcript()!;
    expect(t.title).toBe('Ads 101');
    expect(t.segments.map((s: TranscriptSegment) => s.vi)).toEqual(['VI(Welcome back to the course.)', 'VI(Open Shopify.)']);
    expect(t.segments.every((s) => s.cached)).toBe(true);
    const f = exportTranscript(t, 'srt', 'bi');
    expect(f.content).toContain('00:00:01,000 --> 00:00:03,000');
    src.seek!(4);
    expect(video.currentTime).toBe(4);
    const r = await src.completeTranslations!(() => undefined);
    expect(r).toEqual({ done: 2, total: 2 });
    expect(calls).toBe(before); // nothing re-translated
    c.destroy();
  });
});
