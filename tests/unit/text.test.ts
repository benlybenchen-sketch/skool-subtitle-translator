/** Phase 3C: text-only Skool lessons — detection, formatting-preserving translation, modes, restore. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBlocks, findArticle } from '../../src/text/article';
import { markupValid, renderMarkup, serializeInline } from '../../src/text/markup';
import { TextLessonTranslator, TEXT_CLONE_ATTR, TEXT_HIDDEN_ATTR, type TextTranslate } from '../../src/text/translator';
import { TextLessonManager } from '../../src/text/manager';
import { exportTranscript } from '../../src/transcript/export';
import { generateNotes } from '../../src/notes/generate';
import { MockProvider } from '../../src/translation/providers/mock';
import { buildUserPrompt, MARKUP_RULES } from '../../src/translation/prompt';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/types';

const FIXTURE = readFileSync(join(__dirname, '../fixtures/skool-text-lesson.html'), 'utf8');
const load = () => {
  document.head.innerHTML = '';
  document.body.innerHTML = FIXTURE;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Fake translator: "VI:" prefix, tags kept (like a well-behaved model). */
function fakeTranslate(opts: { fatalAfter?: number; mangle?: boolean } = {}) {
  const calls: { texts: string[]; priority: number }[] = [];
  const fn: TextTranslate = async (units, _ctx, priority) => {
    calls.push({ texts: units.map((u) => u.text), priority });
    if (opts.fatalAfter !== undefined && calls.length > opts.fatalAfter) return units.map((u) => ({ id: u.id, error: 'Chưa cho phép gửi phụ đề tới dịch vụ dịch từ xa.', fatal: true }));
    return units.map((u) => ({ id: u.id, vi: opts.mangle ? `VI: ${u.text.replace(/<\/b>/g, '')}` : `VI: ${u.text}` }));
  };
  return { fn, calls };
}

describe('text lesson detection', () => {
  it('finds the lesson body, not navigation, sidebar, buttons or comments', () => {
    load();
    const art = findArticle(document)!;
    expect(art.id).toBe('lesson-body');
    const blocks = extractBlocks(art);
    const all = blocks.map((b) => b.plain).join(' | ');
    expect(all).toContain('Welcome to the program');
    expect(all).toContain('Start small and scale winners');
    for (const noise of ['Community', 'Acme Ads Academy', 'John Carter', 'Mark as complete', 'Jane Doe', 'Thanks, this was', 'Your comment', 'Module 1']) expect(all).not.toContain(noise);
  });

  it('classifies block types and serialises emphasis, links and inline code', () => {
    load();
    const blocks = extractBlocks(findArticle(document)!);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(expect.arrayContaining(['h2', 'h3', 'p', 'li', 'oli', 'quote', 'code', 'cell']));
    const p1 = blocks.find((b) => b.plain.startsWith('This course'))!;
    expect(p1.markup).toBe('This course will teach you how to find a <b>Mass Desire</b> and turn it into <i>profitable</i> ads. Read this page <b>carefully</b> before you start.');
    const link = blocks.find((b) => b.plain.startsWith('Join'))!;
    expect(link.markup).toBe('Join the <a1>community chat</a1> and introduce yourself.');
    const code = blocks.find((b) => b.plain.startsWith('Run'))!;
    expect(code.markup).toBe('Run ⟦C0⟧ to generate your VOC report.');
    expect(code.codes).toEqual(['npm run research']);
    // nested list: the parent item does not swallow the child item
    const budget = blocks.find((b) => b.plain.startsWith('A budget'))!;
    expect(budget.plain).not.toContain('Start small');
    const pre = blocks.find((b) => b.kind === 'code')!;
    expect(pre.translatable).toBe(false);
  });

  it('returns null for pages without enough readable text', () => {
    document.body.innerHTML = '<nav><a>Home</a></nav><main><p>Short.</p><button>Join</button></main>';
    expect(findArticle(document)).toBeNull();
  });
});

describe('markup rendering (safe DOM, links from the original)', () => {
  it('keeps hrefs, code and emphasis; never parses HTML from the model', () => {
    document.body.innerHTML = '<p id="p">See <a href="https://x.test/a" target="_blank">docs</a> and <code>git push</code> <b>now</b></p>';
    const parts = serializeInline(document.getElementById('p')!, () => false);
    const frag = renderMarkup(document, 'Xem <a1>tài liệu</a1> và ⟦C0⟧ <b>ngay</b> <img src=x onerror=alert(1)>', parts);
    const div = document.createElement('div');
    div.append(frag);
    expect(div.querySelector('a')!.getAttribute('href')).toBe('https://x.test/a');
    expect(div.querySelector('a')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(div.querySelector('code')!.textContent).toBe('git push');
    expect(div.querySelector('strong')!.textContent).toBe('ngay');
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toContain('onerror');
  });

  it('broken tags fall back to plain text; missing code placeholders are re-appended', () => {
    document.body.innerHTML = '<p id="p"><b>Bold</b> <code>x()</code></p>';
    const parts = serializeInline(document.getElementById('p')!, () => false);
    expect(markupValid('<b>Đậm', parts)).toBe(false);
    const div = document.createElement('div');
    div.append(renderMarkup(document, '<b>Đậm', parts));
    expect(div.textContent).toBe('Đậm x()');
    expect(div.querySelector('b,strong')).toBeNull();
  });

  it('drops javascript: links', () => {
    document.body.innerHTML = '<p id="p"><a href="javascript:alert(1)">x</a></p>';
    const parts = serializeInline(document.getElementById('p')!, () => false);
    const div = document.createElement('div');
    div.append(renderMarkup(document, '<a1>y</a1>', parts));
    expect(div.querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('markup requests carry the tag-preservation rules', () => {
    const prompt = buildUserPrompt({ segments: [{ id: 's0', text: '<b>x</b>' }], context: [], glossary: [], sourceLang: 'en', targetLang: 'vi', signal: new AbortController().signal, format: 'markup' });
    expect(prompt).toContain(MARKUP_RULES);
    const sub = buildUserPrompt({ segments: [{ id: 's0', text: 'x' }], context: [], glossary: [], sourceLang: 'en', targetLang: 'vi', signal: new AbortController().signal });
    expect(sub).not.toContain('WRITTEN lesson');
  });
});

describe('TextLessonTranslator', () => {
  const setup = (mode: Settings['textDisplayMode'] = 'vi', t = fakeTranslate()) => {
    load();
    const art = findArticle(document)!;
    const originalHtml = art.innerHTML;
    const tr = new TextLessonTranslator(document, t.fn, mode, { debounceMs: 5 });
    tr.attach(art);
    return { art, tr, t, originalHtml };
  };
  const clone = () => document.querySelector(`[${TEXT_CLONE_ATTR}]`)!;
  const settle = async (tr: TextLessonTranslator) => {
    for (let i = 0; i < 50 && (tr.state().translating || tr.state().done < tr.state().total); i++) await tick(1);
  };

  it('does nothing until started (no API call, page untouched)', async () => {
    const { tr, t, art } = setup();
    await tick(5);
    expect(t.calls).toHaveLength(0);
    expect(art.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(false);
    expect(clone()).toBeNull();
    expect(tr.state()).toMatchObject({ started: false, total: expect.any(Number) });
  });

  it('Vietnamese-only: translated clone with headings, lists, links and code preserved; original hidden but intact', async () => {
    const { tr, art, originalHtml } = setup('vi');
    tr.start();
    await settle(tr);
    const c = clone();
    expect(c).not.toBeNull();
    expect(c.nextElementSibling).toBe(art);
    expect(art.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(true);
    expect(art.innerHTML).toBe(originalHtml); // Skool/React DOM never rewritten
    expect(c.querySelector('h2')!.textContent).toBe('VI: Welcome to the program');
    expect(c.querySelectorAll('ul > li').length).toBe(4); // 3 items + nested item
    expect(c.querySelector('ul ul li')!.textContent).toBe('VI: Start small and scale winners');
    const a = [...c.querySelectorAll('a')].find((x) => x.textContent === 'community chat')!;
    expect(a.getAttribute('href')).toBe('https://www.skool.com/acme-academy/about');
    expect(c.querySelector('pre')!.textContent).toBe('const budget = 50; // do not translate this');
    expect([...c.querySelectorAll('p code')].map((x) => x.textContent)).toEqual(['npm run research']);
    expect(c.querySelector('img')!.getAttribute('src')).toBe('https://assets.skool.com/f/diagram.png');
    expect(c.querySelector('strong')!.textContent).toBe('Mass Desire');
    expect(c.querySelectorAll('[id]').length).toBe(0); // no duplicate ids
    expect(tr.state()).toMatchObject({ done: tr.state().total, failed: 0 });
  });

  it('modes switch instantly without API calls; bilingual shows Vietnamese below each block; original restores exactly', async () => {
    const { tr, t, art, originalHtml } = setup('vi');
    tr.start();
    await settle(tr);
    const calls = t.calls.length;
    tr.setMode('bilingual');
    const c = clone();
    const h2 = c.querySelector('h2')!;
    expect(h2.textContent).toBe('Welcome to the program');
    expect(h2.nextElementSibling!.tagName).toBe('H2');
    expect(h2.nextElementSibling!.hasAttribute('data-sst-vi')).toBe(true);
    expect(h2.nextElementSibling!.textContent).toBe('VI: Welcome to the program');
    const li = c.querySelector('ol li')!;
    expect(li.querySelector('[data-sst-vi]')!.textContent).toBe('VI: Watch every lesson in order.');
    tr.setMode('vi');
    tr.setMode('bilingual');
    expect(document.querySelectorAll(`[${TEXT_CLONE_ATTR}]`)).toHaveLength(1); // no duplicates
    expect(clone().querySelectorAll('h2[data-sst-vi]')).toHaveLength(1);
    tr.setMode('original');
    expect(clone()).toBeNull();
    expect(art.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(false);
    expect(art.innerHTML).toBe(originalHtml);
    expect(t.calls.length).toBe(calls);
  });

  it('keeps the original readable while translation is in progress', async () => {
    load();
    const art = findArticle(document)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tr = new TextLessonTranslator(document, async (units) => (await gate, units.map((u) => ({ id: u.id, vi: 'VI: ' + u.text }))), 'vi', { debounceMs: 5 });
    tr.attach(art);
    tr.start();
    const c = clone();
    expect(c.querySelector('h2')!.textContent).toBe('Welcome to the program'); // English shown meanwhile
    expect(c.querySelector('h2')!.hasAttribute('data-sst-pending')).toBe(true);
    release();
    await settle(tr);
    expect(c.querySelector('h2')!.textContent).toBe('VI: Welcome to the program');
  });

  it('edited lesson content: only the changed block is translated again', async () => {
    const { tr, t, art } = setup('vi');
    tr.start();
    await settle(tr);
    const before = t.calls.flatMap((c) => c.texts).length;
    art.querySelector('h2')!.textContent = 'Welcome to the NEW program';
    await tick(30);
    await settle(tr);
    const after = t.calls.flatMap((c) => c.texts).slice(before);
    expect(after).toEqual(['Welcome to the NEW program']);
    expect(clone().querySelector('h2')!.textContent).toBe('VI: Welcome to the NEW program');
    expect(document.querySelectorAll(`[${TEXT_CLONE_ATTR}]`)).toHaveLength(1);
  });

  it('a re-render that removes our view is repaired (no duplicates)', async () => {
    const { tr } = setup('vi');
    tr.start();
    await settle(tr);
    clone().remove();
    await tick(30);
    expect(document.querySelectorAll(`[${TEXT_CLONE_ATTR}]`)).toHaveLength(1);
  });

  it('permanent errors (consent/permission) stop the job and are reported', async () => {
    const { tr, t } = setup('vi', fakeTranslate({ fatalAfter: 0 }));
    tr.start();
    await settle(tr);
    await tick(5);
    expect(tr.state().error).toMatch(/Chưa cho phép/);
    expect(t.calls.length).toBeLessThanOrEqual(2); // ≤ concurrency, then stops
    expect(tr.state().translating).toBe(false);
  });

  it('a model that breaks tags still yields readable text', async () => {
    const { tr } = setup('vi', fakeTranslate({ mangle: true }));
    tr.start();
    await settle(tr);
    const p = [...clone().querySelectorAll('p')].find((x) => x.textContent!.includes('Mass Desire'))!;
    expect(p.textContent).toContain('VI: This course will teach you');
    expect(p.textContent).not.toContain('<b>');
  });

  it('transcript/export: TXT and Markdown keep headings and lists; no SRT; notes have no timestamps', async () => {
    const { tr } = setup('vi');
    tr.start();
    await settle(tr);
    const t = tr.transcript('L', 'READ ME BEFORE YOU GO ON')!;
    expect(t.kind).toBe('text');
    expect(() => exportTranscript(t, 'srt', 'vi')).toThrow();
    const md = exportTranscript(t, 'md', 'vi').content;
    expect(md).toContain('# READ ME BEFORE YOU GO ON');
    expect(md).toContain('### VI: Welcome to the program');
    expect(md).toContain('- VI: A Facebook Business Manager account');
    expect(md).toContain('1. VI: Watch every lesson in order.');
    expect(md).toContain('```\nconst budget = 50;');
    expect(md).toContain('VI: Run npm run research to generate your VOC report.');
    const bi = exportTranscript(t, 'txt', 'bi').content;
    expect(bi).toContain('Welcome to the program\nVI: Welcome to the program');
    expect(exportTranscript(t, 'txt', 'vi').name).toBe('READ ME BEFORE YOU GO ON-vi.txt');
    const p = new MockProvider();
    const notes = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: (q) => p.complete({ ...q, signal: new AbortController().signal }) });
    expect(notes.refStarts).toEqual({});
    expect(notes.notes.takeaways.length).toBeGreaterThan(0);
  });
});

describe('TextLessonManager (detection lifecycle)', () => {
  const mk = (o: { video?: () => boolean; settings?: Partial<Settings> } = {}) => {
    let s = mergeSettings({ ...DEFAULT_SETTINGS, ...o.settings });
    const t = fakeTranslate();
    const infos: unknown[] = [];
    const m = new TextLessonManager(window, {
      settings: () => s,
      hasVideo: o.video ?? (() => false),
      translate: (_k, units, ctx, prio) => t.fn(units, ctx, prio),
      saveMode: (mode) => (s = { ...s, textDisplayMode: mode }),
      onChange: (i) => infos.push(i),
      graceMs: 5,
      retryMs: 5,
    });
    return { m, t, infos, set: (p: Partial<Settings>) => (s = { ...s, ...p }) };
  };
  beforeEach(() => {
    history.replaceState(null, '', '/acme-academy/classroom/abc?md=a1');
    load();
  });

  it('auto-translate off: detected, not translated until "Dịch bài này"', async () => {
    const { m, t } = mk();
    m.check();
    await tick(20);
    expect(m.info()).toMatchObject({ started: false, auto: false });
    expect(t.calls).toHaveLength(0);
    m.translateNow();
    await tick(20);
    expect(t.calls.length).toBeGreaterThan(0);
    m.destroy();
  });

  it('auto-translate on: starts by itself; Vietnamese-only by default', async () => {
    const { m, t } = mk({ settings: { autoTranslateTextLessons: true } });
    m.check();
    await tick(30);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(m.info()!.mode).toBe('vi');
    expect(document.querySelector(`[${TEXT_CLONE_ATTR}]`)).not.toBeNull();
    m.destroy();
    expect(document.querySelector(`[${TEXT_CLONE_ATTR}]`)).toBeNull();
  });

  it('video lesson: the written material below the video is translated; the player is never inside the translated view', async () => {
    // Skool-like video lesson page: player (open shadow root) above a rich-text description
    document.body.innerHTML = `<main><h1>2.2 - Hero Section Optimization</h1>
      <div id="player-host" class="styled__VideoWrapper"></div>
      <div id="desc" class="styled__RichText">
        <blockquote><p><b>Income Disclaimer</b>: Our course material is provided for educational purposes only and does not guarantee any financial success.</p></blockquote>
        <h2>Hero Section Optimization</h2>
        <p>The hero section is everything below the images on mobile. Aesthetics don't matter, the elements do.</p>
        <p>We'll cover this through the lens of mobile, since 79-80% of your traffic comes from mobile anyway.</p>
        <h2>Why the hero section matters most</h2>
        <p>Upwards of <b>70% of your traffic doesn't scroll.</b></p>
      </div></main>`;
    const host = document.getElementById('player-host')!;
    const root = host.attachShadow({ mode: 'open' });
    const video = document.createElement('video');
    root.append(video);
    const t = fakeTranslate();
    let info: any = null;
    const m = new TextLessonManager(window, {
      settings: () => mergeSettings({ ...DEFAULT_SETTINGS, autoTranslateTextLessons: true }),
      hasVideo: () => true,
      players: () => [host],
      translate: (_k, units, ctx, prio) => t.fn(units, ctx, prio),
      saveMode: () => undefined,
      onChange: (i) => (info = i),
      graceMs: 5,
      retryMs: 5,
    });
    m.check();
    await tick(40);
    expect(info).toMatchObject({ withVideo: true, started: true });
    expect(m.translator.attached!.id).toBe('desc');
    const clone = document.querySelector(`[${TEXT_CLONE_ATTR}]`)!;
    expect(clone.querySelector('h2')!.textContent).toBe('VI: Hero Section Optimization');
    expect(clone.contains(host)).toBe(false);
    expect(host.isConnected && !host.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(true); // player untouched, visible
    expect(t.calls.flatMap((c) => c.texts).some((x) => x.includes('Income Disclaimer'))).toBe(true);
    m.destroy();
  });

  it('readability winner containing the player → descends to the text container without it', () => {
    document.body.innerHTML = `<main><div id="wrap"><div id="ph"><video></video></div><div id="txt"><h2>Title of the lesson</h2><p>${'Long explanation sentence about the offer. '.repeat(6)}</p><p>${'Second paragraph with more teaching. '.repeat(6)}</p></div></div></main>`;
    const art = findArticle(document, { avoid: [document.getElementById('ph')!] })!;
    expect(art.id).toBe('txt');
  });

  it('SPA navigation text → video lesson restores the page; back to text translates from cache-friendly keys', async () => {
    let video = false;
    const keys: string[] = [];
    const s = mergeSettings({ ...DEFAULT_SETTINGS, autoTranslateTextLessons: true });
    const m = new TextLessonManager(window, {
      settings: () => s,
      hasVideo: () => video,
      translate: async (k, units) => (keys.push(k), units.map((u) => ({ id: u.id, vi: 'VI ' + u.text }))),
      saveMode: () => undefined,
      onChange: () => undefined,
      graceMs: 5,
      retryMs: 5,
    });
    m.check();
    await tick(30);
    const art = document.getElementById('lesson-body')!;
    expect(art.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(true);
    history.pushState(null, '', '/acme-academy/classroom/abc?md=a2');
    video = true;
    m.check();
    expect(art.hasAttribute(TEXT_HIDDEN_ATTR)).toBe(false);
    expect(document.querySelector(`[${TEXT_CLONE_ATTR}]`)).toBeNull();
    expect(new Set(keys)).toEqual(new Set(['text:v1:http://localhost:3000/acme-academy/classroom/abc?md=a1']));
    m.destroy();
  });

  it('not on a Classroom page → inactive', async () => {
    history.replaceState(null, '', '/acme-academy/community');
    const { m, t } = mk({ settings: { autoTranslateTextLessons: true } });
    m.check();
    await tick(20);
    expect(m.info()).toBeNull();
    expect(t.calls).toHaveLength(0);
  });
});
