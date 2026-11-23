import type { Transcript } from '../transcript/model';
import { fmtClock } from '../transcript/model';
import { downloadText } from '../transcript/export';
import type { NotesRecord } from '../notes/render';
import { PARTIAL_BANNER, SECTION_TITLES, coverageText, notesToMarkdown, notesToText } from '../notes/render';
import type { NoteItem } from '../notes/schema';
import type { NotesView } from './learningPanel';

/** Background calls used by the notes view (messages in production, fakes in tests). */
export interface NotesApi {
  get(lessonId: string): Promise<{ record: NotesRecord | null; running: boolean }>;
  generate(t: Transcript): Promise<{ record: NotesRecord }>;
  cancel(lessonId: string): Promise<unknown>;
  save(lessonId: string, editedMarkdown: string | null): Promise<{ record: NotesRecord | null }>;
  model(): Promise<{ provider: string; model: string }>;
}

interface LessonState {
  loaded: boolean;
  record: NotesRecord | null;
  running: boolean;
  progress: string;
  error: string;
  editing: boolean;
}

const PROVIDER_LABEL: Record<string, string> = { gemini: 'Google Gemini', openai: 'OpenAI GPT', anthropic: 'Anthropic Claude', local: 'Backend cục bộ', mock: 'Mock' };

export function notesFileName(r: NotesRecord, ext: 'md' | 'txt'): string {
  const base = (r.title || 'skool-lesson').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'skool-lesson';
  return `${base}-ghi-chu-AI${r.coverage.state === 'complete' ? '' : '-PARTIAL'}.${ext}`;
}

/**
 * "🧠 Ghi chú AI" tab. Shows saved notes without any API call; generation happens only when
 * the user presses the button. Rendering uses textContent only (model output is never HTML).
 */
export class AiNotesView implements NotesView {
  private readonly states = new Map<string, LessonState>();
  private container: HTMLElement | null = null;
  private t: Transcript | null = null;
  private seek: ((sec: number) => void) | null = null;
  private model: { provider: string; model: string } | null = null;

  constructor(
    private readonly doc: Document,
    private readonly api: NotesApi,
    private readonly clipboard: (text: string) => Promise<void> = (s) => navigator.clipboard.writeText(s),
  ) {}

  private st(id: string): LessonState {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { loaded: false, record: null, running: false, progress: '', error: '', editing: false }));
    return s;
  }

  onProgress(lessonId: string, done: number, total: number): void {
    const s = this.st(lessonId);
    s.progress = total > 1 ? `phần ${done}/${total}` : '';
    this.rerender();
  }

  private rerender(): void {
    if (this.container?.isConnected) this.render(this.container, this.t, this.seek);
  }

  private load(id: string): void {
    const s = this.st(id);
    s.loaded = true;
    void this.api
      .get(id)
      .then((r) => {
        s.record = r.record;
        s.running ||= r.running;
      })
      .catch((e) => (s.error = (e as Error).message))
      .finally(() => this.rerender());
    if (!this.model) void this.api.model().then((m) => ((this.model = m), this.rerender())).catch(() => undefined);
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = Object.assign(this.doc.createElement(tag), props);
    e.append(...kids);
    return e;
  }

  private btn(text: string, onclick: () => void, cls = 'b', title = ''): HTMLButtonElement {
    return this.el('button', { className: cls, textContent: text, title, onclick: () => onclick() });
  }

  render(container: HTMLElement, t: Transcript | null, seek: ((sec: number) => void) | null): void {
    this.container = container;
    this.t = t;
    this.seek = seek;
    const wrap = this.el('div', { className: 'notes' });
    container.replaceChildren(wrap);
    if (!t || t.coverage.state === 'none' || !t.segments.length) {
      wrap.append(this.el('div', { className: 'warn', textContent: 'Chưa có bản ghi/nội dung truy cập được để tạo ghi chú cho bài này.' }));
      return;
    }
    const s = this.st(t.lessonId);
    if (!s.loaded) this.load(t.lessonId);
    const m = this.model;
    wrap.append(this.el('div', { className: 'muted', textContent: m ? `AI: ${PROVIDER_LABEL[m.provider] ?? m.provider}${m.model && m.model !== 'mock' ? ' · ' + m.model : ''} (theo Cài đặt — không tự đổi)` : '' }));
    if (s.error) wrap.append(this.el('div', { className: 'err', textContent: s.error }));
    if (s.running) {
      wrap.append(this.el('div', { className: 'bar' }, this.el('span', { textContent: `Đang tạo ghi chú AI… ${s.progress}` }), this.btn('Hủy', () => void this.api.cancel(t.lessonId))));
      return;
    }
    const r = s.record;
    if (!r) {
      if (t.coverage.state !== 'complete') wrap.append(this.el('div', { className: 'warn', textContent: `${PARTIAL_BANNER} (${coverageText({ coverage: t.coverage, kind: t.kind, truncated: false })})` }));
      wrap.append(
        this.el('div', { className: 'bar' }, this.btn('🧠 Tạo ghi chú AI', () => this.generate(t), 'b primary')),
        this.el('div', { className: 'muted', textContent: 'Chỉ chạy khi bạn bấm. Gửi bản ghi văn bản của bài này (không phải video/âm thanh) tới nhà cung cấp AI đã cấu hình; ghi chú được lưu trên máy bạn.' }),
      );
      return;
    }
    if (s.editing) {
      const ta = this.el('textarea', { className: 'edit', value: notesToMarkdown(r) });
      wrap.append(
        ta,
        this.el(
          'div',
          { className: 'bar' },
          this.btn('Lưu', () => void this.api.save(r.lessonId, ta.value).then((x) => ((s.record = x.record), (s.editing = false), this.rerender())), 'b primary'),
          this.btn('Hủy', () => ((s.editing = false), this.rerender())),
        ),
      );
      return;
    }
    if (r.coverage.state !== 'complete') wrap.append(this.el('div', { className: 'warn', textContent: `${PARTIAL_BANNER} — ${coverageText(r)}` }));
    if (r.transcriptVersion !== t.version && t.segments.length !== r.coverage.segments)
      wrap.append(this.el('div', { className: 'muted', textContent: `Bản ghi đã thay đổi từ khi tạo ghi chú (ghi chú dùng ${r.coverage.segments} đoạn, hiện có ${t.segments.length}). Bấm "Tạo lại" nếu muốn cập nhật.` }));
    const toast = this.el('span', { className: 'muted' });
    wrap.append(
      this.el(
        'div',
        { className: 'bar' },
        this.btn('Tạo lại', () => this.generate(t), 'b', r.editedMarkdown ? 'Bản bạn đã sửa sẽ được thay bằng bản mới' : ''),
        this.btn('Sao chép', () => void this.clipboard(notesToMarkdown(r)).then(() => (toast.textContent = 'Đã sao chép'))),
        this.btn('⬇ MD', () => downloadText(this.doc, notesFileName(r, 'md'), 'text/markdown', notesToMarkdown(r))),
        this.btn('⬇ TXT', () => downloadText(this.doc, notesFileName(r, 'txt'), 'text/plain', notesToText(r))),
        this.btn('Sửa', () => ((s.editing = true), this.rerender())),
        toast,
      ),
    );
    if (r.editedMarkdown) {
      wrap.append(
        this.el('div', { className: 'muted' }, 'Đang hiển thị bản bạn đã sửa. ', this.btn('Khôi phục bản AI', () => void this.api.save(r.lessonId, null).then((x) => ((s.record = x.record), this.rerender())))),
        this.el('div', { className: 'edited', textContent: r.editedMarkdown }),
      );
      return;
    }
    this.renderNotes(wrap, r);
  }

  private refs(r: NotesRecord, ids: string[]): Node[] {
    if (r.kind !== 'video') return [];
    return ids
      .map((id) => r.refStarts[id])
      .filter((x): x is number => typeof x === 'number')
      .map((sec) => this.el('button', { className: 'ref', textContent: fmtClock(sec), title: this.seek ? 'Tua tới đoạn nguồn' : '', disabled: !this.seek, onclick: () => this.seek?.(sec) }));
  }

  private renderNotes(wrap: HTMLElement, r: NotesRecord): void {
    const n = r.notes;
    const sec = (title: string, items: Node[], ordered = false) => {
      if (!items.length) return;
      wrap.append(this.el('h3', { textContent: title }), this.el(ordered ? 'ol' : 'ul', {}, ...items));
    };
    const li = (x: NoteItem) => this.el('li', {}, x.text, ...this.refs(r, x.refs));
    wrap.append(this.el('h3', { textContent: n.title || r.title }));
    if (n.summary) wrap.append(this.el('h3', { textContent: SECTION_TITLES.summary }), this.el('p', { textContent: n.summary }));
    sec(SECTION_TITLES.objectives, n.objectives.map((x) => this.el('li', { textContent: x })));
    sec(SECTION_TITLES.concepts, n.concepts.map((c) => this.el('li', {}, this.el('b', { textContent: c.term }), `: ${c.explanation}`, ...this.refs(r, c.refs))));
    sec(SECTION_TITLES.insights, n.insights.map(li));
    sec(SECTION_TITLES.steps, n.steps.map(li), true);
    sec(SECTION_TITLES.terminology, n.terminology.map((x) => this.el('li', {}, this.el('b', { textContent: x.term }), x.vi && x.vi !== x.term ? ` (${x.vi})` : '', `: ${x.explanation}`)));
    sec(SECTION_TITLES.takeaways, n.takeaways.map(li));
    sec(SECTION_TITLES.checklist, n.checklist.map((x) => this.el('li', { textContent: '☐ ' + x })));
    if (r.kind === 'video') sec(SECTION_TITLES.moments, n.moments.filter((m) => this.refs(r, m.refs).length).map(li));
    wrap.append(this.el('div', { className: 'muted', textContent: `Tạo bởi ${PROVIDER_LABEL[r.provider] ?? r.provider}${r.model ? ' · ' + r.model : ''} · ${new Date(r.createdAt).toLocaleString('vi-VN')} · ${r.calls} yêu cầu` }));
  }

  private generate(t: Transcript): void {
    const s = this.st(t.lessonId);
    s.running = true;
    s.error = '';
    s.progress = '';
    this.rerender();
    void this.api
      .generate(t)
      .then((x) => (s.record = x.record))
      .catch((e) => {
        const msg = (e as Error).message ?? String(e);
        s.error = /abort/i.test(msg) ? 'Đã hủy tạo ghi chú.' : `Không tạo được ghi chú: ${msg}`;
      })
      .finally(() => {
        s.running = false;
        this.rerender();
      });
  }
}
