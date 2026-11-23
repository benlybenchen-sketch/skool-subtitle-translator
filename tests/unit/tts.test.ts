/** Phase 4A: Vietnamese TTS providers, voice detection, cloud synthesis, audio cache, usage. */
import { DubbingService } from '../../src/background/dubbing';
import { GoogleCloudTts, MockTts, estimateSpeechSec, pickVoice, ttsCostUsd, vietnameseChromeVoices } from '../../src/tts/providers';
import { TtsAudioCache, audioKey } from '../../src/tts/audioCache';
import { TtsLedger } from '../../src/tts/ttsLedger';
import { HttpError } from '../../src/translation/errors';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import type { Settings } from '../../src/shared/types';

const mem = () => {
  const d: Record<string, unknown> = {};
  return { d, get: async (k: string) => (k in d ? { [k]: structuredClone(d[k]) } : {}), set: async (o: Record<string, unknown>) => void Object.assign(d, structuredClone(o)), remove: async (k: string) => void delete d[k] } as any;
};

function fakeTts(voices: chrome.tts.TtsVoice[]) {
  const spoken: { text: string; opts: any }[] = [];
  const api = {
    spoken,
    getVoices: (cb: (v: chrome.tts.TtsVoice[]) => void) => cb(voices),
    speak: (text: string, opts: any) => {
      spoken.push({ text, opts });
      setTimeout(() => opts.onEvent?.({ type: 'start', charIndex: 0 } as chrome.tts.TtsEvent), 1);
      setTimeout(() => opts.onEvent?.({ type: 'end', charIndex: text.length } as chrome.tts.TtsEvent), 5);
    },
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return api;
}

function svc(o: { settings?: Partial<Settings>; voices?: chrome.tts.TtsVoice[]; cloud?: any; perm?: boolean } = {}) {
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...o.settings });
  const events: any[] = [];
  const offscreen: any[] = [];
  const tts = fakeTts(o.voices ?? []);
  const tabsState: Record<number, boolean> = { 7: false };
  const tabs = {
    get: async (id: number) => ({ id, mutedInfo: { muted: tabsState[id] } }) as any,
    update: async (id: number, p: { muted?: boolean }) => ((tabsState[id] = !!p.muted), { id } as any),
  };
  const ledger = new TtsLedger(mem(), mem());
  const s = new DubbingService({
    getSettings: async () => settings,
    getSecrets: async () => ({ ttsApiKey: 'k' }),
    hasEndpointPermission: async () => o.perm ?? true,
    ensureOffscreen: async () => undefined,
    sendOffscreen: async (m: any) => (offscreen.push(m), m.type === 'dub-load' ? { durationSec: 1.5 } : { ok: true }),
    sendToFrame: async (_t, _f, m) => void events.push(m),
    ledger,
    tts: tts as any,
    tabs: tabs as any,
    session: mem(),
    cache: new TtsAudioCache({ dbName: 'tts-' + Math.random() }),
    cloudFactory: o.cloud ? () => o.cloud : undefined,
  });
  return { s, events, offscreen, tts, tabsState, ledger };
}

describe('Chrome TTS voices', () => {
  const voices = [
    { voiceName: 'Google US English', lang: 'en-US' },
    { voiceName: 'Microsoft An - Vietnamese (Vietnam)', lang: 'vi-VN' },
    { voiceName: 'Linh', lang: 'vi-VN' },
    { voiceName: 'Some vi', lang: 'vi' },
  ];
  it('only Vietnamese voices, vi-VN first; genders from known names', () => {
    const vi = vietnameseChromeVoices(voices);
    expect(vi.map((v) => v.id)).toEqual(['Microsoft An - Vietnamese (Vietnam)', 'Linh', 'Some vi']);
    expect(vi.find((v) => v.id === 'Linh')!.gender).toBe('female');
    expect(vi[0].gender).toBe('male');
    expect(pickVoice(vi, '', 'female')!.id).toBe('Linh');
    expect(pickVoice(vi, 'Some vi', 'female')!.id).toBe('Some vi');
  });

  it('no Vietnamese voice → explicit error, nothing spoken with another language', async () => {
    const { s, tts } = svc({ voices: [{ voiceName: 'Google US English', lang: 'en-US' }] });
    const v = await s.voices('chrome');
    expect(v.voices).toEqual([]);
    expect(v.error).toMatch(/không có giọng tiếng Việt/);
    const r = await s.speakChrome(7, 0, { token: 't', segId: 'a', text: 'Xin chào', voice: '', rate: 1, volume: 1 });
    expect(r.ok).toBe(false);
    expect(tts.spoken).toHaveLength(0);
  });

  it('speaks with vi-VN voice, rate/volume clamped; events relayed with the lesson token; usage counted at no cost', async () => {
    const { s, tts, events, ledger } = svc({ voices: [{ voiceName: 'Linh', lang: 'vi-VN' }] });
    await s.speakChrome(7, 0, { token: 'L1', segId: 'seg1', text: 'Xin chào các bạn', voice: '', rate: 9, volume: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(tts.spoken[0].opts).toMatchObject({ lang: 'vi-VN', voiceName: 'Linh', rate: 3, volume: 1, enqueue: false });
    expect(events.map((e) => e.kind)).toEqual(['start', 'end']);
    expect(events.every((e) => e.token === 'L1' && e.segId === 'seg1')).toBe(true);
    const snap = await ledger.snapshot();
    expect(snap.total.requests).toBe(1);
    expect(snap.total.estCostUsd).toBe(0);
  });
});

describe('Google Cloud TTS', () => {
  it('request: text:synthesize, vi-VN voice, MP3, API key header (not a Gemini key)', async () => {
    let url = '';
    let init: any;
    const f = (async (u: string, i: any) => ((url = u), (init = i), new Response(JSON.stringify({ audioContent: btoa('ID3fake') }), { status: 200 }))) as any;
    const r = await new GoogleCloudTts({ endpoint: 'https://texttospeech.googleapis.com/v1', apiKey: 'tts-key', fetchImpl: f }).synthesize({ text: 'Xin chào', voice: 'vi-VN-Neural2-D', rate: 1.1 });
    expect(url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(init.headers['X-Goog-Api-Key']).toBe('tts-key');
    expect(JSON.parse(init.body)).toEqual({ input: { text: 'Xin chào' }, voice: { languageCode: 'vi-VN', name: 'vi-VN-Neural2-D' }, audioConfig: { audioEncoding: 'MP3', speakingRate: 1.1 } });
    expect(r.mime).toBe('audio/mpeg');
    expect(r.chars).toBe(8);
  });
  it('missing key → configuration error', () => {
    expect(() => new GoogleCloudTts({ endpoint: 'https://x' })).toThrow(/Thiếu API key Google Cloud/);
  });
  it('cost estimate by voice tier (list prices, estimate)', () => {
    expect(ttsCostUsd('google', 'vi-VN-Neural2-A', 1e6)).toBe(16);
    expect(ttsCostUsd('google', 'vi-VN-Standard-A', 1e6)).toBe(4);
    expect(ttsCostUsd('chrome', 'Linh', 1e6)).toBe(0);
  });
  it('consent and host permission are required before sending text', async () => {
    const cloud = { id: 'google', format: 'mp3', synthesize: vi.fn() };
    const a = svc({ cloud, settings: { consent: { remoteTranslation: true, remoteAudio: false, remoteTts: false } } });
    await expect(a.s.prepare({ lesson: 'L', text: 'Xin chào', provider: 'google', voice: '', rate: 1 })).rejects.toThrow(/Chưa cho phép gửi văn bản tiếng Việt/);
    const b = svc({ cloud, perm: false, settings: { consent: { remoteTranslation: true, remoteAudio: false, remoteTts: true } } });
    await expect(b.s.prepare({ lesson: 'L', text: 'Xin chào', provider: 'google', voice: '', rate: 1 })).rejects.toThrow(/Chưa cấp quyền/);
    expect(cloud.synthesize).not.toHaveBeenCalled();
  });
});

describe('cloud synthesis pipeline: cache, dedupe, retry', () => {
  it('same text is synthesized once (concurrent dedupe + persistent cache); different voice/rate/lesson → new audio', async () => {
    const mock = new MockTts();
    const { s, offscreen, ledger } = svc({ cloud: mock });
    const req = { lesson: 'L1', text: 'Đây là câu một.', provider: 'mock' as const, voice: 'mock-vi', rate: 1 };
    const [a, b] = await Promise.all([s.prepare(req), s.prepare(req)]);
    expect(a.key).toBe(b.key);
    expect(mock.calls).toBe(1);
    const c = await s.prepare(req);
    expect(c.cached).toBe(true);
    expect(mock.calls).toBe(1);
    await s.prepare({ ...req, rate: 1.2 });
    await s.prepare({ ...req, lesson: 'L2' });
    expect(mock.calls).toBe(3);
    expect(offscreen.filter((m) => m.type === 'dub-load').length).toBe(3); // loaded once per key
    expect(a.durationSec).toBeGreaterThan(0);
    const snap = await ledger.snapshot();
    expect(snap.total.cacheHits).toBeGreaterThanOrEqual(1);
    expect(snap.total.requests).toBe(3);
  });

  it('transient errors retried with backoff; permanent errors not', async () => {
    let n = 0;
    const flaky = { id: 'mock', format: 'wav', synthesize: async (r: any) => { if (++n < 2) throw new HttpError(503, 'busy'); return new MockTts().synthesize(r); } };
    const { s } = svc({ cloud: flaky });
    await s.prepare({ lesson: 'L', text: 'Một', provider: 'mock', voice: 'v', rate: 1 });
    expect(n).toBe(2);
    let m = 0;
    const bad = { id: 'mock', format: 'wav', synthesize: async () => { m++; throw new HttpError(403, 'API key not valid'); } };
    const t = svc({ cloud: bad });
    await expect(t.s.prepare({ lesson: 'L', text: 'Hai', provider: 'mock', voice: 'v', rate: 1 })).rejects.toThrow(/API key not valid/);
    expect(m).toBe(1);
    expect((await t.ledger.snapshot()).total.failures).toBe(1);
  });

  it('audio key covers provider, voice, format, rate, lesson, text and config version', () => {
    const base = { provider: 'google', voice: 'vi-VN-Neural2-A', format: 'mp3', rate: 1, lesson: 'L', text: 'Xin chào' };
    const k = audioKey(base);
    expect(k.startsWith('tts1|google|vi-VN-Neural2-A|mp3|1.00|')).toBe(true);
    for (const patch of [{ voice: 'vi-VN-Neural2-D' }, { rate: 1.1 }, { lesson: 'M' }, { text: 'Xin chào!' }, { format: 'ogg' }]) expect(audioKey({ ...base, ...patch })).not.toBe(k);
  });

  it('cache is bounded (LRU by bytes)', async () => {
    let t = 0;
    const c = new TtsAudioCache({ dbName: 'tts-lru-' + Math.random(), maxBytes: 250, now: () => ++t });
    for (let i = 0; i < 5; i++) await c.put({ key: 'k' + i, audio: new Uint8Array(100), mime: 'audio/wav' });
    await c.get('k0'); // touch
    const r = await c.prune();
    expect(r.removed).toBe(3);
    expect(await c.get('k0')).not.toBeNull();
    expect(await c.get('k1')).toBeNull();
  });
});

describe('tab-level mute fallback', () => {
  it('remembers and restores the user state exactly; never touches other tabs', async () => {
    const { s, tabsState } = svc();
    tabsState[7] = false;
    tabsState[8] = true;
    await s.tabMute(7, true);
    expect(tabsState[7]).toBe(true);
    await s.tabMute(7, true); // idempotent: the original state is not overwritten
    await s.tabMute(7, false);
    expect(tabsState[7]).toBe(false);
    expect(tabsState[8]).toBe(true);
  });
  it('a tab the user had muted stays muted after dubbing; recovery after a crash restores', async () => {
    const { s, tabsState } = svc();
    tabsState[7] = true;
    await s.tabMute(7, true);
    await s.recover(7); // e.g. page reloaded after the content script died
    expect(tabsState[7]).toBe(true);
    tabsState[7] = false;
    await s.tabMute(7, true);
    await s.recover(7);
    expect(tabsState[7]).toBe(false);
  });
});

it('speech duration estimate is plausible for Vietnamese', () => {
  const t = 'Hôm nay chúng ta sẽ thiết lập chiến dịch quảng cáo Facebook đầu tiên.'; // 15 words
  expect(estimateSpeechSec(t)).toBeGreaterThan(3);
  expect(estimateSpeechSec(t)).toBeLessThan(5);
  expect(estimateSpeechSec(t, 1.5)).toBeLessThan(estimateSpeechSec(t));
});

describe('offscreen player eviction', () => {
  it('a clip evicted by the player is reloaded from the cache and played (once)', async () => {
    const mock = new MockTts();
    const { s, offscreen } = svc({ cloud: mock });
    const r = await s.prepare({ lesson: 'L', text: 'Một hai ba', provider: 'mock', voice: 'v', rate: 1 });
    let first = true;
    (s as any).d.sendOffscreen = async (m: any) => {
      offscreen.push(m);
      if (m.type === 'dub-play' && first) {
        first = false;
        return { ok: false, error: 'clip not loaded' };
      }
      return m.type === 'dub-load' ? { durationSec: 1 } : { ok: true };
    };
    await s.play(7, 0, { token: 't', segId: 's', key: r.key, rate: 1, volume: 1, offsetSec: 0 });
    const types = offscreen.map((m) => m.type);
    expect(types.slice(-3)).toEqual(['dub-play', 'dub-load', 'dub-play']);
    expect(mock.calls).toBe(1); // reloaded from the cache, not re-synthesized
    const play = offscreen.at(-1);
    expect(play).toMatchObject({ target: 'offscreen', type: 'dub-play', key: r.key, token: 't', segId: 's' });
  });
});
