import type { LearningOp } from '../shared/messages';
import type { Transcript } from '../transcript/model';
import type { LearningSource } from './learningPanel';

/** Lesson title: first visible heading of the main content, else the document title. */
export function lessonTitle(doc: Document): string {
  const h = [...doc.querySelectorAll<HTMLElement>('main h1, [role=main] h1, h1')].find(
    (e) => !e.closest('[data-sst-panel],[data-sst-learning],nav,header') && (e.textContent ?? '').trim(),
  );
  const t = (h?.textContent ?? doc.title ?? '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 160) || 'lesson';
}

/** What the video source needs from the subtitle controller. */
export interface VideoTranscriptHost {
  transcript(title: string): Transcript | null;
  seek(sec: number): boolean;
  onActiveSegment(cb: (id: string | null) => void): () => void;
  completeTranslations(timeoutMs?: number, onProgress?: (done: number, total: number) => void): Promise<{ done: number; total: number }>;
}

/**
 * Transcript source for the top-frame panel. Uses this frame's controller when it owns the
 * video (native Skool player); otherwise asks the frame that owns it (player iframe) through
 * the background. Remote reads are cached and refreshed asynchronously, so `transcript()`
 * stays synchronous for the panel.
 */
export function createVideoSource(
  doc: Document,
  local: VideoTranscriptHost,
  remote: ((op: LearningOp) => Promise<unknown>) | null,
): LearningSource & { refreshRemote(): Promise<void> } {
  let remoteT: Transcript | null = null;
  let inflight: Promise<void> | null = null;
  const refreshRemote = (): Promise<void> => {
    if (!remote) return Promise.resolve();
    inflight ??= remote({ kind: 'get', title: lessonTitle(doc) })
      .then((r) => {
        remoteT = r && typeof r === 'object' && 'segments' in r ? (r as Transcript) : null;
      })
      .catch(() => undefined)
      .finally(() => (inflight = null));
    return inflight;
  };
  const localT = () => local.transcript(lessonTitle(doc));
  const useLocal = () => !!localT() || !remote;
  return {
    kind: () => 'video',
    transcript() {
      const t = localT();
      if (t) return t;
      void refreshRemote();
      return remoteT;
    },
    seek(sec) {
      if (useLocal()) local.seek(sec);
      else void remote!({ kind: 'seek', sec }).catch(() => undefined);
    },
    onActive: (cb) => local.onActiveSegment(cb),
    async completeTranslations(onProgress) {
      if (useLocal()) return local.completeTranslations(180_000, onProgress);
      const r = (await remote!({ kind: 'complete', timeoutMs: 180_000 }).catch(() => null)) as { done: number; total: number } | null;
      await refreshRemote();
      return r ?? { done: 0, total: 0 };
    },
    refreshRemote,
    prefetch: () => (localT() ? Promise.resolve() : refreshRemote()),
  };
}
