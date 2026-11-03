import type { CacheStats } from '../shared/types';

export interface CacheEntry {
  key: string;
  videoKey: string;
  vi: string;
  createdAt: number;
  lastUsedAt: number;
  size: number;
}

export interface CacheOptions {
  dbName?: string;
  /** Entries unused for longer than this are pruned. */
  maxAgeMs?: number;
  /** Hard cap on entries; least-recently-used are pruned beyond it. */
  maxEntries?: number;
  now?: () => number;
  indexedDB?: IDBFactory;
}

const STORE = 'translations';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** IndexedDB translation cache (lives in the background service worker origin). */
export class TranslationCache {
  private dbp: Promise<IDBDatabase> | null = null;
  private readonly o: Required<Omit<CacheOptions, 'indexedDB'>> & { indexedDB?: IDBFactory };

  constructor(opts: CacheOptions = {}) {
    this.o = {
      dbName: opts.dbName ?? 'sst-cache',
      maxAgeMs: opts.maxAgeMs ?? 45 * 24 * 3600 * 1000,
      maxEntries: opts.maxEntries ?? 60_000,
      now: opts.now ?? Date.now,
      indexedDB: opts.indexedDB,
    };
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      const factory = this.o.indexedDB ?? indexedDB;
      this.dbp = new Promise((resolve, reject) => {
        const open = factory.open(this.o.dbName, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('videoKey', 'videoKey');
          store.createIndex('lastUsedAt', 'lastUsedAt');
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      this.dbp.catch(() => (this.dbp = null));
    }
    return this.dbp;
  }

  async getMany(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!keys.length) return out;
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = this.o.now();
    await Promise.all(
      keys.map(async (k) => {
        const e = (await req(store.get(k))) as CacheEntry | undefined;
        if (!e) return;
        if (now - e.lastUsedAt > this.o.maxAgeMs) {
          store.delete(k);
          return;
        }
        out.set(k, e.vi);
        // touch at most once per hour to limit writes
        if (now - e.lastUsedAt > 3600_000) store.put({ ...e, lastUsedAt: now });
      }),
    );
    await txDone(tx);
    return out;
  }

  async putMany(entries: { key: string; videoKey: string; vi: string }[]): Promise<void> {
    if (!entries.length) return;
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const now = this.o.now();
    for (const e of entries) {
      store.put({ ...e, createdAt: now, lastUsedAt: now, size: e.key.length + e.vi.length * 2 } satisfies CacheEntry);
    }
    await txDone(tx);
  }

  async stats(): Promise<CacheStats> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const entries = await req(store.count());
    let approxBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        approxBytes += (c.value as CacheEntry).size ?? 0;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return { entries, approxBytes };
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await txDone(tx);
  }

  /** Invalidate all cached translations of one video. */
  async deleteVideo(videoKey: string): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.objectStore(STORE).index('videoKey');
    let n = 0;
    await new Promise<void>((resolve, reject) => {
      const cur = idx.openCursor(IDBKeyRange.only(videoKey));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        c.delete();
        n++;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    await txDone(tx);
    return n;
  }

  /** Remove expired entries and enforce the LRU cap. */
  async prune(): Promise<number> {
    const db = await this.db();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const total = await req(store.count());
    const cutoff = this.o.now() - this.o.maxAgeMs;
    let excess = Math.max(0, total - this.o.maxEntries);
    let removed = 0;
    await new Promise<void>((resolve, reject) => {
      const cur = store.index('lastUsedAt').openCursor(); // oldest first
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const e = c.value as CacheEntry;
        if (e.lastUsedAt < cutoff || excess > 0) {
          c.delete();
          removed++;
          if (excess > 0) excess--;
          c.continue();
        } else resolve();
      };
      cur.onerror = () => reject(cur.error);
    });
    await txDone(tx);
    return removed;
  }
}
