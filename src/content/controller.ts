import type { ActiveMode, CaptionSourceKind, CaptionState, Cue, FrameStatus, Settings, TimedUnit } from '../shared/types';
import type { UnitPayload, UnitResult } from '../shared/messages';
import type { PlayerAdapter } from '../players/adapters';
import { stableMediaSrc } from '../players/adapters';
import type { Target } from '../players/detector';
import { SubtitleOverlay } from '../overlay/overlay';
import { NativeTrackFallback } from '../overlay/nativeTrack';
import { normalizeCues } from '../subtitles/normalize';
import { segmentCues } from '../subtitles/segmenter';
import { Timeline } from '../subtitles/timeline';
import { DomCaptionSource, ManualSource, TextTrackSource, findEnglishTrack, type TimedSource } from '../subtitles/sources';
import { TranslationScheduler, type SchedulerOptions, type TranslateBridge } from './scheduler';
import { hash53 } from '../shared/hash';

export interface ControllerBridge extends TranslateBridge {
  reportStatus(status: Omit<FrameStatus, 'frameId'>): void;
}

export interface ControllerEnv {
  doc: Document;
  isTop: boolean;
  adapter: PlayerAdapter;
  bridge: ControllerBridge;
  settings: Settings;
  /** Grace period to wait for late text tracks before declaring "no captions". */
  captionGraceMs?: number;
  /** Max wait for a media change after SPA navigation when the <video> element is reused. */
  navSettleMs?: number;
  schedulerOptions?: Partial<SchedulerOptions>;
  raf?: (cb: () => void) => number;
  cancelRaf?: (h: number) => void;
}

interface LiveSegment {
  id: string;
  en: string;
  vi?: string;
  shownAt: number;
}

/**
 * One controller per frame. Owns at most ONE overlay and ONE active caption
 * source at a time, which is how duplicate subtitles are prevented.
 */
export class SubtitleController {
  private settings: Settings;
  private target: Target | null = null;
  private overlay: SubtitleOverlay | null = null;
  private native: NativeTrackFallback | null = null;
  private timed: TimedSource | null = null;
  private dom: DomCaptionSource | null = null;
  private timeline: Timeline | null = null;
  private scheduler: TranslationScheduler | null = null;
  private captionState: CaptionState = 'searching';
  private captionSource: CaptionSourceKind | null = null;
  private trackLabel?: string;
  private videoKey: string | null = null;
  private error?: string;
  private notice?: string;
  private audioActive = false;
  private audioPrimary = false;
  private live: LiveSegment | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private liveHistory: string[] = [];
  private liveCache = new Map<string, string>();
  private rafHandle: number | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPlayheadPush = 0;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private embeddedProviders: FrameStatus['embeddedProviders'] = [];
  private anchor: Element | null = null;
  private mediaCounts = { videos: 0, audios: 0 };
  private manual: { cues: Cue[]; label: string } | null = null;
  private destroyed = false;
  /** Waiting for the user to press "Bắt đầu dịch" (autoStart / autoInitOnNavigation off). */
  private paused: boolean;
  private captionsOff = false;
  /** After SPA navigation: the element of the previous lesson and a token against races. */
  private navPrevEl: Element | null = null;
  private navToken = 0;
  private navWaitCleanup: (() => void) | null = null;

  constructor(private readonly env: ControllerEnv) {
    this.settings = env.settings;
    this.paused = !env.settings.autoStart;
  }

  /** Track lifecycle log of the active TextTrack source (diagnostics only). */
  trackLog(): string[] {
    return this.timed instanceof TextTrackSource ? [...this.timed.log] : [];
  }

  /** User pressed "Bắt đầu dịch" (or auto-start). */
  startSession(): void {
    if (!this.paused) return;
    this.paused = false;
    this.scheduler?.setEnabled(this.settings.enabled && !this.audioActive);
    this.applyVisibility();
    this.render();
    this.queueStatus();
  }

  // ---------------------------------------------------------------- public API

  get mode(): ActiveMode {
    if (!this.settings.enabled) return 'off';
    if (this.audioActive) return 'audio';
    if (this.paused && this.target) return 'paused';
    // No accessible media: on the Skool page itself, Audio Mode (page overlay) is still available.
    if (!this.target) return this.env.isTop ? 'waiting-audio' : 'idle';
    if (this.captionSource && this.settings.modePreference !== 'audio') return 'caption';
    if (this.captionState === 'searching' && this.settings.modePreference !== 'audio') return 'idle';
    return 'waiting-audio';
  }

  get currentTimeline(): Timeline | null {
    return this.timeline;
  }

  get currentOverlay(): SubtitleOverlay | null {
    return this.overlay;
  }

  private readonly containerListeners = new Set<(el: Element) => void>();

  /** Overlay moved (fullscreen enter/exit) — lets the VI control follow it. */
  onOverlayContainerChange(cb: (el: Element) => void): void {
    this.containerListeners.add(cb);
  }

  get currentVideoKey(): string | null {
    return this.videoKey;
  }

  setDetectionInfo(info: { embeds: FrameStatus['embeddedProviders']; videos: number; audios: number }): void {
    this.embeddedProviders = info.embeds;
    this.mediaCounts = { videos: info.videos, audios: info.audios };
    this.queueStatus();
  }

  /** Always report status, even when nothing was detected (so the popup can say why). */
  announce(): void {
    this.queueStatus();
  }

  /** Element the overlay is positioned over: the video/iframe itself, else the page anchor, else the viewport. */
  private overlayTargetEl(): Element | null {
    const t = this.target;
    if (t && t.kind !== 'media') return t.el;
    return this.anchor && this.anchor.isConnected ? this.anchor : null;
  }

  setTarget(target: Target | null, anchor: Element | null = null, afterNavigation = false): void {
    if (this.destroyed) return;
    if (afterNavigation) {
      this.navWaitCleanup?.();
      this.navWaitCleanup = null;
      const token = ++this.navToken;
      // Same media element as the previous lesson: its source/tracks may still be the OLD
      // lesson's. Wait (bounded) for a media change signal so old cues are never attributed
      // to the new lesson.
      if (target && target.kind !== 'iframe' && target.el === this.navPrevEl) {
        const el = target.el;
        const go = () => {
          cleanup();
          if (token === this.navToken && el.isConnected) this.setTarget(target, anchor);
        };
        const evs = ['emptied', 'loadstart', 'loadedmetadata'];
        const timer = setTimeout(go, this.env.navSettleMs ?? 2000);
        const cleanup = () => {
          clearTimeout(timer);
          for (const e of evs) el.removeEventListener(e, go);
          if (this.navWaitCleanup === cleanup) this.navWaitCleanup = null;
        };
        for (const e of evs) el.addEventListener(e, go);
        this.navWaitCleanup = cleanup;
        return;
      }
    }
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.overlay?.setTarget(this.overlayTargetEl());
    }
    if (target?.el === this.target?.el) {
      this.queueStatus();
      return;
    }
    this.teardownTarget();
    this.target = target;
    if (!target) {
      if (this.audioActive && this.audioPrimary) this.ensureOverlay().setTarget(this.overlayTargetEl());
      this.applyVisibility();
      this.queueStatus();
      return;
    }
    this.videoKey = this.computeVideoKey(target);
    this.ensureOverlay().setTarget(this.overlayTargetEl());
    if (target.kind === 'video' || target.kind === 'media') {
      this.bindVideo(target.el);
      this.attachCaptionSource();
    } else {
      // Cross-origin player iframe: captions (if any) are read by the content
      // script running inside that frame. Here we only host Audio Mode output.
      this.captionState = 'unavailable';
      this.notice = `Trình phát ${target.provider} nằm trong iframe`;
    }
    this.applyVisibility();
    this.queueStatus();
  }

  /** Lesson changed (SPA navigation): drop all per-video state. */
  reset(): void {
    const t = this.target;
    this.navPrevEl = t?.el ?? null;
    this.navWaitCleanup?.();
    this.navWaitCleanup = null;
    this.navToken++;
    this.teardownTarget();
    this.manual = null;
    this.target = null;
    this.paused = !this.settings.autoInitOnNavigation;
    this.queueStatus();
  }

  updateSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    this.overlay?.setStyle(next);
    const segmentationChanged = prev.mergeFragments !== next.mergeFragments;
    const translationChanged =
      JSON.stringify(prev.provider) !== JSON.stringify(next.provider) ||
      prev.glossary !== next.glossary ||
      JSON.stringify(prev.consent) !== JSON.stringify(next.consent);
    if (prev.modePreference !== next.modePreference || prev.customCaptionSelectors !== next.customCaptionSelectors) {
      if (this.target && this.target.kind !== 'iframe') {
        this.stopSources();
        this.attachCaptionSource();
      }
    } else if (translationChanged && this.timeline) {
      // New provider/glossary → retranslate (cache keys differ).
      this.rebuildTimeline(this.lastCues, true);
    } else if (segmentationChanged && this.timeline) {
      this.rebuildTimeline(this.lastCues, false);
    }
    if (translationChanged) this.error = undefined;
    this.scheduler?.setEnabled(next.enabled && !this.paused && !this.audioActive);
    if (!prev.autoEnableCaptions && next.autoEnableCaptions && this.captionsOff && this.target && this.target.kind !== 'iframe') {
      this.stopSources();
      this.attachCaptionSource();
    }
    this.applyVisibility();
    this.render();
    this.queueStatus();
  }

  setAudioState(active: boolean, primary: boolean, error?: string): void {
    this.audioActive = active;
    this.audioPrimary = primary;
    if (error) this.error = error;
    if (!active) this.clearLive();
    // Audio Mode works without any accessible media element: page-level overlay.
    if (active && primary) this.ensureOverlay().setTarget(this.overlayTargetEl());
    this.overlay?.setIndicator(active && primary ? 'Audio Mode • đang nghe âm thanh tab' : null);
    this.scheduler?.setEnabled(this.settings.enabled && !active && !this.paused);
    this.applyVisibility();
    this.render();
    this.queueStatus();
  }

  /** A live (Audio Mode) segment from the background. */
  onLiveSegment(seg: { id: string; en: string; vi?: string; final: boolean }): void {
    if (!this.audioActive || !this.audioPrimary) return;
    if (this.live?.id === seg.id) {
      this.live.vi = seg.vi ?? this.live.vi;
      this.live.en = seg.en || this.live.en;
    } else {
      this.live = { id: seg.id, en: seg.en, vi: seg.vi, shownAt: Date.now() };
    }
    this.armLiveExpiry();
    this.render();
  }

  onManualCues(cues: Cue[], label: string): void {
    this.manual = { cues, label };
    if (this.target && this.target.kind !== 'iframe') {
      this.stopSources();
      this.attachCaptionSource();
    }
    this.queueStatus();
  }

  destroy(): void {
    this.navWaitCleanup?.();
    this.teardownTarget();
    this.overlay?.destroy();
    this.overlay = null;
    this.destroyed = true;
    clearTimeout(this.statusTimer);
  }

  /** Render the subtitle for the current playback time (cheap; called per frame while playing). */
  render = (): void => {
    const ov = this.overlay;
    if (!ov) return;
    const mode = this.mode;
    if (!this.target && mode !== 'audio') {
      ov.show(null);
      return;
    }
    const video = this.target && this.target.kind !== 'iframe' ? this.target.el : null;
    let content: { en?: string; vi?: string } | null = null;
    let range: [number, number] = [0, 0];

    if (mode === 'audio' && this.audioPrimary && this.live) {
      content = { en: this.live.en, vi: this.live.vi };
      const t = video?.currentTime ?? 0;
      range = [t, t + 6];
    } else if (mode === 'caption' && video) {
      if (this.captionSource === 'dom') {
        if (this.live) content = { en: this.live.en, vi: this.live.vi };
        range = [video.currentTime, video.currentTime + 5];
      } else if (this.timeline) {
        const u = this.timeline.activeAt(video.currentTime);
        if (u && !u.vi && u.status !== 'error' && !this.missed.has(u.id) && this.settings.enabled) {
          // Visible before its translation arrived → a missed deadline (measured, reported).
          this.missed.add(u.id);
          this.queueStatus();
        }
        if (u) {
          content = { en: u.text, vi: u.vi };
          range = [u.start, u.end];
        }
      }
    }

    if (video && ov.isNativeVideoFullscreen()) {
      // HTML overlay is invisible here → mirror into a native text track.
      ov.show(null);
      if (!this.native) this.native = new NativeTrackFallback(video);
      const txt = content
        ? this.settings.displayMode === 'bilingual' && content.vi
          ? `${content.vi}\n${content.en ?? ''}`
          : content.vi ?? content.en ?? ''
        : '';
      this.native.show(txt || null, range[0], range[1]);
      return;
    }
    if (this.native) {
      this.native.disable();
      this.native = null;
    }
    if (content?.vi) this.lastDisplayAt = Date.now();
    ov.show(content);
  };

  // ---------------------------------------------------------------- internals

  private lastCues: Cue[] = [];
  private missed = new Set<string>();

  private ensureOverlay(): SubtitleOverlay {
    if (!this.overlay) {
      this.overlay = new SubtitleOverlay(this.env.doc, this.settings);
      this.overlay.onContainerChange((el) => {
        for (const l of this.containerListeners) l(el);
      });
      this.overlay.onFullscreenChange(() => {
        this.render();
        if (this.target?.kind === 'iframe' && this.env.doc.fullscreenElement === this.target.el) {
          this.notice = 'Toàn màn hình của iframe: phụ đề hiển thị bên trong trình phát nếu được hỗ trợ.';
          this.queueStatus();
        }
      });
    }
    return this.overlay;
  }

  private computeVideoKey(target: Target): string {
    const loc = new URL(this.env.doc.location.href);
    const id = this.env.adapter.videoIdFromUrl(loc) ?? loc.pathname;
    let key = `${target.provider}:${id}`;
    if (target.kind !== 'iframe') {
      const src = stableMediaSrc(target.el.currentSrc || target.el.src);
      if (src) key += '|' + hash53(src);
    } else {
      key += '|' + hash53(target.el.getAttribute('src') ?? '');
    }
    return key;
  }

  private videoListeners: [string, EventListener][] = [];

  private bindVideo(video: HTMLMediaElement): void {
    const on = (ev: string, fn: EventListener) => {
      video.addEventListener(ev, fn);
      this.videoListeners.push([ev, fn]);
    };
    on('play', () => this.startLoop());
    on('playing', () => this.startLoop());
    on('pause', () => {
      this.stopLoop();
      this.render();
    });
    on('ended', () => this.stopLoop());
    on('seeking', () => {
      this.scheduler?.setPlayhead(video.currentTime, video.playbackRate);
      this.render();
    });
    on('seeked', () => {
      // Seek completed: re-anchor prefetching on the final position (some players fire
      // `seeking` before currentTime settles), then render from the playback clock.
      this.scheduler?.setPlayhead(video.currentTime, video.playbackRate);
      this.render();
    });
    on('timeupdate', () => {
      // Always render from the playback clock too (diff-based, cheap): rendering must not depend
      // on requestAnimationFrame alone (throttled/suspended frames would freeze subtitles).
      this.render();
      this.pushPlayhead();
      this.watchdog(video);
    });
    on('ratechange', () => this.scheduler?.setPlayhead(video.currentTime, video.playbackRate));
    on('emptied', () => {
      // Source swapped in place (some players reuse the <video> between lessons).
      const t = this.target;
      if (t && t.kind !== 'iframe') {
        const key = this.computeVideoKey(t);
        if (key !== this.videoKey) {
          this.teardownTarget();
          this.target = null;
          this.setTarget(t, this.anchor);
        }
      }
    });
    const tracks = video.textTracks;
    if (tracks?.addEventListener) {
      const onAdd = () => {
        if (this.captionSource !== 'texttrack' && this.captionSource !== 'manual') {
          this.stopSources();
          this.attachCaptionSource();
        }
      };
      // `change` = a track's mode changed (e.g. the user turned CC on while we were waiting).
      const onChange = () => {
        if (this.captionsOff) onAdd();
      };
      tracks.addEventListener('addtrack', onAdd);
      tracks.addEventListener('change', onChange);
      this.trackListUnsub = () => {
        tracks.removeEventListener('addtrack', onAdd);
        tracks.removeEventListener('change', onChange);
      };
    }
    if (!video.paused) this.startLoop();
  }

  private trackListUnsub: (() => void) | null = null;
  private lastWatchdog = 0;
  private stallSince: number | null = null;
  private stallRediscoveries = 0;
  private stallReenables = 0;
  private static readonly STALL_NOTICE_PREFIX = 'Trình phát ngừng cung cấp phụ đề mới';
  private lastDisplayAt: number | null = null;
  private untranslatedSince: number | null = null;
  private readonly recoveries: { atSec: number; kind: string; outcome: string }[] = [];

  private logRecovery(kind: string, outcome: string): void {
    const media = this.target && this.target.kind !== 'iframe' ? this.target.el : null;
    this.recoveries.push({ atSec: Math.round(media?.currentTime ?? 0), kind, outcome });
    if (this.recoveries.length > 20) this.recoveries.shift();
  }

  /**
   * Low-overhead self-healing (runs on timeupdate, at most every 2 s; no timers):
   * - heals the translation scheduler (stalled requests, free slots)
   * - if playback ran >10 s past the last known English cue, re-evaluates the caption tracks
   *   (bounded) and, only with the auto-enable opt-in, re-enables a player-disabled track once
   *   per stall; after 30 s without new cues it reports the condition (Audio Mode fallback).
   */
  private watchdog(video: HTMLMediaElement): void {
    const now = Date.now();
    if (now - this.lastWatchdog < 2000) return;
    this.lastWatchdog = now;
    this.scheduler?.heal();
    const src = this.timed instanceof TextTrackSource ? this.timed : null;
    if (!src || video.paused || !this.settings.enabled) return;
    const end = src.latestCueEnd;
    const t = video.currentTime;
    // Processing failure (not a silent gap): an English cue is on screen but its Vietnamese
    // translation has not arrived for > 4 s → re-anchor scheduling at the playhead.
    const active = this.timeline?.activeAt(t);
    if (active && !active.vi) {
      if (this.untranslatedSince === null) this.untranslatedSince = now;
      else if (now - this.untranslatedSince > 4000) {
        this.untranslatedSince = now;
        this.scheduler?.setPlayhead(t, video.playbackRate);
        this.logRecovery('untranslated-active-cue', `status=${active.status}, rescheduled`);
      }
    } else this.untranslatedSince = null;
    const nearEnd = Number.isFinite(video.duration) && video.duration > 0 && t > video.duration - 5;
    if (end > 0 && t > end + 10 && !nearEnd) {
      if (this.stallSince === null) {
        this.stallSince = now;
        this.stallRediscoveries = 0;
      }
      if (this.stallRediscoveries < 6 && now - this.stallSince >= this.stallRediscoveries * 5000) {
        const reenable = this.stallRediscoveries === 0 && this.stallReenables < 5;
        if (reenable && src.track.mode === 'disabled') this.stallReenables++;
        this.stallRediscoveries++;
        const before = src.storedCues;
        src.rediscover(`playback ${Math.round(t)}s > last cue ${Math.round(end)}s`, reenable);
        this.logRecovery('cues-exhausted', src.storedCues > before ? `found ${src.storedCues - before} new cues` : `no new cues (mode=${src.track.mode})`);
      }
      if (now - this.stallSince > 30_000 && !this.notice?.startsWith(SubtitleController.STALL_NOTICE_PREFIX)) {
        const mm = `${Math.floor(end / 60)}:${String(Math.floor(end % 60)).padStart(2, '0')}`;
        this.notice = `${SubtitleController.STALL_NOTICE_PREFIX} sau ${mm}. Thử bật lại CC, hoặc dùng Audio Mode.`;
        this.queueStatus();
      }
    } else if (this.stallSince !== null) {
      this.stallSince = null;
      if (this.notice?.startsWith(SubtitleController.STALL_NOTICE_PREFIX)) {
        this.notice = undefined;
        this.queueStatus();
      }
    }
  }

  /** Diagnostics snapshot — timings and counts only, never caption text, keys or URLs. */
  debugState() {
    const media = this.target && this.target.kind !== 'iframe' ? this.target.el : null;
    const src = this.timed instanceof TextTrackSource ? this.timed : null;
    const sch = this.scheduler?.debug();
    const now = Date.now();
    const latestCueEnd = src ? src.latestCueEnd : this.timeline?.units.at(-1)?.end ?? 0;
    const duration = media && Number.isFinite(media.duration) ? media.duration : null;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const allTracks: { kind: string; language: string; mode: string; cues: number | null }[] = [];
    const tl = media?.textTracks;
    for (let i = 0; i < (tl?.length ?? 0); i++) {
      const t = tl![i];
      allTracks.push({ kind: t.kind, language: t.language, mode: t.mode, cues: t.cues ? t.cues.length : null });
    }
    const counts = this.timeline?.counts();
    const complete = duration !== null && latestCueEnd >= duration - 15;
    const health = !sch
      ? 'no-captions'
      : sch.fatal
        ? 'api-error-backoff'
        : this.stallSince
          ? 'stalled-no-new-cues'
          : complete && counts && counts.done === counts.total
            ? 'completed'
            : 'running';
    return {
      /** Privacy-safe lesson identity (hash of route + lesson id). */
      lessonId: this.videoKey ? hash53(this.videoKey) : null,
      videoDetected: media ? (this.target!.kind === 'video' ? 'video' : 'media') : this.target ? 'iframe' : 'none',
      textTrackCount: allTracks.length,
      textTracks: allTracks,
      health,
      prefetchCoverage90s: this.scheduler ? Math.round(this.scheduler.aheadCoverage() * 100) / 100 : null,
      lastVietnameseShownAgoSec: this.lastDisplayAt ? Math.round((now - this.lastDisplayAt) / 1000) : null,
      autoEnableCaptions: this.settings.autoEnableCaptions,
      recoveries: [...this.recoveries],
      currentTimeSec: media ? r1(media.currentTime) : null,
      durationSec: duration !== null ? r1(duration) : null,
      paused: media?.paused ?? null,
      playbackRate: media?.playbackRate ?? null,
      captionSource: this.captionSource,
      englishTracks: src ? src.trackInfo() : [],
      availableCues: src ? src.storedCues : this.lastCues.length,
      translationUnits: this.timeline?.size ?? 0,
      latestCueEndSec: r1(latestCueEnd),
      latestTranslatedEndSec: r1(sch?.latestTranslatedEnd ?? 0),
      /** Source coverage reaching the media duration is required before calling the transcript complete. */
      transcriptComplete: duration !== null && latestCueEnd >= duration - 15,
      lastCueDiscoveryAgoSec: src && src.lastDiscoveryAt ? Math.round((now - src.lastDiscoveryAt) / 1000) : null,
      scheduler: sch
        ? {
            state: sch.state,
            queuedInWindow: sch.queuedInWindow,
            pendingRequests: sch.inFlight,
            lastSuccessAgoSec: sch.lastSuccessAt ? Math.round((now - sch.lastSuccessAt) / 1000) : null,
            errors: sch.errorCount,
            lastError: sch.lastError ? sch.lastError.slice(0, 160) : null,
          }
        : null,
      stalledForSec: this.stallSince ? Math.round((now - this.stallSince) / 1000) : 0,
    };
  }

  private pushPlayhead(): void {
    const v = this.target && this.target.kind !== 'iframe' ? this.target.el : null;
    if (!v) return;
    const now = Date.now();
    if (now - this.lastPlayheadPush < 1000) return;
    this.lastPlayheadPush = now;
    this.scheduler?.setPlayhead(v.currentTime, v.playbackRate);
  }

  private startLoop(): void {
    if (this.rafHandle !== null) return;
    const raf = this.env.raf ?? ((cb) => requestAnimationFrame(cb));
    const tick = () => {
      this.rafHandle = raf(tick);
      this.render();
    };
    this.rafHandle = raf(tick);
  }

  private stopLoop(): void {
    if (this.rafHandle === null) return;
    (this.env.cancelRaf ?? cancelAnimationFrame)(this.rafHandle);
    this.rafHandle = null;
  }

  private attachCaptionSource(): void {
    const t = this.target;
    if (!t || t.kind === 'iframe') return;
    const video = t.el;
    clearTimeout(this.graceTimer);
    if (this.settings.modePreference === 'audio') {
      this.captionState = findEnglishTrack(video, this.settings.sourceLanguage) ? 'available' : 'unavailable';
      this.queueStatus();
      return;
    }
    if (this.manual) {
      this.useTimedSource(new ManualSource(this.manual.cues, this.manual.label), 'manual');
      return;
    }
    const choice = findEnglishTrack(video, this.settings.sourceLanguage);
    this.captionsOff = false;
    if (choice && choice.track.mode === 'disabled' && !this.settings.autoEnableCaptions) {
      // Accessible English track, but CC is off and the user has not opted in to auto-enable:
      // do not touch the player's caption state. Attach as soon as CC is turned on (change event).
      this.captionsOff = true;
      this.captionState = 'unavailable';
      this.notice = 'Có phụ đề tiếng Anh nhưng CC đang tắt. Bật CC, hoặc bật "Tự bật phụ đề tiếng Anh" (một lần) để dịch tự động.';
      this.applyVisibility();
      this.queueStatus();
      return;
    }
    if (choice) {
      const src = new TextTrackSource(video, choice.track, undefined, this.settings.autoEnableCaptions);
      this.useTimedSource(src, 'texttrack');
      if (choice.uncertain) this.notice = 'Không xác định được ngôn ngữ phụ đề — giả định là tiếng Anh.';
      return;
    }
    // DOM-rendered captions (YouTube CC, or user-provided selectors).
    const selectors = [
      ...(this.env.adapter.domCaptionSelectors ?? []),
      ...this.settings.customCaptionSelectors.split('\n').map((s) => s.trim()).filter(Boolean),
    ];
    if (selectors.length) {
      this.dom = new DomCaptionSource(this.env.doc, selectors);
      this.dom.start((text) => this.onDomText(text));
    }
    this.captionState = 'searching';
    this.graceTimer = setTimeout(() => {
      if (this.captionState === 'searching') {
        this.captionState = 'unavailable';
        if (!video.textTracks?.length)
          this.notice = 'Trình phát chưa cung cấp track phụ đề nào. Nếu bật CC trên trình phát làm xuất hiện phụ đề, tiện ích sẽ tự nhận ngay.';
        this.applyVisibility();
        this.queueStatus();
      }
    }, this.env.captionGraceMs ?? 3000);
    this.queueStatus();
  }

  private useTimedSource(src: TimedSource, kind: CaptionSourceKind): void {
    this.timed = src;
    this.captionSource = kind;
    this.captionState = 'available';
    this.trackLabel = src.label;
    src.start(
      (cues) => this.rebuildTimeline(cues, false),
      (state) => {
        this.notice =
          state === 'lost'
            ? 'Phụ đề tiếng Anh của trình phát không còn truy cập được — chỉ hiển thị các đoạn đã đọc trước đó.'
            : state === 'disabled'
              ? 'CC của trình phát đang tắt — dùng phụ đề đã tải; bật CC để tải tiếp phần mới.'
              : undefined;
        this.render();
        this.queueStatus();
      },
    );
    this.applyVisibility();
    this.queueStatus();
  }

  private rebuildTimeline(rawCues: Cue[], resetTranslations: boolean): void {
    this.lastCues = rawCues;
    const cues = normalizeCues(rawCues);
    const units = segmentCues(cues, { merge: this.settings.mergeFragments });
    const prev = resetTranslations ? undefined : this.timeline ?? undefined;
    this.timeline = new Timeline(units, prev);
    const video = this.target && this.target.kind !== 'iframe' ? this.target.el : null;
    if (!this.scheduler || resetTranslations) {
      this.scheduler?.dispose();
      this.scheduler = new TranslationScheduler(
        this.timeline,
        this.videoKey ?? 'unknown',
        this.env.bridge,
        () => {
          this.render();
          this.queueStatus();
        },
        (msg) => {
          this.error = msg;
          this.queueStatus();
        },
        { pretranslateAll: this.settings.pretranslateAll, ...this.env.schedulerOptions },
      );
      this.scheduler.setEnabled(this.settings.enabled && !this.audioActive && !this.paused);
    } else {
      this.scheduler.setTimeline(this.timeline);
    }
    this.scheduler.setPlayhead(video?.currentTime ?? 0, video?.playbackRate ?? 1);
    this.render();
    this.queueStatus();
  }

  private async onDomText(text: string): Promise<void> {
    if (!text) {
      if (this.captionSource === 'dom') {
        this.live = null;
        this.render();
      }
      return;
    }
    if (this.captionSource !== 'dom') {
      this.captionSource = 'dom';
      this.captionState = 'available';
      this.trackLabel = 'DOM captions';
      clearTimeout(this.graceTimer);
      this.applyVisibility();
      this.queueStatus();
    }
    const id = 'd' + hash53(text);
    this.live = { id, en: text, vi: this.liveCache.get(id), shownAt: Date.now() };
    this.render();
    if (this.live.vi || !this.settings.enabled || this.audioActive) return;
    const context = this.liveHistory.slice(-this.settings.contextWindow);
    this.liveHistory.push(text);
    if (this.liveHistory.length > 10) this.liveHistory.shift();
    try {
      const [r] = await this.env.bridge.translate(this.videoKey ?? 'dom', [{ id, text }], context);
      if (r?.vi) {
        this.liveCache.set(id, r.vi);
        if (this.liveCache.size > 500) this.liveCache.delete(this.liveCache.keys().next().value!);
        if (this.live?.id === id) {
          this.live.vi = r.vi;
          this.render();
        }
      } else if (r?.fatal) {
        this.error = r.error;
        this.queueStatus();
      }
    } catch {
      /* transient; next caption will retry */
    }
  }

  private armLiveExpiry(): void {
    clearTimeout(this.liveTimer);
    const l = this.live;
    if (!l) return;
    const text = l.vi ?? l.en;
    const ms = Math.min(9000, Math.max(3000, text.length * 75));
    this.liveTimer = setTimeout(() => {
      if (this.live === l) {
        this.live = null;
        this.render();
      }
    }, ms);
  }

  private clearLive(): void {
    clearTimeout(this.liveTimer);
    this.live = null;
  }

  private applyVisibility(): void {
    const m = this.mode;
    const show = (m === 'caption' && !!this.target) || (m === 'audio' && this.audioPrimary); // 'paused' → hidden
    if (show && this.overlay) this.overlay.setTarget(this.overlayTargetEl());
    this.overlay?.setVisible(show);
    if (!show && this.native) {
      this.native.disable();
      this.native = null;
    }
  }

  private stopSources(): void {
    this.timed?.stop();
    this.timed = null;
    this.dom?.stop();
    this.dom = null;
    this.scheduler?.dispose();
    this.scheduler = null;
    this.timeline = null;
    this.lastCues = [];
    this.captionSource = null;
    this.captionState = 'searching';
    this.trackLabel = undefined;
    if (this.captionSource === null && this.live && !this.audioActive) this.live = null;
  }

  private teardownTarget(): void {
    this.stopLoop();
    this.stopSources();
    clearTimeout(this.graceTimer);
    const t = this.target;
    if (t && t.kind !== 'iframe') for (const [ev, fn] of this.videoListeners) t.el.removeEventListener(ev, fn);
    this.videoListeners = [];
    this.trackListUnsub?.();
    this.trackListUnsub = null;
    this.native?.disable();
    this.native = null;
    this.overlay?.setTarget(null);
    this.overlay?.show(null);
    this.videoKey = null;
    this.error = undefined;
    this.notice = undefined;
    this.liveHistory = [];
    this.missed = new Set();
    this.captionsOff = false;
    this.stallSince = null;
    this.stallReenables = 0;
    this.untranslatedSince = null;
    this.recoveries.length = 0;
  }

  private queueStatus(): void {
    if (this.destroyed) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.env.bridge.reportStatus(this.status()), 250);
  }

  status(): Omit<FrameStatus, 'frameId'> {
    const counts = this.timeline?.counts() ?? { total: 0, done: 0, failed: 0 };
    return {
      isTop: this.env.isTop,
      host: this.env.doc.location.hostname,
      provider: this.target?.provider ?? null,
      embeddedProviders: this.embeddedProviders,
      targetKind: this.target?.kind ?? null,
      videoElements: this.mediaCounts.videos,
      audioElements: this.mediaCounts.audios,
      pageAnchor: !!this.anchor,
      targetArea: this.target ? Math.round(this.target.area % 1e7) : 0,
      captionState: this.target ? this.captionState : 'unavailable',
      captionSource: this.audioActive ? 'live' : this.captionSource,
      trackLabel: this.trackLabel,
      mode: this.mode,
      videoKey: this.videoKey,
      unitsTotal: counts.total,
      unitsTranslated: counts.done,
      unitsFailed: counts.failed,
      error: this.error,
      notice: this.notice,
      captionsOff: this.captionsOff || undefined,
      perf: this.scheduler
        ? { timeToFirstMs: this.scheduler.timeToFirstMs, missedDeadlines: this.missed.size, aheadCoverage: Math.round(this.scheduler.aheadCoverage() * 100) / 100 }
        : undefined,
      updatedAt: Date.now(),
    };
  }
}

export type { UnitPayload, UnitResult, TimedUnit };
