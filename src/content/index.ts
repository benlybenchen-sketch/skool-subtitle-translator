import type { ContentMessage, HelloResponse, TranslateResponse } from '../shared/messages';
import { isContextInvalidated, sendToBackground } from '../shared/messages';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/types';
import { adapterForFrame, isSkoolUrl } from '../players/adapters';
import { VideoDetector, type DetectionResult } from '../players/detector';
import { collectDiagnostics } from './diagnostics';
import { NavigationWatcher } from '../skool/navigation';
import { SubtitleController, type ControllerBridge } from './controller';
import { ControlPanel } from './panel';

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
    async translate(videoKey, units, context) {
      const res = await sendToBackground<TranslateResponse>({ type: 'translate:units', videoKey, units, context }, { retries: 3 });
      return res.results;
    },
    cancel(videoKey) {
      sendToBackground({ type: 'translate:cancel', videoKey }, { retries: 0 }).catch(() => undefined);
    },
    reportStatus(status) {
      sendToBackground({ type: 'frame:status', status }, { retries: 2 }).catch(() => undefined);
    },
  };

  const controller = new SubtitleController({ doc: document, isTop, adapter, bridge, settings });
  const detector = new VideoDetector(document, adapter);
  let panel: ControlPanel | null = null;

  const nav = new NavigationWatcher(window, () => {
    controller.reset();
    detector.scan();
  });

  const info = (r: DetectionResult) => ({
    embeds: [...new Set(r.embeds.map((e) => e.provider))],
    videos: r.videos.length,
    audios: r.audios.length,
  });
  detector.onChange((r, changed) => {
    nav.check();
    if (changed) controller.setTarget(r.primary, r.anchor);
    controller.setDetectionInfo(info(r));
  });

  const r = detector.start();
  controller.setTarget(r.primary, r.anchor);
  controller.setDetectionInfo(info(r));
  controller.announce();
  nav.start();

  if (isTop) {
    panel = new ControlPanel(
      document,
      settings,
      (patch) => void saveSettings(patch),
      () => void sendToBackground({ type: 'audio:stop' }).catch(() => undefined),
    );
    if (settings.showPanel) panel.mount();
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
        sendResponse(collectDiagnostics(document, detector.result, controller.status()));
        return;
    }
    sendResponse({ ok: true });
  };
  chrome.runtime.onMessage.addListener(onMessage);

  const teardown = () => {
    detector.stop();
    nav.stop();
    controller.destroy();
    panel?.unmount();
    offSettings();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context gone */
    }
    w[GUARD] = false;
  };

  // Tell the background when this frame goes away (lesson iframe swapped, tab navigated).
  window.addEventListener('pagehide', () => {
    if (!isContextInvalidated()) sendToBackground({ type: 'frame:gone' }, { retries: 0 }).catch(() => undefined);
  });

  // Extension reloaded/updated → this script is orphaned; clean up our DOM.
  const orphanCheck = () => {
    if (isContextInvalidated()) {
      teardown();
      document.removeEventListener('visibilitychange', orphanCheck);
    }
  };
  document.addEventListener('visibilitychange', orphanCheck);
}

main().catch((e) => {
  if (!isContextInvalidated(e)) console.warn('[Skool VI Subtitles]', e);
});
