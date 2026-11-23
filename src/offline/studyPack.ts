import type { Transcript } from '../transcript/model';
import { exportFileName, toMarkdown, toSrt, toTxt, toVtt } from '../transcript/export';
import type { LessonRecord } from '../transcript/store';
import { parseGlossary } from '../translation/glossary';
import { makeZip, type ZipEntry } from './zip';

/** A saved lesson record as a Transcript (genuine timestamps for video lessons only). */
export function recordToTranscript(r: LessonRecord): Transcript {
  const segments = r.units.map((u) => ({
    id: u.id,
    lessonId: r.lessonId,
    start: u.start,
    end: u.end,
    en: u.en,
    vi: u.vi,
    status: (u.vi ? 'done' : 'pending') as 'done' | 'pending',
    source: r.kind === 'text' ? ('text' as const) : ('texttrack' as const),
    block: (u as { block?: string }).block,
  }));
  return {
    lessonId: r.lessonId,
    title: r.title || 'Skool lesson',
    kind: r.kind,
    segments,
    coverage: {
      state: !segments.length ? 'none' : r.complete ? 'complete' : 'partial',
      sourceUntilSec: r.sourceUntilSec,
      durationSec: r.durationSec,
      segments: segments.length,
      translated: segments.filter((s) => s.vi).length,
      failed: 0,
      sourceLabel: r.source,
    },
    version: r.contentHash,
  };
}

/** Glossary entries that actually occur in this lesson (user glossary text, never keys/settings). */
export function lessonGlossary(t: Transcript, glossaryText: string): string {
  const all = t.segments.map((s) => s.en).join(' \n ').toLowerCase();
  const rows = parseGlossary(glossaryText)
    .filter((g) => g.term && all.includes(g.term.toLowerCase()))
    .map((g) => `- **${g.term}**${g.translation ? ` → ${g.translation}` : ' (giữ nguyên)'}`);
  return rows.length ? `# Thuật ngữ trong bài\n\n${rows.join('\n')}\n` : '';
}

/**
 * Offline study pack (ZIP, local download only): transcripts (EN / VI / bilingual), SRT/VTT for
 * genuinely timestamped video lessons, AI notes, lesson glossary and a README stating completeness.
 */
export function buildStudyPack(r: LessonRecord, glossaryText = '', now = new Date()): { name: string; bytes: Uint8Array; files: string[] } {
  const t = recordToTranscript(r);
  const partial = t.coverage.state !== 'complete';
  const viMissing = t.coverage.segments - t.coverage.translated;
  const base = exportFileName(t, 'txt', 'bi').replace(/-bilingual(-PARTIAL)?\.txt$/, '');
  const files: ZipEntry[] = [];
  const readme = [
    `${t.title}`,
    '',
    `Loại bài: ${t.kind === 'video' ? 'video' : 'bài viết'}`,
    `Bản ghi tiếng Anh: ${partial ? 'MỘT PHẦN (chỉ phần đã truy cập được)' : 'đầy đủ'}${t.kind === 'video' && t.coverage.durationSec ? ` — có đến ${Math.round(t.coverage.sourceUntilSec)} s / ${Math.round(t.coverage.durationSec)} s` : ''}`,
    `Bản dịch tiếng Việt: ${viMissing ? `${t.coverage.translated}/${t.coverage.segments} đoạn (chưa đủ)` : 'đầy đủ cho phần đã có'}`,
    `Nguồn: ${r.source}`,
    `Lưu lúc: ${now.toISOString()}`,
    '',
    'Tài liệu học cá nhân, lưu trên máy của bạn. Không chứa video, cookie hay khóa API.',
  ].join('\n');
  files.push({ name: 'README.txt', data: readme });
  files.push({ name: `${base}-en.txt`, data: toTxt(t, 'en') });
  files.push({ name: `${base}-vi.txt`, data: toTxt(t, 'vi') });
  files.push({ name: `${base}-bilingual.md`, data: toMarkdown(t, 'bi') });
  if (t.kind === 'video' && t.segments.some((s) => s.end > s.start)) {
    files.push({ name: `${base}-vi.srt`, data: toSrt(t, 'vi') });
    files.push({ name: `${base}-en.srt`, data: toSrt(t, 'en') });
    files.push({ name: `${base}-bilingual.srt`, data: toSrt(t, 'bi') });
    files.push({ name: `${base}-vi.vtt`, data: toVtt(t, 'vi') });
    files.push({ name: `${base}-en.vtt`, data: toVtt(t, 'en') });
  }
  if (r.notesMarkdown) files.push({ name: `${base}-ghi-chu-AI.md`, data: r.notesMarkdown });
  const g = lessonGlossary(t, glossaryText);
  if (g) files.push({ name: `${base}-thuat-ngu.md`, data: g });
  const bytes = makeZip(files.map((f) => ({ ...f, date: now })));
  return { name: `${base}${partial ? '-PARTIAL' : ''}-offline.zip`, bytes, files: files.map((f) => f.name) };
}
