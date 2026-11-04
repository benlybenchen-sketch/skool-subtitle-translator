/** Phase 5C: authorized video downloads only. */
import { findAuthorizedDownloads, safeName } from '../../src/offline/videoDownload';

const video = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector('video');
};

describe('authorized video download detection', () => {
  it('Skool-style streaming player (MSE blob:/HLS) → disabled with the reason', () => {
    const v = video('<main><video></video></main>')!;
    Object.defineProperty(v, 'currentSrc', { value: 'blob:https://www.skool.com/abc' });
    const r = findAuthorizedDownloads(document, v, { title: 'Bài 1' });
    expect(r).toMatchObject({ ok: false, reason: 'stream' });
    const h = video('<video controls src="https://stream.mux.com/abc.m3u8"></video>')!;
    expect(findAuthorizedDownloads(document, h, { title: 'x' })).toMatchObject({ ok: false, reason: 'stream' });
  });
  it('owner disabled downloads (controlsList=nodownload) → disabled', () => {
    const v = video('<video controls controlslist="nodownload" src="https://cdn.test/lesson.mp4"></video>')!;
    expect(findAuthorizedDownloads(document, v, { title: 'x' })).toMatchObject({ ok: false, reason: 'nodownload' });
  });
  it('plain https video file with native controls (browser already offers Download) → offered', () => {
    const v = video('<video controls src="https://cdn.test/files/lesson.mp4"></video>')!;
    const r = findAuthorizedDownloads(document, v, { title: 'Bài 3: Hook / MSL?' });
    expect(r).toEqual({ ok: true, options: [{ url: 'https://cdn.test/files/lesson.mp4', filename: 'Bài 3 Hook MSL.mp4', label: 'Tệp video của trình phát', source: 'native-file' }] });
  });
  it('no controls attribute → not offered (no browser download either)', () => {
    const v = video('<video src="https://cdn.test/files/lesson.mp4"></video>')!;
    expect(findAuthorizedDownloads(document, v, { title: 'x' }).ok).toBe(false);
  });
  it('owner-provided links in the lesson content are offered; navigation and http links ignored', () => {
    video('<nav><a href="https://cdn.test/promo.mp4">promo</a></nav><main><a href="https://cdn.test/class/rec-720p.mp4">Download lesson recording (720p)</a><a href="http://insecure.test/a.mp4">x</a><a download href="https://cdn.test/slides.pdf">slides</a></main><video></video>');
    const r = findAuthorizedDownloads(document, document.querySelector('video'), { title: 'L' });
    expect(r.ok && r.options.map((o) => o.url)).toEqual(['https://cdn.test/class/rec-720p.mp4']);
  });
  it('embedded third-party player → explain, never extract', () => {
    video('<iframe src="https://player.vimeo.com/video/1"></iframe>');
    expect(findAuthorizedDownloads(document, null, { title: 'x', iframeTarget: true })).toMatchObject({ ok: false, reason: 'iframe' });
  });
  it('safe file names', () => {
    expect(safeName('a:b*c', 'https://x/y.webm?sig=1')).toBe('a b c.webm');
  });
});
