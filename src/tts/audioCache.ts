import { hash53 } from '../shared/hash';

/**
 * Persistent synthesized-audio cache (IndexedDB, extension origin).
 * Key = config version | provider | voice | model/format | rate | lesson | text hash.
 * Bounded by total bytes (LRU on last use) and age.
 */
export const TTS_CONFIG_VERSION = 'tts1';

export interface AudioEntry {
  key: string;
  audio: Uint8Array;
  mime: string;
  durationSec?: number;
  size: number;
  lastUsed: number;
  createdAt: number;
}

export function audioKey(p: { provider: string; voice: string; format: string; rate: number; lesson: string; text: string }): string {
  return [TTS_CONFIG_VERSION, p.provider, p.voice, p.format, p.rate.toFixed(2), hash53(p.lesson), hash53(p.text.trim()) + ':' + p.text.length].join('|');
}

export class TtsAudioCache {
  private dbp: Promise<IDBDatabase> | null = null;
  constructor(
    private readonly o: { dbName?: string; maxBytes?: number; maxAgeMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.o.dbName ?? 'sst-tts-audio', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('audio', { keyPath: 'key' });
        s.createIndex('lastUsed', 'lastUsed');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.dbp;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction('audio', mode);
      const req = fn(t.objectStore('audio'));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async get(key: string): Promise<AudioEntry | null> {
    const e = (await this.tx<AudioEntry>('readonly', (s) => s.get(key))) ?? null;
    if (!e) return null;
    if (this.now() - e.createdAt > (this.o.maxAgeMs ?? 30 * 86_400_000)) {
      await this.tx('readwrite', (s) => void s.delete(key));
      return null;
    }
    void this.tx('readwrite', (s) => void s.put({ ...e, lastUsed: this.now() })).catch(() => undefined);
    return e;
  }

  async put(e: Omit<AudioEntry, 'size' | 'lastUsed' | 'createdAt'>): Promise<void> {
    const now = this.now();
    await this.tx('readwrite', (s) => void s.put({ ...e, size: e.audio.byteLength, lastUsed: now, createdAt: now }));
    this.writes++;
    if (this.writes % 20 === 0) await this.prune().catch(() => undefined);
  }
  private writes = 0;

  async setDuration(key: string, durationSec: number): Promise<void> {
    const e = (await this.tx<AudioEntry>('readonly', (s) => s.get(key))) ?? null;
    if (e && !e.durationSec) await this.tx('readwrite', (s) => void s.put({ ...e, durationSec }));
  }

  /** Drop least-recently-used entries above the byte budget. */
  async prune(): Promise<{ removed: number; bytes: number }> {
    const max = this.o.maxBytes ?? 80 * 1024 * 1024;
    const all = ((await this.tx<AudioEntry[]>('readonly', (s) => s.getAll())) ?? []).sort((a, b) => b.lastUsed - a.lastUsed);
    let bytes = 0;
    const drop: string[] = [];
    for (const e of all) {
      bytes += e.size;
      if (bytes > max) drop.push(e.key);
    }
    if (drop.length) await this.tx('readwrite', (s) => drop.forEach((k) => s.delete(k)));
    return { removed: drop.length, bytes: Math.min(bytes, max) };
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    const all = (await this.tx<AudioEntry[]>('readonly', (s) => s.getAll())) ?? [];
    return { entries: all.length, bytes: all.reduce((a, b) => a + b.size, 0) };
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', (s) => void s.clear());
  }
}
