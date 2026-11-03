import type { SubtitleController } from './controller';
import type { VideoDetector, DetectionResult } from '../players/detector';
import { NavigationWatcher } from '../skool/navigation';

/**
 * Lesson lifecycle manager (one per frame).
 * - Lesson identity = route + `md` lesson id (see lessonKey).
 * - On change: dispose the old session (listeners, sources, scheduler → stale jobs cancelled,
 *   overlay cleared; completed translations stay in the IndexedDB cache) and ALWAYS re-target,
 *   because Skool may reuse the same <video> element.
 * - Signals: Navigation API, popstate/hashchange, DOM media mutations, and the background's
 *   tabs.onUpdated URL change (`nav:check`). No polling.
 */
export function createLessonLifecycle(win: Window, controller: SubtitleController, detector: VideoDetector) {
  const nav = new NavigationWatcher(win, () => {
    controller.reset();
    const r = detector.scan();
    controller.setTarget(r.primary, r.anchor, true);
  });
  const offDetector = detector.onChange((r: DetectionResult, changed: boolean) => {
    nav.check();
    if (changed) controller.setTarget(r.primary, r.anchor, controller.currentVideoKey === null);
    controller.setDetectionInfo({ embeds: [...new Set(r.embeds.map((e) => e.provider))], videos: r.videos.length, audios: r.audios.length });
  });
  return {
    nav,
    start(): void {
      const r = detector.start();
      controller.setTarget(r.primary, r.anchor);
      controller.setDetectionInfo({ embeds: [...new Set(r.embeds.map((e) => e.provider))], videos: r.videos.length, audios: r.audios.length });
      controller.announce();
      nav.start();
    },
    stop(): void {
      offDetector();
      detector.stop();
      nav.stop();
    },
  };
}
