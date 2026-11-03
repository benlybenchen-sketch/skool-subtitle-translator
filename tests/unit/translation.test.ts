import { OpenAICompatibleProvider } from '../../src/translation/providers/openai';
import { GeminiProvider } from '../../src/translation/providers/gemini';
import { LocalHttpProvider } from '../../src/translation/providers/local';
import { MockProvider } from '../../src/translation/providers/mock';
import { HttpError, ParseError, parseRetryAfter } from '../../src/translation/errors';
import { extractJson, parseTranslations, buildUserPrompt } from '../../src/translation/prompt';
import { parseGlossary, relevantGlossary, glossaryVersion } from '../../src/translation/glossary';
import { TranslationQueue } from '../../src/translation/queue';
import type { BatchRequest, TranslationProvider } from '../../src/translation/types';

const req = (texts: string[]): BatchRequest => ({
  segments: texts.map((t, i) => ({ id: 's' + i, text: t })),
  context: ['Previous line.'],
  glossary: [{ term: 'ROAS' }, { term: 'funnel', translation: 'phễu bán hàng' }],
  sourceLang: 'en',
  targetLang: 'vi',
  signal: new AbortController().signal,
});

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('prompt & parsing', () => {
  it('builds a prompt with glossary, context and segments', () => {
    const p = buildUserPrompt(req(['Our ROAS doubled.']));
    expect(p).toContain('ROAS => (keep as "ROAS")');
    expect(p).toContain('funnel => phễu bán hàng');
    expect(p).toContain('> Previous line.');
    expect(p).toContain('"subtitle_id":"s0"');
  });

  it('extracts JSON from fenced/noisy replies', () => {
    expect(extractJson('```json\n{"t":[]}\n```')).toEqual({ t: [] });
    expect(extractJson('Sure! {"t":[{"i":"s0","v":"x"}]} done')).toEqual({ t: [{ i: 's0', v: 'x' }] });
    expect(() => extractJson('no json')).toThrow(ParseError);
  });

  it('accepts several reply shapes', () => {
    expect(parseTranslations({ t: [{ i: 's0', v: 'a' }] }, ['s0'])).toEqual({ s0: 'a' });
    expect(parseTranslations({ translations: [{ id: 's1', text: 'b' }] }, ['s0', 's1'])).toEqual({ s1: 'b' });
    expect(parseTranslations(['x', 'y'], ['s0', 's1'])).toEqual({ s0: 'x', s1: 'y' });
    expect(parseTranslations({ t: [{ i: 'zzz', v: 'ignored' }] }, ['s0'])).toEqual({});
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });
});

describe('glossary', () => {
  const g = parseGlossary('# comment\nROAS\nfunnel => phễu bán hàng\nROAS\n\nad set → nhóm quảng cáo');
  it('parses entries and dedupes', () => {
    expect(g).toEqual([{ term: 'ROAS' }, { term: 'funnel', translation: 'phễu bán hàng' }, { term: 'ad set', translation: 'nhóm quảng cáo' }]);
  });
  it('selects only relevant entries (whole-word match)', () => {
    expect(relevantGlossary(g, ['Build your funnel today']).map((e) => e.term)).toEqual(['funnel']);
    expect(relevantGlossary(g, ['funnels? no, roast']).map((e) => e.term)).toEqual([]);
  });
  it('version changes when glossary changes', () => {
    expect(glossaryVersion('ROAS')).not.toBe(glossaryVersion('ROAS\nCTR'));
    expect(glossaryVersion('ROAS\n# c')).toBe(glossaryVersion('ROAS'));
  });
});

describe('providers', () => {
  it('OpenAI-compatible: posts chat/completions with bearer key and parses JSON', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.response_format).toEqual({ type: 'json_object' });
      return jsonResponse({ choices: [{ message: { content: '{"t":[{"i":"s0","v":"Xin chào"}]}' } }] });
    });
    const p = new OpenAICompatibleProvider({ endpoint: 'https://api.openai.com/v1/', model: 'gpt-4o-mini', apiKey: 'sk-test', temperature: 0.2, fetchImpl: fetchImpl as any });
    expect(await p.translateBatch(req(['Hello']))).toEqual({ s0: 'Xin chào' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as any).Authorization).toBe('Bearer sk-test');
  });

  it('Gemini: uses generateContent with x-goog-api-key header (key not in URL)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"t":[{"i":"s0","v":"Chào"}]}' }] } }] }),
    );
    const p = new GeminiProvider({ endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: 'g-key', temperature: 0.2, fetchImpl: fetchImpl as any });
    expect(await p.translateBatch(req(['Hi']))).toEqual({ s0: 'Chào' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(url).not.toContain('g-key');
    expect((init.headers as any)['x-goog-api-key']).toBe('g-key');
  });

  it('Local backend: posts /translate', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ translations: [{ id: 's0', text: 'Một' }] }));
    const p = new LocalHttpProvider({ endpoint: 'http://localhost:8787', model: 'default', fetchImpl: fetchImpl as any });
    expect(await p.translateBatch(req(['One']))).toEqual({ s0: 'Một' });
    expect((fetchImpl.mock.calls[0] as any)[0]).toBe('http://localhost:8787/translate');
  });

  it('maps HTTP errors (401 not retryable, 429 retryable with Retry-After)', async () => {
    const p401 = new OpenAICompatibleProvider({ endpoint: 'https://x', model: 'm', temperature: 0, fetchImpl: (async () => new Response('bad key', { status: 401 })) as any });
    const e1 = await p401.translateBatch(req(['a'])).catch((e) => e);
    expect(e1).toBeInstanceOf(HttpError);
    expect(e1.retryable).toBe(false);
    expect(e1.message).toContain('API key');
    const p429 = new OpenAICompatibleProvider({ endpoint: 'https://x', model: 'm', temperature: 0, fetchImpl: (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })) as any });
    const e2 = await p429.translateBatch(req(['a'])).catch((e) => e);
    expect(e2.retryable).toBe(true);
    expect(e2.retryAfterMs).toBe(2000);
  });
});

/** Scriptable provider for queue tests. */
class ScriptedProvider implements TranslationProvider {
  readonly id = 'scripted';
  calls: string[][] = [];
  active = 0;
  maxActive = 0;
  constructor(private readonly script: ((texts: string[], call: number) => Promise<Record<string, string>> | Record<string, string>)) {}
  async translateBatch(r: BatchRequest): Promise<Record<string, string>> {
    const texts = r.segments.map((s) => s.text);
    this.calls.push(texts);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.script(texts, this.calls.length);
    } finally {
      this.active--;
    }
  }
}

const echo = (texts: string[]) => Object.fromEntries(texts.map((t, i) => ['s' + i, `vi:${t}`]));
const noSleep = async () => undefined;
const ctx = (provider: TranslationProvider, group = 'g') => ({ provider, context: [], glossary: [], group });

describe('TranslationQueue', () => {
  it('batches by item count and character budget', async () => {
    const p = new ScriptedProvider(echo);
    const q = new TranslationQueue({ maxBatchItems: 3, maxBatchChars: 1000, sleep: noSleep });
    const items = Array.from({ length: 7 }, (_, i) => ({ key: 'k' + i, text: 't' + i }));
    const res = await q.translate(items, ctx(p));
    expect(p.calls.map((c) => c.length)).toEqual([3, 3, 1]);
    expect(res.get('k6')?.vi).toBe('vi:t6');
  });

  it('deduplicates identical keys within and across concurrent requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new ScriptedProvider(async (t) => {
      await gate;
      return echo(t);
    });
    const q = new TranslationQueue({ sleep: noSleep });
    const a = q.translate([{ key: 'same', text: 'Hello' }, { key: 'same', text: 'Hello' }], ctx(p));
    const b = q.translate([{ key: 'same', text: 'Hello' }], ctx(p));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(p.calls).toHaveLength(1);
    expect(ra.get('same')?.vi).toBe('vi:Hello');
    expect(rb.get('same')?.vi).toBe('vi:Hello');
    expect(q.inflightCount).toBe(0);
  });

  it('respects the concurrency limit', async () => {
    const p = new ScriptedProvider(async (t) => {
      await new Promise((r) => setTimeout(r, 5));
      return echo(t);
    });
    const q = new TranslationQueue({ concurrency: 2, maxBatchItems: 1, sleep: noSleep });
    await q.translate(Array.from({ length: 6 }, (_, i) => ({ key: 'k' + i, text: 'x' + i })), ctx(p));
    expect(p.maxActive).toBe(2);
  });

  it('retries HTTP 429 honouring Retry-After (rate limits)', async () => {
    const sleeps: number[] = [];
    const events: string[] = [];
    const p = new ScriptedProvider((t, n) => {
      if (n === 1) throw new HttpError(429, 'rate limited', 2500);
      return echo(t);
    });
    const q = new TranslationQueue({ sleep: async (ms) => void sleeps.push(ms), onEvent: (e) => events.push(e.type) });
    const res = await q.translate([{ key: 'a', text: 'A' }], ctx(p));
    expect(res.get('a')?.vi).toBe('vi:A');
    expect(sleeps).toEqual([2500]);
    expect(events).toContain('rate-limited');
  });

  it('uses exponential backoff for 5xx and gives up after maxRetries', async () => {
    const sleeps: number[] = [];
    const p = new ScriptedProvider(() => {
      throw new HttpError(503, 'unavailable');
    });
    const q = new TranslationQueue({ maxRetries: 3, baseDelayMs: 100, random: () => 0.5, sleep: async (ms) => void sleeps.push(ms) });
    const res = await q.translate([{ key: 'a', text: 'A' }], ctx(p));
    expect(res.get('a')?.error).toBeInstanceOf(HttpError);
    expect(p.calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('does not retry permanent errors (401)', async () => {
    const p = new ScriptedProvider(() => {
      throw new HttpError(401, 'bad key');
    });
    const q = new TranslationQueue({ sleep: noSleep });
    const res = await q.translate([{ key: 'a', text: 'A' }], ctx(p));
    expect(res.get('a')?.error?.message).toBe('bad key');
    expect(p.calls).toHaveLength(1);
  });

  it('splits batches and shrinks the budget on malformed model output (adaptive batching)', async () => {
    const p = new ScriptedProvider((t) => {
      if (t.length > 2) throw new ParseError('garbage');
      return echo(t);
    });
    const q = new TranslationQueue({ maxBatchChars: 1000, sleep: noSleep });
    const res = await q.translate(Array.from({ length: 4 }, (_, i) => ({ key: 'k' + i, text: 'x' + i })), ctx(p));
    expect([...res.values()].every((r) => r.vi)).toBe(true);
    expect(p.calls.map((c) => c.length)).toEqual([4, 2, 2]);
    expect(q.batchBudget).toBeLessThan(1000);
  });

  it('retries only the segments the model omitted', async () => {
    const p = new ScriptedProvider((t, n) => (n === 1 ? { s0: 'vi:' + t[0] } : echo(t)));
    const q = new TranslationQueue({ sleep: noSleep });
    const res = await q.translate([{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], ctx(p));
    expect(res.get('b')?.vi).toBe('vi:B');
    expect(p.calls[1]).toEqual(['B']);
  });

  it('times out slow network requests and retries', async () => {
    let n = 0;
    const p: TranslationProvider = {
      id: 'slow',
      translateBatch: (r) =>
        new Promise((resolve, reject) => {
          n++;
          if (n === 1) {
            r.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            return; // never resolves → timeout
          }
          resolve(echo(r.segments.map((s) => s.text)));
        }),
    };
    const q = new TranslationQueue({ timeoutMs: 20, sleep: noSleep });
    const res = await q.translate([{ key: 'a', text: 'A' }], ctx(p));
    expect(res.get('a')?.vi).toBe('vi:A');
    expect(n).toBe(2);
  });

  it('cancels all jobs of a group (lesson change)', async () => {
    const p: TranslationProvider = {
      id: 'hang',
      translateBatch: (r) =>
        new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    };
    const q = new TranslationQueue({ sleep: noSleep });
    const pending = q.translate([{ key: 'a', text: 'A' }], ctx(p, 'lesson-1'));
    await new Promise((r) => setTimeout(r, 5));
    q.cancelGroup('lesson-1');
    const res = await pending;
    expect(res.get('a')?.error?.name).toBe('AbortError');
    // the group can be reused afterwards
    const ok = await q.translate([{ key: 'b', text: 'B' }], ctx(new MockProvider(), 'lesson-1'));
    expect(ok.get('b')?.vi).toBe('[VI] B');
  });
});

describe('speed-first Gemini 3.5 Flash-Lite configuration', () => {
  const geminiReply = (body: unknown) =>
    vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, thoughtsTokenCount: 5 },
      }),
    );

  it('sends minimal thinking, temperature 0.2 and a structured JSON schema; reports token usage', async () => {
    const fetchImpl = geminiReply({ translations: [{ subtitle_id: 's0', translated_text: 'Tỷ lệ ROAS là 3,5x.' }] });
    const usage: any[] = [];
    const p = new GeminiProvider({ endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash-lite', apiKey: 'k', temperature: 0.2, fetchImpl: fetchImpl as any });
    const out = await p.translateBatch({ ...req(['Our ROAS is 3.5x.']), onUsage: (u) => usage.push(u) });
    expect(out).toEqual({ s0: 'Tỷ lệ ROAS là 3,5x.' });
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect((fetchImpl.mock.calls[0] as any)[0]).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(body.generationConfig).toMatchObject({ temperature: 0.2, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(body.generationConfig.responseSchema.properties.translations.items.required).toEqual(['subtitle_id', 'translated_text']);
    expect(usage).toEqual([{ inputTokens: 120, outputTokens: 45 }]); // thinking tokens billed as output
  });

  it('does not send thinkingConfig to pre-3.x models (switching models keeps working)', async () => {
    const fetchImpl = geminiReply({ translations: [{ subtitle_id: 's0', translated_text: 'x' }] });
    await new GeminiProvider({ endpoint: 'https://g', model: 'gemini-2.0-flash', temperature: 0.2, fetchImpl: fetchImpl as any }).translateBatch(req(['a']));
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).generationConfig.thinkingConfig).toBeUndefined();
  });

  it('validates the one-to-one mapping: unknown, duplicate and empty items are rejected', () => {
    const out = parseTranslations(
      { translations: [
        { subtitle_id: 's0', translated_text: 'một' },
        { subtitle_id: 's0', translated_text: 'trùng lặp' },
        { subtitle_id: 's1', translated_text: '   ' },
        { subtitle_id: 's9', translated_text: 'bịa' },
      ] },
      ['s0', 's1'],
    );
    expect(out).toEqual({ s0: 'một' }); // s1 missing → retried by the queue, never fabricated
  });

  it('OpenAI-compatible provider reports usage too', async () => {
    const usage: any[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{"translations":[{"subtitle_id":"s0","translated_text":"x"}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    await new OpenAICompatibleProvider({ endpoint: 'https://x/v1', model: 'gpt-4o-mini', temperature: 0.2, fetchImpl: fetchImpl as any }).translateBatch({ ...req(['a']), onUsage: (u) => usage.push(u) });
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 3 }]);
  });

  it('estimates cost only for models with a known price', async () => {
    const { estimateCostUsd } = await import('../../src/translation/pricing');
    expect(estimateCostUsd('gemini-3.5-flash-lite', 1_000_000, 1_000_000)).toBeCloseTo(2.8);
    expect(estimateCostUsd('some-unknown-model', 100, 100)).toBeNull();
  });

  it('glossary terms are sent so technical terminology is preserved', () => {
    const p = buildUserPrompt({ ...req(['Check the ROAS of this funnel']), glossary: relevantGlossary(parseGlossary('ROAS\nfunnel => phễu bán hàng (funnel)\nCTR'), ['Check the ROAS of this funnel']) });
    expect(p).toContain('ROAS => (keep as "ROAS")');
    expect(p).toContain('funnel => phễu bán hàng (funnel)');
    expect(p).not.toContain('CTR');
  });
});

describe('queue priorities', () => {
  it('a P1 request waiting for a slot jumps ahead of queued P4 background work', async () => {
    const order: string[] = [];
    let gate!: () => void;
    const first = new Promise<void>((r) => (gate = r));
    const p = new ScriptedProvider(async (t) => {
      order.push(t[0]);
      if (t[0] === 'busy') await first;
      return echo(t);
    });
    const q = new TranslationQueue({ concurrency: 1, sleep: noSleep });
    const busy = q.translate([{ key: 'b', text: 'busy' }], { ...ctx(p), priority: 2 });
    const bg = q.translate([{ key: 'g', text: 'background' }], { ...ctx(p), priority: 4 });
    const urgent = q.translate([{ key: 'u', text: 'urgent' }], { ...ctx(p), priority: 1 });
    await new Promise((r) => setTimeout(r, 5));
    gate();
    await Promise.all([busy, bg, urgent]);
    expect(order).toEqual(['busy', 'urgent', 'background']);
  });
});
