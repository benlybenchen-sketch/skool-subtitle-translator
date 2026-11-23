/** Phase 5D: Gemini TTS (Interactions API) as an additional dubbing provider. */
import { DubbingService } from '../../src/background/dubbing';
import { GeminiTts, decodeGeminiAudio, findAudioPayload, geminiTtsCostUsd, pcmToWav, wavDurationSec } from '../../src/tts/providers';
import { TtsAudioCache } from '../../src/tts/audioCache';
import { TtsLedger } from '../../src/tts/ttsLedger';
import { DubbingSession } from '../../src/dubbing/session';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { arrayBufferToBase64 } from '../../src/shared/util';
import type { Settings } from '../../src/shared/types';

const mem = () => {
  const d: Record<string, unknown> = {};
  return { get: async (k: string) => (k in d ? { [k]: structuredClone(d[k]) } : {}), set: async (o: Record<string, unknown>) => void Object.assign(d, structuredClone(o)), remove: async (k: string) => void delete d[k] } as any;
};
const b64 = (u: Uint8Array) => arrayBufferToBase64(u.slice().buffer as ArrayBuffer);
/** 0.5 s of silence as 24 kHz mono 16-bit PCM. */
const PCM = new Uint8Array(24000);
const WAV = pcmToWav(PCM, 24000);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fakeGemini(o: { reply?: (body: any) => Response; } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return o.reply ? o.reply(body) : json({ outputs: [{ type: 'audio', mime_type: 'audio/wav', data: b64(WAV) }], usage: { total_input_tokens: 12, total_output_tokens: 13 } });
  });
  return { f, calls };
}

function service(o: { settings?: Partial<Settings>; secrets?: any; perm?: boolean } = {}) {
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, consent: { remoteTranslation: true, remoteAudio: false, remoteTts: true }, ...o.settings });
  const ledger = new TtsLedger(mem(), mem());
  const s = new DubbingService({
    getSettings: async () => settings,
    getSecrets: async () => o.secrets ?? { translationApiKeys: { gemini: 'AIza-gemini-translation-key' } },
    hasEndpointPermission: async () => o.perm ?? true,
    ensureOffscreen: async () => undefined,
    sendOffscreen: async (m: any) => (m.type === 'dub-load' ? { durationSec: 0.5 } : { ok: true }),
    sendToFrame: async () => undefined,
    ledger,
    session: mem(),
    cache: new TtsAudioCache({ dbName: 'gtts-' + Math.random() }),
  });
  return { s, ledger };
}

beforeEach(() => GeminiTts.resetVariant());
afterEach(() => vi.unstubAllGlobals());

describe('Gemini TTS request', () => {
  it('reuses the Gemini translation key; Interactions API schema; model selection', async () => {
    const g = fakeGemini();
    vi.stubGlobal('fetch', g.f);
    const { s } = service({ settings: { dubbing: { ...DEFAULT_SETTINGS.dubbing, geminiModel: 'gemini-3.8-flash-tts', geminiStyle: false } } });
    const r = await s.prepare({ lesson: 'L', text: 'Xin chào các bạn.', provider: 'gemini', voice: 'Puck', rate: 1, model: 'gemini-3.8-flash-tts', style: false });
    const c = g.calls[0];
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(c.headers['x-goog-api-key']).toBe('AIza-gemini-translation-key');
    expect(c.headers['Api-Revision']).toBeTruthy();
    expect(c.body).toEqual({ model: 'gemini-3.8-flash-tts', input: 'Xin chào các bạn.', response_format: { type: 'audio' }, generation_config: { speech_config: { voice: 'Puck' } } });
    expect(r.durationSec).toBeGreaterThan(0);
  });

  it('default model is 3.8 Flash-Lite TTS; style goes in speech_metadata, never into the spoken text', async () => {
    expect(DEFAULT_SETTINGS.dubbing.geminiModel).toBe('gemini-3.8-flash-lite-tts');
    const g = fakeGemini();
    await new GeminiTts({ endpoint: 'https://g/v1beta', apiKey: 'k', model: 'gemini-3.8-flash-lite-tts', style: true, fetchImpl: g.f as any }).synthesize({ text: 'Mở Shopify.', voice: 'Kore', rate: 1 });
    expect(g.calls[0].body.input).toEqual([{ type: 'text', text: 'Mở Shopify.', speech_metadata: { style: expect.stringMatching(/giảng dạy/) } }]);
    expect(g.calls[0].body.input[0].text).toBe('Mở Shopify.');
  });

  it('a 400 on the style shape falls back to the plain documented form (remembered)', async () => {
    const g = fakeGemini({ reply: (b) => (Array.isArray(b.input) ? json({ error: { message: 'Unknown field speech_metadata' } }, 400) : json({ outputs: [{ type: 'audio', mime_type: 'audio/wav', data: b64(WAV) }] })) });
    const tts = new GeminiTts({ endpoint: 'https://g/v1beta', apiKey: 'k', model: 'gemini-3.8-flash-lite-tts', style: true, fetchImpl: g.f as any });
    await tts.synthesize({ text: 'Một', voice: 'Kore', rate: 1 });
    await tts.synthesize({ text: 'Hai', voice: 'Kore', rate: 1 });
    expect(g.calls.map((c) => (Array.isArray(c.body.input) ? 'style' : 'plain'))).toEqual(['style', 'plain', 'plain']);
  });

  it('missing key → exact cause; consent and host permission required', async () => {
    const { s } = service({ secrets: {} });
    await expect(s.prepare({ lesson: 'L', text: 'A', provider: 'gemini', voice: 'Kore', rate: 1 })).rejects.toThrow(/Thiếu API key Gemini/);
    const noConsent = service({ settings: { consent: { remoteTranslation: true, remoteAudio: false, remoteTts: false } } });
    await expect(noConsent.s.prepare({ lesson: 'L', text: 'A', provider: 'gemini', voice: 'Kore', rate: 1 })).rejects.toThrow(/Chưa cho phép gửi văn bản tiếng Việt tới Gemini TTS/);
    const noPerm = service({ perm: false });
    await expect(noPerm.s.prepare({ lesson: 'L', text: 'A', provider: 'gemini', voice: 'Kore', rate: 1 })).rejects.toThrow(/Chưa cấp quyền truy cập Gemini TTS/);
  });
});

describe('audio decoding', () => {
  it('self-contained WAV kept; raw L16 PCM wrapped (never confused); malformed rejected', () => {
    const w = decodeGeminiAudio(b64(WAV), 'audio/wav');
    expect(w.durationSec).toBeCloseTo(0.5);
    expect(String.fromCharCode(...w.wav.slice(0, 4))).toBe('RIFF');
    const p = decodeGeminiAudio(b64(PCM), 'audio/l16;rate=24000');
    expect(p.durationSec).toBeCloseTo(0.5);
    expect(wavDurationSec(p.wav)).toBeCloseTo(0.5);
    expect(() => decodeGeminiAudio(b64(new Uint8Array([1, 2, 3])), 'audio/l16')).toThrow(/PCM không hợp lệ/);
    expect(() => decodeGeminiAudio(b64(new Uint8Array([82, 73, 70, 70, 0, 0])), 'audio/wav')).toThrow(/WAV hỏng/);
    expect(() => decodeGeminiAudio(b64(new Uint8Array(100)), 'audio/ogg')).toThrow(/không hỗ trợ/);
  });
  it('finds audio in Interactions outputs or the legacy candidates/inlineData shape', () => {
    expect(findAudioPayload({ outputs: [{ type: 'text', text: 'x' }, { type: 'audio', data: 'A'.repeat(100), mime_type: 'audio/wav' }] })?.mime).toBe('audio/wav');
    expect(findAudioPayload({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'B'.repeat(100) } }] } }] })?.mime).toMatch(/L16/);
    expect(findAudioPayload({ outputs: [] })).toBeNull();
  });
  it('response without audio → clear error (counted as failure)', async () => {
    vi.stubGlobal('fetch', fakeGemini({ reply: () => json({ outputs: [{ type: 'text', text: 'sorry' }] }) }).f);
    const { s, ledger } = service();
    await expect(s.prepare({ lesson: 'L', text: 'A', provider: 'gemini', voice: 'Kore', rate: 1 })).rejects.toThrow(/không có âm thanh/);
    expect((await ledger.snapshot()).total.failures).toBe(1);
  });
});

describe('robustness, cache and accounting', () => {
  it('429 / 5xx retried with backoff; quota exhaustion reported after bounded attempts', async () => {
    let n = 0;
    vi.stubGlobal('fetch', fakeGemini({ reply: () => (++n === 1 ? json({ error: { message: 'Resource exhausted' } }, 429) : json({ outputs: [{ type: 'audio', mime_type: 'audio/wav', data: b64(WAV) }] })) }).f);
    const { s } = service();
    await s.prepare({ lesson: 'L', text: 'Retry me', provider: 'gemini', voice: 'Kore', rate: 1 });
    expect(n).toBe(2);
    let m = 0;
    vi.stubGlobal('fetch', fakeGemini({ reply: () => (m++, json({ error: { message: 'Quota exceeded for gemini tts' } }, 429)) }).f);
    const t = service();
    await expect(t.s.prepare({ lesson: 'L', text: 'Always 429', provider: 'gemini', voice: 'Kore', rate: 1 })).rejects.toThrow(/429/);
    expect(m).toBe(3);
  }, 20_000);

  it('identical text is synthesized once; model / style / voice changes make new audio', async () => {
    const g = fakeGemini();
    vi.stubGlobal('fetch', g.f);
    const { s, ledger } = service();
    const req = { lesson: 'L', text: 'Câu giống nhau.', provider: 'gemini' as const, voice: 'Kore', rate: 1, model: 'gemini-3.8-flash-lite-tts', style: true };
    await s.prepare(req);
    await s.prepare(req);
    await s.prepare({ ...req, rate: 1.3 }); // user rate is applied at playback → same audio
    expect(g.f).toHaveBeenCalledTimes(1);
    await s.prepare({ ...req, model: 'gemini-3.8-flash-tts' });
    await s.prepare({ ...req, style: false });
    await s.prepare({ ...req, voice: 'Puck' });
    expect(g.f).toHaveBeenCalledTimes(4);
    const snap = await ledger.snapshot();
    expect(snap.total.cacheHits).toBe(2);
  });

  it('TTS tokens and estimated cost are accounted separately from translation', async () => {
    vi.stubGlobal('fetch', fakeGemini().f);
    const { s, ledger } = service();
    await s.prepare({ lesson: 'L', text: 'Một câu.', provider: 'gemini', voice: 'Kore', rate: 1, model: 'gemini-3.8-flash-lite-tts' });
    const t = (await ledger.snapshot()).total;
    expect(t.inputTokens).toBe(12);
    expect(t.outputTokens).toBe(13);
    expect(t.estimatedTokens).toBe(0);
    expect(t.estCostUsd).toBeCloseTo(geminiTtsCostUsd('gemini-3.8-flash-lite-tts', 12, 13));
    expect(geminiTtsCostUsd('gemini-3.8-flash-lite-tts', 1e6, 1e6)).toBeCloseTo(6.5);
    expect(geminiTtsCostUsd('gemini-3.8-flash-tts', 0, 1e6)).toBeCloseTo(9);
  });

  it('no usage reported → tokens estimated and labelled as estimates', async () => {
    vi.stubGlobal('fetch', fakeGemini({ reply: () => json({ outputs: [{ type: 'audio', mime_type: 'audio/wav', data: b64(WAV) }] }) }).f);
    const { s, ledger } = service();
    await s.prepare({ lesson: 'L', text: 'Không có usage.', provider: 'gemini', voice: 'Kore', rate: 1, model: 'gemini-3.8-flash-lite-tts' });
    const t = (await ledger.snapshot()).total;
    expect(t.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('dubbing session with Gemini TTS', () => {
  it('Gemini voices listed (gender not assumed); rate applied at playback; original muted; restored on dispose', async () => {
    const v = document.createElement('video');
    const sent: any[] = [];
    const s = new DubbingSession(v, 'L', { ...DEFAULT_SETTINGS.dubbing, enabled: true, provider: 'gemini', geminiVoice: 'Charon', rate: 1.25 }, (async (m: any) => {
      sent.push(m);
      if (m.type === 'dub:voices') return { voices: [{ id: 'Kore', label: 'Kore', lang: 'vi-VN', gender: 'unknown' }, { id: 'Charon', label: 'Charon', lang: 'vi-VN', gender: 'unknown' }] };
      if (m.type === 'dub:prepare') return { key: 'k:' + m.text, durationSec: 2.5 };
      return { ok: true };
    }) as any);
    await s.start();
    expect(v.muted).toBe(true);
    expect(s.status().voice).toBe('Charon');
    s.setUnits([{ id: 'u0', start: 0.5, end: 4, text: 'Hello.', vi: 'Xin chào.', status: 'done', cueIds: [] } as any]);
    await new Promise((r) => setTimeout(r, 10));
    const prep = sent.find((m) => m.type === 'dub:prepare');
    expect(prep).toMatchObject({ provider: 'gemini', voice: 'Charon', model: 'gemini-3.8-flash-lite-tts', style: true });
    Object.defineProperty(v, 'paused', { value: false, configurable: true });
    v.currentTime = 0.6;
    s.play();
    await new Promise((r) => setTimeout(r, 10));
    const play = sent.find((m) => m.type === 'dub:play');
    expect(play.rate).toBeCloseTo(1.25); // natural-rate audio sped to the user's rate
    s.dispose();
    expect(v.muted).toBe(false);
  });
});

// Optional, opt-in real API check (never runs in CI): RUN_REAL_GEMINI_TTS=1 GEMINI_API_KEY=... npx vitest run gemini-tts
describe.skipIf(!(process.env.RUN_REAL_GEMINI_TTS === '1' && process.env.GEMINI_API_KEY))('real Gemini TTS (opt-in)', () => {
  it('synthesizes a short Vietnamese sentence', async () => {
    const r = await new GeminiTts({ endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-lite-tts', style: true }).synthesize({ text: 'Xin chào, đây là bài kiểm tra.', voice: 'Kore', rate: 1 });
    expect(r.durationSec).toBeGreaterThan(0.5);
  }, 60_000);
});
