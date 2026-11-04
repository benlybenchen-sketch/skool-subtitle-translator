import type { Transcript, TranscriptSegment } from '../transcript/model';
import { fmtClock, searchSegments } from '../transcript/model';
import { downloadText, exportTranscript, type ExportFormat, type ExportLang } from '../transcript/export';
import { addFullscreenListener, apiFullscreenElement } from '../overlay/fullscreen';

/** What the panel needs from the active lesson (video controller or text-lesson translator). */
export interface LearningSource {
  kind(): 'video' | 'text' | 'none';
  transcript(): Transcript | null;
  seek?(sec: number): void;
  onActive?(cb: (id: string | null) => void): () => void;
  completeTranslations?(onProgress: (done: number, total: number) => void): Promise<{ done: number; total: number }>;
  /** Refresh data held elsewhere (player iframe) before the first render. */
  prefetch?(): Promise<void>;
}

/** AI notes hooks (Milestone 3B); the panel renders whatever the notes view returns. */
export interface NotesView {
  render(container: HTMLElement, t: Transcript | null, seek: ((sec: number) => void) | null): void;
}

export type PanelTab = 'transcript' | 'notes' | 'export';
type ViewLang = 'en' | 'vi' | 'bi';

const CSS = `
:host { all: initial; }
.drawer { position: fixed; top: 64px; right: 12px; bottom: 12px; width: min(400px, calc(100vw - 24px)); z-index: 2147483644;
  display: flex; flex-direction: column; background: #fff; color: #1f2328; border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.3);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
.hidden { display: none !important; }
header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #d0d7de; }
header b { flex: 1; font-size: 14px; }
.tabs { display: flex; gap: 4px; padding: 6px 10px 0; }
.tab { border: 0; background: none; padding: 6px 8px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; color: inherit; }
.tab.on { border-color: #1f6feb; font-weight: 600; }
.body { flex: 1; overflow: auto; padding: 8px 10px; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; }
.bar input[type=search] { flex: 1 1 140px; padding: 5px 7px; border: 1px solid #d0d7de; border-radius: 6px; font: inherit; }
button.b, select { border: 1px solid #d0d7de; background: #f6f8fa; color: inherit; border-radius: 6px; padding: 4px 8px; cursor: pointer; font: inherit; }
button.b.on { background: #1f6feb; border-color: #1f6feb; color: #fff; }
button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.muted { color: #59636e; font-size: 12px; }
.warn { color: #9a6700; font-size: 12px; } .err { color: #b42318; font-size: 12px; }
.row { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; padding: 5px 4px; border-radius: 6px; align-items: start; }
.row.active { background: #ddf4ff; }
.row .t { border: 0; background: none; color: #0969da; cursor: pointer; font: 12px/1.6 ui-monospace, monospace; padding: 0; }
.row .t[disabled] { color: #59636e; cursor: default; }
.row .vi { font-weight: 500; } .row .en { color: #59636e; } .row .pending { font-style: italic; color: #8c959f; }
.row .c { opacity: .45; border: 0; background: none; cursor: pointer; }
.row:hover .c { opacity: 1; }
.notes h3 { font-size: 14px; margin: 12px 0 4px; } .notes li { margin: 3px 0; }
.notes .ref { border: 0; background: #ddf4ff; color: #0969da; border-radius: 4px; padding: 0 4px; margin-left: 4px; cursor: pointer; font: 11px ui-monospace, monospace; }
.notes .edited { white-space: pre-wrap; }
textarea.edit { width: 100%; min-height: 320px; font: 12px/1.5 ui-monospace, monospace; box-sizing: border-box; }
@media (prefers-color-scheme: dark) {
  .drawer { background: #161b22; color: #e6edf3; } header { border-color: #3d444d; }
  button.b, select, .bar input[type=search] { background: #21262d; border-color: #3d444d; color: #e6edf3; }
  .row.active { background: #0c2d6b; } .muted, .row .en { color: #9198a1; } .notes .ref { background: #0c2d6b; color: #79c0ff; }
}`;

export class LearningPanel {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private open = false;
  private tab: PanelTab = 'transcript';
  private lang: ViewLang = 'bi';
  private query = '';
  private shownVersion = '';
  private activeId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private offActive: (() => void) | null = null;
  private readonly offFs: () => void;
  private busy = '';

  constructor(
    private readonly doc: Document,
    private source: LearningSource,
    private readonly notes: NotesView | null = null,
  ) {
    this.host = doc.createElement('div');
    this.host.setAttribute('data-sst-learning', '');
    this.root = this.host.attachShadow({ mode: 'open' });
    this.offFs = addFullscreenListener(doc, () => this.place());
  }

  setSource(source: LearningSource): void {
    this.source = source;
    this.shownVersion = '';
    this.bindActive();
    if (this.open) this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(tab?: PanelTab): void {
    this.open = true;
    if (tab) this.tab = tab;
    if (this.source.kind() === 'text' && this.tab === 'transcript') this.tab = 'notes';
    this.place();
    this.bindActive();
    this.shownVersion = '';
    this.render();
    void this.source.prefetch?.().then(() => this.refresh());
    clearInterval(this.refreshTimer);
    // Light refresh while open (new cues / translations); stops when closed.
    this.refreshTimer = setInterval(() => this.refresh(), 2000);
  }

  hide(): void {
    this.open = false;
    clearInterval(this.refreshTimer);
    this.offActive?.();
    this.offActive = null;
    this.host.remove();
  }

  toggle(tab?: PanelTab): void {
    if (this.open && (!tab || tab === this.tab)) this.hide();
    else this.show(tab);
  }

  destroy(): void {
    this.hide();
    this.offFs();
  }

  private place(): void {
    if (!this.open) return;
    const fs = apiFullscreenElement(this.doc);
    const parent = fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME' ? fs : this.doc.body ?? this.doc.documentElement;
    if (this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  private bindActive(): void {
    this.offActive?.();
    this.offActive = this.source.onActive?.((id) => this.highlight(id)) ?? null;
  }

  private refresh(): void {
    const t = this.source.transcript();
    if ((t?.version ?? '') !== this.shownVersion && this.tab !== 'notes') this.render();
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
    const e = Object.assign(this.doc.createElement(tag), props);
    e.append(...kids);
    return e;
  }

  render(): void {
    if (!this.open) return;
    const kind = this.source.kind();
    const t = this.source.transcript();
    this.shownVersion = t?.version ?? '';
    const tabs: [PanelTab, string][] = kind === 'text' ? [['notes', '🧠 Ghi chú AI'], ['export', 'Xuất']] : [['transcript', 'Bản ghi'], ['notes', '🧠 Ghi chú AI'], ['export', 'Xuất']];
    const header = this.el('header', {}, this.el('b', {}, kind === 'text' ? 'Bài viết' : 'Bài học'), this.el('button', { className: 'b', textContent: '×', title: 'Đóng', onclick: () => this.hide() }));
    const tabBar = this.el('div', { className: 'tabs' }, ...tabs.map(([k, label]) => this.el('button', { className: 'tab' + (k === this.tab ? ' on' : ''), textContent: label, onclick: () => { this.tab = k; this.render(); } })));
    const body = this.el('div', { className: 'body' });
    if (this.tab === 'transcript') this.renderTranscript(body, t);
    else if (this.tab === 'export') this.renderExport(body, t);
    else if (this.notes) this.notes.render(body, t, this.source.seek ? (s) => this.source.seek!(s) : null);
    else body.append(this.el('div', { className: 'muted', textContent: 'Chưa hỗ trợ.' }));
    const style = this.el('style', { textContent: CSS });
    this.root.replaceChildren(style, this.el('div', { className: 'drawer' }, header, tabBar, body));
  }

  private coverageLine(t: Transcript | null): HTMLElement {
    if (!t || t.coverage.state === 'none') return this.el('div', { className: 'warn', textContent: 'Không có phụ đề/nội dung truy cập được cho bài này.' });
    const c = t.coverage;
    const span = t.kind === 'video' ? ` · có đến ${fmtClock(c.sourceUntilSec)}${c.durationSec ? ` / ${fmtClock(c.durationSec)}` : ''}` : '';
    const state = c.state === 'complete' ? 'Đầy đủ' : 'MỘT PHẦN (partial)';
    return this.el('div', { className: c.state === 'complete' ? 'muted' : 'warn', textContent: `${state}${span} · đã dịch ${c.translated}/${c.segments}${c.failed ? ` · ${c.failed} lỗi` : ''}` });
  }

  private renderTranscript(body: HTMLElement, t: Transcript | null): void {
    const langBtn = (l: ViewLang, label: string) => this.el('button', { className: 'b' + (this.lang === l ? ' on' : ''), textContent: label, onclick: () => { this.lang = l; this.render(); } });
    const search = this.el('input', { type: 'search', placeholder: 'Tìm từ khóa…', value: this.query });
    search.addEventListener('input', () => {
      this.query = search.value;
      this.fillRows(list, t);
    });
    const copyAll = this.el('button', { className: 'b', textContent: 'Sao chép tất cả', onclick: () => void navigator.clipboard.writeText(this.plain(t?.segments ?? [])) });
    const list = this.el('div', {});
    body.append(this.coverageLine(t), this.el('div', { className: 'bar' }, langBtn('vi', 'VI'), langBtn('bi', 'EN+VI'), langBtn('en', 'EN'), copyAll), this.el('div', { className: 'bar' }, search), list);
    this.fillRows(list, t);
  }

  private segText(s: TranscriptSegment): Node[] {
    const out: Node[] = [];
    if (this.lang !== 'en') out.push(s.vi ? this.el('div', { className: 'vi', textContent: s.vi }) : this.el('div', { className: 'pending', textContent: '(chưa dịch)' }));
    if (this.lang !== 'vi') out.push(this.el('div', { className: this.lang === 'en' ? '' : 'en', textContent: s.en }));
    return out;
  }

  private plain(segs: TranscriptSegment[]): string {
    return segs.map((s) => `[${fmtClock(s.start)}] ${this.lang === 'en' ? s.en : this.lang === 'vi' ? s.vi ?? '' : `${s.en}\n${s.vi ?? ''}`}`).join('\n');
  }

  private fillRows(list: HTMLElement, t: Transcript | null): void {
    const segs = searchSegments(t?.segments ?? [], this.query);
    list.replaceChildren(
      ...segs.map((s) => {
        const time = this.el('button', { className: 't', textContent: fmtClock(s.start), title: 'Tua tới đây', disabled: !this.source.seek, onclick: () => this.source.seek?.(s.start) });
        const copy = this.el('button', { className: 'c', textContent: '⧉', title: 'Sao chép', onclick: () => void navigator.clipboard.writeText(this.plain([s])) });
        const row = this.el('div', { className: 'row' + (s.id === this.activeId ? ' active' : '') }, time, this.el('div', {}, ...this.segText(s)), copy);
        row.dataset.id = s.id;
        return row;
      }),
    );
  }

  private highlight(id: string | null): void {
    this.activeId = id;
    if (!this.open || this.tab !== 'transcript') return;
    for (const r of this.root.querySelectorAll<HTMLElement>('.row')) {
      const on = r.dataset.id === id;
      r.classList.toggle('active', on);
      if (on && !this.query) r.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderExport(body: HTMLElement, t: Transcript | null): void {
    const isVideo = t?.kind === 'video';
    const fmt = this.el('select', {});
    for (const [v, l] of (isVideo ? [['srt', 'SRT'], ['vtt', 'VTT'], ['txt', 'TXT'], ['md', 'Markdown']] : [['txt', 'TXT'], ['md', 'Markdown']]) as [ExportFormat, string][]) fmt.add(new Option(l, v));
    const lang = this.el('select', {});
    for (const [v, l] of [['vi', 'Tiếng Việt'], ['bi', 'Song ngữ'], ['en', 'English']] as [ExportLang, string][]) lang.add(new Option(l, v));
    const msg = this.el('div', { className: 'muted' });
    const missing = t ? t.coverage.segments - t.coverage.translated : 0;
    const doExport = () => {
      const cur = this.source.transcript();
      if (!cur) return;
      try {
        const f = exportTranscript(cur, fmt.value as ExportFormat, lang.value as ExportLang);
        downloadText(this.doc, f.name, f.mime, f.content);
        msg.textContent = `Đã tải xuống ${f.name}`;
      } catch (e) {
        msg.textContent = (e as Error).message;
      }
    };
    const exportNow = this.el('button', { className: 'b primary', textContent: 'Xuất phần có sẵn', onclick: doExport });
    const complete = this.el('button', {
      className: 'b',
      textContent: 'Dịch nốt phần còn thiếu rồi xuất',
      disabled: !missing || !this.source.completeTranslations || !!this.busy,
      onclick: async () => {
        this.busy = 'complete';
        complete.disabled = true;
        const r = await this.source.completeTranslations!((d, n) => (msg.textContent = `Đang dịch… ${d}/${n}`));
        this.busy = '';
        msg.textContent = `Đã dịch ${r.done}/${r.total}.`;
        doExport();
      },
    });
    body.append(
      this.coverageLine(t),
      t && t.coverage.state !== 'complete' ? this.el('div', { className: 'warn', textContent: 'Bản xuất sẽ được đánh dấu PARTIAL (tên tệp có "-PARTIAL") vì chỉ gồm phần nội dung truy cập được.' }) : '',
      missing ? this.el('div', { className: 'muted', textContent: `${missing} đoạn chưa dịch: bản tiếng Việt sẽ bỏ qua chúng, bản song ngữ chỉ có tiếng Anh ở các đoạn đó.` }) : '',
      this.el('div', { className: 'bar' }, fmt, lang),
      this.el('div', { className: 'bar' }, exportNow, isVideo ? complete : ''),
      msg,
      isVideo ? '' : this.el('div', { className: 'muted', textContent: 'Bài viết không có mốc thời gian nên không có SRT/VTT.' }),
    );
  }
}
