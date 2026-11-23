import { SpeechChunker, type AudioChunk } from '../../src/audio/chunker';
import { encodeWav, resample } from '../../src/audio/wav';
import { LiveSegmentAssembler, isLikelyHallucination } from '../../src/speech/assembler';
import { AudioSessionManager, type AudioDeps } from '../../src/background/audioSession';
import { TabRegistry } from '../../src/background/tabRegistry';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings';
import { HttpError } from '../../src/translation/errors';
import type { SttBackend } from '../../src/speech/types';
import type { Settings } from '../../src/shared/types';

const SR = 16000;
const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
const silence = (sec: number) => new Float32Array(Math.round(sec * SR)).map(() => (Math.random() - 0.5) * 0.0005);

describe('SpeechChunker (VAD)', () => {
  const run = (parts: Float32Array[], opts = {}) => {
    const chunks: AudioChunk[] = [];
    const c = new SpeechChunker({ sampleRate: SR, ...opts }, (ch) => chunks.push(ch));
    for (const p of parts) for (let i = 0; i < p.length; i += 4096) c.push(p.subarray(i, i + 4096));
    c.flush();
    return chunks;
  };

  it('splits speech at pauses and keeps timestamps', () => {
    const chunks = run([silence(1), tone(1.5), silence(1), tone(2), silence(1)]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startSec).toBeGreaterThan(0.6);
    expect(chunks[0].startSec).toBeLessThan(1.05);
    expect(chunks[0].endSec).toBeGreaterThan(2.4);
    expect(chunks[0].endSec).toBeLessThan(2.8);
    expect(chunks[1].startSec).toBeGreaterThan(3.2);
  });

  it('ignores silence and short clicks', () => {
    expect(run([silence(3)])).toHaveLength(0);
    expect(run([silence(1), tone(0.1), silence(1)])).toHaveLength(0);
  });

  it('forces a cut during long continuous speech (bounded latency)', () => {
    const chunks = run([tone(20)], { maxChunkMs: 5000 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.slice(0, -1).every((c) => c.forced && c.endSec - c.startSec <= 5.05)).toBe(true);
    // contiguous, no lost audio
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startSec).toBeCloseTo(chunks[i - 1].endSec, 2);
  });

  it('handles incomplete speech at stop via flush()', () => {
    const chunks: AudioChunk[] = [];
    const c = new SpeechChunker({ sampleRate: SR }, (ch) => chunks.push(ch));
    c.push(tone(1));
    expect(chunks).toHaveLength(0);
    c.flush();
    expect(chunks).toHaveLength(1);
  });
});

describe('WAV encoding / resampling', () => {
  it('writes a valid 16-bit mono header', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1]), 16000);
    const v = new DataView(buf);
    expect(String.fromCharCode(...new Uint8Array(buf, 0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(buf.byteLength).toBe(44 + 6);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
  });
  it('resamples 48k → 16k', () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });
});

describe('LiveSegmentAssembler', () => {
  it('joins short fragments with the next chunk', () => {
    const a = new LiveSegmentAssembler();
    expect(a.push('and so', 0, 1)).toEqual([]);
    const out = a.push('we open the dashboard.', 1, 3);
    expect(out[0].text).toBe('and so we open the dashboard.');
    expect(out[0].startSec).toBe(0);
  });
  it('removes words repeated across chunk boundaries', () => {
    const a = new LiveSegmentAssembler();
    a.push('Click on the settings button', 0, 2);
    expect(a.push('settings button and then save.', 2, 4)[0].text).toBe('and then save.');
  });
  it('filters silence hallucinations', () => {
    expect(isLikelyHallucination('Thanks for watching!', 0.001)).toBe(true);
    expect(isLikelyHallucination('Thanks for watching!', 0.2)).toBe(false);
    expect(new LiveSegmentAssembler().push('Thank you.', 0, 1, 0.001)).toEqual([]);
  });
  it('flushes held fragments', () => {
    const a = new LiveSegmentAssembler();
    a.push('so', 0, 1);
    expect(a.flush()[0].text).toBe('so');
  });
});

// ------------------------------------------------------------- background audio session

function sessionStore() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k: string) => ({ [k]: data[k] }),
    set: async (v: Record<string, unknown>) => void Object.assign(data, v),
  };
}

function deps(over: Partial<AudioDeps> & { settings?: Partial<Settings>; stt?: SttBackend } = {}) {
  const sent: any[] = [];
  const offscreen: any[] = [];
  const badges: string[] = [];
  const registry = new TabRegistry(sessionStore());
  registry.updateFrame(7, 0, { isTop: true, host: 'www.skool.com', provider: 'skool-native', embeddedProviders: [], targetKind: 'video', targetArea: 100, captionState: 'unavailable', captionSource: null, mode: 'waiting-audio', videoKey: 'k', unitsTotal: 0, unitsTranslated: 0, unitsFailed: 0, updatedAt: 0, videoElements: 1, audioElements: 0, pageAnchor: false });
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...over.settings });
  let offscreenOpen = false;
  const d: AudioDeps = {
    registry,
    getSettings: async () => settings,
    getSecrets: async () => ({}),
    ensureOffscreen: async () => void (offscreenOpen = true),
    closeOffscreen: async () => void (offscreenOpen = false),
    sendOffscreen: async (m) => void offscreen.push(m),
    sendToFrame: async (_t, f, m) => void sent.push({ f, ...m }),
    broadcast: async () => undefined,
    translate: async (_k, text) => ({ vi: `VI:${text}` }),
    setBadge: (_t, b) => void badges.push(b),
    sttFactory: () => over.stt ?? { id: 'fake', transcribe: async () => ({ text: 'Hello everyone, welcome back.' }) },
    sessionStore: sessionStore(),
    ...over,
  };
  return { d, sent, offscreen, badges, registry, isOffscreenOpen: () => offscreenOpen };
}

const chunk = (seq: number, sessionId: string) => ({ sessionId, seq, wavBase64: btoa('RIFF'), startSec: seq * 2, endSec: seq * 2 + 2, endedAt: Date.now(), rms: 0.2 });

describe('AudioSessionManager', () => {
  it('start → chunk → STT → translation → overlay, with REC badge and latency metrics', async () => {
    const t = deps();
    const m = new AudioSessionManager(t.d);
    await m.start(7, 'stream-1');
    expect(t.offscreen[0]).toMatchObject({ type: 'start', streamId: 'stream-1' });
    expect(t.badges).toEqual(['REC']);
    expect(t.sent.find((s) => s.type === 'audio:state')).toMatchObject({ active: true, primary: true });
    await m.onChunk(chunk(0, m.active!.id));
    await new Promise((r) => setTimeout(r, 0));
    const segs = t.sent.filter((s) => s.type === 'live:segment');
    expect(segs[0]).toMatchObject({ en: 'Hello everyone, welcome back.', final: false });
    expect(segs[1]).toMatchObject({ vi: 'VI:Hello everyone, welcome back.', final: true });
    const a = t.registry.get(7).audio;
    expect(a.active).toBe(true);
    expect(a.chunks).toBe(1);
    expect(a.sttLatencyMs).toBeTypeOf('number');
    expect(a.totalLatencyMs).toBeTypeOf('number');
  });

  it('stop() terminates capture, closes the offscreen document and clears the badge', async () => {
    const t = deps();
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    await m.stop(7);
    expect(t.offscreen.at(-1)).toEqual({ type: 'stop' });
    expect(t.isOffscreenOpen()).toBe(false);
    expect(t.badges.at(-1)).toBe('');
    expect(t.registry.get(7).audio.active).toBe(false);
    expect(m.active).toBeNull();
  });

  it('refuses remote STT without explicit audio consent', async () => {
    const t = deps({ settings: { stt: { kind: 'openai', endpoint: 'https://api.openai.com/v1', model: 'whisper-1' } } });
    const m = new AudioSessionManager(t.d);
    await expect(m.start(7, 's')).rejects.toThrow(/consent/);
    expect(t.offscreen).toHaveLength(0);
  });

  it('requires host permission for the STT endpoint', async () => {
    const t = deps({ hasEndpointPermission: async () => false });
    const m = new AudioSessionManager(t.d);
    await expect(m.start(7, 's')).rejects.toThrow(/quyền/);
  });

  it('reports offscreen capture-permission errors and cleans up', async () => {
    const t = deps();
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    await m.onOffscreenError(m.active!.id, 'Permission denied');
    expect(t.registry.get(7).audio).toMatchObject({ active: false, error: 'Permission denied' });
    expect(t.isOffscreenOpen()).toBe(false);
  });

  it('stops with a clear error after repeated STT backend failures', async () => {
    const stt: SttBackend = { id: 'down', transcribe: async () => { throw new TypeError('Failed to fetch'); } };
    const t = deps({ stt });
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    const id = m.active!.id;
    for (let i = 0; i < 3; i++) await m.onChunk(chunk(i, id));
    expect(m.active).toBeNull();
    expect(t.registry.get(7).audio.error).toMatch(/STT/);
  }, 10_000);

  it('stops immediately on STT authentication errors', async () => {
    const stt: SttBackend = { id: 'auth', transcribe: async () => { throw new HttpError(401, 'bad key'); } };
    const t = deps({ stt });
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    await m.onChunk(chunk(0, m.active!.id));
    expect(m.active).toBeNull();
  });

  it('emits transcripts in capture order even if STT responses arrive out of order', async () => {
    const delays = [30, 0];
    let i = 0;
    const stt: SttBackend = {
      id: 'ooo',
      transcribe: async () => {
        const n = i++;
        await new Promise((r) => setTimeout(r, delays[n]));
        return { text: n === 0 ? 'First sentence here.' : 'Second sentence here.' };
      },
    };
    const t = deps({ stt });
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    const id = m.active!.id;
    await Promise.all([m.onChunk(chunk(0, id)), m.onChunk(chunk(1, id))]);
    await new Promise((r) => setTimeout(r, 10));
    const en = t.sent.filter((s) => s.type === 'live:segment' && !s.final).map((s) => s.en);
    expect(en).toEqual(['First sentence here.', 'Second sentence here.']);
  });

  it('survives a service-worker restart (session restored from storage.session)', async () => {
    const t = deps();
    const m1 = new AudioSessionManager(t.d);
    await m1.start(7, 's');
    const id = m1.active!.id;
    // worker killed → new instance with the same session store
    const m2 = new AudioSessionManager(t.d);
    await m2.onChunk(chunk(42, id));
    await new Promise((r) => setTimeout(r, 0));
    expect(m2.active?.id).toBe(id);
    expect(t.sent.some((s) => s.type === 'live:segment' && s.final)).toBe(true);
  });

  it('ignores chunks from stale sessions', async () => {
    const t = deps();
    const m = new AudioSessionManager(t.d);
    await m.start(7, 's');
    await m.onChunk(chunk(0, 'old-session'));
    expect(t.sent.filter((s) => s.type === 'live:segment')).toHaveLength(0);
  });
});
