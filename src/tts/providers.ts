import { ConfigError, ensureOk } from '../translation/errors';
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
}

export interface CloudTts {
  readonly id: 'google' | 'mock';
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
