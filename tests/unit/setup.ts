import 'fake-indexeddb/auto';
import { vi } from 'vitest';

type Listener = (...args: any[]) => any;

function storageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      return changes;
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    clear: vi.fn(async () => {
      data = {};
    }),
    _dump: () => data,
  };
}

export function installChromeMock() {
  const onChanged = new Set<Listener>();
  const wrap = (area: ReturnType<typeof storageArea>, name: string) => ({
    ...area,
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes = await area.set(items);
      for (const l of onChanged) l(changes, name);
    }),
  });
  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
      lastError: undefined,
    },
    storage: {
      sync: wrap(storageArea(), 'sync'),
      local: wrap(storageArea(), 'local'),
      session: wrap(storageArea(), 'session'),
      onChanged: {
        addListener: (l: Listener) => onChanged.add(l),
        removeListener: (l: Listener) => onChanged.delete(l),
      },
    },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
  };
  (globalThis as any).chrome = chromeMock;
  return chromeMock;
}

installChromeMock();
