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
export type TranslationProviderKind = 'openai' | 'gemini' | 'local' | 'mock';
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
  provider: TranslationProviderSettings;
  stt: SttSettings;
  consent: ConsentSettings;
  /** Glossary, one entry per line: `English term => Vietnamese` or just `Term` (keep as-is). */
  glossary: string;
  /** Number of preceding segments sent as context. */
  contextWindow: number;
  /** Merge short caption fragments into sentence-sized units before translating. */
  mergeFragments: boolean;
  /** Extra CSS selectors that point to caption text rendered in the DOM (advanced). */
  customCaptionSelectors: string;
}

export type CaptionState = 'searching' | 'available' | 'unavailable';
export type CaptionSourceKind = 'texttrack' | 'dom' | 'manual' | 'live';
export type ActiveMode = 'off' | 'idle' | 'caption' | 'audio' | 'waiting-audio';

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
  updatedAt: number;
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
  p95LatencyMs: number;
}

export interface CacheStats {
  entries: number;
  approxBytes: number;
}

export interface Secrets {
  translationApiKey?: string;
  sttApiKey?: string;
}
