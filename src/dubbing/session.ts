import type { BackgroundRequest } from '../shared/messages';
import type { DubbingSettings, DubStatus, TimedUnit } from '../shared/types';
import { pickVoice, defaultGoogleVoice, type VoiceInfo } from '../tts/providers';
import { DubbingScheduler, type DubSink } from './scheduler';
import { OriginalAudio, recoverMedia } from './originalAudio';
import type { SpeechUnit } from './units';

export type DubSend = <T = unknown>(m: BackgroundRequest) => Promise<T>;

let tokenSeq = 0;
const newToken = () => `dub-${Date.now().toString(36)}-${++tokenSeq}`;

class ChromeSink implements DubSink {
  readonly kind = 'chrome' as const;
  readonly canResume = false;
  constructor(private readonly s: DubbingSession) {}
  speak(u: SpeechUnit, speed: number): void {
    const d = this.s.settings;
    void this.s
      .send<{ ok: boolean; error?: string }>({ type: 'dub:speak', token: this.s.token, segId: u.id, text: u.text, voice: this.s.voiceId, rate: d.rate * speed, volume: d.volume })
      .then((r) => !r?.ok && this.s.onEvent(this.s.token, u.id, 'error', r?.error ?? 'speak failed'))
      .catch((e: Error) => this.s.onEvent(this.s.token, u.id, 'error', e.message));
  }
  stop(): void {
    void this.s.send({ type: 'dub:control', action: 'stop', token: this.s.token }).catch(() => undefined);
  }
  pause(): void {
    this.stop();
  }
  resume(): void {}
}

class CloudSink implements DubSink {
  readonly kind = 'cloud' as const;
  readonly canResume = true;
  constructor(private readonly s: DubbingSession) {}
  prepare(u: { id: string; text: string }): Promise<{ key: string; durationSec: number }> {
    const d = this.s.settings;
    return this.s.send({ type: 'dub:prepare', lesson: this.s.lesson, text: u.text, provider: d.provider === 'mock' ? 'mock' : 'google', voice: this.s.voiceId, rate: d.rate });
  }
  speak(u: SpeechUnit, speed: number): void {
    if (!u.audioKey) return this.s.onEvent(this.s.token, u.id, 'error', 'audio not prepared');
    void this.s
      .send({ type: 'dub:play', token: this.s.token, segId: u.id, key: u.audioKey, rate: speed, volume: this.s.settings.volume, offsetSec: 0 })
      .catch((e: Error) => this.s.onEvent(this.s.token, u.id, 'error', e.message));
  }
  stop(): void {
    void this.s.send({ type: 'dub:control', action: 'stop', token: this.s.token }).catch(() => undefined);
  }
  pause(): void {
    void this.s.send({ type: 'dub:control', action: 'pause', token: this.s.token }).catch(() => undefined);
  }
  resume(): void {
    void this.s.send({ type: 'dub:control', action: 'resume', token: this.s.token }).catch(() => undefined);
  }
}

/**
 * One dubbing session = one lesson video. Owns the scheduler, the sink and the original-audio
 * state; `dispose()` stops speech and restores the user's audio (lesson switch, disable, teardown).
 */
export class DubbingSession {
  readonly token = newToken();
  voiceId = '';
  private voice: VoiceInfo | null = null;
  private scheduler: DubbingScheduler | null = null;
  private readonly audio: OriginalAudio;
  private state: DubStatus['state'] = 'waiting';
  private error: string | undefined;
  private disposed = false;
  private fatal = false;

  constructor(
    readonly media: HTMLMediaElement,
    readonly lesson: string,
    public settings: DubbingSettings,
    readonly send: DubSend,
    private readonly onChange: () => void = () => undefined,
    private readonly opts: { schedulerOptions?: Partial<DubbingScheduler['o']> } = {},
  ) {
    recoverMedia(media); // a previous session died without restoring → put the user's state back first
    this.audio = new OriginalAudio(media, (mute) => send({ type: 'dub:tabmute', mute }));
  }

  /** Resolve the voice; mute the original only once speech is actually possible. */
  async start(): Promise<void> {
    const d = this.settings;
    let voices: VoiceInfo[] = [];
    try {
      const r = await this.send<{ voices: VoiceInfo[]; error?: string }>({ type: 'dub:voices', provider: d.provider });
      voices = r?.voices ?? [];
      if (!voices.length) this.error = r?.error ?? 'Không có giọng tiếng Việt.';
    } catch (e) {
      this.error = (e as Error).message;
    }
    if (this.disposed) return;
    this.voice = pickVoice(voices, d.voice || (d.provider === 'google' ? defaultGoogleVoice(d.gender) : ''), d.gender);
    if (!this.voice) {
      this.state = 'no-voice';
      this.onChange();
      return; // never mute without a usable Vietnamese voice
    }
    this.voiceId = this.voice.id;
    const sink: DubSink = d.provider === 'chrome' ? new ChromeSink(this) : new CloudSink(this);
    this.scheduler = new DubbingScheduler(
      sink,
      this.lesson,
      { baseRate: d.rate, maxSpeedup: d.maxSpeedup, maxDelaySec: d.maxDelaySec, latePolicy: d.latePolicy, lookaheadSec: d.lookaheadSec, ...this.opts.schedulerOptions },
      { onFatal: (e) => this.onFatal(e), onChange: () => this.onChange() },
    );
    this.state = 'buffering';
    this.audio.apply(d.listenMode, d.originalVolume);
    if (!this.media.paused) this.scheduler.play(this.media.currentTime, this.media.playbackRate);
    this.onChange();
  }

  private onFatal(error: string): void {
    this.error = error;
    this.fatal = true;
    this.state = 'error';
    // never trap the user in silence
    if (this.settings.restoreOnFailure) this.audio.restore();
    this.onChange();
  }

  onEvent(token: string, segId: string, kind: 'start' | 'end' | 'error' | 'interrupted', error?: string): void {
    if (token !== this.token || this.disposed) return; // speech of an older lesson/session
    if (kind === 'error') this.error = error;
    this.scheduler?.handleEvent(segId, kind, error);
    this.onChange();
  }

  setUnits(units: readonly TimedUnit[]): void {
    this.scheduler?.setUnits(units);
  }

  tick(): void {
    const m = this.media;
    this.scheduler?.tick(m.currentTime, !m.paused && !m.ended, m.playbackRate);
  }
  play(): void {
    this.scheduler?.play(this.media.currentTime, this.media.playbackRate);
  }
  pause(): void {
    this.scheduler?.pause();
  }
  seek(): void {
    this.scheduler?.seek(this.media.currentTime);
  }
  ratechange(): void {
    this.scheduler?.ratechange(this.media.playbackRate);
  }
  ended(): void {
    this.scheduler?.ended();
  }

  /** Live settings change (volume, listening mode); provider/voice changes restart the session. */
  updateSettings(d: DubbingSettings): void {
    this.settings = d;
    if (!this.fatal) this.audio.apply(d.listenMode, d.originalVolume);
  }

  /** Captions/translation unavailable → speak nothing, keep the original audio. */
  setNoCaptions(none: boolean): void {
    if (none && this.state !== 'no-captions') {
      this.state = 'no-captions';
      this.audio.restore();
      this.onChange();
    } else if (!none && this.state === 'no-captions') {
      this.state = 'buffering';
      this.audio.apply(this.settings.listenMode, this.settings.originalVolume);
      this.onChange();
    }
  }

  status(): DubStatus {
    const s = this.scheduler?.snapshot();
    const speaking = this.scheduler?.speaking;
    const state: DubStatus['state'] =
      this.state === 'no-voice' || this.state === 'error' || this.state === 'no-captions'
        ? this.state
        : this.media.paused
          ? 'paused'
          : speaking
            ? 'speaking'
            : s && s.bufferedAheadSec > 0
              ? 'idle'
              : 'buffering';
    return {
      enabled: true,
      provider: this.settings.provider,
      state,
      bufferedAheadSec: s?.bufferedAheadSec ?? 0,
      segmentsTotal: s?.segmentsTotal ?? 0,
      spoken: s?.spoken ?? 0,
      skipped: s?.skipped ?? 0,
      late: s?.late ?? 0,
      rateAdjusted: s?.rateAdjusted ?? 0,
      medianDelayMs: s?.medianDelayMs ?? null,
      p95DelayMs: s?.p95DelayMs ?? null,
      firstSpeechMs: s?.firstSpeechMs ?? null,
      muted: this.audio.strategy,
      voice: this.voice?.label,
      lastError: this.error ?? this.scheduler?.lastError,
    };
  }

  diagnostics() {
    return { ...this.status(), stats: this.scheduler?.snapshot() ?? null, userChangedVolume: this.audio.overriddenByUser };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler?.dispose();
    this.scheduler = null;
    void this.send({ type: 'dub:control', action: 'stop', token: this.token }).catch(() => undefined);
    this.audio.dispose();
  }
}
