import { fmtClock, type TranscriptCoverage } from '../transcript/model';
import type { NoteItem, StudyNotes } from './schema';

/** Saved notes for one lesson (chrome.storage.local, key notes:<lessonId>). */
export interface NotesRecord {
  lessonId: string;
  title: string;
  kind: 'video' | 'text';
  notes: StudyNotes;
  refStarts: Record<string, number>;
  transcriptVersion: string;
  coverage: TranscriptCoverage;
  provider: string;
  model: string;
  createdAt: number;
  calls: number;
  truncated: boolean;
  /** User-edited Markdown (local only); shown instead of the generated notes when present. */
  editedMarkdown?: string;
  editedAt?: number;
  /** Intermediate per-chunk results, reused on regeneration. */
  chunks?: Record<string, StudyNotes>;
}

export const PARTIAL_BANNER = 'AI Notes generated from the available transcript only.';

export const SECTION_TITLES = {
  summary: 'Tóm tắt',
  objectives: 'Mục tiêu bài học',
  concepts: 'Khái niệm chính',
  insights: 'Nhận định quan trọng của giảng viên',
  steps: 'Các bước thực hành',
  terminology: 'Thuật ngữ',
  takeaways: 'Điểm cần nhớ',
  checklist: 'Checklist áp dụng',
  moments: 'Mốc thời gian quan trọng',
} as const;

export function coverageText(r: Pick<NotesRecord, 'coverage' | 'kind' | 'truncated'>): string {
  const c = r.coverage;
  const span = r.kind === 'video' ? `${fmtClock(c.sourceUntilSec)}${c.durationSec ? ` / ${fmtClock(c.durationSec)}` : ''}` : `${c.segments} đoạn`;
  return `${c.state === 'complete' ? 'Đầy đủ' : 'Một phần'} (${span})${r.truncated ? ' · đã cắt bớt vì quá dài' : ''}`;
}

function stamps(refs: string[], starts: Record<string, number>): string {
  const t = refs.map((id) => starts[id]).filter((x): x is number => typeof x === 'number');
  return t.length ? ' ' + t.map((x) => `[${fmtClock(x)}]`).join(' ') : '';
}

export function notesToMarkdown(r: NotesRecord): string {
  if (r.editedMarkdown) return r.editedMarkdown;
  const n = r.notes;
  const st = r.kind === 'video' ? r.refStarts : {};
  const it = (x: NoteItem) => `- ${x.text}${stamps(x.refs, st)}`;
  const out: string[] = [`# ${n.title || r.title}`, ''];
  if (r.coverage.state !== 'complete') out.push(`> ⚠️ ${PARTIAL_BANNER} — ${coverageText(r)}`, '');
  const sec = (title: string, lines: string[]) => {
    if (lines.length) out.push(`## ${title}`, '', ...lines, '');
  };
  sec(SECTION_TITLES.summary, n.summary ? [n.summary] : []);
  sec(SECTION_TITLES.objectives, n.objectives.map((x) => `- ${x}`));
  sec(SECTION_TITLES.concepts, n.concepts.map((c) => `- **${c.term}**: ${c.explanation}${stamps(c.refs, st)}`));
  sec(SECTION_TITLES.insights, n.insights.map(it));
  sec(SECTION_TITLES.steps, n.steps.map((x, i) => `${i + 1}. ${x.text}${stamps(x.refs, st)}`));
  sec(SECTION_TITLES.terminology, n.terminology.map((t) => `- **${t.term}**${t.vi && t.vi !== t.term ? ` (${t.vi})` : ''}: ${t.explanation}`));
  sec(SECTION_TITLES.takeaways, n.takeaways.map(it));
  sec(SECTION_TITLES.checklist, n.checklist.map((x) => `- [ ] ${x}`));
  if (r.kind === 'video') sec(SECTION_TITLES.moments, n.moments.filter((m) => stamps(m.refs, st)).map((m) => `-${stamps(m.refs, st)} ${m.text}`));
  out.push(`---`, `_Tạo bởi ${r.provider}${r.model ? ' / ' + r.model : ''} · ${new Date(r.createdAt).toISOString().slice(0, 10)}_`);
  return out.join('\n') + '\n';
}

/** Plain text: Markdown markers removed. */
export function notesToText(r: NotesRecord): string {
  return notesToMarkdown(r)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^_(.*)_$/gm, '$1')
    .replace(/^> /gm, '')
    .replace(/^- \[ \] /gm, '☐ ')
    .replace(/^---$/gm, '');
}
