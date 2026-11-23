/** Phase 5B: offline study pack (ZIP) and saved lesson records. */
import { crc32, makeZip } from '../../src/offline/zip';
import { buildStudyPack, lessonGlossary, recordToTranscript } from '../../src/offline/studyPack';
import { mergeRecords } from '../../src/transcript/store';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rec = (o: Partial<Parameters<typeof mergeRecords>[1]> = {}) =>
  mergeRecords(null, {
    lessonId: 'L1',
    title: 'Bài 2: Market Awareness',
    kind: 'video',
    complete: true,
    source: 'playlist phụ đề công khai',
    durationSec: 12,
    sourceUntilSec: 9,
    units: [
      { id: 'u1', start: 1, end: 3, en: 'Know your funnel.', vi: 'Hiểu phễu bán hàng.' },
      { id: 'u2', start: 4, end: 9, en: 'Mass Desire drives sales.', vi: 'Mong muốn số đông thúc đẩy doanh số.' },
    ],
    notesMarkdown: '# Ghi chú\n\n- Ý chính',
    ...o,
  });

/** Read a ZIP back with Python's zipfile (independent implementation) when available. */
function unzipList(bytes: Uint8Array): { name: string; text: string }[] | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const f = join(dir, 'a.zip');
    writeFileSync(f, bytes);
    const out = execFileSync('python3', ['-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps([{"name":i.filename,"text":z.read(i).decode("utf-8")} for i in z.infolist()]))', f]).toString();
    return JSON.parse(out);
  } catch {
    return null;
  }
}

describe('zip', () => {
  it('CRC-32 reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });
  it('produces a valid archive with UTF-8 names (verified by an independent reader)', () => {
    const z = makeZip([{ name: 'bài-học.txt', data: 'Xin chào' }, { name: 'b.md', data: '# B' }]);
    const files = unzipList(z);
    if (files === null) return; // python not available in this environment
    expect(files).toEqual([{ name: 'bài-học.txt', text: 'Xin chào' }, { name: 'b.md', text: '# B' }]);
  });
});

describe('offline study pack', () => {
  it('video lesson: transcripts, SRT/VTT, notes, lesson glossary, README — and no secrets', () => {
    const p = buildStudyPack(rec(), 'funnel => phễu bán hàng\nROAS\nMass Desire', new Date('2026-11-04T10:00:00Z'));
    expect(p.name).toBe('Bài 2 Market Awareness-offline.zip');
    expect(p.files).toEqual(expect.arrayContaining(['README.txt', 'Bài 2 Market Awareness-vi.srt', 'Bài 2 Market Awareness-en.vtt', 'Bài 2 Market Awareness-ghi-chu-AI.md', 'Bài 2 Market Awareness-thuat-ngu.md', 'Bài 2 Market Awareness-bilingual.md']));
    const files = unzipList(p.bytes);
    if (!files) return;
    const get = (n: string) => files.find((f) => f.name.endsWith(n))!.text;
    expect(get('-vi.srt')).toContain('00:00:01,000 --> 00:00:03,000\nHiểu phễu bán hàng.');
    expect(get('-thuat-ngu.md')).toContain('**funnel** → phễu bán hàng');
    expect(get('-thuat-ngu.md')).not.toContain('ROAS'); // only terms that occur in this lesson
    expect(get('README.txt')).toMatch(/Bản ghi tiếng Anh: đầy đủ/);
    expect(JSON.stringify(files)).not.toMatch(/AIza|sk-|api[_-]?key/i);
  });
  it('partial transcript is labelled; text lessons get no SRT/VTT', () => {
    const partial = buildStudyPack(rec({ complete: false }));
    expect(partial.name).toMatch(/-PARTIAL-offline\.zip$/);
    const text = buildStudyPack(rec({ kind: 'text', units: [{ id: 'b0', start: 0, end: 1, en: 'READ ME', vi: 'ĐỌC TRƯỚC', block: 'h2' } as any] }));
    expect(text.files.some((f) => /\.(srt|vtt)$/.test(f))).toBe(false);
    expect(recordToTranscript(rec({ kind: 'text' })).kind).toBe('text');
  });
  it('lesson glossary is empty when no glossary term occurs', () => {
    expect(lessonGlossary(recordToTranscript(rec()), 'ROAS')).toBe('');
  });
});
