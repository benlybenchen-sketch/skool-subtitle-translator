import type { ContentMessage, HelloResponse, TranslateResponse } from '../shared/messages';
import { isContextInvalidated, sendToBackground } from '../shared/messages';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/types';
import { adapterForFrame, isSkoolUrl } from '../players/adapters';
import { VideoDetector } from '../players/detector';
import { createLessonLifecycle } from './lifecycle';
import { collectDiagnostics } from './diagnostics';
import { SubtitleController, type ControllerBridge } from './controller';
import { ControlPanel } from './panel';
import { LearningPanel, type PanelTab } from './learningPanel';
import { createVideoSource } from './learningSource';

const GUARD = '__sstContentScript__';

async function main(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  // Prevent double initialisation (e.g. programmatic re-injection).
  if (w[GUARD]) return;
  w[GUARD] = true;

  const isTop = window.top === window;
  const loc = new URL(location.href);
  if (isTop && !isSkoolUrl(loc)) return;

  // Player iframes only activate when the tab's top-level page is Skool.
  // The background verifies this from the tab URL (ancestorOrigins can be masked).
  let hello: HelloResponse;
  try {
    hello = await sendToBackground<HelloResponse>({ type: 'frame:hello', isTop });
  } catch {
    return;
  }
  if (!hello?.active) return;

  let settings: Settings = await loadSettings();
  const adapter = adapterForFrame(loc);

  const bridge: ControllerBridge = {
    async translate(videoKey, units, context, priority) {
      try {
        const res = await sendToBackground<TranslateResponse>({ type: 'translate:units', videoKey, units, context, priority }, { retries: 3 });
        return res.results;
      } catch (e) {
        orphanCheck();
        throw e;
      }
    },
    cancel(videoKey) {
      sendToBackground({ type: 'translate:cancel', videoKey }, { retries: 0 }).catch(orphaned);
    },
    reportStatus(status) {
      sendToBackground({ type: 'frame:status', status }, { retries: 2 }).catch(orphaned);
    },
  };

  const controller = new SubtitleController({ doc: document, isTop, adapter, bridge, settings });
  const detector = new VideoDetector(document, adapter);
  let panel: ControlPanel | null = null;
  let learning: LearningPanel | null = null;

  const lifecycle = createLessonLifecycle(window, controller, detector);
  const nav = lifecycle.nav;
  lifecycle.start();

  if (isTop) {
    panel = new ControlPanel(
      document,
      settings,
      (patch) => void saveSettings(patch).catch(orphaned),
      () => void sendToBackground({ type: 'audio:stop' }).catch(() => undefined),
      () => void sendToBackground({ type: 'session:start' }).catch(() => undefined),
      (tab) => learning?.toggle(tab),
    );
    if (settings.showPanel) panel.mount();
    controller.onOverlayContainerChange((el) => panel?.follow(el));
    // Transcript / notes / export drawer — opened only by the user (VI control or popup).
    const source = createVideoSource(document, controller, (op) => sendToBackground({ type: 'learning:remote', op }, { retries: 1 }));
    learning = new LearningPanel(document, source);
  }

  const offSettings = onSettingsChanged((s) => {
    settings = s;
    controller.updateSettings(s);
    panel?.setSettings(s);
    if (panel) s.showPanel ? panel.mount() : panel.unmount();
  });

  const onMessage = (msg: ContentMessage, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    switch (msg.type) {
      case 'frame:ping':
        sendResponse({ ok: true });
        return;
      case 'live:segment':
        controller.onLiveSegment(msg);
        break;
      case 'audio:state':
        controller.setAudioState(msg.active, msg.primary, msg.error);
        break;
      case 'manual:cues':
        controller.onManualCues(msg.cues, msg.label);
        break;
      case 'tab:status:changed':
        panel?.setStatus(msg.status);
        break;
      case 'diag:collect':
        sendResponse({
          ...collectDiagnostics(document, detector.result, controller.status()),
          subtitles: controller.debugState(),
          detector: { observedShadowRoots: detector.observedShadowRoots, lastScanAgoMs: Date.now() - detector.lastScanAt },
          trackLog: controller.trackLog(),
        });
        return;
      case 'nav:check':
        nav.check(); // URL change reported by the background (tabs.onUpdated)
        break;
      case 'session:start':
        controller.startSession();
        break;
      case 'learning:open':
        learning?.show(msg.tab as PanelTab);
        break;
      case 'learning:op': {
        const op = msg.op;
        if (op.kind === 'get') {
          sendResponse(controller.transcript(op.title));
          return;
        }
        if (op.kind === 'seek') {
          sendResponse({ ok: controller.seek(op.sec) });
          return;
        }
        controller.completeTranslations(Math.min(op.timeoutMs, 300_000)).then(sendResponse, () => sendResponse(null));
        return true; // async response
      }
    }
    sendResponse({ ok: true });
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // Runs once; every step is guarded because after an extension reload the chrome.* APIs of
  // this (orphaned) script are gone — the UI must still be removed from the page.
  let tornDown = false;
  teardownRef = () => {
    if (tornDown) return;
    tornDown = true;
    const safe = (f: () => void) => {
      try {
        f();
      } catch {
        /* extension context gone */
      }
    };
    safe(() => lifecycle.stop());
    safe(() => controller.destroy());
    safe(() => panel?.destroy());
    safe(() => learning?.destroy());
    safe(() => offSettings());
    safe(() => chrome.runtime.onMessage.removeListener(onMessage));
    document.removeEventListener('visibilitychange', orphanCheck);
    w[GUARD] = false;
  };

  // Tell the background when this frame goes away (lesson iframe swapped, tab navigated).
  window.addEventListener('pagehide', () => {
    if (!isContextInvalidated()) sendToBackground({ type: 'frame:gone' }, { retries: 0 }).catch(() => undefined);
  });

  // Extension reloaded/updated → this script is orphaned; clean up our DOM.
  document.addEventListener('visibilitychange', orphanCheck);
}

let teardownRef: (() => void) | null = null;
/** Called on visibility changes and whenever a message to the extension fails. */
function orphanCheck(): void {
  if (isContextInvalidated()) teardownRef?.();
}
function orphaned(): void {
  orphanCheck();
}

main().catch((e) => {
  if (!isContextInvalidated(e)) console.warn('[Skool VI Subtitles]', e);
});
