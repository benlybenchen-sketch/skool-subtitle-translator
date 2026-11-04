import type { ContentMessage, OffscreenMessage } from '../shared/messages';
import type { Secrets, Settings, TtsProviderKind } from '../shared/types';
import { ConfigError, HttpError } from '../translation/errors';
import { arrayBufferToBase64, sleep } from '../shared/util';
import { GOOGLE_VI_VOICES, GoogleCloudTts, MockTts, defaultGoogleVoice, ttsCostUsd, vietnameseChromeVoices, type CloudTts, type VoiceInfo } from '../tts/providers';
import { TtsAudioCache, audioKey } from '../tts/audioCache';
import type { TtsLedger } from '../tts/ttsLedger';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export interface DubbingDeps {
  getSettings: () => Promise<Settings>;
  getSecrets: () => Promise<Secrets>;
  hasEndpointPermission: (endpoint: string) => Promise<boolean>;
  ensureOffscreen: () => Promise<void>;
  sendOffscreen: (m: OffscreenMessage) => Promise<unknown>;
  sendToFrame: (tabId: number, frameId: number, m: ContentMessage) => Promise<void>;
  ledger: TtsLedger;
  /** chrome.tts (absent in tests). */
  tts?: typeof chrome.tts;
  /** chrome.tabs subset for tab-level muting. */
  tabs?: Pick<typeof chrome.tabs, 'get' | 'update'>;
  session: Area;
  cache?: TtsAudioCache;
  cloudFactory?: (provider: 'google' | 'mock', s: Settings, secrets: Secrets) => CloudTts;
}

interface Owner {
  tabId: number;
  frameId: number;
  token: string;
  segId: string;
}

const MUTE_KEY = 'dubTabMute';

/**
 * Background side of AI Vietnamese dubbing.
 * - chrome.tts speech (outside the tab → never affected by tab muting)
 * - cloud synthesis (Google Cloud TTS / mock) with persistent audio cache, request dedupe,
 *   bounded retries and timeout; playback in the offscreen document (extension audio, not the tab)
 * - tab-level mute fallback with recorded previous state (restored on stop / next page load)
 * Stale playback is impossible across lessons: every speak/play carries the lesson token and
 * events of an older token are dropped by the content script.
 */
export class DubbingService {
  private owner: Owner | null = null;
  private readonly inflight = new Map<string, Promise<{ key: string; durationSec: number; cached: boolean }>>();
  private readonly loaded = new Set<string>();
  readonly cache: TtsAudioCache;

  constructor(private readonly d: DubbingDeps) {
    this.cache = d.cache ?? new TtsAudioCache();
  }

  async voices(provider: TtsProviderKind): Promise<{ voices: VoiceInfo[]; error?: string }> {
    if (provider === 'google') return { voices: GOOGLE_VI_VOICES };
    if (provider === 'mock') return { voices: [{ id: 'mock-vi', label: 'Mock (im lặng)', lang: 'vi-VN', gender: 'female' }] };
    const tts = this.d.tts;
    if (!tts?.getVoices) return { voices: [], error: 'chrome.tts không khả dụng.' };
    const all = await new Promise<chrome.tts.TtsVoice[]>((r) => tts.getVoices((v) => r(v ?? [])));
    const vi = vietnameseChromeVoices(all);
    return vi.length
      ? { voices: vi }
      : { voices: [], error: 'Máy này không có giọng tiếng Việt (vi-VN) cho Chrome TTS. Cài gói giọng nói tiếng Việt của hệ điều hành (Windows: Cài đặt → Thời gian & ngôn ngữ → Giọng nói; macOS có sẵn giọng "Linh"), hoặc chọn Google Cloud TTS.' };
  }

  // ---- Chrome TTS ---------------------------------------------------------------------------

  async speakChrome(tabId: number, frameId: number, m: { token: string; segId: string; text: string; voice: string; rate: number; volume: number }): Promise<{ ok: boolean; error?: string }> {
    const tts = this.d.tts;
    if (!tts) return { ok: false, error: 'chrome.tts không khả dụng.' };
    const { voices, error } = await this.voices('chrome');
    const voice = voices.find((v) => v.id === m.voice) ?? voices[0];
    if (!voice) return { ok: false, error };
    this.owner = { tabId, frameId, token: m.token, segId: m.segId };
    const started = Date.now();
    tts.speak(m.text, {
      lang: voice.lang,
      voiceName: voice.id,
      rate: Math.min(3, Math.max(0.5, m.rate)),
      volume: Math.min(1, Math.max(0, m.volume)),
      enqueue: false,
      onEvent: (e) => {
        const kind = e.type === 'start' ? 'start' : e.type === 'end' ? 'end' : e.type === 'error' ? 'error' : e.type === 'interrupted' || e.type === 'cancelled' ? 'interrupted' : null;
        if (!kind) return;
        if (kind === 'start') void this.d.ledger.record({ type: 'request', chars: m.text.length, latencyMs: Date.now() - started, costUsd: 0 }, { provider: 'chrome' });
        if (kind === 'error') void this.d.ledger.record({ type: 'failure' }, { provider: 'chrome' });
        void this.d.sendToFrame(tabId, frameId, { type: 'dub:event', token: m.token, segId: m.segId, kind, error: e.errorMessage });
      },
    });
    return { ok: true };
  }

  // ---- Cloud TTS ----------------------------------------------------------------------------

  private async cloud(provider: 'google' | 'mock'): Promise<{ tts: CloudTts; s: Settings }> {
    const s = await this.d.getSettings();
    const secrets = await this.d.getSecrets();
    if (provider === 'google') {
      if (!s.consent.remoteTts) throw new ConfigError('Chưa cho phép gửi văn bản tiếng Việt tới Google Cloud TTS (Cài đặt → Lồng tiếng → quyền riêng tư).');
      if (!(await this.d.hasEndpointPermission(s.dubbing.googleEndpoint))) throw new ConfigError('Chưa cấp quyền truy cập Google Cloud TTS. Mở Cài đặt và bấm "Lưu & cấp quyền".');
    }
    const tts = this.d.cloudFactory
      ? this.d.cloudFactory(provider, s, secrets)
      : provider === 'google'
        ? new GoogleCloudTts({ endpoint: s.dubbing.googleEndpoint, apiKey: secrets.ttsApiKey })
        : new MockTts();
    return { tts, s };
  }

  /** Synthesize (or reuse) and load into the offscreen player. Deduplicated per audio key. */
  prepare(m: { lesson: string; text: string; provider: 'google' | 'mock'; voice: string; rate: number }): Promise<{ key: string; durationSec: number; cached: boolean }> {
    const voice = m.provider === 'google' ? m.voice || defaultGoogleVoice('female') : m.voice || 'mock-vi';
    const key = audioKey({ provider: m.provider, voice, format: m.provider === 'google' ? 'mp3' : 'wav', rate: m.rate, lesson: m.lesson, text: m.text });
    let p = this.inflight.get(key);
    if (!p) {
      p = this.prepareKey(key, { ...m, voice }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async prepareKey(key: string, m: { lesson: string; text: string; provider: 'google' | 'mock'; voice: string; rate: number }) {
    let entry = await this.cache.get(key).catch(() => null);
    const meta = { provider: m.provider, lesson: m.lesson };
    const hit = !!entry;
    void this.d.ledger.record({ type: 'cache', hit }, meta);
    if (!entry) {
      const { tts } = await this.cloud(m.provider);
      const started = Date.now();
      let last: unknown;
      let res: Awaited<ReturnType<CloudTts['synthesize']>> | null = null;
      for (let attempt = 0; attempt < 3 && !res; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        try {
          res = await tts.synthesize({ text: m.text, voice: m.voice, rate: m.rate, signal: ac.signal });
        } catch (e) {
          last = e;
          const transient = (e instanceof HttpError && e.retryable) || e instanceof TypeError || (e as Error).name === 'AbortError';
          if (!transient || e instanceof ConfigError) break;
          await sleep(e instanceof HttpError && e.retryAfterMs ? Math.min(10_000, e.retryAfterMs) : 500 * 3 ** attempt);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!res) {
        void this.d.ledger.record({ type: 'failure' }, meta);
        throw last instanceof Error ? last : new Error(String(last));
      }
      void this.d.ledger.record({ type: 'request', chars: res.chars, latencyMs: Date.now() - started, costUsd: ttsCostUsd(m.provider, m.voice, res.chars) }, meta);
      entry = { key, audio: res.audio, mime: res.mime, durationSec: res.durationSec, size: res.audio.byteLength, lastUsed: Date.now(), createdAt: Date.now() };
      await this.cache.put({ key, audio: res.audio, mime: res.mime, durationSec: res.durationSec }).catch(() => undefined);
    }
    await this.d.ensureOffscreen();
    let durationSec = entry.durationSec ?? 0;
    if (!this.loaded.has(key) || !durationSec) {
      const r = (await this.d.sendOffscreen({ target: 'offscreen', type: 'dub-load', key, audioBase64: arrayBufferToBase64(entry.audio.slice().buffer as ArrayBuffer), mime: entry.mime })) as { durationSec?: number } | undefined;
      if (r?.durationSec) {
        durationSec = r.durationSec;
        if (!entry.durationSec) void this.cache.setDuration(key, durationSec).catch(() => undefined);
      }
      this.loaded.add(key);
      // stay below the offscreen player's own LRU (60) so a key marked loaded is really there
      if (this.loaded.size > 40) this.loaded.delete(this.loaded.values().next().value!);
    }
    return { key, durationSec, cached: hit };
  }

  async play(tabId: number, frameId: number, m: { token: string; segId: string; key: string; rate: number; volume: number; offsetSec: number }): Promise<void> {
    this.owner = { tabId, frameId, token: m.token, segId: m.segId };
    await this.d.ensureOffscreen();
    const load = async () => {
      const e = await this.cache.get(m.key).catch(() => null);
      if (!e) throw new Error('audio not cached');
      await this.d.sendOffscreen({ target: 'offscreen', type: 'dub-load', key: m.key, audioBase64: arrayBufferToBase64(e.audio.slice().buffer as ArrayBuffer), mime: e.mime });
      this.loaded.add(m.key);
    };
    if (!this.loaded.has(m.key)) await load();
    // Explicit fields: the incoming request also has a `type`, which must not leak into this one.
    const send = () => this.d.sendOffscreen({ target: 'offscreen', type: 'dub-play', key: m.key, token: m.token, segId: m.segId, rate: m.rate, volume: m.volume, offsetSec: m.offsetSec }) as Promise<{ ok?: boolean; error?: string } | undefined>;
    let r = await send();
    if (r?.ok === false && r.error === 'clip not loaded') {
      // evicted by the player (or offscreen document recreated): reload from the cache once
      this.loaded.delete(m.key);
      await load();
      r = await send();
    }
    if (r?.ok === false) throw new Error(r.error ?? 'playback failed');
  }

  /** Offscreen playback events → the owning frame. */
  onOffscreen(e: { event: 'started' | 'ended' | 'error'; token: string; segId: string; error?: string }): void {
    const o = this.owner;
    if (!o || o.token !== e.token) return;
    void this.d.sendToFrame(o.tabId, o.frameId, { type: 'dub:event', token: e.token, segId: e.segId, kind: e.event === 'started' ? 'start' : e.event === 'ended' ? 'end' : 'error', error: e.error });
  }

  /** Returns false when the command came from an older session (another lesson owns the voice now). */
  async control(action: 'stop' | 'pause' | 'resume', token?: string): Promise<boolean> {
    if (token && this.owner && this.owner.token !== token) return false;
    try {
      if (action === 'stop') this.d.tts?.stop();
      else if (action === 'pause') this.d.tts?.pause();
      else this.d.tts?.resume();
    } catch {
      /* not speaking */
    }
    await this.d.sendOffscreen({ target: 'offscreen', type: action === 'stop' ? 'dub-stop' : action === 'pause' ? 'dub-pause' : 'dub-resume' }).catch(() => undefined);
    if (action === 'stop') this.owner = null;
    return true;
  }

  // ---- tab-level mute fallback ---------------------------------------------------------------

  /** Mute/unmute a tab, remembering the user's own state so it is restored exactly. */
  async tabMute(tabId: number, mute: boolean): Promise<{ ok: boolean; error?: string }> {
    const tabs = this.d.tabs;
    if (!tabs) return { ok: false, error: 'tabs API unavailable' };
    const rec = ((await this.d.session.get(MUTE_KEY))[MUTE_KEY] as Record<string, boolean> | undefined) ?? {};
    try {
      if (mute) {
        if (!(String(tabId) in rec)) {
          const tab = await tabs.get(tabId);
          rec[String(tabId)] = !!tab.mutedInfo?.muted;
          await this.d.session.set({ [MUTE_KEY]: rec });
        }
        await tabs.update(tabId, { muted: true });
      } else if (String(tabId) in rec) {
        const prev = rec[String(tabId)];
        delete rec[String(tabId)];
        await this.d.session.set({ [MUTE_KEY]: rec });
        await tabs.update(tabId, { muted: prev });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** New page in a tab we muted (crash, reload, navigation): put the user's state back. */
  async recover(tabId: number): Promise<void> {
    await this.tabMute(tabId, false);
  }

  async onTabRemoved(tabId: number): Promise<void> {
    const rec = ((await this.d.session.get(MUTE_KEY))[MUTE_KEY] as Record<string, boolean> | undefined) ?? {};
    if (String(tabId) in rec) {
      delete rec[String(tabId)];
      await this.d.session.set({ [MUTE_KEY]: rec });
    }
    if (this.owner?.tabId === tabId) await this.control('stop');
  }
}
