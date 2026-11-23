/** Phase 2C: token accounting, pricing, persistent usage ledger. */
import { GeminiProvider } from '../../src/translation/providers/gemini';
import { OpenAICompatibleProvider } from '../../src/translation/providers/openai';
import { AnthropicProvider } from '../../src/translation/providers/anthropic';
import { LocalHttpProvider } from '../../src/translation/providers/local';
import { costOf, findPrice, DEFAULT_PRICES, type PriceRow } from '../../src/translation/pricing';
import { UsageLedger } from '../../src/background/usageLedger';
import { TranslationService } from '../../src/translation/service';
import { TranslationCache } from '../../src/cache/translationCache';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { MockProvider } from '../../src/translation/providers/mock';
import type { BatchRequest, TokenUsage } from '../../src/translation/types';

const req = (texts: string[], onUsage?: (u: TokenUsage) => void): BatchRequest => ({
  segments: texts.map((t, i) => ({ id: 's' + i, text: t })), context: [], glossary: [], sourceLang: 'en', targetLang: 'vi', signal: new AbortController().signal, onUsage,
});
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const OUT = '{"translations":[{"subtitle_id":"s0","translated_text":"x"}]}';

describe('provider-reported token usage', () => {
  it('Gemini: prompt / cached / candidates / thoughts', async () => {
    const u: TokenUsage[] = [];
    await new GeminiProvider({ endpoint: 'https://g', model: 'gemini-3.5-flash-lite', temperature: 0.2, fetchImpl: (async () => json({ candidates: [{ content: { parts: [{ text: OUT }] } }], usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 10 } })) as any }).translateBatch(req(['a'], (x) => u.push(x)));
    expect(u).toEqual([{ inputTokens: 900, outputTokens: 60, cachedInputTokens: 600, reasoningTokens: 10 }]);
  });
  it('OpenAI: prompt (cached) / completion (reasoning)', async () => {
    const u: TokenUsage[] = [];
    await new OpenAICompatibleProvider({ endpoint: 'https://o/v1', model: 'gpt-4o-mini', temperature: 0, fetchImpl: (async () => json({ choices: [{ message: { content: OUT } }], usage: { prompt_tokens: 800, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: 0 } } })) as any }).translateBatch(req(['a'], (x) => u.push(x)));
    expect(u).toEqual([{ inputTokens: 800, outputTokens: 40, cachedInputTokens: 512, reasoningTokens: undefined }]);
  });
  it('Anthropic: uncached + cache read + cache write normalised to total input', async () => {
    const u: TokenUsage[] = [];
    const f = (async () => json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: OUT }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 30 } })) as any;
    await new AnthropicProvider({ endpoint: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'k', fetchImpl: f }).translateBatch(req(['a'], (x) => u.push(x)));
    expect(u).toEqual([{ inputTokens: 1000, outputTokens: 30, cachedInputTokens: 700, cacheWriteTokens: 200 }]);
  });
  it('Local backend passes the upstream usage through; zero usage is not reported', async () => {
    const u: TokenUsage[] = [];
    await new LocalHttpProvider({ endpoint: 'http://localhost:8787', model: 'm', fetchImpl: (async () => json({ translations: [{ subtitle_id: 's0', translated_text: 'x' }], usage: { inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 } })) as any }).translateBatch(req(['a'], (x) => u.push(x)));
    await new LocalHttpProvider({ endpoint: 'http://localhost:8787', model: 'm', fetchImpl: (async () => json({ translations: [{ subtitle_id: 's0', translated_text: 'x' }], usage: { inputTokens: 0, outputTokens: 0 } })) as any }).translateBatch(req(['a'], (x) => u.push(x)));
    expect(u).toEqual([{ inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 }]);
  });
});

describe('pricing', () => {
  it('longest prefix match, editable table, unknown model → null', () => {
    const table: PriceRow[] = [{ match: 'claude', input: 1, output: 1 }, { match: 'claude-haiku-5-5', input: 0.1, output: 0.5 }];
    expect(findPrice('claude-haiku-5-5', table)!.input).toBe(0.1);
    expect(findPrice('models/gemini-3.5-flash-lite-preview')!.match).toBe('gemini-3.5-flash-lite');
    expect(costOf('unknown-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(costOf('mock', { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
  it('cached and cache-write tokens are priced separately', () => {
    const c = costOf('claude-opus-5-5', { inputTokens: 1_000_000, cachedInputTokens: 700_000, cacheWriteTokens: 200_000, outputTokens: 100_000 }, DEFAULT_PRICES)!;
    // 100k uncached × $4 + 700k cached × $0.20 + 200k write × $5 + 100k out × $20
    expect(c).toBeCloseTo((100_000 * 4 + 700_000 * 0.2 + 200_000 * 5 + 100_000 * 20) / 1e6, 9);
  });
});

function areas() {
  const mk = () => {
    const d: Record<string, unknown> = {};
    return { d, get: async (k: string) => ({ [k]: structuredClone(d[k]) }), set: async (v: Record<string, unknown>) => void Object.assign(d, structuredClone(v)) };
  };
  return { local: mk(), session: mk() };
}

describe('persistent usage ledger', () => {
  it('aggregates by total / day / model / lesson / session and survives a worker restart', async () => {
    const a = areas();
    const l1 = new UsageLedger(a.local, a.session, async () => DEFAULT_PRICES, () => Date.parse('2026-11-04T10:00:00Z'));
    const meta = { provider: 'gemini', model: 'gemini-3.5-flash-lite', lesson: 'L1' };
    await l1.record({ type: 'request', size: 10 }, meta);
    await l1.record({ type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, reasoningTokens: 5 } }, meta);
    await l1.record({ type: 'success', size: 10, latencyMs: 800 }, meta);
    await l1.record({ type: 'retry' }, meta);
    await l1.record({ type: 'failure', size: 2, reason: 'HTTP 503' }, meta);
    await l1.flush();
    const l2 = new UsageLedger(a.local, a.session, async () => DEFAULT_PRICES, () => Date.parse('2026-11-04T11:00:00Z')); // restarted worker
    const s = await l2.snapshot();
    for (const b of [s.total, s.today, s.session, s.models['gemini:gemini-3.5-flash-lite'], s.lessons['L1']]) {
      expect(b).toMatchObject({ requests: 1, segments: 10, retries: 1, failed: 1, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, reasoningTokens: 5 });
      expect(b.costUsd).toBeCloseTo((600 * 0.3 + 400 * 0.03 + 200 * 2.5) / 1e6, 12);
    }
    expect(s.sessionAvgLatencyMs).toBe(800);
    expect(s.lastError).toBe('HTTP 503');
  });

  it('estimates and unpriced models are kept apart from exact, priced usage', async () => {
    const a = areas();
    const l = new UsageLedger(a.local, a.session, async () => DEFAULT_PRICES);
    await l.record({ type: 'usage', usage: { inputTokens: 500, outputTokens: 50, estimated: true } }, { provider: 'openai', model: 'gpt-4o-mini' });
    await l.record({ type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }, { provider: 'openai', model: 'some-new-model' });
    const s = await l.snapshot();
    expect(s.total).toMatchObject({ inputTokens: 100, outputTokens: 10, estimatedInputTokens: 500, estimatedOutputTokens: 50, unpricedTokens: 110, costUsd: 0 });
    expect(s.total.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('end-to-end accounting through the service', () => {
  it('real usage is summed per request; cache hits are counted as cache hits, NOT as new API usage', async () => {
    const a = areas();
    const ledger = new UsageLedger(a.local, a.session, async () => DEFAULT_PRICES);
    const svc = new TranslationService({
      cache: new TranslationCache({ dbName: 'usage-' + Math.random() }),
      getSettings: async () => mergeSettings({ ...DEFAULT_SETTINGS, provider: { kind: 'gemini', endpoint: 'https://g', model: 'gemini-3.5-flash-lite', temperature: 0.2 }, consent: { remoteTranslation: true, remoteAudio: false } }),
      getSecrets: async () => ({}),
      providerFactory: () => ({
        id: 'u',
        async translateBatch(r) {
          r.onUsage?.({ inputTokens: 700, outputTokens: 30 * r.segments.length });
          return Object.fromEntries(r.segments.map((s) => [s.id, 'vi ' + s.text]));
        },
      }),
      onAccounting: (e, meta) => void ledger.record(e, meta),
      queueOptions: { sleep: async () => undefined, maxBatchItems: 2 },
    });
    const units = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
    await svc.translateUnits('lesson-1', units, []); // 2 batches: [a,b] [c]
    await new Promise((r) => setTimeout(r, 20)); // async cache write
    await svc.translateUnits('lesson-1', units, []); // all cached
    await new Promise((r) => setTimeout(r, 5));
    const s = await ledger.snapshot();
    expect(s.total).toMatchObject({ requests: 2, inputTokens: 1400, outputTokens: 90, segments: 3, cacheHits: 3, cacheMisses: 3 });
  });

  it('a provider without usage data produces a labelled ESTIMATE (never shown as exact)', async () => {
    const a = areas();
    const ledger = new UsageLedger(a.local, a.session, async () => DEFAULT_PRICES);
    const svc = new TranslationService({
      cache: new TranslationCache({ dbName: 'usage-est-' + Math.random() }),
      getSettings: async () => mergeSettings({ ...DEFAULT_SETTINGS, provider: { kind: 'local', endpoint: 'http://localhost:8787', model: 'default', temperature: 0 } }),
      getSecrets: async () => ({}),
      providerFactory: () => new MockProvider(),
      onAccounting: (e, meta) => void ledger.record(e, meta),
      queueOptions: { sleep: async () => undefined },
    });
    await svc.translateUnits('v', [{ id: 'a', text: 'Hello there.' }], []);
    await new Promise((r) => setTimeout(r, 5));
    const s = await ledger.snapshot();
    expect(s.total.inputTokens).toBe(0);
    expect(s.total.estimatedInputTokens).toBeGreaterThan(0);
  });
});
