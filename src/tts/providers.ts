import { ConfigError, HttpError, ParseError, ensureOk } from '../translation/errors';
import { base64ToUint8 } from '../shared/util';
import { encodeWav } from '../audio/wav';

/**
 * Vietnamese text-to-speech providers.
 * - chrome  : chrome.tts (on-device / OS voices). Plays outside the page and outside the tab's audio
 *             (unaffected by tab muting). No audio bytes, so no prefetch: synthesis happens on speak.
 * - google  : Google Cloud Text-to-Speech REST `text:synthesize` → MP3 bytes (prefetched + cached),
 *             played by the extension's offscreen document.
 * - mock    : deterministic silent WAV whose length follows the text (tests / demos).
 * New cloud providers implement `CloudTts`.
 */
export interface SynthRequest {
  text: string;
  voice: string;
  /** Base speaking rate (user setting); fitting to time slots is done at playback. */
  rate: number;
  signal?: AbortSignal;
}

export interface SynthResult {
  audio: Uint8Array;
  mime: string;
  /** Billable characters as sent (Google bills input characters). */
  chars: number;
  /** Known duration (mock / PCM); otherwise measured when the audio is loaded. */
  durationSec?: number;
  /** Token usage (Gemini TTS): provider-reported or estimated. */
  tokens?: { inputTokens: number; outputTokens: number; estimated: boolean };
}

export interface CloudTts {
  readonly id: 'google' | 'gemini' | 'mock';
  readonly format: string;
  synthesize(req: SynthRequest): Promise<SynthResult>;
}

export interface VoiceInfo {
  id: string;
  label: string;
  lang: string;
  gender: 'female' | 'male' | 'unknown';
  /** Pricing tier for estimates (cloud voices). */
  tier?: 'standard' | 'wavenet' | 'neural2' | 'chirp3-hd' | 'studio';
  local?: boolean;
}

/**
 * Google Cloud vi-VN voices (documented voice names). Availability can change per region/project;
 * the user can type any other voice name in Settings.
 */
export const GOOGLE_VI_VOICES: VoiceInfo[] = [
  { id: 'vi-VN-Neural2-A', label: 'Neural2 A (nữ)', lang: 'vi-VN', gender: 'female', tier: 'neural2' },
  { id: 'vi-VN-Neural2-D', label: 'Neural2 D (nam)', lang: 'vi-VN', gender: 'male', tier: 'neural2' },
  { id: 'vi-VN-Wavenet-A', label: 'WaveNet A (nữ)', lang: 'vi-VN', gender: 'female', tier: 'wavenet' },
  { id: 'vi-VN-Wavenet-B', label: 'WaveNet B (nam)', lang: 'vi-VN', gender: 'male', tier: 'wavenet' },
  { id: 'vi-VN-Wavenet-C', label: 'WaveNet C (nữ)', lang: 'vi-VN', gender: 'female', tier: 'wavenet' },
  { id: 'vi-VN-Wavenet-D', label: 'WaveNet D (nam)', lang: 'vi-VN', gender: 'male', tier: 'wavenet' },
  { id: 'vi-VN-Standard-A', label: 'Standard A (nữ)', lang: 'vi-VN', gender: 'female', tier: 'standard' },
  { id: 'vi-VN-Standard-B', label: 'Standard B (nam)', lang: 'vi-VN', gender: 'male', tier: 'standard' },
  { id: 'vi-VN-Chirp3-HD-Aoede', label: 'Chirp 3 HD Aoede (nữ)', lang: 'vi-VN', gender: 'female', tier: 'chirp3-hd' },
  { id: 'vi-VN-Chirp3-HD-Charon', label: 'Chirp 3 HD Charon (nam)', lang: 'vi-VN', gender: 'male', tier: 'chirp3-hd' },
];

/** USD per 1M characters — Google's list prices at the time of writing (editable estimate, not billing; free tiers ignored). */
export const TTS_PRICE_PER_M: Record<NonNullable<VoiceInfo['tier']>, number> = {
  standard: 4,
  wavenet: 4,
  neural2: 16,
  'chirp3-hd': 30,
  studio: 160,
};

export function googleTier(voice: string): NonNullable<VoiceInfo['tier']> {
  const v = voice.toLowerCase();
  if (v.includes('chirp3')) return 'chirp3-hd';
  if (v.includes('studio')) return 'studio';
  if (v.includes('neural2')) return 'neural2';
  if (v.includes('wavenet')) return 'wavenet';
  return 'standard';
}

export function ttsCostUsd(provider: string, voice: string, chars: number): number {
  if (provider !== 'google') return 0;
  return (chars / 1e6) * TTS_PRICE_PER_M[googleTier(voice)];
}

export function defaultGoogleVoice(gender: 'female' | 'male'): string {
  return gender === 'male' ? 'vi-VN-Neural2-D' : 'vi-VN-Neural2-A';
}

export class GoogleCloudTts implements CloudTts {
  readonly id = 'google' as const;
  readonly format = 'mp3';
  constructor(private readonly o: { endpoint: string; apiKey?: string; fetchImpl?: typeof fetch }) {
    if (!o.apiKey) throw new ConfigError('Thiếu API key Google Cloud Text-to-Speech (Cài đặt → Lồng tiếng). Key Gemini không dùng được cho Cloud TTS.');
  }

  async synthesize(req: SynthRequest): Promise<SynthResult> {
    const f = this.o.fetchImpl ?? fetch;
    const voice = req.voice || defaultGoogleVoice('female');
    const res = await f(`${this.o.endpoint.replace(/\/+$/, '')}/text:synthesize`, {
      method: 'POST',
      signal: req.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Goog-Api-Key': this.o.apiKey! },
      body: JSON.stringify({
        input: { text: req.text },
        voice: { languageCode: 'vi-VN', name: voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: Math.min(2, Math.max(0.5, req.rate)) },
      }),
    });
    await ensureOk(res, 'Google Cloud TTS');
    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) throw new Error('Google Cloud TTS returned no audio');
    return { audio: base64ToUint8(data.audioContent), mime: 'audio/mpeg', chars: req.text.length };
  }
}

/** Vietnamese speech duration estimate at rate 1 (≈ 4.2 syllables/s; Vietnamese words are mostly one syllable). */
export function estimateSpeechSec(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const pauses = (text.match(/[,.;:!?…]/g) ?? []).length * 0.12;
  return (words / 4.2 + pauses + 0.15) / Math.max(0.1, rate);
}

export class MockTts implements CloudTts {
  readonly id = 'mock' as const;
  readonly format = 'wav';
  calls = 0;
  constructor(private readonly o: { latencyMs?: number; fail?: (text: string) => boolean } = {}) {}
  async synthesize(req: SynthRequest): Promise<SynthResult> {
    this.calls++;
    if (this.o.latencyMs) await new Promise((r) => setTimeout(r, this.o.latencyMs));
    if (this.o.fail?.(req.text)) throw new Error('mock TTS failure');
    const sec = estimateSpeechSec(req.text, req.rate);
    const rate = 8000;
    const samples = new Float32Array(Math.max(1, Math.round(sec * rate)));
    return { audio: new Uint8Array(encodeWav(samples, rate)), mime: 'audio/wav', chars: req.text.length, durationSec: sec };
  }
}

/** Chrome voices usable for Vietnamese — never a voice of another language. */
export function vietnameseChromeVoices(voices: { voiceName?: string; lang?: string; remote?: boolean }[]): VoiceInfo[] {
  return voices
    .filter((v) => v.voiceName && /^vi([-_]|$)/i.test(v.lang ?? ''))
    .sort((a, b) => Number(/^vi[-_]VN$/i.test(b.lang ?? '')) - Number(/^vi[-_]VN$/i.test(a.lang ?? '')))
    .map((v) => ({ id: v.voiceName!, label: v.voiceName!, lang: v.lang!, gender: guessGender(v.voiceName!), local: !v.remote }));
}

/** Known Vietnamese OS voice names (Windows: An, HoaiMy, NamMinh; macOS: Linh). Unknown → 'unknown'. */
export function guessGender(name: string): VoiceInfo['gender'] {
  if (/\b(hoaimy|hoài my|linh|female|nữ)\b/i.test(name)) return 'female';
  if (/\b(an|namminh|nam minh|male|nam)\b/i.test(name)) return 'male';
  return 'unknown';
}

export function pickVoice(voices: VoiceInfo[], wanted: string, gender: 'female' | 'male'): VoiceInfo | null {
  if (!voices.length) return null;
  return voices.find((v) => v.id === wanted) ?? voices.find((v) => v.gender === gender) ?? voices[0];
}

// ---- Gemini TTS (Gemini Developer API, Interactions API) ---------------------------------------

/** Prebuilt Gemini voices (names as documented; gender is NOT assumed — use "Nghe thử"). */
export const GEMINI_VOICES = [
  'Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
].map((v): VoiceInfo => ({ id: v, label: v, lang: 'vi-VN', gender: 'unknown' }));

export const GEMINI_TTS_MODELS = { fast: 'gemini-3.8-flash-lite-tts', quality: 'gemini-3.8-flash-tts' } as const;

/** USD per 1M tokens (text in / audio out) — published rates as reported at launch; estimates only. */
export const GEMINI_TTS_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash-lite-tts': { input: 0.5, output: 6 },
  'gemini-3.8-flash-tts': { input: 0.5, output: 9 },
};
/** Audio output tokens per second of speech (Gemini audio tokenisation) — used only when no usage is reported. */
export const GEMINI_AUDIO_TOKENS_PER_SEC = 25;

export function geminiTtsCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = GEMINI_TTS_PRICES[model] ?? GEMINI_TTS_PRICES['gemini-3.8-flash-tts'];
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

export const GEMINI_STYLE = 'Đọc rõ ràng, bình tĩnh, giọng giảng dạy thân thiện; giữ nguyên tên riêng và thuật ngữ kỹ thuật.';

/** Wrap raw 16-bit PCM (mono) into a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Duration of a PCM WAV (header fields; tolerant of extra chunks). */
export function wavDurationSec(wav: Uint8Array): number | null {
  if (wav.length < 44 || String.fromCharCode(...wav.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...wav.slice(8, 12)) !== 'WAVE') return null;
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.slice(p, p + 4));
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ') byteRate = v.getUint32(p + 16, true);
    if (id === 'data') return byteRate ? Math.min(size, wav.length - p - 8) / byteRate : null;
    p += 8 + size + (size % 2);
  }
  return null;
}

/** Find base64 audio in a response (Interactions outputs, or legacy candidates/inlineData) without assuming one exact shape. */
export function findAudioPayload(o: unknown, depth = 0): { data: string; mime: string } | null {
  if (!o || typeof o !== 'object' || depth > 8) return null;
  const r = o as Record<string, unknown>;
  const mime = (r.mime_type ?? r.mimeType) as string | undefined;
  if (typeof r.data === 'string' && r.data.length > 64 && (!mime || /audio/i.test(mime) || r.type === 'audio')) return { data: r.data, mime: mime ?? '' };
  for (const v of Object.values(r)) {
    const f = Array.isArray(v) ? v.map((x) => findAudioPayload(x, depth + 1)).find(Boolean) : findAudioPayload(v, depth + 1);
    if (f) return f;
  }
  return null;
}

/** Bytes → playable WAV: self-contained WAV is kept; raw L16/PCM is wrapped; anything else is rejected. */
export function decodeGeminiAudio(b64: string, mime: string): { wav: Uint8Array; durationSec: number } {
  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8(b64);
  } catch {
    throw new ParseError('Gemini TTS: dữ liệu âm thanh không hợp lệ (base64)');
  }
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head === 'RIFF') {
    const d = wavDurationSec(bytes);
    if (d === null || d <= 0) throw new ParseError('Gemini TTS: tệp WAV hỏng');
    return { wav: bytes, durationSec: d };
  }
  if (/l16|pcm|raw/i.test(mime) || !mime) {
    if (bytes.length < 2 || bytes.length % 2) throw new ParseError('Gemini TTS: dữ liệu PCM không hợp lệ');
    const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
    return { wav: pcmToWav(bytes, rate), durationSec: bytes.length / 2 / rate };
  }
  throw new ParseError(`Gemini TTS: định dạng âm thanh không hỗ trợ (${mime})`);
}

type GeminiVariant = 'style' | 'plain' | 'list';
let workingVariant: GeminiVariant | null = null;

/**
 * Gemini TTS via the Interactions API: POST {endpoint}/interactions
 * { model, input, response_format: {type:'audio'}, generation_config: { speech_config: { voice } } }.
 * The style hint goes in structured speech metadata, never into the spoken text. Because this API is
 * new and its schema could not be checked live from the development environment, a 400 on the
 * style/voice shape falls back to the plain documented form (remembered per worker).
 */
export class GeminiTts implements CloudTts {
  readonly id = 'gemini' as const;
  readonly format = 'wav';
  lastUsage: { inputTokens: number; outputTokens: number; estimated: boolean } | null = null;
  constructor(private readonly o: { endpoint: string; apiKey?: string; model: string; style: boolean; fetchImpl?: typeof fetch }) {
    if (!o.apiKey) throw new ConfigError('Thiếu API key Gemini (Cài đặt → nhà cung cấp Google Gemini). Gemini TTS dùng chung key Gemini dùng để dịch.');
  }

  static resetVariant(): void {
    workingVariant = null;
  }

  private body(text: string, voice: string, variant: GeminiVariant): unknown {
    const speech = variant === 'list' ? [{ voice }] : { voice };
    return {
      model: this.o.model,
      input: variant === 'style' ? [{ type: 'text', text, speech_metadata: { style: GEMINI_STYLE } }] : text,
      response_format: { type: 'audio' },
      generation_config: { speech_config: speech },
    };
  }

  async synthesize(req: SynthRequest): Promise<SynthResult> {
    const f = this.o.fetchImpl ?? fetch;
    const voice = req.voice || 'Kore';
    const order: GeminiVariant[] = workingVariant ? [workingVariant] : this.o.style ? ['style', 'plain', 'list'] : ['plain', 'list'];
    let lastErr: unknown;
    for (const variant of order) {
      const res = await f(`${this.o.endpoint.replace(/\/+$/, '')}/interactions`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.o.apiKey!, 'Api-Revision': '2026-05-20' },
        body: JSON.stringify(this.body(req.text, voice, variant)),
      });
      if (res.status === 400 && variant !== order[order.length - 1]) {
        lastErr = new HttpError(400, `Gemini TTS HTTP 400 (${variant})`);
        continue; // schema variant not accepted → next documented form
      }
      await ensureOk(res, 'Gemini TTS');
      const data = (await res.json()) as Record<string, unknown>;
      const audio = findAudioPayload(data);
      if (!audio) throw new ParseError('Gemini TTS: phản hồi không có âm thanh');
      const { wav, durationSec } = decodeGeminiAudio(audio.data, audio.mime);
      workingVariant = variant;
      const u = (data.usage ?? data.usageMetadata) as Record<string, number> | undefined;
      const input = u?.total_input_tokens ?? u?.input_tokens ?? u?.promptTokenCount;
      const output = u?.total_output_tokens ?? u?.output_tokens ?? u?.candidatesTokenCount;
      this.lastUsage =
        typeof input === 'number' && typeof output === 'number'
          ? { inputTokens: input, outputTokens: output, estimated: false }
          : { inputTokens: Math.ceil(req.text.length / 4), outputTokens: Math.ceil(durationSec * GEMINI_AUDIO_TOKENS_PER_SEC), estimated: true };
      return { audio: wav, mime: 'audio/wav', chars: req.text.length, durationSec, tokens: this.lastUsage };
    }
    throw lastErr instanceof Error ? lastErr : new Error('Gemini TTS failed');
  }
}
