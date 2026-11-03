import type { BackgroundRequest, ContentMessage, StatusResponse } from '../shared/messages';
import { loadSecrets, loadSettings } from '../shared/settings';
import { isSkoolUrl, safeUrl } from '../players/adapters';
import { originPattern } from '../shared/util';
import { TranslationCache } from '../cache/translationCache';
import { TranslationService } from '../translation/service';
import { TabRegistry } from './tabRegistry';
import { AudioSessionManager } from './audioSession';
import { checkBackends } from '../translation/health';

/*
 * MV3 service worker. All listeners are registered synchronously at the top
 * level so events wake the worker correctly after it has been terminated.
 * Durable state lives in chrome.storage.session (tab status, audio session)
 * and IndexedDB (translation cache) — nothing important is memory-only.
 */

const OFFSCREEN_URL = 'audio/offscreen.html';

const cache = new TranslationCache();
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
  hasEndpointPermission,
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
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Process user-approved tab audio for live speech-to-text subtitles.',
      })
      .then(() => new Promise<void>((r) => setTimeout(r, 50)))
      .finally(() => (offscreenCreating = null));
  }
  await offscreenCreating;
}

async function closeOffscreen(): Promise<void> {
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
      return { results: await service.translateUnits(msg.videoKey, msg.units, msg.context, msg.priority) };
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

chrome.tabs.onRemoved.addListener((tabId) => {
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

chrome.runtime.onInstalled.addListener(() => {
  void cache.prune().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  void cache.prune().catch(() => undefined);
});


export {};
