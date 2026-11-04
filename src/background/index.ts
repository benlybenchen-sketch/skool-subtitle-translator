import type { BackgroundRequest, ContentMessage, StatusResponse } from '../shared/messages';
import { loadSecrets, loadSettings } from '../shared/settings';
import { isSkoolUrl, safeUrl } from '../players/adapters';
import { originPattern } from '../shared/util';
import { TranslationCache } from '../cache/translationCache';
import { TranslationService } from '../translation/service';
import { TabRegistry } from './tabRegistry';
import { AudioSessionManager } from './audioSession';
import { checkBackends } from '../translation/health';
import { loadEffectiveGlossary } from '../shared/glossaryStore';
import { UsageLedger } from './usageLedger';
import { DEFAULT_PRICES, loadPricing, savePricing } from '../translation/pricing';
import { NotesManager } from './notesManager';
import { TranscriptStore } from '../transcript/store';
import { buildStudyPack } from '../offline/studyPack';
import { arrayBufferToBase64 } from '../shared/util';
import { DubbingService } from './dubbing';
import { TtsLedger } from '../tts/ttsLedger';

/*
 * MV3 service worker. All listeners are registered synchronously at the top
 * level so events wake the worker correctly after it has been terminated.
 * Durable state lives in chrome.storage.session (tab status, audio session)
 * and IndexedDB (translation cache) — nothing important is memory-only.
 */

const OFFSCREEN_URL = 'audio/offscreen.html';

const cache = new TranslationCache();
const ledger = new UsageLedger(chrome.storage.local, chrome.storage.session, loadPricing);
const registry = new TabRegistry(chrome.storage.session);

async function hasEndpointPermission(endpoint: string): Promise<boolean> {
  const pattern = originPattern(endpoint);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

const service = new TranslationService({
  cache,
  getSettings: loadSettings,
  getSecrets: loadSecrets,
  getGlossaryText: (s) => loadEffectiveGlossary(s.glossary),
  onAccounting: (e, meta) => void ledger.record(e, meta),
  hasEndpointPermission,
});

const lessons = new TranscriptStore();

/** Tabs with a live dubbing session (keeps the offscreen player open). */
const dubTabs = new Set<number>();
const ttsLedger = new TtsLedger(chrome.storage.local, chrome.storage.session);
const dubbing = new DubbingService({
  getSettings: loadSettings,
  getSecrets: loadSecrets,
  hasEndpointPermission,
  ensureOffscreen,
  sendOffscreen: (m) => chrome.runtime.sendMessage(m),
  sendToFrame: (tabId, frameId, m) => sendToFrame(tabId, frameId, m),
  ledger: ttsLedger,
  tts: chrome.tts,
  tabs: chrome.tabs,
  session: chrome.storage.session,
});

const notes = new NotesManager({
  storage: chrome.storage.local,
  complete: (req, o) => service.complete(req, o),
  activeModel: () => service.activeModel(),
  glossary: async () => loadEffectiveGlossary((await loadSettings()).glossary),
});

async function sendToFrame(tabId: number, frameId: number | null, msg: ContentMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: frameId ?? 0 });
  } catch {
    /* frame gone */
  }
}

let offscreenCreating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Process user-approved tab audio for live speech-to-text subtitles, and play Vietnamese dubbing audio separately from the tab.',
      })
      .then(() => new Promise<void>((r) => setTimeout(r, 50)))
      .finally(() => (offscreenCreating = null));
  }
  await offscreenCreating;
}

async function closeOffscreen(): Promise<void> {
  if (dubTabs.size) return; // the dubbing player lives in the same document
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) await chrome.offscreen.closeDocument();
}

const audio = new AudioSessionManager({
  registry,
  getSettings: loadSettings,
  getSecrets: loadSecrets,
  ensureOffscreen,
  closeOffscreen,
  sendOffscreen: async (m) => {
    await chrome.runtime.sendMessage({ target: 'offscreen', ...m });
  },
  sendToFrame,
  broadcast: (tabId, msg) => sendToFrame(tabId, 0, msg),
  translate: async (videoKey, text, id, context) => {
    const [r] = await service.translateUnits(videoKey, [{ id, text }], context);
    return r;
  },
  setBadge: (tabId, text) => {
    void chrome.action.setBadgeText({ tabId, text });
    if (text) void chrome.action.setBadgeBackgroundColor({ tabId, color: '#d1242f' });
  },
  hasEndpointPermission,
  sessionStore: chrome.storage.session,
});

// Push aggregated status to the top frame (floating panel), coalesced.
const statusTimers = new Map<number, ReturnType<typeof setTimeout>>();
function pushStatus(tabId: number): void {
  clearTimeout(statusTimers.get(tabId));
  statusTimers.set(
    tabId,
    setTimeout(() => {
      statusTimers.delete(tabId);
      void sendToFrame(tabId, 0, { type: 'tab:status:changed', status: registry.get(tabId) });
    }, 200),
  );
}

/** Remove frames that no longer answer (navigated iframes). */
async function pruneFrames(tabId: number): Promise<void> {
  const st = registry.get(tabId);
  await Promise.all(
    st.frames.map(async (f) => {
      try {
        await Promise.race([
          chrome.tabs.sendMessage(tabId, { type: 'frame:ping' } satisfies ContentMessage, { frameId: f.frameId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 400)),
        ]);
      } catch {
        registry.removeFrame(tabId, f.frameId);
      }
    }),
  );
}

async function handle(msg: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await registry.ready();
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  switch (msg.type) {
    case 'frame:hello': {
      if (tabId === undefined) return { active: false, frameId };
      const topUrl = safeUrl(sender.tab?.url ?? (frameId === 0 ? sender.url : undefined));
      const isSkool = !!topUrl && isSkoolUrl(topUrl);
      if (frameId === 0) registry.setSkool(tabId, isSkool);
      return { active: isSkool, frameId };
    }
    case 'frame:status':
      if (tabId === undefined) return null;
      registry.updateFrame(tabId, frameId, msg.status);
      pushStatus(tabId);
      return { ok: true };
    case 'frame:gone':
      if (tabId !== undefined) {
        registry.removeFrame(tabId, frameId);
        pushStatus(tabId);
      }
      return { ok: true };
    case 'translate:units':
      return { results: await service.translateUnits(msg.videoKey, msg.units, msg.context, msg.priority, msg.format === 'markup' ? 'markup' : 'subtitle') };
    case 'translate:cancel':
      service.cancel(msg.videoKey);
      return { ok: true };
    case 'translate:test': {
      const [r] = await service.translateUnits(`test:${Date.now()}`, [{ id: 't', text: 'Welcome back! Today we will set up our first Facebook Ads campaign with a $50 daily budget.' }], []);
      return r;
    }
    case 'tab:status': {
      await pruneFrames(msg.tabId);
      const res: StatusResponse = {
        status: registry.get(msg.tabId),
        metrics: service.metrics.snapshot(),
        cache: await cache.stats().catch(() => ({ entries: 0, approxBytes: 0 })),
      };
      return res;
    }
    case 'backend:check':
      return checkBackends(await loadSettings(), await loadSecrets(), { hasPermission: hasEndpointPermission });
    case 'diag:run': {
      // Collect read-only diagnostics from every frame where our content script runs.
      await pruneFrames(msg.tabId);
      const ids = new Set([0, ...registry.get(msg.tabId).frames.map((f) => f.frameId)]);
      const frames = await Promise.all(
        [...ids].map(async (frameId) => {
          try {
            return { frameId, report: await chrome.tabs.sendMessage(msg.tabId, { type: 'diag:collect' } satisfies ContentMessage, { frameId }) };
          } catch (e) {
            return { frameId, error: (e as Error).message };
          }
        }),
      );
      return { collectedAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version, frames };
    }
    case 'usage:get':
      return { usage: await ledger.snapshot(), pricing: await loadPricing(), defaultPricing: DEFAULT_PRICES };
    case 'usage:reset':
      await ledger.reset();
      return { ok: true };
    case 'pricing:set':
      await savePricing(msg.rows);
      return { ok: true };
    case 'metrics:get':
      return service.metrics.snapshot();
    case 'cache:stats':
      return cache.stats();
    case 'cache:clear':
      await cache.clear();
      return { ok: true };
    case 'audio:start':
      try {
        await audio.start(msg.tabId, msg.streamId);
        pushStatus(msg.tabId);
        return { ok: true };
      } catch (e) {
        registry.setAudio(msg.tabId, { active: false, error: (e as Error).message });
        return { ok: false, error: (e as Error).message };
      }
    case 'audio:stop': {
      const t = msg.tabId ?? tabId;
      await audio.stop(t);
      if (t !== undefined) pushStatus(t);
      return { ok: true };
    }
    case 'manual:cues': {
      const primary = registry.primaryFrame(msg.tabId);
      await sendToFrame(msg.tabId, primary, { type: 'manual:cues', cues: msg.cues, label: msg.label });
      return { ok: true, frameId: primary };
    }
    case 'session:start': {
      if (tabId === undefined) return { ok: false };
      const st = registry.get(tabId);
      await Promise.all([0, ...st.frames.map((f) => f.frameId)].map((f) => sendToFrame(tabId, f, { type: 'session:start' })));
      return { ok: true };
    }
    case 'learning:remote': {
      // Only the Skool tab's own top frame may ask; forwarded to the frame that owns the video.
      if (tabId === undefined || frameId !== 0) return { ok: false };
      const primary = registry.primaryFrame(tabId);
      if (primary === null || primary === 0) return { ok: false };
      try {
        return await chrome.tabs.sendMessage(tabId, { type: 'learning:op', op: msg.op } satisfies ContentMessage, { frameId: primary });
      } catch {
        return { ok: false };
      }
    }
    case 'notes:get':
      return { record: await notes.get(msg.lessonId), running: notes.isRunning(msg.lessonId) };
    case 'notes:model':
      return service.activeModel();
    case 'notes:cancel':
      notes.cancel(msg.lessonId);
      return { ok: true };
    case 'notes:save':
      return { record: await notes.saveEdit(msg.lessonId, msg.editedMarkdown) };
    case 'notes:generate': {
      if (tabId === undefined) return { ok: false };
      const lessonId = msg.transcript?.lessonId;
      const record = await notes.generate(msg.transcript, (done, total) =>
        void sendToFrame(tabId, 0, { type: 'notes:progress', lessonId, done, total }),
      );
      return { record };
    }
    case 'learning:open':
      await sendToFrame(msg.tabId, 0, { type: 'learning:open', tab: msg.tab });
      return { ok: true };
    case 'lesson:get':
      return { record: await lessons.get(msg.lessonId) };
    case 'lesson:put':
      await lessons.put(msg.record);
      return { ok: true };
    case 'lesson:list':
      return { lessons: await lessons.list() };
    case 'lesson:delete':
      await lessons.delete(msg.lessonId);
      return { ok: true };
    case 'lesson:clear':
      return { removed: await lessons.clear(msg.includeOffline) };
    case 'lesson:pack': {
      const rec = await lessons.get(msg.lessonId);
      if (!rec) return { __error: 'Bài này chưa được lưu.' };
      const glossary = await loadEffectiveGlossary((await loadSettings()).glossary).catch(() => '');
      const pack = buildStudyPack(rec, glossary);
      return { name: pack.name, files: pack.files, base64: arrayBufferToBase64(pack.bytes.slice().buffer as ArrayBuffer) };
    }
    case 'video:offer':
      // Only URLs the page itself offered (owner links / plain files with browser download); the
      // user starts the download on the extension page (permission prompt + save dialog).
      await chrome.storage.session.set({ [`dlOffer:${msg.lessonId}`]: { lessonId: msg.lessonId, title: msg.title, options: msg.options.filter((o) => /^https:\/\//.test(o.url)).slice(0, 10) } });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`reader/reader.html#dl=${encodeURIComponent(msg.lessonId)}`) });
      return { ok: true };
    case 'video:offer:get':
      return { offer: (await chrome.storage.session.get(`dlOffer:${msg.lessonId}`))[`dlOffer:${msg.lessonId}`] ?? null };
    case 'reader:open':
      await chrome.tabs.create({ url: chrome.runtime.getURL(`reader/reader.html${msg.lessonId ? `#${encodeURIComponent(msg.lessonId)}` : ''}`) });
      return { ok: true };
    case 'lesson:usage': {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      return { usage: est?.usage ?? null, quota: est?.quota ?? null, lessons: (await lessons.list()).length };
    }
    case 'dub:voices':
      return dubbing.voices(msg.provider);
    case 'dub:speak':
      if (tabId === undefined) return { ok: false };
      dubTabs.add(tabId);
      return dubbing.speakChrome(tabId, frameId, msg);
    case 'dub:prepare':
      if (tabId !== undefined) dubTabs.add(tabId);
      return dubbing.prepare(msg);
    case 'dub:play':
      if (tabId === undefined) return { ok: false };
      dubTabs.add(tabId);
      await dubbing.play(tabId, frameId, msg);
      return { ok: true };
    case 'dub:control':
      await dubbing.control(msg.action, msg.token);
      if (msg.final && tabId !== undefined) dubTabs.delete(tabId);
      return { ok: true };
    case 'dub:tabmute':
      if (tabId === undefined) return { ok: false };
      return dubbing.tabMute(tabId, msg.mute);
    case 'dub:recover':
      if (tabId !== undefined && frameId === 0) await dubbing.recover(tabId);
      return { ok: true };
    case 'dub:usage':
      return { usage: await ttsLedger.snapshot(), cache: await dubbing.cache.stats().catch(() => ({ entries: 0, bytes: 0 })) };
    case 'dub:usage:reset':
      await ttsLedger.reset();
      return { ok: true };
    case 'dub:cache:clear':
      await dubbing.cache.clear();
      return { ok: true };
    case 'offscreen:dub':
      dubbing.onOffscreen(msg);
      return { ok: true };
    case 'offscreen:ready':
      return { ok: true };
    case 'offscreen:started': {
      const a = audio.active;
      if (a) pushStatus(a.tabId);
      return { ok: true };
    }
    case 'offscreen:chunk':
      void audio.onChunk(msg).then(() => {
        const a = audio.active;
        if (a) pushStatus(a.tabId);
      });
      return { ok: true };
    case 'offscreen:error':
      await audio.onOffscreenError(msg.sessionId, msg.error);
      return { ok: true };
    case 'offscreen:stopped':
      await audio.onOffscreenStopped(msg.sessionId, msg.reason);
      return { ok: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest & { target?: string }, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'offscreen') return false;
  // Only accept messages from this extension (content scripts, popup, options, offscreen).
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(sendResponse, (e: Error) => sendResponse({ __error: e.message }));
  return true;
});

// Offscreen dubbing player → worker events (see audio/offscreen.ts for why a Port is used).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sst-offscreen-dub' || port.sender?.id !== chrome.runtime.id) return;
  port.onMessage.addListener((m: { type?: string; event?: 'started' | 'ended' | 'error'; token?: string; segId?: string; error?: string }) => {
    if (m?.type === 'offscreen:dub' && m.event && m.token && m.segId) dubbing.onOffscreen({ event: m.event, token: m.token, segId: m.segId, error: m.error });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dubTabs.delete(tabId);
  void dubbing.onTabRemoved(tabId);
  void audio.stop(tabId, 'tab-closed');
  registry.removeTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Full (non-SPA) navigation away from Skool ends Audio Mode for that tab.
  if (!info.url) return;
  if (!isSkoolUrl(safeUrl(info.url) ?? new URL('about:blank'))) {
    void audio.stop(tabId, 'navigated');
    registry.removeTab(tabId);
  } else {
    // Skool SPA lesson change (pushState/replaceState also update the tab URL): tell the
    // content script to re-check its lesson identity. Uses existing host permission only.
    void sendToFrame(tabId, 0, { type: 'nav:check' });
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  void cache.prune().catch(() => undefined);
  // First install only: open Settings once so provider, consent and automation are set up once.
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  void cache.prune().catch(() => undefined);
});


export {};
