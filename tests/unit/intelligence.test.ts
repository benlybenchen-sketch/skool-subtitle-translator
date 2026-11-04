/** Phase 2B: glossary store, structured-output validation, context-aware batching, modes & models. */
import { addPreset, compileGlossary, emptyStore, exportGlossary, fromLegacyText, importGlossary, PRESETS, loadEffectiveGlossary, saveGlossaryStore } from '../../src/shared/glossaryStore';
import { glossaryVersion } from '../../src/translation/glossary';
import { parseTranslations } from '../../src/translation/prompt';
import { TranslationQueue } from '../../src/translation/queue';
import { TranslationService, settingsFingerprint } from '../../src/translation/service';
import { TranslationCache } from '../../src/cache/translationCache';
import { DEFAULT_SETTINGS, effectiveProvider, mergeSettings } from '../../src/shared/settings';
import { checkModeSwitch, MODE_PROFILES } from '../../src/translation/modes';
import { ParseError } from '../../src/translation/errors';
import type { BatchRequest, TranslationProvider } from '../../src/translation/types';
import { installChromeMock } from './setup';

beforeEach(() => installChromeMock());

describe('editable glossary', () => {
  it('migrates the legacy text glossary into global entries (nothing lost)', () => {
    const s = fromLegacyText('# c\nROAS\nfunnel => phễu bán hàng');
    expect(s.entries).toEqual([
      { term: 'ROAS', translation: undefined, subject: 'global' },
      { term: 'funnel', translation: 'phễu bán hàng', subject: 'global' },
    ]);
    expect(compileGlossary(s)).toBe('ROAS\nfunnel => phễu bán hàng');
  });

  it('presets add terms without overwriting the user\'s own entries', () => {
    let s = emptyStore();
    s.entries.push({ term: 'Hook', translation: 'móc câu (bản dịch của tôi)', subject: 'global' });
    const r = addPreset(s, 'marketing');
    s = r.store;
    expect(r.added).toBe(PRESETS.marketing.length - 1);
    expect(s.entries.filter((e) => e.term.toLowerCase() === 'hook')).toEqual([{ term: 'Hook', translation: 'móc câu (bản dịch của tôi)', subject: 'global' }]);
    expect(addPreset(s, 'marketing').added).toBe(0); // idempotent
  });

  it('effective glossary = global + ACTIVE subjects; toggling a subject changes the cache version', () => {
    let s = addPreset(emptyStore(), 'ai').store;
    s = addPreset(s, 'marketing').store;
    const on = compileGlossary(s);
    expect(on).toContain('Agent Reach');
    expect(on).toContain('VOC => VOC (tiếng nói khách hàng)');
    const off = compileGlossary({ ...s, activeSubjects: s.activeSubjects.filter((x) => x !== 'ai') });
    expect(off).not.toContain('Agent Reach');
    expect(glossaryVersion(on)).not.toBe(glossaryVersion(off));
    expect(glossaryVersion(compileGlossary(s))).toBe(glossaryVersion(on)); // stable
  });

  it('import validates, merges without overwriting, export round-trips', () => {
    const base = fromLegacyText('ROAS => ROAS (lợi nhuận trên chi tiêu QC)');
    const json = JSON.stringify({ entries: [{ term: 'ROAS', translation: 'khác' }, { term: 'Mass Desire', subject: 'marketing' }, { nope: 1 }, { term: '  ' }] });
    const r = importGlossary(base, json);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.store.entries.find((e) => e.term === 'ROAS')!.translation).toBe('ROAS (lợi nhuận trên chi tiêu QC)');
    expect(() => importGlossary(base, '{oops')).toThrow(/JSON/);
    const back = importGlossary(emptyStore(), exportGlossary(r.store), true).store;
    expect(back.entries).toEqual(r.store.entries);
  });

  it('the translator uses the saved store (compiled) and the cache key follows it', async () => {
    await saveGlossaryStore(addPreset(emptyStore(), 'coding').store);
    const text = await loadEffectiveGlossary('legacy');
    expect(text).toContain('repository => repository (kho mã)');
    const s = mergeSettings(DEFAULT_SETTINGS);
    expect(settingsFingerprint({ ...s, glossary: text })).not.toBe(settingsFingerprint({ ...s, glossary: 'legacy' }));
  });
});

describe('structured output validation', () => {
  it('maps reordered results by subtitle_id (not by position)', () => {
    const out = parseTranslations({ translations: [{ subtitle_id: 's2', translated_text: 'ba' }, { subtitle_id: 's0', translated_text: 'một' }, { subtitle_id: 's1', translated_text: 'hai' }] }, ['s0', 's1', 's2']);
    expect(out).toEqual({ s0: 'một', s1: 'hai', s2: 'ba' });
  });

  it('malformed reply → retried (split), only unresolved segments re-sent, nothing invented', async () => {
    const calls: string[][] = [];
    const p: TranslationProvider = {
      id: 'flaky',
      async translateBatch(r: BatchRequest) {
        calls.push(r.segments.map((s) => s.text));
        if (calls.length === 1) throw new ParseError('not JSON');
        if (calls.length === 2) return { s0: 'vi:' + r.segments[0].text }; // second item missing
        return Object.fromEntries(r.segments.map((s) => [s.id, 'vi:' + s.text]));
      },
    };
    const q = new TranslationQueue({ sleep: async () => undefined });
    const res = await q.translate([{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], { provider: p, context: [], glossary: [], group: 'g' });
    expect(res.get('a')?.vi).toBe('vi:A');
    expect(res.get('b')?.vi).toBe('vi:B');
    expect(calls.at(-1)).toEqual(['B']); // only the unresolved one
  });
});

describe('context-aware batching, modes and models', () => {
  const svc = (settings = {}, seen: BatchRequest[] = []) =>
    new TranslationService({
      cache: new TranslationCache({ dbName: 'intel-' + Math.random() }),
      getSettings: async () => mergeSettings({ ...DEFAULT_SETTINGS, ...settings }),
      getSecrets: async () => ({}),
      providerFactory: () => ({
        id: 'rec',
        async translateBatch(r) {
          seen.push(r);
          return Object.fromEntries(r.segments.map((s) => [s.id, 'vi']));
        },
      }),
      queueOptions: { sleep: async () => undefined },
    });

  it('context = previous lines only (never re-translated), sized by the mode', async () => {
    const ctx = Array.from({ length: 10 }, (_, i) => `previous ${i}`);
    for (const [mode, n] of [['fast', MODE_PROFILES.fast.contextSize], ['quality', MODE_PROFILES.quality.contextSize]] as const) {
      const seen: BatchRequest[] = [];
      await svc({ translationMode: mode }, seen).translateUnits('v', [{ id: 'u', text: 'Now.' }], ctx);
      expect(seen[0].context).toEqual(ctx.slice(-n));
      expect(seen[0].segments.map((s) => s.text)).toEqual(['Now.']);
    }
  });

  it('a mode uses a different model ONLY when the user configured one; pricier/unknown needs approval', () => {
    const gem = { kind: 'gemini' as const, endpoint: 'https://g', model: 'gemini-3.5-flash-lite', temperature: 0.2 };
    const s = mergeSettings({ ...DEFAULT_SETTINGS, provider: gem });
    expect(effectiveProvider({ ...s, translationMode: 'quality' }).model).toBe('gemini-3.5-flash-lite'); // no silent switch
    expect(checkModeSwitch(s, 'quality')).toMatchObject({ modelChanges: false, needsApproval: false });
    const withOverride = mergeSettings({ ...s, modeModels: { quality: { gemini: 'gemini-3.6-pro' } } });
    expect(effectiveProvider({ ...withOverride, translationMode: 'quality' }).model).toBe('gemini-3.6-pro');
    expect(checkModeSwitch(withOverride, 'quality')).toMatchObject({ modelChanges: true, pricier: null, needsApproval: true });
    const claude = mergeSettings({ ...DEFAULT_SETTINGS, provider: { kind: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-haiku-5-5', temperature: 0 }, modeModels: { quality: { anthropic: 'claude-opus-5-5' }, fast: { anthropic: 'claude-haiku-5-5' } } });
    expect(checkModeSwitch(claude, 'quality')).toMatchObject({ pricier: true, needsApproval: true });
    expect(checkModeSwitch({ ...claude, translationMode: 'quality' }, 'fast')).toMatchObject({ pricier: false, needsApproval: false });
  });

  it('the per-mode model is what the provider receives and what the cache key uses', async () => {
    const used: string[] = [];
    const s = { provider: { kind: 'local' as const, endpoint: 'http://localhost:8787', model: 'base', temperature: 0 }, translationMode: 'fast' as const, modeModels: { fast: { local: 'fast-model' } } };
    const service = new TranslationService({
      cache: new TranslationCache({ dbName: 'intel-m' }),
      getSettings: async () => mergeSettings({ ...DEFAULT_SETTINGS, ...s }),
      getSecrets: async () => ({}),
      providerFactory: (st) => {
        used.push(st.provider.model);
        return { id: 'x', translateBatch: async (r) => Object.fromEntries(r.segments.map((x) => [x.id, 'vi'])) };
      },
      queueOptions: { sleep: async () => undefined },
    });
    await service.translateUnits('v', [{ id: 'u', text: 'Hi' }], []);
    expect(used).toEqual(['fast-model']);
    const base = mergeSettings({ ...DEFAULT_SETTINGS, ...s });
    expect(settingsFingerprint({ ...base, provider: effectiveProvider(base) })).not.toBe(settingsFingerprint(base));
  });
});
