import { sendToBackground } from '../shared/messages';
import type { LessonRecord, LessonSummary } from '../transcript/store';
import { fmtClock } from '../transcript/model';
import { recordToTranscript } from '../offline/studyPack';
import { toVtt } from '../transcript/export';
import { base64ToUint8 } from '../shared/util';

/** Offline reader: everything comes from the extension's local store (works without network). */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

function fileInput(onchange: (e: Event) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = 'video/*';
  i.addEventListener('change', onchange);
  return i;
}

// ---- authorized video download (5C) ------------------------------------------------------------
interface Offer {
  lessonId: string;
  title: string;
  options: { url: string; filename: string; label: string; source: 'owner-link' | 'native-file' }[];
}

async function showDownload(lessonId: string): Promise<void> {
  const { offer } = await sendToBackground<{ offer: Offer | null }>({ type: 'video:offer:get', lessonId });
  const card = $('dl-card');
  if (!offer) return;
  card.classList.remove('hidden');
  const msg = el('div', { className: 'hint' });
  const progress = el('div', { className: 'hint' });
  const start = async (o: Offer['options'][number]) => {
    // permission asked only now, on this click; the user picks the destination (save dialog)
    const ok = await chrome.permissions.request({ permissions: ['downloads'] }).catch(() => false);
    if (!ok || !chrome.downloads) return void (msg.textContent = 'Chưa được cấp quyền quản lý tải xuống — không tải.');
    let id: number;
    try {
      id = await chrome.downloads.download({ url: o.url, filename: o.filename, saveAs: true, conflictAction: 'uniquify' });
    } catch (e) {
      return void (msg.textContent = `Không bắt đầu tải được: ${(e as Error).message}`);
    }
    msg.textContent = 'Đang tải…';
    const tick = async () => {
      const [d] = await chrome.downloads.search({ id });
      if (!d) return;
      const mb = (b: number) => (b / 1048576).toFixed(1);
      progress.textContent = `${d.state === 'complete' ? 'Hoàn tất' : d.state === 'interrupted' ? `Bị gián đoạn (${d.error ?? 'lỗi'})` : 'Đang tải'} · ${mb(d.bytesReceived)}${d.totalBytes > 0 ? ` / ${mb(d.totalBytes)}` : ''} MB`;
      if (d.state === 'complete') {
        await sendToBackground({
          type: 'lesson:put',
          record: { lessonId: offer.lessonId, title: offer.title, video: { filename: d.filename.split(/[\\/]/).pop() ?? o.filename, downloadId: id, sizeBytes: d.fileSize || d.totalBytes, savedAt: Date.now(), sourceLabel: o.source === 'owner-link' ? 'tệp do khóa học cung cấp' : 'tệp video của trình phát (trình duyệt cho phép tải)' } },
        });
        msg.textContent = 'Đã lưu video trên máy. Mở bài trong thư viện và chọn tệp để xem kèm phụ đề tiếng Việt.';
        full.delete(offer.lessonId);
        await refresh();
        return;
      }
      if (d.state === 'interrupted') {
        // Chrome keeps partial data only as an incomplete download; never presented as a finished file
        if (d.canResume) card.append(el('button', { textContent: 'Tiếp tục tải', onclick: () => void chrome.downloads.resume(id).then(() => setTimeout(tick, 500)) }));
        return;
      }
      setTimeout(tick, 700);
    };
    void tick();
  };
  card.replaceChildren(
    el('h2', { textContent: `🎬 Tải video: ${offer.title}` }),
    el('div', { className: 'hint', textContent: 'Chỉ các tệp mà bài học/trình phát cho phép tải. Bạn chọn thư mục lưu. Tiện ích không tự tải và không giữ bản sao video.' }),
    ...offer.options.map((o) =>
      el('div', { className: 'row' }, el('button', { className: 'primary', textContent: 'Tải xuống', onclick: () => void start(o) }), el('span', { textContent: `${o.label} — ${o.filename}` }), el('span', { className: 'badge', textContent: o.source === 'owner-link' ? 'khóa học cung cấp' : 'tệp của trình phát' })),
    ),
    msg,
    progress,
  );
}

let lessons: LessonSummary[] = [];
const full = new Map<string, LessonRecord>();
const hash = decodeURIComponent(location.hash.slice(1));
let current: string | null = hash.startsWith('dl=') ? hash.slice(3) : hash || null;
let lang: 'vi' | 'bi' | 'en' = 'bi';
let videoUrl: string | null = null;

async function getRecord(id: string): Promise<LessonRecord | null> {
  if (!full.has(id)) {
    const r = await sendToBackground<{ record: LessonRecord | null }>({ type: 'lesson:get', lessonId: id });
    if (r.record) full.set(id, r.record);
  }
  return full.get(id) ?? null;
}

async function refresh(): Promise<void> {
  const [l, u] = await Promise.all([
    sendToBackground<{ lessons: LessonSummary[] }>({ type: 'lesson:list' }),
    sendToBackground<{ usage: number | null; quota: number | null; lessons: number }>({ type: 'lesson:usage' }),
  ]);
  lessons = l.lessons;
  const mb = (b: number | null) => (b === null ? '?' : `${(b / 1048576).toFixed(1)} MB`);
  $('usage').textContent = `${u.lessons} bài · dung lượng tiện ích đang dùng ${mb(u.usage)}${u.quota ? ` / ${mb(u.quota)}` : ''}`;
  await renderList();
  if (current) await renderView(current);
}

function status(r: Pick<LessonSummary, 'complete' | 'translated' | 'kind'> & { units: number }): string {
  return `${r.complete ? 'EN đầy đủ' : 'EN MỘT PHẦN'} · VI ${r.translated}/${r.units}`;
}

async function renderList(): Promise<void> {
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const only = $<HTMLInputElement>('only-offline').checked;
  let list = lessons.filter((l) => !only || l.savedOffline);
  if (q) {
    const hits: LessonSummary[] = [];
    for (const l of list) {
      const r = await getRecord(l.lessonId);
      const text = r ? [r.title, ...r.units.map((u) => `${u.en} ${u.vi ?? ''}`), r.notesMarkdown ?? ''].join(' ').toLowerCase() : l.title.toLowerCase();
      if (text.includes(q)) hits.push(l);
    }
    list = hits;
  }
  $('items').replaceChildren(
    ...(list.length
      ? list.map((l) =>
          el(
            'button',
            { className: 'item' + (l.lessonId === current ? ' on' : ''), onclick: () => void select(l.lessonId) },
            el('b', { textContent: l.title || '(không tên)' }),
            l.savedOffline ? el('span', { className: 'badge', textContent: 'offline' }) : el('span', { className: 'badge', textContent: 'tự lưu' }),
            l.video ? el('span', { className: 'badge', textContent: '🎬 video' }) : '',
            el('div', { className: 'hint', textContent: `${status(l)} · ${new Date(l.updatedAt).toLocaleDateString('vi-VN')}` }),
          ),
        )
      : [el('p', { className: 'hint', textContent: only ? 'Chưa có bài nào được lưu offline. Trên Skool: nút VI → Bài học → Xuất → "💾 Lưu để học offline".' : 'Không có bài nào.' })]),
  );
}

async function select(id: string): Promise<void> {
  current = id;
  location.hash = encodeURIComponent(id);
  await renderList();
  await renderView(id);
}

async function renderView(id: string): Promise<void> {
  const r = await getRecord(id);
  const view = $('view');
  if (!r) return void view.replaceChildren(el('p', { className: 'hint', textContent: 'Bài này không còn trên máy.' }));
  const t = recordToTranscript(r);
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const langBtn = (l: typeof lang, label: string) => el('button', { className: lang === l ? 'primary' : '', textContent: label, onclick: () => ((lang = l), void renderView(id)) });
  const rows = t.segments
    .filter((s) => !q || `${s.en} ${s.vi ?? ''}`.toLowerCase().includes(q))
    .map((s) =>
      el(
        'div',
        { className: 'r' },
        el('span', { className: 't', textContent: t.kind === 'video' ? fmtClock(s.start) : '' }),
        el('div', {}, ...(lang !== 'en' ? [el('div', { textContent: s.vi ?? '(chưa dịch)' })] : []), ...(lang !== 'vi' ? [el('div', { className: lang === 'bi' ? 'en' : '', textContent: s.en })] : [])),
      ),
    );
  const video = r.video
    ? el(
        'div',
        {},
        el('h2', { textContent: '🎬 Video đã tải (tệp trên máy)' }),
        el('div', { className: 'hint', textContent: `${r.video.filename} · ${r.video.sourceLabel}. Chọn đúng tệp này để xem offline kèm phụ đề tiếng Việt (tệp nằm trong thư mục Tải xuống của bạn, tiện ích không giữ bản sao).` }),
        fileInput((e: Event) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            if (videoUrl) URL.revokeObjectURL(videoUrl);
            videoUrl = URL.createObjectURL(f);
            const v = el('video', { controls: true, src: videoUrl });
            const vtt = URL.createObjectURL(new Blob([toVtt(t, lang === 'en' ? 'en' : lang === 'bi' ? 'bi' : 'vi')], { type: 'text/vtt' }));
            v.append(el('track', { kind: 'subtitles', srclang: 'vi', label: 'Tiếng Việt', src: vtt, default: true }));
            (e.target as HTMLElement).after(v);
        }),
      )
    : el('div', { className: 'hint', textContent: 'Video không có sẵn offline (chỉ bản ghi và ghi chú được lưu). Chỉ video có nguồn tải được phép mới tải về được.' });
  view.replaceChildren(
    el('div', { className: 'head' }, el('h2', { textContent: r.title || '(không tên)' }), el('span', { className: 'hint', textContent: status({ ...r, units: r.units.length }) })),
    !r.complete ? el('div', { className: 'warn', textContent: 'Bản ghi tiếng Anh MỘT PHẦN — chỉ gồm phần đã truy cập được khi lưu.' }) : '',
    el(
      'div',
      { className: 'row' },
      langBtn('vi', 'Tiếng Việt'),
      langBtn('bi', 'Song ngữ'),
      langBtn('en', 'English'),
      el('button', {
        textContent: '⬇ Gói ZIP',
        onclick: async () => {
          const p = await sendToBackground<{ name: string; base64: string }>({ type: 'lesson:pack', lessonId: id });
          const url = URL.createObjectURL(new Blob([base64ToUint8(p.base64) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
          el('a', { href: url, download: p.name }).click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        },
      }),
      el('button', {
        className: 'danger',
        textContent: 'Xóa bài này',
        onclick: async () => {
          if (!confirm(`Xóa "${r.title}" khỏi máy?`)) return;
          await sendToBackground({ type: 'lesson:delete', lessonId: id });
          full.delete(id);
          current = null;
          location.hash = '';
          $('view').replaceChildren(el('p', { className: 'hint', textContent: 'Đã xóa.' }));
          await refresh();
        },
      }),
    ),
    video,
    r.notesMarkdown ? el('details', {}, el('summary', { textContent: '🧠 Ghi chú AI' }), el('div', { className: 'notes', textContent: r.notesMarkdown })) : el('p', { className: 'hint', textContent: 'Chưa có ghi chú AI cho bài này.' }),
    el('h2', { textContent: `Bản ghi (${rows.length}${q ? ' kết quả' : ' đoạn'})` }),
    el('div', { className: 'rows' }, ...rows),
  );
}

$('q').addEventListener('input', () =>
  void renderList().then(() => {
    if (current) void renderView(current);
  }),
);
$('only-offline').addEventListener('change', () => void renderList());
$('clear-auto').addEventListener('click', async () => {
  if (!confirm('Xóa mọi bản ghi tự lưu (giữ lại các bài đã lưu offline)?')) return;
  await sendToBackground({ type: 'lesson:clear', includeOffline: false });
  full.clear();
  await refresh();
});
void refresh();
if (hash.startsWith('dl=')) void showDownload(hash.slice(3));
