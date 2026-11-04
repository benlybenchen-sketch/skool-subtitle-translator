/**
 * Authorized video downloads only. A user's ability to WATCH a lesson is not treated as permission
 * to DOWNLOAD it. Offered only when the page itself offers the file:
 *  1. owner-link   a link in the lesson content to a video file (or with the HTML `download`
 *                  attribute) — material the course owner chose to provide;
 *  2. native-file  a plain https video file (not a stream) in a <video controls> whose owner did not
 *                  set controlsList="nodownload" — the browser itself already offers "Download".
 * Streams (HLS/DASH/MSE blob:), DRM, embedded third-party players and nodownload are never
 * downloaded: no tokens, private APIs or stream reassembly.
 */
export interface DownloadOption {
  url: string;
  filename: string;
  label: string;
  source: 'owner-link' | 'native-file';
}

export type DownloadVerdict =
  | { ok: true; options: DownloadOption[] }
  | { ok: false; reason: 'stream' | 'nodownload' | 'iframe' | 'none'; message: string };

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)(\?|#|$)/i;

export function safeName(title: string, url: string): string {
  const ext = (VIDEO_EXT.exec(new URL(url).pathname)?.[1] ?? 'mp4').toLowerCase();
  const base = (title || 'skool-lesson').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'skool-lesson';
  return `${base}.${ext}`;
}

function https(u: string | null | undefined, base: string): string | null {
  if (!u) return null;
  try {
    const x = new URL(u, base);
    return x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
}

export const MESSAGES = {
  stream: 'Video này phát dạng luồng (HLS/MSE) nên không có tệp video tải được. Tiện ích không ghép luồng hay dùng token phát để tải.',
  nodownload: 'Chủ video đã tắt tải xuống cho trình phát này.',
  iframe: 'Video nằm trong trình phát nhúng (Loom/Vimeo/YouTube/Wistia). Hãy dùng nút tải của chính trình phát nếu chủ video cho phép.',
  none: 'Bài học không cung cấp tệp video được phép tải. Bạn vẫn có thể lưu bản ghi, bản dịch và ghi chú để học offline, hoặc xin chủ khóa học bản tải về.',
};

export function findAuthorizedDownloads(doc: Document, media: HTMLMediaElement | null, opts: { title: string; iframeTarget?: boolean }): DownloadVerdict {
  const base = doc.location?.href ?? 'https://www.skool.com/';
  const options: DownloadOption[] = [];
  const seen = new Set<string>();
  // 1. Links the course owner put in the lesson content.
  for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (a.closest('nav, header, footer, aside, [data-sst-panel], [data-sst-learning], [role="navigation"]')) continue;
    const url = https(a.getAttribute('href'), base);
    if (!url || seen.has(url)) continue;
    if (!a.hasAttribute('download') && !VIDEO_EXT.test(new URL(url).pathname)) continue;
    if (a.hasAttribute('download') && !VIDEO_EXT.test(new URL(url).pathname) && !/video|mp4|bài học|lesson|recording/i.test(a.textContent ?? '')) continue;
    seen.add(url);
    options.push({ url, filename: a.getAttribute('download') || safeName(opts.title, url), label: (a.textContent ?? '').trim().slice(0, 80) || 'Tệp video do khóa học cung cấp', source: 'owner-link' });
  }
  // 2. A plain video file whose player offers the browser's own download.
  let reason: 'stream' | 'nodownload' | 'none' = 'none';
  if (media && media.tagName === 'VIDEO') {
    const list = (media as HTMLVideoElement & { controlsList?: DOMTokenList }).controlsList;
    const nodl = (list && typeof list.contains === 'function' && list.contains('nodownload')) || /nodownload/.test(media.getAttribute('controlslist') ?? '');
    const srcs = [media.currentSrc, media.getAttribute('src'), ...[...media.querySelectorAll('source')].map((s) => s.getAttribute('src'))];
    const streamed = srcs.some((s) => s && (/^blob:/.test(s) || /\.(m3u8|mpd)(\?|$)/i.test(s))) || (!!media.currentSrc && /^blob:/.test(media.currentSrc));
    if (nodl) reason = 'nodownload';
    else if (streamed) reason = 'stream';
    else if (media.hasAttribute('controls')) {
      for (const s of srcs) {
        const url = https(s, base);
        if (!url || seen.has(url) || !VIDEO_EXT.test(new URL(url).pathname)) continue;
        seen.add(url);
        const res = [...media.querySelectorAll('source')].find((x) => https(x.getAttribute('src'), base) === url);
        options.push({ url, filename: safeName(opts.title, url), label: res?.getAttribute('label') || res?.getAttribute('res') || res?.getAttribute('size') || 'Tệp video của trình phát', source: 'native-file' });
      }
    }
  }
  if (options.length) return { ok: true, options };
  if (opts.iframeTarget) return { ok: false, reason: 'iframe', message: MESSAGES.iframe };
  return { ok: false, reason, message: MESSAGES[reason] };
}

export const OWNER_REQUEST_TEXT =
  'Chào thầy/cô, em đang học khóa này và muốn xem lại bài khi không có mạng. Thầy/cô có thể cho phép tải video (hoặc đính kèm tệp video/ghi chú) của bài học không ạ? Em chỉ dùng cho việc học cá nhân. Cảm ơn thầy/cô!';
