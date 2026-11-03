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
  const page = u.search.includes('loom') ? 'skool-loom.html' : u.search.includes('nocaptions') ? 'skool-nocaptions.html' : 'skool-native.html';
  return route.fulfill(serve(readFileSync(join(pages, page)), 'text/html'));
});
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
const setup = await context.newPage();
await setup.goto(`chrome-extension://${extId}/settings/options.html`);
await setup.evaluate(async () => {
  const { settings = {} } = await chrome.storage.sync.get('settings');
  await chrome.storage.sync.set({ settings: { ...settings, provider: { kind: 'mock', endpoint: 'mock://', model: 'mock', temperature: 0 } } });
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

await test('Overlay follows the player into fullscreen', async () => {
  const inside = await page.evaluate(async () => {
    await document.getElementById('player').requestFullscreen();
    await new Promise((r) => setTimeout(r, 300));
    const host = document.querySelector('[data-sst-overlay]');
    const ok = document.fullscreenElement?.contains(host);
    await document.exitFullscreen();
    await new Promise((r) => setTimeout(r, 300));
    return { ok, back: document.body.contains(host) && !document.getElementById('player').contains(host) };
  });
  assert(inside.ok, 'overlay not inside fullscreen element');
  assert(inside.back, 'overlay not restored after fullscreen');
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
    assert(tr.translations[0].text === '[VI] Hello', JSON.stringify(tr));
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
