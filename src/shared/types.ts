/** Core domain types shared by every extension context. */

export type ProviderId = 'skool-native' | 'loom' | 'vimeo' | 'youtube' | 'wistia' | 'html5';

/** A single timed caption cue as read from a TextTrack, VTT/SRT file or DOM. */
export interface Cue {
  id: string;
  start: number; // seconds
  end: number; // seconds
  text: string;
}

/**
 * A translation unit: one or more consecutive cues merged into a sentence-like
 * segment. The unit keeps a stable mapping back to the original cue IDs.
 */
export interface Unit {
  id: string;
  start: number;
  end: number;
  text: string;
  cueIds: string[];
}

export type UnitStatus = 'pending' | 'inflight' | 'done' | 'error';

export interface TimedUnit extends Unit {
  vi?: string;
  status: UnitStatus;
  attempts: number;
}

export type DisplayMode = 'vi' | 'bilingual';
export type ModePreference = 'auto' | 'caption' | 'audio';
export type TranslationProviderKind = 'gemini' | 'openai' | 'anthropic' | 'local' | 'mock';
export type SttKind = 'openai' | 'local' | 'mock';

export interface TranslationProviderSettings {
  kind: TranslationProviderKind;
  /** Base URL. OpenAI-compatible: https://api.openai.com/v1, Gemini: https://generativelanguage.googleapis.com/v1beta, local: http://localhost:8787 */
  endpoint: string;
  model: string;
  temperature: number;
}

export interface SttSettings {
  kind: SttKind;
  endpoint: string;
  model: string;
}

export interface ConsentSettings {
  /** User allowed sending subtitle TEXT to a non-local translation endpoint. */
  remoteTranslation: boolean;
  /** User allowed sending tab AUDIO chunks to a non-local STT endpoint. */
  remoteAudio: boolean;
}

export interface Settings {
  enabled: boolean;
  modePreference: ModePreference;
  displayMode: DisplayMode;
  fontScale: number; // 0.6 – 2
  bottomOffsetPct: number; // 3 – 45 (% of video height from bottom)
  background: boolean;
  backgroundOpacity: number; // 0 – 1
  outline: boolean;
  shadow: boolean;
  showPanel: boolean;
  /** Active translation provider (a copy of its profile). */
  provider: TranslationProviderSettings;
  /** Remembered endpoint/model/temperature per provider, so switching never loses configuration. */
  providerProfiles: Partial<Record<TranslationProviderKind, TranslationProviderSettings>>;
  stt: SttSettings;
  consent: ConsentSettings;
  /** Glossary, one entry per line: `English term => Vietnamese` or just `Term` (keep as-is). */
  glossary: string;
  /** Number of preceding segments sent as context. */
  contextWindow: number;
  /** FAST / BALANCED / QUALITY scheduling profile (see translation/modes.ts). */
  translationMode: 'fast' | 'balanced' | 'quality';
  /**
   * Optional model per mode and provider (e.g. a faster model for FAST). Empty = keep the provider's
   * model. Only ever set by the user — modes never switch models on their own.
   */
  modeModels: Partial<Record<'fast' | 'balanced' | 'quality', Partial<Record<string, string>>>>;
  /** After the prefetch window is covered, translate the rest of an accessible transcript in the background. */
  pretranslateAll: boolean;
  /** Merge short caption fragments into sentence-sized units before translating. */
  mergeFragments: boolean;
  /** Start translating automatically when a lesson opens (else wait for "Bắt đầu dịch"). */
  autoStart: boolean;
  /**
   * Opt-in: switch an accessible but disabled English track to "hidden" so its cues load
   * (no native rendering). Off by default — the user's CC choice is otherwise left untouched.
   */
  autoEnableCaptions: boolean;
  /** The one-time "auto-enable English captions?" question was answered (yes or no). */
  autoEnableCaptionsAsked: boolean;
  /** Re-initialise translation automatically after Skool SPA lesson changes. */
  autoInitOnNavigation: boolean;
  /** Source subtitle language (BCP-47 prefix). Only English is supported by the prompt today. */
  sourceLanguage: 'en';
  /** Target language. Only Vietnamese is supported today. */
  targetLanguage: 'vi';
  /** Daily estimated-cost warning threshold in USD (0 = off). Advisory only — not a billing limit. */
  costWarningUsd: number;
  /** Extra CSS selectors that point to caption text rendered in the DOM (advanced). */
  customCaptionSelectors: string;
}

export type CaptionState = 'searching' | 'available' | 'unavailable';
export type CaptionSourceKind = 'texttrack' | 'dom' | 'manual' | 'live';
export type ActiveMode = 'off' | 'paused' | 'idle' | 'caption' | 'audio' | 'waiting-audio';

/** What one frame (top Skool page or an embedded player iframe) reports. */
export interface FrameStatus {
  frameId: number;
  isTop: boolean;
  host: string;
  provider: ProviderId | null;
  /** Players detected as iframes in this frame (top frame only). */
  embeddedProviders: ProviderId[];
  /** video = visible <video>; media = accessible non-visual media (e.g. <audio>); iframe = player iframe; null = none accessible */
  targetKind: 'video' | 'media' | 'iframe' | null;
  /** Accessible media elements found in this frame (light DOM + open shadow roots). */
  videoElements: number;
  audioElements: number;
  /** A visible player-like container was found for page-level overlay positioning. */
  pageAnchor: boolean;
  targetArea: number;
  captionState: CaptionState;
  captionSource: CaptionSourceKind | null;
  trackLabel?: string;
  mode: ActiveMode;
  videoKey: string | null;
  unitsTotal: number;
  unitsTranslated: number;
  unitsFailed: number;
  error?: string;
  notice?: string;
  perf?: CaptionPerf;
  /** An English track exists but is disabled and auto-enable is off (user can opt in). */
  captionsOff?: boolean;
  updatedAt: number;
}

/** Measured (not assumed) caption-translation performance for the current video. */
export interface CaptionPerf {
  /** Captions available → first Vietnamese segment received. */
  timeToFirstMs?: number;
  /** Segments that became visible on screen before their translation arrived. */
  missedDeadlines: number;
  /** Share of segments in the prefetch window that are already translated (0–1). */
  aheadCoverage: number;
  /** Video coverage: latest available English cue, latest translated cue, media duration (s). */
  sourceUntilSec?: number;
  translatedUntilSec?: number;
  durationSec?: number;
  /** Scheduler state (translating / idle / waiting-retry / fatal-backoff / paused). */
  queueState?: string;
  queuedInWindow?: number;
  lastError?: string | null;
}

export interface AudioStatus {
  active: boolean;
  sessionId?: string;
  startedAt?: number;
  error?: string;
  chunks: number;
  droppedChunks: number;
  sttLatencyMs?: number; // rolling average: chunk end -> STT text
  totalLatencyMs?: number; // rolling average: chunk end -> Vietnamese ready
}

export interface TabStatus {
  tabId: number;
  isSkool: boolean;
  frames: FrameStatus[];
  primaryFrameId: number | null;
  audio: AudioStatus;
}

export interface MetricsSnapshot {
  requests: number;
  failedRequests: number;
  retries: number;
  rateLimited: number;
  segmentsTranslated: number;
  cacheHits: number;
  cacheMisses: number;
  avgLatencyMs: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** null when the model's price is unknown */
  estimatedCostUsd: number | null;
}

export interface CacheStats {
  entries: number;
  approxBytes: number;
}

export interface Secrets {
  /** Legacy single key (pre-3.3); still used as a fallback for the active provider. */
  translationApiKey?: string;
  /** One API key per translation provider. */
  translationApiKeys?: Partial<Record<TranslationProviderKind, string>>;
  sttApiKey?: string;
}
