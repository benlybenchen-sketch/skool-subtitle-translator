import { TranslationCache } from '../../src/cache/translationCache';
import { TranslationService, cacheKey, settingsFingerprint } from '../../src/translation/service';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { MockProvider } from '../../src/translation/providers/mock';
import type { Settings } from '../../src/shared/types';

let dbn = 0;
const newCache = (opts = {}) => new TranslationCache({ dbName: `test-${++dbn}`, ...opts });

describe('IndexedDB translation cache', () => {
  it('stores and retrieves translations', async () => {
    const c = newCache();
    await c.putMany([
      { key: 'k1', videoKey: 'v1', vi: 'một' },
      { key: 'k2', videoKey: 'v1', vi: 'hai' },
    ]);
    const got = await c.getMany(['k1', 'k2', 'missing']);
    expect(Object.fromEntries(got)).toEqual({ k1: 'một', k2: 'hai' });
    expect((await c.stats()).entries).toBe(2);
  });

  it('expires stale entries and enforces the LRU cap', async () => {
    let now = 1_000_000;
    const c = newCache({ now: () => now, maxAgeMs: 1000, maxEntries: 2 });
    await c.putMany([{ key: 'old', videoKey: 'v', vi: 'cũ' }]);
    now += 10;
    await c.putMany([{ key: 'a', videoKey: 'v', vi: 'a' }, { key: 'b', videoKey: 'v', vi: 'b' }]);
    expect(await c.prune()).toBe(1); // cap 2 → oldest removed
    expect((await c.getMany(['old'])).size).toBe(0);
    now += 5000;
    expect((await c.getMany(['a'])).size).toBe(0); // expired on read
  });

  it('invalidates one video and clears everything', async () => {
    const c = newCache();
    await c.putMany([
      { key: 'a', videoKey: 'v1', vi: 'a' },
      { key: 'b', videoKey: 'v2', vi: 'b' },
    ]);
    expect(await c.deleteVideo('v1')).toBe(1);
    expect((await c.stats()).entries).toBe(1);
    await c.clear();
    expect((await c.stats()).entries).toBe(0);
  });
});

describe('cache keys', () => {
  it('include provider/model/glossary version, video and text', () => {
    const base = DEFAULT_SETTINGS;
    const fp = settingsFingerprint(base);
    expect(settingsFingerprint(mergeSettings({ ...base, provider: { ...base.provider, model: 'other' } }))).not.toBe(fp);
    expect(settingsFingerprint(mergeSettings({ ...base, glossary: base.glossary + '\nNewTerm' }))).not.toBe(fp);
    expect(settingsFingerprint(mergeSettings({ ...base, fontScale: 2 }))).toBe(fp); // display settings don't matter
    expect(cacheKey(fp, 'v1', 'Hello')).not.toBe(cacheKey(fp, 'v2', 'Hello'));
    expect(cacheKey(fp, 'v1', 'Hello')).toBe(cacheKey(fp, 'v1', ' hello '.trim().replace('h', 'H')));
  });
});

describe('TranslationService', () => {
  const make = (settings: Partial<Settings> = {}, hasPermission = true) => {
    const provider = new MockProvider();
    const s = mergeSettings({ ...DEFAULT_SETTINGS, ...settings });
    const svc = new TranslationService({
      cache: newCache(),
      getSettings: async () => s,
      getSecrets: async () => ({}),
      hasEndpointPermission: async () => hasPermission,
      providerFactory: () => provider,
      queueOptions: { sleep: async () => undefined },
    });
    return { svc, provider };
  };

  it('serves repeated segments from cache without calling the provider again', async () => {
    const { svc, provider } = make();
    const units = [{ id: 'u1', text: 'Welcome back.' }, { id: 'u2', text: 'Open Shopify.' }];
    const r1 = await svc.translateUnits('video-1', units, []);
    expect(r1.map((r) => r.vi)).toEqual(['[VI] Welcome back.', '[VI] Open Shopify.']);
    await new Promise((r) => setTimeout(r, 20)); // cache write is async
    const r2 = await svc.translateUnits('video-1', units, []);
    expect(r2.every((r) => r.cached)).toBe(true);
    expect(provider.calls).toBe(1);
    const m = svc.metrics.snapshot();
    expect(m.cacheHits).toBe(2);
    expect(m.cacheMisses).toBe(2);
  });

  it('refuses to send text to a remote provider without consent', async () => {
    const { svc, provider } = make({ provider: { kind: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', temperature: 0.2 } });
    const [r] = await svc.translateUnits('v', [{ id: 'u', text: 'Hi' }], []);
    expect(r.fatal).toBe(true);
    expect(r.error).toMatch(/consent/);
    expect(provider.calls).toBe(0);
  });

  it('allows remote providers once consent is given, but requires host permission', async () => {
    const remote = { provider: { kind: 'openai' as const, endpoint: 'https://api.openai.com/v1', model: 'm', temperature: 0 }, consent: { remoteTranslation: true, remoteAudio: false } };
    const { svc: noPerm } = make(remote, false);
    expect((await noPerm.translateUnits('v', [{ id: 'u', text: 'Hi' }], []))[0].error).toMatch(/permission/);
    const { svc } = make(remote, true);
    expect((await svc.translateUnits('v', [{ id: 'u', text: 'Hi' }], []))[0].vi).toBe('[VI] Hi');
  });

  it('local backend needs no remote consent', async () => {
    const { svc } = make();
    expect((await svc.translateUnits('v', [{ id: 'u', text: 'Hi' }], []))[0].vi).toBe('[VI] Hi');
  });
});
