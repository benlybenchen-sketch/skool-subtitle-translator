import type { AudioStatus, FrameStatus, TabStatus } from '../shared/types';

const STORAGE_KEY = 'tabRegistry';

interface TabRecord {
  isSkool: boolean;
  frames: Record<number, FrameStatus>;
  audio: AudioStatus;
}

export const emptyAudio = (): AudioStatus => ({ active: false, chunks: 0, droppedChunks: 0 });

export interface SessionStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Per-tab state aggregated from all frames. Persisted to chrome.storage.session
 * so it survives service-worker restarts (MV3 workers are short-lived).
 */
export class TabRegistry {
  private tabs = new Map<number, TabRecord>();
  private loaded: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: SessionStore) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const data = await this.store.get(STORAGE_KEY);
      const raw = (data[STORAGE_KEY] ?? {}) as Record<string, TabRecord>;
      for (const [k, v] of Object.entries(raw)) this.tabs.set(Number(k), v);
    } catch {
      /* first run */
    }
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const obj: Record<string, TabRecord> = {};
      for (const [k, v] of this.tabs) obj[k] = v;
      void this.store.set({ [STORAGE_KEY]: obj }).catch(() => undefined);
    }, 100);
  }

  /** Flush pending writes immediately (tests / shutdown). */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    const obj: Record<string, TabRecord> = {};
    for (const [k, v] of this.tabs) obj[k] = v;
    await this.store.set({ [STORAGE_KEY]: obj });
  }

  private rec(tabId: number): TabRecord {
    let r = this.tabs.get(tabId);
    if (!r) {
      r = { isSkool: false, frames: {}, audio: emptyAudio() };
      this.tabs.set(tabId, r);
    }
    return r;
  }

  setSkool(tabId: number, isSkool: boolean): void {
    this.rec(tabId).isSkool = isSkool;
    this.persist();
  }

  updateFrame(tabId: number, frameId: number, status: Omit<FrameStatus, 'frameId'>): void {
    this.rec(tabId).frames[frameId] = { ...status, frameId };
    this.persist();
  }

  removeFrame(tabId: number, frameId: number): void {
    const r = this.tabs.get(tabId);
    if (!r) return;
    delete r.frames[frameId];
    if (frameId === 0) r.frames = {};
    this.persist();
  }

  setAudio(tabId: number, patch: Partial<AudioStatus>): AudioStatus {
    const r = this.rec(tabId);
    r.audio = { ...r.audio, ...patch };
    this.persist();
    return r.audio;
  }

  removeTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.persist();
  }

  tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  /** Frame that should display subtitles: largest real <video>, else the top frame. */
  primaryFrame(tabId: number): number | null {
    const r = this.tabs.get(tabId);
    if (!r) return null;
    const frames = Object.values(r.frames);
    const videos = frames.filter((f) => f.targetKind === 'video').sort((a, b) => b.targetArea - a.targetArea);
    if (videos.length) return videos[0].frameId;
    const media = frames.find((f) => f.targetKind === 'media');
    if (media) return media.frameId;
    const iframeTarget = frames.find((f) => f.targetKind === 'iframe');
    if (iframeTarget) return iframeTarget.frameId;
    return frames.length ? 0 : null;
  }

  get(tabId: number): TabStatus {
    const r = this.tabs.get(tabId) ?? { isSkool: false, frames: {}, audio: emptyAudio() };
    return {
      tabId,
      isSkool: r.isSkool,
      frames: Object.values(r.frames).sort((a, b) => a.frameId - b.frameId),
      primaryFrameId: this.primaryFrame(tabId),
      audio: r.audio,
    };
  }
}
