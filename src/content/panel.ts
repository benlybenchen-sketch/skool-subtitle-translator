import type { Settings, TabStatus } from '../shared/types';
import { adapterById } from '../players/adapters';
import { addFullscreenListener, apiFullscreenElement } from '../overlay/fullscreen';

const CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483645;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; }
.pill { display: flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
  background: #1f6feb; color: #fff; border-radius: 999px; padding: 7px 12px; font: 600 12px/1 system-ui, sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #9be9a8; }
.pill.off .dot { background: #bbb; } .pill.rec .dot { background: #ff6b6b; }
.card { width: 260px; background: #fff; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.28); padding: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
.title { font-weight: 700; } .muted { color: #59636e; font-size: 12px; }
.err { color: #b42318; font-size: 12px; margin-top: 6px; }
button.b { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 4px 8px; cursor: pointer; font: inherit; }
button.b.on { background: #1f6feb; color: #fff; border-color: #1f6feb; }
button.x { border: 0; background: none; cursor: pointer; font-size: 16px; color: #59636e; }
@media (prefers-color-scheme: dark) {
  .card { background: #161b22; color: #e6edf3; } .muted { color: #9198a1; }
  button.b { background: #21262d; border-color: #3d444d; color: #e6edf3; } .err { color: #ff8182; }
}`;

/** Compact, collapsible control panel injected into the Skool page (top frame only). */
export class ControlPanel {
  private readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private collapsed = true;
  private settings: Settings;
  private status: TabStatus | null = null;
  private wanted = false;
  /** Container the subtitle overlay currently lives in (followed for CSS pseudo-fullscreen). */
  private followed: Element | null = null;
  private readonly offFs: () => void;

  constructor(
    private readonly doc: Document,
    settings: Settings,
    private readonly update: (patch: Partial<Settings>) => void,
    private readonly stopAudio: () => void,
    private readonly startSession: () => void = () => undefined,
  ) {
    this.settings = settings;
    this.host = doc.createElement('div');
    this.host.setAttribute('data-sst-panel', '');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.render();
    this.offFs = addFullscreenListener(doc, () => this.place());
  }

  /** Same container rule as the subtitle overlay: inside the fullscreen element, else <body>. */
  private parent(): Element {
    const body = this.doc.body ?? this.doc.documentElement;
    const fs = apiFullscreenElement(this.doc);
    if (fs) return fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME' ? body : fs;
    return this.followed?.isConnected ? this.followed : body;
  }

  private place(): void {
    if (!this.wanted) return;
    const p = this.parent();
    if (this.host.parentElement !== p) p.appendChild(this.host);
  }

  /** Called when the subtitle overlay changes container (covers custom fullscreen without the API). */
  follow(container: Element): void {
    this.followed = container === this.doc.body ? null : container;
    this.place();
  }

  mount(): void {
    this.wanted = true;
    this.place();
  }

  unmount(): void {
    this.wanted = false;
    this.host.remove();
  }

  destroy(): void {
    this.unmount();
    this.offFs();
  }

  setSettings(s: Settings): void {
    this.settings = s;
    this.render();
  }

  setStatus(s: TabStatus): void {
    this.status = s;
    this.render();
  }

  private summary(): { line: string; error?: string } {
    const st = this.status;
    if (!st) return { line: 'Đang tìm video…' };
    const frames = st.frames;
    const withVideo = frames.filter((f) => f.targetKind);
    if (!withVideo.length) {
      if (st.audio.active) return { line: 'Audio Mode đang chạy (phụ đề hiển thị ở mức trang)', error: st.audio.error };
      return { line: 'Không truy cập được phần tử video. Có thể bật Audio Mode từ biểu tượng tiện ích.', error: st.audio.error };
    }
    const best = frames.find((f) => f.frameId === st.primaryFrameId) ?? withVideo[0];
    const err = st.audio.error ?? frames.find((f) => f.error)?.error;
    if (st.audio.active) return { line: 'Audio Mode đang chạy', error: err };
    const captioned = frames.find((f) => f.captionState === 'available' && f.captionSource);
    if (captioned) {
      return {
        line: `Phụ đề: ${captioned.unitsTranslated}/${captioned.unitsTotal} đoạn đã dịch${captioned.provider ? ` · ${adapterById(captioned.provider).label}` : ''}`,
        error: err,
      };
    }
    if (frames.some((f) => f.captionState === 'searching')) return { line: 'Đang kiểm tra phụ đề…', error: err };
    return { line: `Không có phụ đề truy cập được (${best.provider ? adapterById(best.provider).label : 'video'}). Dùng Audio Mode từ biểu tượng tiện ích.`, error: err };
  }

  private render(): void {
    const s = this.settings;
    const rec = !!this.status?.audio.active;
    const { line, error } = this.summary();
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    this.shadow.innerHTML = `<style>${CSS}</style><div class="wrap">${
      this.collapsed
        ? `<button class="pill ${s.enabled ? '' : 'off'} ${rec ? 'rec' : ''}" data-a="open" title="Phụ đề tiếng Việt"><span class="dot"></span>VI ${rec ? '• REC' : ''}</button>`
        : `<div class="card" role="dialog" aria-label="Phụ đề tiếng Việt">
          <div class="row"><span class="title">Phụ đề tiếng Việt</span><button class="x" data-a="close" aria-label="Thu gọn">×</button></div>
          <div class="muted">${esc(line)}</div>
          ${error ? `<div class="err">${esc(error)}</div>` : ''}
          <div class="row"><span>Dịch</span><button class="b ${s.enabled ? 'on' : ''}" data-a="toggle">${s.enabled ? 'BẬT' : 'TẮT'}</button></div>
          <div class="row"><span>Hiển thị</span><span>
            <button class="b ${s.displayMode === 'vi' ? 'on' : ''}" data-a="vi">VI</button>
            <button class="b ${s.displayMode === 'bilingual' ? 'on' : ''}" data-a="bi">EN+VI</button></span></div>
          <div class="row"><span>Cỡ chữ</span><span>
            <button class="b" data-a="smaller" aria-label="Nhỏ hơn">A−</button>
            <button class="b" data-a="bigger" aria-label="Lớn hơn">A+</button></span></div>
          ${rec ? `<div class="row"><span>Audio Mode</span><button class="b" data-a="stop">Dừng ghi</button></div>` : ''}
          ${this.status?.frames.some((f) => f.mode === 'paused') ? `<div class="row"><span>Bài học này</span><button class="b on" data-a="start">Bắt đầu dịch</button></div>` : ''}
          ${this.status?.frames.some((f) => f.captionsOff) && !s.autoEnableCaptions ? `<div class="row"><span class="muted">CC đang tắt</span><button class="b" data-a="autocc" title="Chuyển track tiếng Anh sang chế độ ẩn để đọc phụ đề (không hiện phụ đề Anh gốc)">Tự bật phụ đề tiếng Anh</button></div>` : ''}
        </div>`
    }</div>`;
    this.shadow.querySelectorAll<HTMLElement>('[data-a]').forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.action(el.dataset.a!);
      }),
    );
  }

  private action(a: string): void {
    const s = this.settings;
    switch (a) {
      case 'open':
        this.collapsed = false;
        break;
      case 'close':
        this.collapsed = true;
        break;
      case 'toggle':
        this.update({ enabled: !s.enabled });
        break;
      case 'vi':
        this.update({ displayMode: 'vi' });
        break;
      case 'bi':
        this.update({ displayMode: 'bilingual' });
        break;
      case 'smaller':
        this.update({ fontScale: Math.max(0.6, +(s.fontScale - 0.1).toFixed(2)) });
        break;
      case 'bigger':
        this.update({ fontScale: Math.min(2, +(s.fontScale + 0.1).toFixed(2)) });
        break;
      case 'stop':
        this.stopAudio();
        break;
      case 'start':
        this.startSession();
        break;
      case 'autocc':
        this.update({ autoEnableCaptions: true }); // explicit user opt-in, persisted
        break;
    }
    this.render();
  }
}
