/** Phase 3B: AI Study Notes — grounding, hierarchy, persistence, UI, provider calls. */
import { buildTranscript, type Transcript } from '../../src/transcript/model';
import { chunkLines, generateNotes, sourceLines, DEFAULT_BUDGET, type CompleteFn } from '../../src/notes/generate';
import { coerceNotes, NOTES_SCHEMA } from '../../src/notes/schema';
import { notesToMarkdown, notesToText, PARTIAL_BANNER, type NotesRecord } from '../../src/notes/render';
import { NotesManager } from '../../src/background/notesManager';
import { AiNotesView, notesFileName, type NotesApi } from '../../src/content/notesView';
import { MockProvider } from '../../src/translation/providers/mock';
import { GeminiProvider } from '../../src/translation/providers/gemini';
import { OpenAICompatibleProvider } from '../../src/translation/providers/openai';
import { AnthropicProvider } from '../../src/translation/providers/anthropic';
import { LocalHttpProvider } from '../../src/translation/providers/local';
import { TranslationService } from '../../src/translation/service';
import { TranslationCache } from '../../src/cache/translationCache';
import { TranslationQueue } from '../../src/translation/queue';
import { HttpError } from '../../src/translation/errors';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { TimedUnit } from '../../src/shared/types';

const units = (n: number, len = 60): TimedUnit[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, start: i * 5, end: i * 5 + 4, text: `Sentence ${i} about Mass Desire and the Hook ${'x'.repeat(Math.max(0, len - 40))}.`, vi: `Câu ${i}`, status: 'done', cueIds: [] }) as unknown as TimedUnit);

const tx = (n: number, o: { full?: boolean; duration?: number; len?: number } = {}): Transcript =>
  buildTranscript({ lessonId: 'lesson-A', title: 'Market Awareness 101', units: units(n, o.len), source: 'texttrack', fullTranscript: o.full ?? true, durationSec: o.duration ?? null, version: (s) => `v${s.length}` });

const mockComplete = () => {
  const p = new MockProvider();
  const calls: string[] = [];
  const fn: CompleteFn = (req) => {
    calls.push(req.label);
    return p.complete({ ...req, signal: new AbortController().signal });
  };
  return { fn, calls, p };
};

describe('grounding & validation', () => {
  it('drops refs to labels that were never sent (no fabricated timestamps)', async () => {
    const t = tx(3);
    const complete: CompleteFn = async () =>
      JSON.stringify({ title: 'T', summary: 'Tóm tắt', objectives: [], concepts: [{ term: 'Hook', explanation: 'Câu mở đầu', refs: ['S2', 'S999'] }], insights: [], steps: [], terminology: [], takeaways: [{ text: 'A', refs: ['S1 0:00', '[S3]', 'bogus'] }], checklist: [], moments: [{ text: 'M', refs: ['S77'] }] });
    const r = await generateNotes({ transcript: t, glossary: '', complete, fingerprint: 'f' });
    expect(r.notes.concepts[0].refs).toEqual(['u1']);
    expect(r.notes.takeaways[0].refs).toEqual(['u0', 'u2']);
    expect(r.notes.moments[0].refs).toEqual([]);
    expect(r.refStarts).toEqual({ u0: 0, u1: 5, u2: 10 });
    const md = notesToMarkdown({ ...rec(r), kind: 'video' });
    expect(md).toContain('- A [0:00] [0:10]');
    expect(md).not.toContain('Mốc thời gian'); // the only moment had no valid ref → not listed
  });

  it('text lessons never get timestamps', async () => {
    const t: Transcript = { ...tx(2), kind: 'text' };
    expect(sourceLines(t)[0].label).toBe('P1');
    expect(sourceLines(t)[0].start).toBeNull();
    const r = await generateNotes({ transcript: t, glossary: '', complete: mockComplete().fn, fingerprint: 'f' });
    expect(r.refStarts).toEqual({});
    expect(notesToMarkdown({ ...rec(r), kind: 'text' })).not.toMatch(/\[\d+:\d\d\]/);
  });

  it('coerces malformed output safely', () => {
    const n = coerceNotes({ title: 5, summary: 'x', steps: ['plain string', { text: '' }], concepts: [{ term: 'a' }] }, () => null, 'Fallback');
    expect(n.title).toBe('Fallback');
    expect(n.steps).toEqual([{ text: 'plain string', refs: [] }]);
    expect(n.concepts).toEqual([]);
  });

  it('schema is strict-mode compatible (all keys required, no extra props)', () => {
    const walk = (s: any): void => {
      if (s.type === 'object') {
        expect(s.additionalProperties).toBe(false);
        expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(walk);
      } else if (s.type === 'array') walk(s.items);
    };
    walk(NOTES_SCHEMA);
  });
});

function rec(r: Awaited<ReturnType<typeof generateNotes>>, extra: Partial<NotesRecord> = {}): NotesRecord {
  return { lessonId: 'lesson-A', title: 'Market Awareness 101', kind: 'video', notes: r.notes, refStarts: r.refStarts, transcriptVersion: r.transcriptVersion, coverage: r.coverage, provider: 'mock', model: 'mock', createdAt: 0, calls: r.calls, truncated: r.truncated, ...extra };
}

describe('partial coverage', () => {
  it('prompt states the partial coverage; notes and exports carry the banner', async () => {
    const t = tx(24, { full: false, duration: 1200 }); // 2 minutes of a 20-minute lesson
    expect(t.coverage.state).toBe('partial');
    const prompts: string[] = [];
    const r = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: async (q) => (prompts.push(q.user), JSON.stringify({ summary: 's' })) });
    expect(prompts[0]).toMatch(/only part of the lesson transcript is available \(up to 1:59 of 20:00\)/);
    const md = notesToMarkdown(rec(r));
    expect(md).toContain(PARTIAL_BANNER);
    expect(notesFileName(rec(r), 'md')).toBe('Market Awareness 101-ghi-chu-AI-PARTIAL.md');
  });

  it('complete transcript → no partial banner', async () => {
    const r = await generateNotes({ transcript: tx(5), glossary: '', fingerprint: 'f', complete: mockComplete().fn });
    expect(notesToMarkdown(rec(r))).not.toContain(PARTIAL_BANNER);
  });
});

describe('long lessons (hierarchical)', () => {
  it('short lesson = one call; 60-minute lesson = chunks + merge, bounded', async () => {
    const short = mockComplete();
    await generateNotes({ transcript: tx(40), glossary: '', fingerprint: 'f', complete: short.fn });
    expect(short.calls).toEqual(['notes']);

    const t = tx(720, { len: 140 }); // 60 min, one line per 5 s
    const { chunks } = chunkLines(sourceLines(t), DEFAULT_BUDGET);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(DEFAULT_BUDGET.maxChunks);
    const long = mockComplete();
    const progress: [number, number][] = [];
    const r = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: long.fn, onProgress: (d, n) => progress.push([d, n]) });
    expect(long.calls.filter((c) => c.startsWith('chunk'))).toHaveLength(chunks.length);
    expect(long.calls.filter((c) => c === 'merge').length).toBeGreaterThanOrEqual(1);
    expect(r.calls).toBe(long.calls.length);
    // Merge keeps refs from every part (first and last chunk are both represented).
    const refs = r.notes.takeaways.flatMap((x) => x.refs);
    expect(refs).toContain('u0');
    expect(refs.some((id) => Number(id.slice(1)) > 600)).toBe(true);
    // Deduplicated
    expect(new Set(r.notes.takeaways.map((x) => x.text)).size).toBe(r.notes.takeaways.length);
    expect(progress.at(-1)![0]).toBeGreaterThan(0);
  });

  it('every request stays within the input budget', async () => {
    const sizes: number[] = [];
    const m = mockComplete();
    await generateNotes({ transcript: tx(2000, { len: 160 }), glossary: '', fingerprint: 'f', complete: (q) => (sizes.push(q.user.length), m.fn(q)) });
    const perChunk = Math.max(DEFAULT_BUDGET.chunkChars, Math.ceil(DEFAULT_BUDGET.maxTotalChars / DEFAULT_BUDGET.maxChunks));
    expect(Math.max(...sizes)).toBeLessThan(perChunk + 60_000);
  });

  it('regeneration reuses intermediate chunk results', async () => {
    const t = tx(720, { len: 140 });
    const first = mockComplete();
    const a = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: first.fn });
    const second = mockComplete();
    const b = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: second.fn, previousChunks: a.chunks });
    expect(b.reusedChunks).toBe(Object.keys(a.chunks).length);
    expect(second.calls.every((c) => c === 'merge')).toBe(true);
    // A different model must not reuse them.
    const third = mockComplete();
    const c = await generateNotes({ transcript: t, glossary: '', fingerprint: 'other', complete: third.fn, previousChunks: a.chunks });
    expect(c.reusedChunks).toBe(0);
  });
});

function memStorage() {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(k: string) {
      return k in data ? { [k]: structuredClone(data[k]) } : {};
    },
    async set(o: Record<string, unknown>) {
      Object.assign(data, structuredClone(o));
    },
    async remove(k: string) {
      delete data[k];
    },
  } as any;
}

describe('NotesManager persistence', () => {
  it('saves by lesson, survives a new manager (restart), returns saved notes without API calls, edits locally', async () => {
    const storage = memStorage();
    const p = new MockProvider();
    const complete = vi.fn((req: any) => p.complete({ ...req, signal: new AbortController().signal }));
    const mk = () => new NotesManager({ storage, complete, activeModel: async () => ({ provider: 'mock', model: 'mock' }), glossary: async () => '' });
    const rec1 = await mk().generate(tx(5));
    expect(rec1.chunks).toBeUndefined(); // intermediate results stay in the worker
    expect(complete).toHaveBeenCalledTimes(1);
    const again = await mk().get('lesson-A');
    expect(again?.notes.summary).toBe(rec1.notes.summary);
    expect(complete).toHaveBeenCalledTimes(1);
    const edited = await mk().saveEdit('lesson-A', '# Của tôi');
    expect(edited?.editedMarkdown).toBe('# Của tôi');
    expect(notesToMarkdown(edited!)).toBe('# Của tôi');
    const restored = await mk().saveEdit('lesson-A', null);
    expect(restored?.editedMarkdown).toBeUndefined();
  });

  it('cancel aborts the running generation', async () => {
    const storage = memStorage();
    let seen: AbortSignal | null = null;
    const m = new NotesManager({
      storage,
      activeModel: async () => ({ provider: 'mock', model: 'mock' }),
      glossary: async () => '',
      complete: (_r, o) =>
        new Promise((_, rej) => {
          seen = o.signal;
          o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    const p = m.generate(tx(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(m.isRunning('lesson-A')).toBe(true);
    m.cancel('lesson-A');
    await expect(p).rejects.toThrow(/abort/);
    expect(seen!.aborted).toBe(true);
    expect(m.isRunning('lesson-A')).toBe(false);
    expect(storage.data['notes:lesson-A']).toBeUndefined();
  });
});

describe('service.complete: current provider, consent, low priority, errors', () => {
  const settings = (o: any = {}) => mergeSettings({ ...DEFAULT_SETTINGS, provider: { kind: 'gemini', endpoint: 'https://g', model: 'gemini-3.5-flash-lite', temperature: 0.2 }, consent: { remoteTranslation: true, remoteAudio: false }, ...o });
  const svc = (s: any, factory: any, extra: any = {}) =>
    new TranslationService({ cache: new TranslationCache({ dbName: 'notes-' + Math.random() }), getSettings: async () => s, getSecrets: async () => ({}), providerFactory: factory, queueOptions: { sleep: async () => undefined }, ...extra });
  const q = { system: 's', user: 'u', schema: {}, maxTokens: 100, label: 'x' };

  it('refuses without remote-text consent (nothing sent)', async () => {
    const complete = vi.fn();
    await expect(svc(settings({ consent: { remoteTranslation: false, remoteAudio: false } }), () => ({ id: 'g', translateBatch: vi.fn(), complete })).complete(q, { signal: new AbortController().signal, lesson: 'l' })).rejects.toThrow(/Chưa cho phép/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses when the endpoint permission is missing', async () => {
    await expect(svc(settings(), () => new MockProvider(), { hasEndpointPermission: async () => false }).complete(q, { signal: new AbortController().signal, lesson: 'l' })).rejects.toThrow(/quyền/);
  });

  it('uses the configured model and accounts usage with the notes label', async () => {
    const events: any[] = [];
    let used = '';
    const s = svc(settings(), (st: any) => ((used = st.provider.model), new MockProvider()), { onAccounting: (e: any, m: any) => events.push([e.type, m]) });
    await s.complete(q, { signal: new AbortController().signal, lesson: 'l' });
    expect(used).toBe('gemini-3.5-flash-lite');
    expect(events.some(([t, m]) => t === 'usage' && m.kind === 'notes' && m.model === 'gemini-3.5-flash-lite')).toBe(true);
  });

  it('retries a 429 once then reports a permanent error without retrying', async () => {
    let n = 0;
    const s = svc(settings(), () => ({ id: 'x', translateBatch: vi.fn(), complete: async () => { if (++n === 1) throw new HttpError(429, 'quota', 10); return '{"summary":"ok"}'; } }));
    expect(await s.complete(q, { signal: new AbortController().signal, lesson: 'l' })).toBe('{"summary":"ok"}');
    let m = 0;
    const bad = svc(settings(), () => ({ id: 'x', translateBatch: vi.fn(), complete: async () => { m++; throw new HttpError(401, 'bad key'); } }));
    await expect(bad.complete(q, { signal: new AbortController().signal, lesson: 'l' })).rejects.toThrow(/bad key/);
    expect(m).toBe(1);
  });
});

describe('queue priority', () => {
  it('subtitle batches get free slots before notes tasks', async () => {
    const queue = new TranslationQueue({ concurrency: 1, sleep: async () => undefined });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const signal = new AbortController().signal;
    const first = queue.runTask(async () => { order.push('notes-1'); await gate; }, { priority: 9, signal });
    const notes2 = queue.runTask(async () => void order.push('notes-2'), { priority: 9, signal });
    const sub = queue.translate([{ key: 'k', text: 'Hi' }], { provider: { id: 'p', translateBatch: async (r) => (order.push('subtitle'), { [r.segments[0].id]: 'x' }) }, context: [], glossary: [], group: 'g', priority: 1 });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, notes2, sub]);
    expect(order).toEqual(['notes-1', 'subtitle', 'notes-2']);
  });
});

describe('providers: complete()', () => {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const base = { system: 'SYS', user: 'USER', schema: NOTES_SCHEMA, maxTokens: 1234, signal: new AbortController().signal };

  it('Gemini: same model, JSON mime type, output budget, usage', async () => {
    let body: any;
    let url = '';
    const u: any[] = [];
    const out = await new GeminiProvider({ endpoint: 'https://g', model: 'gemini-3.5-flash-lite', temperature: 0.2, fetchImpl: (async (x: string, i: any) => ((url = x), (body = JSON.parse(i.body)), json({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }))) as any }).complete({ ...base, onUsage: (x) => u.push(x) });
    expect(out).toBe('{"a":1}');
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 1234 });
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(u[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('OpenAI-compatible: json_object, max_tokens, configured model', async () => {
    let body: any;
    await new OpenAICompatibleProvider({ endpoint: 'https://o/v1', model: 'gpt-4o-mini', temperature: 0.2, fetchImpl: (async (_: string, i: any) => ((body = JSON.parse(i.body)), json({ choices: [{ message: { content: '{}' } }] }))) as any }).complete(base);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 1234, response_format: { type: 'json_object' } });
  });

  it('Anthropic: strict JSON schema output, configured model', async () => {
    let body: any;
    const f = (async (_: string, i: any) => ((body = JSON.parse(i.body)), json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"summary":"x"}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))) as any;
    const out = await new AnthropicProvider({ endpoint: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'k', fetchImpl: f }).complete(base);
    expect(out).toBe('{"summary":"x"}');
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(1234);
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: NOTES_SCHEMA });
  });

  it('Local backend: POST /complete', async () => {
    let url = '';
    const out = await new LocalHttpProvider({ endpoint: 'http://localhost:8787', model: 'm', fetchImpl: (async (x: string) => ((url = x), json({ text: '{}' }))) as any }).complete(base);
    expect(url).toBe('http://localhost:8787/complete');
    expect(out).toBe('{}');
  });
});

describe('notes view (UI)', () => {
  function api(record: NotesRecord | null = null) {
    const calls = { get: 0, generate: 0 };
    let saved = record;
    const a: NotesApi & { calls: typeof calls } = {
      calls,
      async get() {
        calls.get++;
        return { record: saved, running: false };
      },
      async generate(t) {
        calls.generate++;
        const r = await generateNotes({ transcript: t, glossary: '', fingerprint: 'f', complete: mockComplete().fn });
        saved = rec(r);
        return { record: saved };
      },
      async cancel() {},
      async save(_id, md) {
        saved = saved && { ...saved, editedMarkdown: md ?? undefined };
        return { record: saved };
      },
      async model() {
        return { provider: 'gemini', model: 'gemini-3.5-flash-lite' };
      },
    };
    return a;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('no API call until the user presses the button; then renders sections with clickable timestamps', async () => {
    document.body.innerHTML = '<div id="c"></div>';
    const c = document.getElementById('c')!;
    const a = api();
    const seeks: number[] = [];
    const v = new AiNotesView(document, a, async () => undefined);
    v.render(c, tx(6, { full: false, duration: 600 }), (s) => seeks.push(s));
    await tick();
    expect(a.calls.generate).toBe(0);
    expect(c.textContent).toContain(PARTIAL_BANNER);
    expect(c.textContent).toContain('gemini-3.5-flash-lite');
    [...c.querySelectorAll('button')].find((b) => b.textContent === '🧠 Tạo ghi chú AI')!.click();
    await tick();
    await tick();
    expect(a.calls.generate).toBe(1);
    expect(c.textContent).toContain('Điểm cần nhớ');
    expect(c.textContent).toContain(PARTIAL_BANNER);
    const ref = c.querySelector<HTMLButtonElement>('button.ref')!;
    expect(ref.textContent).toBe('0:00');
    ref.click();
    expect(seeks).toEqual([0]);
    expect(c.innerHTML).not.toContain('<script');
  });

  it('shows saved notes for a returning lesson without generating', async () => {
    document.body.innerHTML = '<div id="c"></div>';
    const c = document.getElementById('c')!;
    const r = await generateNotes({ transcript: tx(4), glossary: '', fingerprint: 'f', complete: mockComplete().fn });
    const a = api(rec(r));
    const v = new AiNotesView(document, a, async () => undefined);
    v.render(c, tx(4), null);
    await tick();
    await tick();
    expect(a.calls.generate).toBe(0);
    expect(c.textContent).toContain('Tạo lại');
    expect(notesToText(rec(r))).not.toMatch(/\*\*|^#/m);
  });

  it('model output is rendered as text, never HTML', async () => {
    document.body.innerHTML = '<div id="c"></div>';
    const c = document.getElementById('c')!;
    const r = await generateNotes({ transcript: tx(2), glossary: '', fingerprint: 'f', complete: async () => JSON.stringify({ summary: '<img src=x onerror=alert(1)>' }) });
    const v = new AiNotesView(document, api(rec(r)), async () => undefined);
    v.render(c, tx(2), null);
    await tick();
    await tick();
    expect(c.querySelector('img')).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
