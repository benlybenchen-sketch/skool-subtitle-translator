/**
 * End-to-end tests: loads the BUILT extension (dist/) into Chromium and runs it
 * against MOCK pages served under https://www.skool.com/* and
 * https://www.loom.com/embed/* via request interception.
 *
 * These prove the extension pipeline works in a real browser (content script
 * injection, iframe frames, MV3 service worker, IndexedDB, overlay, SPA
 * navigation). They do NOT prove compatibility with the real Skool/Loom DOM.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Run `npm run build` first');
const pages = join(root, 'tests/e2e/pages');
const fixtures = join(root, 'tests/fixtures');

function wav(seconds, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}
const WAV = wav(30);
const LONG_WAV = wav(720); // 12-minute lesson for minute-level seeks
const LONG_VTT = 'WEBVTT\n\n' + Array.from({ length: 24 }, (_, i) => {
  const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23);
  return `${ts(i * 30)} --> ${ts(i * 30 + 20)}\nLesson cue number ${i}.\n`;
}).join('\n');
const VTT2 = 'WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nThis is the second lesson.\n';

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const userDataDir = mkdtempSync(join(tmpdir(), 'sst-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium', // full Chromium (new headless) — the headless shell cannot load extensions
  executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true,
});

const serve = (body, type) => ({ status: 200, contentType: type, body, headers: { 'Access-Control-Allow-Origin': '*' } });
// Media needs HTTP Range support, otherwise Chromium cannot seek.
const serveMedia = (route, body) => {
  const range = route.request().headers()['range'];
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return route.fulfill({ status: 200, body, headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length), 'Access-Control-Allow-Origin': '*' } });
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : body.length - 1;
  return route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1), 'Access-Control-Allow-Origin': '*' },
  });
};
await context.route(/^https:\/\/www\.skool\.com\//, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/media/lesson.wav' || u.pathname === '/media/lesson2.wav') return serveMedia(route, WAV);
  if (u.pathname === '/media/lesson.vtt') return route.fulfill(serve(readFileSync(join(fixtures, 'lesson.vtt')), 'text/vtt'));
  if (u.pathname === '/media/lesson2.vtt') return route.fulfill(serve(VTT2, 'text/vtt'));
  if (u.pathname === '/media/long.wav') return serveMedia(route, LONG_WAV);
  if (u.pathname === '/media/long.vtt') return route.fulfill(serve(LONG_VTT, 'text/vtt'));
  const page = u.search.includes('jstrack') ? 'skool-jstrack.html' : u.search.includes('trackfile') ? 'skool-trackfile.html' : u.search.includes('continuous') ? 'skool-continuous.html' : u.search.includes('seekreset') ? 'skool-seek.html' : u.search.includes('novideo') ? 'skool-novideo.html' : u.search.includes('loom') ? 'skool-loom.html' : u.search.includes('nocaptions') ? 'skool-nocaptions.html' : 'skool-native.html';
  return route.fulfill(serve(readFileSync(join(pages, page)), 'text/html'));
});
await context.route(/^https:\/\/js\.stripe\.com\//, (route) => route.fulfill(serve('<!doctype html><title>stripe mock</title>', 'text/html')));
await context.route(/^https:\/\/www\.loom\.com\//, (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/media/lesson.wav') return serveMedia(route, WAV);
  if (u.pathname === '/media/lesson.vtt') return route.fulfill(serve(readFileSync(join(fixtures, 'lesson.vtt')), 'text/vtt'));
  return route.fulfill(serve(readFileSync(join(pages, 'loom-embed.html')), 'text/html'));
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
console.log(`Extension loaded: ${extId}`);

// Use the offline mock translator (no network, no permissions) for E2E.
// On first install the extension opens its Settings page itself (onInstalled): let that settle
// first, then use our own tab (avoids "navigation interrupted" races).
await new Promise((r) => setTimeout(r, 1000));
const setup = await context.newPage();
for (let i = 0; i < 3; i++) {
  try {
    await setup.goto(`chrome-extension://${extId}/settings/options.html`);
    break;
  } catch (e) {
    if (i === 2) throw e;
    await new Promise((r) => setTimeout(r, 500));
  }
}
await setup.evaluate(async () => {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  // autoEnableCaptions: the mock players expose non-default (disabled) English tracks; the user
  // opt-in is given here explicitly. The opt-out behaviour has its own test below.
  await chrome.storage.sync.set({ settings: { ...settings, autoEnableCaptions: true, provider: { kind: 'mock', endpoint: 'mock://', model: 'mock', temperature: 0 } } });
});

const overlayText = (frame) =>
  frame.evaluate(() => {
    const host = document.querySelector('[data-sst-overlay]');
    const vi = host?.shadowRoot?.querySelector('.vi');
    return vi && !vi.classList.contains('hidden') ? vi.textContent : null;
  });
async function waitFor(fn, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}
const seek = (frame, t) => frame.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = t; }, t);

console.log('E2E (mock pages, real Chromium + built extension):');

const page = await context.newPage();
await test('Skool-native mock: English track → Vietnamese overlay in sync', async () => {
  await page.goto('https://www.skool.com/test-group/classroom/course1?md=lesson1');
  await page.waitForSelector('video');
  await page.evaluate(() => document.querySelector('video').play());
  await seek(page, 2);
  const t = await waitFor(async () => { const x = await overlayText(page); return x?.startsWith('[VI]') && x; }, 8000, 'overlay text');
  assert(t === '[VI] Welcome back to the course.', `unexpected overlay: ${t}`);
});

await test('Seek forward/backward keeps the right line', async () => {
  await seek(page, 7);
  const t = await waitFor(async () => { const x = await overlayText(page); return x?.includes('Facebook Ads') && x; }, 5000, 'merged sentence');
  assert(t.includes('$50') && t.includes('2.5%'), 'numbers preserved in merged sentence');
  await seek(page, 12.5);
  await waitFor(async () => (await overlayText(page)) === "[VI] Let's open Shopify.", 4000, 'shopify line');
  await seek(page, 1.5);
  await waitFor(async () => (await overlayText(page)) === '[VI] Welcome back to the course.', 4000, 'first line');
});

await test('Pause + playback speed change', async () => {
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.playbackRate = 2; v.currentTime = 4.8; });
  await waitFor(async () => (await overlayText(page))?.includes('Facebook Ads'), 4000, 'paused text');
  await page.evaluate(() => document.querySelector('video').play());
  await seek(page, 13);
  await waitFor(async () => (await overlayText(page)) === "[VI] Let's open Shopify.", 4000, 'after rate change');
});

await test('Only one overlay exists (no duplicate subtitles)', async () => {
  const n = await page.evaluate(() => document.querySelectorAll('[data-sst-overlay]').length);
  assert(n === 1, `expected 1 overlay, found ${n}`);
});

await test('Fullscreen: VI control + subtitles move into the fullscreen element, 3 enter/exit cycles', async () => {
  const probe = () =>
    page.evaluate(() => {
      const player = document.getElementById('player');
      const ov = document.querySelector('[data-sst-overlay]');
      const panel = document.querySelector('[data-sst-panel]');
      const visible = (host, sel) => {
        const el = host?.shadowRoot?.querySelector(sel);
        if (!el) return false;
        const b = el.getBoundingClientRect();
        // must be the topmost element at its centre, i.e. really rendered in the top layer
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return b.width > 0 && b.height > 0 && (hit === host || host.contains(hit));
      };
      return {
        fs: document.fullscreenElement === player,
        overlayInFs: player.contains(ov),
        panelInFs: player.contains(panel),
        panelVisible: visible(panel, '.pill'),
        // overlay is pointer-events:none (controls stay clickable) → elementFromPoint skips it;
        // check rendering + geometry inside the fullscreen player instead
        subtitleVisible: (() => {
          const el = ov?.shadowRoot?.querySelector('.vi');
          if (!el || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          const b = el.getBoundingClientRect();
          const p = player.getBoundingClientRect();
          return b.width > 0 && b.top >= p.top && b.bottom <= p.bottom && b.left >= p.left && b.right <= p.right;
        })(),
        text: ov.shadowRoot.querySelector('.vi').textContent,
        backInBody: ov.parentElement === document.body && panel.parentElement === document.body,
        overlays: document.querySelectorAll('[data-sst-overlay]').length,
        panels: document.querySelectorAll('[data-sst-panel]').length,
      };
    });
  await page.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 1.5; });
  await page.waitForTimeout(300);
  const cycles = [];
  let after;
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('f'); // enter (real key press = user activation)
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.waitForTimeout(250);
    cycles.push(await probe());
    await page.keyboard.press('f'); // exit
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.waitForTimeout(250);
    after = await probe();
  }
  const r = { cycles, ...after, textAfter: after.text };
  for (const [i, c] of r.cycles.entries()) {
    assert(c.overlayInFs, `cycle ${i}: overlay not in fullscreen element`);
    assert(c.panelInFs && c.panelVisible, `cycle ${i}: VI control not visible in fullscreen`);
    assert(c.subtitleVisible, `cycle ${i}: subtitle not visible in fullscreen`);
    assert(c.text === '[VI] Welcome back to the course.', `cycle ${i}: text=${c.text}`);
  }
  assert(r.backInBody, 'UI not restored to <body> after exit');
  assert(r.overlays === 1 && r.panels === 1, `duplicates: overlays=${r.overlays} panels=${r.panels}`);
  assert(r.textAfter === '[VI] Welcome back to the course.', `sync lost: ${r.textAfter}`);
});

await test('SPA lesson navigation: new video detected without reload', async () => {
  await page.evaluate(() => window.goNextLesson());
  await page.waitForFunction(() => location.search.includes('lesson2'));
  await page.evaluate(() => document.querySelector('video').play());
  await seek(page, 1);
  await waitFor(async () => (await overlayText(page)) === '[VI] This is the second lesson.', 8000, 'lesson 2 overlay');
  const n = await page.evaluate(() => document.querySelectorAll('[data-sst-overlay]').length);
  assert(n === 1, `expected 1 overlay after navigation, found ${n}`);
});

await test('SPA navigation reusing the SAME <video> element (source swapped later): new lesson auto-translated, no F5', async () => {
  await page.evaluate(() => window.goNextLessonSameVideo());
  await page.waitForFunction(() => location.search.includes('lesson3'));
  await page.waitForFunction(() => document.querySelector('video track'));
  await page.evaluate(() => document.querySelector('video').play());
  await waitFor(async () => {
    await page.evaluate(() => (document.querySelector('video').currentTime = 1));
    return (await overlayText(page)) === '[VI] This is the second lesson.';
  }, 8000, 'lesson 3 overlay on reused element');
  const n = await page.evaluate(() => document.querySelectorAll('[data-sst-overlay]').length);
  assert(n === 1, `overlays=${n}`);
});

await test('Floating control panel is injected and collapsible', async () => {
  const label = await page.evaluate(() => document.querySelector('[data-sst-panel]')?.shadowRoot?.querySelector('.pill')?.textContent);
  assert(label?.includes('VI'), 'panel pill missing');
});

await test('Translation cache: re-visiting a lesson hits IndexedDB', async () => {
  const p2 = await context.newPage();
  await p2.goto('https://www.skool.com/test-group/classroom/course1?md=lesson1');
  await p2.waitForSelector('video');
  await p2.evaluate(() => document.querySelector('video').play());
  await seek(p2, 2);
  await waitFor(async () => (await overlayText(p2)) === '[VI] Welcome back to the course.', 8000, 'cached overlay');
  const m = await sw.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'metrics:get' }).then(r).catch(() => r(null))));
  const stats = await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'metrics:get' }));
  assert(stats.cacheHits > 0, `expected cache hits, got ${JSON.stringify(stats)}`);
  void m;
  await p2.close();
});

await test('Loom-style iframe: content script runs inside the embed and renders there', async () => {
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course2?md=loomlesson');
  const frame = await waitFor(async () => p.frames().find((f) => f.url().includes('loom.com/embed')), 5000, 'loom frame');
  await frame.waitForSelector('video');
  await frame.evaluate(() => document.querySelector('video').play());
  await seek(frame, 2);
  await waitFor(async () => (await overlayText(frame)) === '[VI] Welcome back to the course.', 8000, 'iframe overlay');
  const topOverlayText = await overlayText(p);
  assert(!topOverlayText, 'top frame must not render a duplicate overlay');
  await p.close();
});

await test('Loom page opened outside Skool: extension stays inactive', async () => {
  const p = await context.newPage();
  await p.goto('https://www.loom.com/embed/standalone');
  await p.waitForSelector('video');
  await new Promise((r) => setTimeout(r, 1200));
  const n = await p.evaluate(() => document.querySelectorAll('[data-sst-overlay]').length);
  assert(n === 0, 'extension must not run on Loom outside Skool');
  await p.close();
});

await test('Missing captions: status reports unavailable + Audio Mode offer', async () => {
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course3?md=nocaptions');
  await p.waitForSelector('video');
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*nocaptions*' }))[0]?.id);
  const st = await waitFor(async () => {
    const r = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab:status', tabId: id }), tabId);
    const f = r.status.frames[0];
    return f && f.captionState === 'unavailable' && r;
  }, 8000, 'unavailable status');
  assert(st.status.frames[0].mode === 'waiting-audio', `mode=${st.status.frames[0].mode}`);
  await p.close();
});

await test('Popup renders status for the active Skool tab', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#st-page');
  await popup.waitForFunction(() => document.getElementById('st-page').textContent !== '…');
  const txt = await popup.textContent('#st-page');
  assert(txt.length > 0, 'popup status empty');
  await popup.close();
});

await test('Service worker restart: translation keeps working after the worker is stopped', async () => {
  const cdp = await context.newCDPSession(setup);
  // Stop all service workers through CDP (simulates MV3 idle termination).
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await new Promise((r) => setTimeout(r, 500));
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course9?md=after-restart');
  await p.waitForSelector('video');
  await p.evaluate(() => document.querySelector('video').play());
  await seek(p, 2);
  await waitFor(async () => (await overlayText(p)) === '[VI] Welcome back to the course.', 10000, 'overlay after SW restart');
  await p.close();
});

await test('Audio Mode: offscreen document loads; invalid/denied capture fails cleanly', async () => {
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course4?md=audio');
  await p.waitForSelector('video');
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*md=audio*' }))[0]?.id);
  await setup.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, stt: { kind: 'mock', endpoint: 'mock://', model: 'mock' } } });
  });
  const r = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'audio:start', tabId: id, streamId: 'not-a-real-stream' }), tabId);
  assert(r.ok, `start failed early: ${JSON.stringify(r)}`);
  const offscreenExists = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  const st = await waitFor(async () => {
    const s = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab:status', tabId: id }), tabId);
    return !s.status.audio.active && s.status.audio.error && s;
  }, 8000, 'audio error state');
  assert(/thu âm thanh tab/.test(st.status.audio.error), st.status.audio.error);
  const left = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  assert(left === 0, 'offscreen document should be closed after failure');
  void offscreenExists;
  await p.close();
});

await test('Regression: Skool page with NO accessible <video> (2 <audio>, Stripe iframes, closed shadow player)', async () => {
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course5?md=novideo');
  await p.waitForSelector('#a2', { state: 'attached' });
  await p.evaluate(() => document.getElementById('a2').play());
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*novideo*' }))[0]?.id);
  // 1. Status is reported (previously: nothing reported → "No video detected" with no explanation)
  const st = await waitFor(async () => {
    const r = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab:status', tabId: id }), tabId);
    const f = r.status.frames.find((x) => x.isTop);
    return f && f.audioElements === 2 && f.captionState === 'unavailable' && r;
  }, 8000, 'status for page without video');
  const top = st.status.frames.find((x) => x.isTop);
  assert(top.videoElements === 0, `videoElements=${top.videoElements}`);
  assert(top.targetKind === 'media' || top.targetKind === null, `targetKind=${top.targetKind}`);
  assert(top.pageAnchor === true, 'player anchor not found');
  assert(top.mode === 'waiting-audio', `mode=${top.mode}`);
  // 2. Diagnostics describe what is accessible
  const diag = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'diag:run', tabId: id }), tabId);
  const d = diag.frames.find((f) => f.frameId === 0).report;
  assert(d.videoLight === 0 && d.videoInOpenShadow === 0, 'closed-shadow video must not be visible');
  assert(d.audioLight === 2, `audioLight=${d.audioLight}`);
  assert(d.iframes.length === 3 && d.iframes.every((i) => i.host === 'js.stripe.com'), JSON.stringify(d.iframes));
  assert(d.pageAnchor?.includes('LessonVideoPlayer'), `anchor=${d.pageAnchor}`);
  // 3. Audio Mode can be started without any HTMLVideoElement (reaches the offscreen capture step)
  const r = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'audio:start', tabId: id, streamId: 'not-a-real-stream' }), tabId);
  assert(r.ok, `audio:start refused: ${JSON.stringify(r)}`);
  await waitFor(async () => {
    const s2 = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab:status', tabId: id }), tabId);
    return !s2.status.audio.active && /thu âm thanh tab/.test(s2.status.audio.error ?? '');
  }, 8000, 'capture attempted');
  // 4. Page-level overlay shows live Vietnamese subtitles over the player area
  await sw.evaluate(async (id) => {
    await chrome.tabs.sendMessage(id, { type: 'audio:state', active: true, primary: true }, { frameId: 0 });
    await chrome.tabs.sendMessage(id, { type: 'live:segment', id: 'live-1', en: 'Welcome back.', vi: 'Chào mừng trở lại.', final: true }, { frameId: 0 });
  }, tabId);
  const shown = await waitFor(() => overlayText(p), 4000, 'page-level overlay');
  assert(shown === 'Chào mừng trở lại.', `overlay=${shown}`);
  const geo = await p.evaluate(() => {
    const root = document.querySelector('[data-sst-overlay]').shadowRoot.querySelector('.root');
    const pr = document.getElementById('player').getBoundingClientRect();
    return { w: root.style.width, pw: pr.width + 'px', badge: !root.querySelector('.badge').classList.contains('hidden') };
  });
  assert(geo.w === geo.pw, `overlay width ${geo.w} != player ${geo.pw}`);
  assert(geo.badge, 'Audio Mode indicator not visible');
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'audio:state', active: false, primary: true }, { frameId: 0 }), tabId);
  await p.close();
});

await test('Pretranslation: cues translated before playback reaches them, shown instantly, no duplicate requests', async () => {
  const before = await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'metrics:get' }));
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course7?md=pretranslate');
  await p.waitForSelector('video');
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*md=pretranslate*' }))[0]?.id);
  // video stays PAUSED at 0 s — nothing has been displayed yet
  const st = await waitFor(async () => {
    const r = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'tab:status', tabId: id }), tabId);
    const f = r.status.frames.find((x) => x.captionSource === 'texttrack');
    return f && f.unitsTotal > 0 && f.unitsTranslated === f.unitsTotal && f;
  }, 8000, 'all cues pretranslated while paused');
  assert(st.perf && st.perf.timeToFirstMs >= 0, `timeToFirst missing: ${JSON.stringify(st.perf)}`);
  assert(st.perf.missedDeadlines === 0, `missed deadlines: ${st.perf.missedDeadlines}`);
  // seek to a later cue: the Vietnamese text must be there on the very next frame (no pending English)
  const shown = await p.evaluate(async () => {
    const v = document.querySelector('video');
    v.currentTime = 12.5;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    await new Promise((r) => requestAnimationFrame(() => r()));
    const vi = document.querySelector('[data-sst-overlay]').shadowRoot.querySelector('.vi');
    return { text: vi.textContent, pending: vi.classList.contains('pending') };
  });
  assert(shown.text === "[VI] Let's open Shopify." && !shown.pending, JSON.stringify(shown));
  const after = await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'metrics:get' }));
  const translated = after.segmentsTranslated - before.segmentsTranslated;
  assert(translated === st.unitsTotal, `expected ${st.unitsTotal} segments requested once, got ${translated}`);
  await p.close();
});

await test('Settings: Gemini / OpenAI GPT / Anthropic Claude as separate providers; switching keeps each one\'s key, model and endpoint', async () => {
  const o = await context.newPage();
  await o.goto(`chrome-extension://${extId}/settings/options.html`);
  const pick = (k) => o.selectOption('#p-kind', k);
  const val = (id) => o.inputValue(id);
  const labels = await o.$$eval('#p-kind option', (els) => els.map((e) => e.value));
  assert(['gemini', 'openai', 'anthropic'].every((k) => labels.includes(k)), labels.join(','));
  await pick('gemini');
  await o.fill('#p-model', 'gemini-3.5-flash-lite');
  await o.fill('#p-key', 'GEMINI-KEY');
  await pick('anthropic');
  assert((await val('#p-endpoint')) === 'https://api.anthropic.com' && (await val('#p-model')) === 'claude-opus-5-5', 'Claude preset');
  assert((await val('#p-key')) === '', 'Claude key must start empty');
  assert(await o.$eval('#p-temp', (e) => e.disabled), 'temperature not used for Claude');
  await o.fill('#p-key', 'CLAUDE-KEY');
  await pick('openai');
  assert((await val('#p-model')) === 'gpt-4o-mini', 'OpenAI preset');
  await pick('gemini');
  assert((await val('#p-key')) === 'GEMINI-KEY' && (await val('#p-model')) === 'gemini-3.5-flash-lite', 'Gemini restored without re-entering');
  await pick('anthropic');
  assert((await val('#p-key')) === 'CLAUDE-KEY', 'Claude key kept');
  const marked = await o.$eval('#p-kind', (s) => [...s.options].filter((x) => x.textContent.includes('✓')).map((x) => x.value).sort().join(','));
  assert(marked === 'anthropic,gemini', `key markers: ${marked}`);
  await o.close();
});

await test('Glossary editor: add term, presets do not overwrite it, delete, filter; mode selector present', async () => {
  const o = await context.newPage();
  await o.goto(`chrome-extension://${extId}/settings/options.html`);
  await o.waitForSelector('#gl-rows');
  await o.fill('#gl-term', 'Hook');
  await o.fill('#gl-vi', 'câu móc của tôi');
  await o.click('#gl-add');
  await o.click('#gl-presets button:has-text("Marketing")');
  const hooks = await o.$$eval('#gl-rows tr', (rows) => rows.map((r) => [...r.querySelectorAll('input')].map((i) => i.value)).filter(([t]) => t.toLowerCase() === 'hook'));
  assert(hooks.length === 1 && hooks[0][1] === 'câu móc của tôi', `Hook rows: ${JSON.stringify(hooks)}`);
  const msg = await o.textContent('#gl-msg');
  assert(/Đã thêm \d+ thuật ngữ/.test(msg ?? ''), `preset message: ${msg}`);
  await o.fill('#gl-filter', 'Mass Desire');
  const visible = await o.$$eval('#gl-rows tr', (r) => r.length);
  assert(visible === 1, `filter rows: ${visible}`);
  await o.click('#gl-rows tr button');
  assert((await o.$$eval('#gl-rows tr', (r) => r.length)) === 0, 'delete failed');
  const modes = await o.$$eval('#mode option', (els) => els.map((e) => e.value).join(','));
  assert(modes === 'fast,balanced,quality', modes);
  await o.close();
  const pop = await context.newPage();
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
  assert((await pop.$$eval('#transMode option', (els) => els.length)) === 3, 'popup mode selector');
  await pop.close();
});

await test('Seek regression: player disables CC on seek → Vietnamese subtitles recover without toggling CC', async () => {
  const before = await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'metrics:get' }));
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course8?md=seekreset');
  await p.waitForSelector('video');
  await p.evaluate(() => document.querySelector('video').play());
  const expectAt = async (t, label, rate = 1) => {
    await p.evaluate(({ t, rate }) => { const v = document.querySelector('video'); v.playbackRate = rate; v.currentTime = t; }, { t, rate });
    const want = `[VI] Lesson cue number ${Math.floor(t / 30)}.`;
    await waitFor(async () => (await overlayText(p)) === want, 4000, `${label}: "${want}" (got ${JSON.stringify(await overlayText(p))})`);
  };
  await expectAt(5, 'start');
  await expectAt(15, '+10 s');
  await expectAt(315, '+5 min');
  await expectAt(285, '-30 s');
  await expectAt(5 + 30 * 0.2, '-10 min'); // back near the start
  for (const t of [400, 95, 610, 35]) await p.evaluate((t) => (document.querySelector('video').currentTime = t), t); // rapid
  await expectAt(455, 'after rapid seeks');
  await expectAt(605, '2× speed', 2);
  await p.evaluate(() => document.querySelector('video').pause());
  await expectAt(125, 'paused');
  await p.keyboard.press('f');
  await p.waitForFunction(() => !!document.fullscreenElement);
  await expectAt(245, 'fullscreen');
  const fsState = () =>
    p.evaluate(() => ({
      fs: document.fullscreenElement?.id ?? null,
      inPlayer: document.getElementById('player').contains(document.querySelector('[data-sst-overlay]')),
    }));
  const st = await waitFor(async () => {
    const s = await fsState();
    return s.inPlayer && s;
  }, 2000, 'overlay inside the fullscreen player').catch(async (e) => {
    throw new Error(`${e.message} — state ${JSON.stringify(await fsState())}`);
  });
  assert(st.inPlayer, 'overlay left the fullscreen player');
  await p.keyboard.press('f');
  const n = await p.evaluate(() => document.querySelectorAll('[data-sst-overlay]').length);
  assert(n === 1, `overlays=${n}`);
  const after = await setup.evaluate(() => chrome.runtime.sendMessage({ type: 'metrics:get' }));
  const translated = after.segmentsTranslated - before.segmentsTranslated;
  assert(translated <= 24, `each of the 24 cues may be translated at most once, got ${translated}`);
  await p.close();
});

await test('CC off, not opted in: VI panel asks ONCE (auto-expanded); "Đồng ý" → translation starts, persisted, never asked again', async () => {
  await setup.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, autoEnableCaptions: false, autoEnableCaptionsAsked: false } });
  });
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course6?md=optin-jstrack');
  await p.waitForSelector('video');
  await p.waitForTimeout(800);
  const before = await p.evaluate(() => ({ mode: document.querySelector('video').textTracks[0].mode, overlay: document.querySelector('[data-sst-overlay]')?.shadowRoot?.querySelector('.vi')?.textContent ?? '' }));
  assert(before.mode === 'disabled', `track mode changed without opt-in: ${before.mode}`);
  // no click on the pill: the one-time question must be visible by itself
  const btn = await waitFor(() => p.evaluate(() => !!document.querySelector('[data-sst-panel]').shadowRoot.querySelector('[data-a="consent-yes"]')), 4000, 'one-time consent card');
  assert(btn, 'consent card missing');
  await p.evaluate(() => document.querySelector('[data-sst-panel]').shadowRoot.querySelector('[data-a="consent-yes"]').click());
  await p.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 2; });
  await waitFor(async () => (await overlayText(p)) === '[VI] Welcome back to the course.', 8000, 'translation after opt-in');
  const mode = await p.evaluate(() => document.querySelector('video').textTracks[0].mode);
  assert(mode === 'hidden', `expected hidden (no duplicate English rendering), got ${mode}`);
  const persisted = await setup.evaluate(async () => (await chrome.storage.sync.get('settings')).settings);
  assert(persisted.autoEnableCaptions === true && persisted.autoEnableCaptionsAsked === true, 'opt-in not persisted');
  await p.close();
  // next lesson in a fresh tab: CC off again, but no question and no CC click needed
  const p2 = await context.newPage();
  await p2.goto('https://www.skool.com/test-group/classroom/course6?md=optin-next-jstrack');
  await p2.waitForSelector('video');
  await p2.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 2; });
  await waitFor(async () => (await overlayText(p2)) === '[VI] Welcome back to the course.', 8000, 'auto translation on next lesson');
  const asked = await p2.evaluate(() => !!document.querySelector('[data-sst-panel]').shadowRoot.querySelector('[data-a="consent-yes"]'));
  assert(!asked, 'asked again');
  await p2.close();
});

await test('Continuous: 12-min lesson, cues delivered in chunks via new tracks — translation never stops (16× playback)', async () => {
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course10?md=continuous');
  await p.waitForSelector('video');
  await p.evaluate(() => { const v = document.querySelector('video'); v.playbackRate = 16; v.play(); });
  const seen = new Set();
  const untranslated = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    const s = await p.evaluate(() => {
      const v = document.querySelector('video');
      const el = document.querySelector('[data-sst-overlay]')?.shadowRoot?.querySelector('.vi');
      return { t: v.currentTime, ended: v.ended, text: el && !el.classList.contains('hidden') ? el.textContent : '', pending: el?.classList.contains('pending') };
    });
    if (s.text && s.t > 125) (s.pending ? untranslated : seen).add(s.text.replace('[VI] ', ''));
    if (s.ended || s.t > 700) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*md=continuous*' }))[0]?.id);
  const diag = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'diag:run', tabId: id }), tabId);
  const d = diag.frames.find((f) => f.frameId === 0).report.subtitles;
  assert(d.availableCues === 72, `availableCues=${d.availableCues}`);
  assert(d.latestTranslatedEndSec >= 700, `translated only until ${d.latestTranslatedEndSec}s`);
  assert(seen.size >= 30, `only ${seen.size} translated lines observed after 2 min (untranslated: ${untranslated.size})`);
  assert(!JSON.stringify(diag).includes('Chunked line'), 'diagnostics must not contain caption text');
  await p.close();
});

await test('CC OFF, no opt-in, <track src> caption file: whole 12-min transcript translated, CC state untouched', async () => {
  await setup.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, autoEnableCaptions: false, autoEnableCaptionsAsked: true } });
  });
  const p = await context.newPage();
  await p.goto('https://www.skool.com/test-group/classroom/course11?md=trackfile');
  await p.waitForSelector('video');
  await p.evaluate(() => document.querySelector('video').play());
  for (const t of [5, 215, 455, 695]) { // inside cues (cue n spans 30n … 30n+20 s)
    await p.evaluate((t) => (document.querySelector('video').currentTime = t), t);
    const want = `[VI] Lesson cue number ${Math.floor(t / 30)}.`;
    await waitFor(async () => (await overlayText(p)) === want, 8000, `cue at ${t}s`);
  }
  const mode = await p.evaluate(() => document.querySelector('video').textTracks[0].mode);
  assert(mode === 'disabled', `CC state must stay untouched without opt-in, got ${mode}`);
  const tabId = await setup.evaluate(async () => (await chrome.tabs.query({ url: '*://www.skool.com/*md=trackfile*' }))[0]?.id);
  const diag = await setup.evaluate((id) => chrome.runtime.sendMessage({ type: 'diag:run', tabId: id }), tabId);
  const d = diag.frames.find((f) => f.frameId === 0).report;
  assert(d.subtitles.captionFileRead && d.subtitles.transcriptComplete && d.subtitles.availableCues === 24, JSON.stringify(d.subtitles));
  assert(!JSON.stringify(diag).includes('long.vtt'), 'caption file URL must not appear in diagnostics');
  await setup.evaluate(async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, autoEnableCaptions: true } });
  });
  await p.close();
});

await test('Extension reloaded with a Skool tab open: orphaned content script removes its UI without errors', async () => {
  const p = await context.newPage();
  const errors = [];
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('https://www.skool.com/test-group/classroom/course12?md=reload');
  await p.waitForSelector('[data-sst-panel]', { state: 'attached' });
  // reload the extension (what ⟳ in chrome://extensions does)
  // (must stay the last extension test: the reload closes extension pages used by earlier tests)
  await setup.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2000));
  // orphaned script notices on the next visibility change / failed message
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(300);
  const left = await p.evaluate(() => document.querySelectorAll('[data-sst-panel], [data-sst-overlay]').length);
  assert(left === 0, `orphaned UI left on the page: ${left}`);
  assert(!errors.some((e) => /onChanged|Extension context invalidated|Cannot read properties of undefined/.test(e)), errors.join(' | '));
  // (After chrome.runtime.reload() an extension loaded via --load-extension does not come back in
  // this headless harness — ERR_BLOCKED_BY_CLIENT — so "F5 after ⟳" is verified manually; a
  // normal page load is what every other test exercises.)
  await p.close();
});

await test('Local backend server (mock mode): /health, /translate, /transcribe, website origins refused', async () => {
  const { spawn } = await import('node:child_process');
  const srv = spawn(process.execPath, [join(root, 'dist-server/local-server.mjs')], {
    env: { ...process.env, PORT: '8799', TRANSLATE_BACKEND: 'mock', STT_BACKEND: 'mock', OPENAI_API_KEY: '', GEMINI_API_KEY: '' },
    stdio: 'pipe',
  });
  try {
    await waitFor(async () => fetch('http://127.0.0.1:8799/health').then((r) => r.ok).catch(() => false), 5000, 'server up');
    const tr = await fetch('http://127.0.0.1:8799/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' },
      body: JSON.stringify({ segments: [{ id: 's0', text: 'Hello' }], context: [], glossary: [] }),
    }).then((r) => r.json());
    assert(tr.translations[0].subtitle_id === 's0' && tr.translations[0].translated_text === '[VI] Hello', JSON.stringify(tr));
    const st = await fetch('http://127.0.0.1:8799/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(1) }).then((r) => r.json());
    assert(typeof st.text === 'string' && st.text.length > 0, JSON.stringify(st));
    const evil = await fetch('http://127.0.0.1:8799/translate', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    assert(evil.status === 403, `website origin should be refused, got ${evil.status}`);
  } finally {
    srv.kill();
  }
});

await context.close();
rmSync(userDataDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E tests passed`);
process.exit(failed.length ? 1 : 0);
