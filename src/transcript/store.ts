import type { Cue } from '../shared/types';

/**
 * Persistent lesson transcripts (IndexedDB, extension origin — background / extension pages only).
 * One record per lesson: source cues + completeness metadata + translated units snapshot, so a
 * lesson reopens with its full transcript instantly and long translations resume where they
 * stopped. "Saved for offline" records are never pruned automatically.
 */
export interface LessonUnit {
  id: string;
  start: number;
  end: number;
  en: string;
  vi?: string;
  /** Text lessons: block type (h2, li, code…) for structured exports. */
  block?: string;
}

export interface LessonRecord {
  lessonId: string;
  title: string;
  kind: 'video' | 'text';
  /** Source cues as read (ids = cue identity). Empty for text lessons. */
  cues: Cue[];
  /** The whole lesson's English transcript is known (caption file / complete HLS rendition / cues reach the end). */
  complete: boolean;
  /** Where the English transcript came from. */
  source: string;
  durationSec: number | null;
  sourceUntilSec: number;
  units: LessonUnit[];
  translated: number;
  provider?: string;
  model?: string;
  contentHash: string;
  updatedAt: number;
  error?: string;
  /** User pressed "Lưu để học offline". */
  savedOffline?: boolean;
  savedAt?: number;
  /** Copy of the AI notes markdown at save time (offline reader). */
  notesMarkdown?: string;
  /** Authorized video downloaded through the extension (metadata only — the file lives in Downloads). */
  video?: { filename: string; downloadId?: number; sizeBytes?: number; savedAt: number; sourceLabel: string };
}

export type LessonSummary = Omit<LessonRecord, 'cues' | 'units' | 'notesMarkdown'> & { units: number; bytes: number };

export class TranscriptStore {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(private readonly o: { dbName?: string; maxRecords?: number } = {}) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.o.dbName ?? 'sst-transcripts', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('lessons', { keyPath: 'lessonId' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.dbp;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction('lessons', mode);
      const req = fn(t.objectStore('lessons'));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async get(lessonId: string): Promise<LessonRecord | null> {
    return ((await this.tx<LessonRecord>('readonly', (s) => s.get(lessonId))) as LessonRecord | undefined) ?? null;
  }

  /**
   * Merge-save: never downgrades a complete transcript to a partial one, never drops known
   * translations, keeps offline/notes/video metadata.
   */
  async put(next: Partial<LessonRecord> & { lessonId: string }): Promise<LessonRecord> {
    const prev = await this.get(next.lessonId);
    const merged = mergeRecords(prev, next);
    try {
      await this.tx('readwrite', (s) => void s.put(merged));
    } catch (e) {
      if ((e as DOMException)?.name !== 'QuotaExceededError') throw e;
      await this.prune(true);
      await this.tx('readwrite', (s) => void s.put(merged));
    }
    void this.prune(false).catch(() => undefined);
    return merged;
  }

  async list(): Promise<LessonSummary[]> {
    const all = ((await this.tx<LessonRecord[]>('readonly', (s) => s.getAll())) ?? []) as LessonRecord[];
    return all
      .map(({ cues: _c, units, notesMarkdown: _n, ...r }) => ({ ...r, units: units.length, bytes: approxBytes(r, units, _c, _n) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(lessonId: string): Promise<void> {
    await this.tx('readwrite', (s) => void s.delete(lessonId));
  }

  async clear(includeOffline: boolean): Promise<number> {
    const all = await this.list();
    const del = all.filter((r) => includeOffline || !r.savedOffline);
    for (const r of del) await this.delete(r.lessonId);
    return del.length;
  }

  /** Keep at most maxRecords automatically cached lessons (offline-saved ones are kept). */
  private async prune(aggressive: boolean): Promise<void> {
    const max = aggressive ? Math.floor((this.o.maxRecords ?? 300) / 2) : this.o.maxRecords ?? 300;
    const auto = (await this.list()).filter((r) => !r.savedOffline);
    for (const r of auto.slice(max)) await this.delete(r.lessonId);
  }
}

function approxBytes(...parts: unknown[]): number {
  try {
    return JSON.stringify(parts).length * 2;
  } catch {
    return 0;
  }
}

export function mergeRecords(prev: LessonRecord | null, next: Partial<LessonRecord> & { lessonId: string }): LessonRecord {
  const base: LessonRecord = prev ?? {
    lessonId: next.lessonId,
    title: '',
    kind: 'video',
    cues: [],
    complete: false,
    source: 'none',
    durationSec: null,
    sourceUntilSec: 0,
    units: [],
    translated: 0,
    contentHash: '',
    updatedAt: 0,
  };
  // cues: union by id (a newer partial snapshot never removes cues we already had)
  const cues = new Map(base.cues.map((c) => [c.id, c]));
  for (const c of next.cues ?? []) cues.set(c.id, c);
  // units: the newest snapshot is the current segmentation, but a known translation of the same
  // English text is never replaced by "untranslated"
  const oldVi = new Map(base.units.filter((u) => u.vi).map((u) => [`${u.start.toFixed(2)}|${u.en}`, u.vi!]));
  const unitList = (next.units ?? base.units)
    .map((u) => ({ ...u, vi: u.vi ?? oldVi.get(`${u.start.toFixed(2)}|${u.en}`) }))
    .sort((a, b) => a.start - b.start);
  const complete = base.complete || !!next.complete;
  return {
    ...base,
    ...next,
    cues: [...cues.values()].sort((a, b) => a.start - b.start),
    units: unitList,
    complete,
    source: complete && base.complete && !next.complete ? base.source : next.source ?? base.source,
    translated: unitList.filter((u) => !!u.vi).length,
    savedOffline: next.savedOffline ?? base.savedOffline,
    notesMarkdown: next.notesMarkdown ?? base.notesMarkdown,
    video: next.video ?? base.video,
    updatedAt: next.updatedAt ?? Date.now(),
  };
}
