import { adapterForFrame, adapterForIframe, isSkoolUrl, loomAdapter, providerForVideo, skoolNativeAdapter, stableMediaSrc, vimeoAdapter, wistiaAdapter, youtubeAdapter } from '../../src/players/adapters';
import { VideoDetector, detect } from '../../src/players/detector';
import { makeVideo, setRect } from './fakes';

const iframe = (src: string, w = 960, h = 540) => {
  const f = document.createElement('iframe');
  f.src = src;
  setRect(f, w, h);
  return f;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('provider adapters', () => {
  it.each([
    ['https://www.loom.com/embed/0123456789abcdef', 'loom', '0123456789abcdef'],
    ['https://www.loom.com/share/abcdef123', 'loom', 'abcdef123'],
    ['https://player.vimeo.com/video/76979871?h=8272103f6e', 'vimeo', '76979871'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://fast.wistia.net/embed/iframe/abc123xyz', 'wistia', 'abc123xyz'],
  ])('detects %s as %s', (src, provider, id) => {
    const a = adapterForIframe(iframe(src), 'https://www.skool.com/');
    expect(a?.id).toBe(provider);
    expect(a?.videoIdFromUrl(new URL(src))).toBe(id);
    expect(adapterForFrame(new URL(src)).id).toBe(provider);
  });

  it('ignores unrelated iframes', () => {
    expect(adapterForIframe(iframe('https://www.google.com/maps/embed'), 'https://www.skool.com')).toBeNull();
    expect(adapterForIframe(iframe('https://www.youtube.com/watch?v=x'), 'https://www.skool.com')).toBeNull();
  });

  it('identifies Skool pages and lesson ids', () => {
    const u = new URL('https://www.skool.com/my-group/classroom/abc123?md=lesson42');
    expect(isSkoolUrl(u)).toBe(true);
    expect(isSkoolUrl(new URL('https://skool.com.evil.example/'))).toBe(false);
    expect(adapterForFrame(u).id).toBe('skool-native');
    expect(skoolNativeAdapter.videoIdFromUrl(u)).toBe('/my-group/classroom/abc123?md=lesson42');
  });

  it('recognises a Wistia JS embed inside the Skool page', () => {
    const wrap = document.createElement('div');
    wrap.className = 'wistia_embed wistia_async_abc';
    const v = makeVideo(document);
    wrap.append(v);
    document.body.append(wrap);
    expect(providerForVideo(v, skoolNativeAdapter)).toBe('wistia');
    const plain = makeVideo(document);
    document.body.append(plain);
    expect(providerForVideo(plain, skoolNativeAdapter)).toBe('skool-native');
  });

  it('strips signed query strings and ignores blob: URLs for identity', () => {
    expect(stableMediaSrc('https://cdn.example.com/v/1.m3u8?sig=abc')).toBe('https://cdn.example.com/v/1.m3u8');
    expect(stableMediaSrc('blob:https://www.skool.com/1234')).toBeNull();
  });

  it('exposes DOM caption selectors only where documented (YouTube)', () => {
    expect(youtubeAdapter.domCaptionSelectors?.length).toBeGreaterThan(0);
    expect(loomAdapter.domCaptionSelectors).toBeUndefined();
    expect(vimeoAdapter.domCaptionSelectors).toBeUndefined();
    expect(wistiaAdapter.domCaptionSelectors).toBeUndefined();
  });
});

describe('detector', () => {
  it('Skool native: picks the largest HTML5 video', () => {
    const small = makeVideo(document, { width: 200, height: 120 });
    const big = makeVideo(document, { width: 1280, height: 720 });
    document.body.append(small, big);
    const r = detect(document, skoolNativeAdapter);
    expect(r.primary?.el).toBe(big);
    expect(r.primary?.provider).toBe('skool-native');
  });

  it('Loom/Vimeo/YouTube/Wistia embeds become iframe targets', () => {
    document.body.append(iframe('https://www.loom.com/embed/abc'), iframe('https://player.vimeo.com/video/1', 300, 200));
    const r = detect(document, skoolNativeAdapter);
    expect(r.embeds.map((e) => e.provider)).toEqual(['loom', 'vimeo']);
    expect(r.primary).toMatchObject({ kind: 'iframe', provider: 'loom' });
  });

  it('ignores tiny/hidden videos (ads, previews)', () => {
    document.body.append(makeVideo(document, { width: 0, height: 0, src: '' }));
    expect(detect(document, skoolNativeAdapter).primary).toBeNull();
  });

  it('notices videos added dynamically (SPA lesson render)', async () => {
    const det = new VideoDetector(document, skoolNativeAdapter, (cb) => setTimeout(cb, 0));
    const seen: (Element | null)[] = [];
    det.onChange((r, changed) => changed && seen.push(r.primary?.el ?? null));
    det.start();
    const v = makeVideo(document);
    const wrapper = document.createElement('div');
    wrapper.append(v);
    document.body.append(wrapper);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain(v);
    wrapper.remove();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[seen.length - 1]).toBeNull();
    det.stop();
  });

  it('coalesces bursts of mutations into one scan', async () => {
    const det = new VideoDetector(document, skoolNativeAdapter, (cb) => setTimeout(cb, 5));
    const scan = vi.spyOn(det, 'scan');
    det.start();
    scan.mockClear();
    for (let i = 0; i < 20; i++) document.body.append(makeVideo(document));
    await new Promise((r) => setTimeout(r, 30));
    expect(scan).toHaveBeenCalledTimes(1);
    det.stop();
  });
});
