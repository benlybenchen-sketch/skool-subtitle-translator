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
  /** User-requested: complete English captions from the player's public caption playlist. */
  acquireFull?(): Promise<void>;
}

/** AI notes hooks (Milestone 3B); the panel renders whatever the notes view returns. */
export interface NotesView {
  render(container: HTMLElement, t: Transcript | null, seek: ((sec: number) => void) | null): void;
}

/** Offline study actions (local only). */
export interface OfflineActions {
  save(t: Transcript): Promise<string>;
  zip(t: Transcript): Promise<string>;
  openReader(): void;
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
    private readonly offline: OfflineActions | null = null,
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
    if (!t || t.coverage.state === 'none') {
      const box = this.el('div', { className: 'warn', textContent: 'Chưa có bản ghi: phụ đề của bài này chưa truy cập được.' });
      if (t?.coverage.note) box.append(this.el('div', { className: 'muted', textContent: t.coverage.note }));
      return box;
    }
    const c = t.coverage;
    const box = this.el('div', {});
    if (t.kind === 'video') {
      // Coverage by real timestamps vs the video duration (never "100 %" for the first minutes only).
      const pct = c.durationSec ? Math.min(100, Math.round((c.sourceUntilSec / c.durationSec) * 100)) : null;
      const en = c.state === 'complete' ? `Tiếng Anh: đầy đủ (${c.segments} câu${c.sourceLabel ? ` · ${c.sourceLabel}` : ''})` : `Tiếng Anh: MỘT PHẦN — có đến ${fmtClock(c.sourceUntilSec)}${c.durationSec ? ` / ${fmtClock(c.durationSec)} (≈${pct}% thời lượng)` : ''}${c.sourceLabel ? ` · ${c.sourceLabel}` : ''}`;
      box.append(this.el('div', { className: c.state === 'complete' ? 'muted' : 'warn', textContent: en }));
    } else box.append(this.el('div', { className: 'muted', textContent: `Bài viết: ${c.segments} đoạn` }));
    const viDone = c.translated >= c.segments && c.state === 'complete';
    box.append(
      this.el('div', {
        className: viDone ? 'muted' : 'warn',
        textContent: viDone ? `Tiếng Việt: hoàn tất (${c.translated}/${c.segments})` : `Tiếng Việt: đang dịch ${c.translated}/${c.segments}${c.state !== 'complete' ? ' (của phần đã có)' : ''}${c.failed ? ` · ${c.failed} lỗi` : ''}`,
      }),
    );
    if (c.note) box.append(this.el('div', { className: 'muted', textContent: c.note }));
    return box;
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
    const actions = this.el('div', { className: 'bar' });
    if (t && t.kind === 'video' && t.coverage.state !== 'complete' && this.source.acquireFull)
      actions.append(
        this.el('button', {
          className: 'b',
          textContent: 'Tải toàn bộ phụ đề từ trình phát',
          title: 'Chỉ dùng playlist phụ đề công khai mà trình phát dùng (không dùng liên kết có chữ ký). Thời gian được kiểm tra khớp với trình phát trước khi dùng.',
          onclick: async () => {
            await this.source.acquireFull!();
            this.shownVersion = '';
            this.render();
          },
        }),
      );
    if (t && t.coverage.translated < t.coverage.segments && this.source.completeTranslations)
      actions.append(
        this.el('button', {
          className: 'b',
          textContent: 'Dịch toàn bộ ngay',
          title: 'Mặc định: dịch phần sắp phát trước rồi dịch phần còn lại ở nền. Nút này dịch toàn bộ bản ghi hiện có ngay (dùng cache, không gửi lại câu đã dịch).',
          onclick: () => void this.source.completeTranslations!(() => this.refresh()).then(() => this.render()),
        }),
      );
    body.append(this.coverageLine(t), actions, this.el('div', { className: 'bar' }, langBtn('vi', 'VI'), langBtn('bi', 'EN+VI'), langBtn('en', 'EN'), copyAll), this.el('div', { className: 'bar' }, search), list);
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
    if (this.offline && t && t.segments.length) {
      const off = this.offline;
      const omsg = this.el('div', { className: 'muted' });
      const run = (fn: () => Promise<string>) => () => void fn().then((m) => (omsg.textContent = m)).catch((e: Error) => (omsg.textContent = `Lỗi: ${e.message}`));
      body.append(
        this.el('h3', { textContent: 'Học offline' }),
        this.el('div', { className: 'muted', textContent: 'Lưu bản ghi Anh/Việt, ghi chú AI và thuật ngữ của bài này trên máy (không tải video, không gửi đi đâu).' }),
        this.el(
          'div',
          { className: 'bar' },
          this.el('button', { className: 'b primary', textContent: '💾 Lưu để học offline', onclick: run(() => off.save(this.source.transcript() ?? t)) }),
          this.el('button', { className: 'b', textContent: '⬇ Gói ZIP', onclick: run(() => off.zip(this.source.transcript() ?? t)) }),
          this.el('button', { className: 'b', textContent: '📚 Thư viện offline', onclick: () => off.openReader() }),
        ),
        omsg,
      );
    }
  }
}
