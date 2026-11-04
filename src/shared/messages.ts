import type {
  CacheStats,
  Cue,
  FrameStatus,
  MetricsSnapshot,
  TabStatus,
} from './types';

export interface UnitPayload {
  id: string;
  text: string;
}

export interface UnitResult {
  id: string;
  vi?: string;
  error?: string;
  /** true when the error is permanent (bad key, consent missing, …) */
  fatal?: boolean;
  cached?: boolean;
}

/** Messages handled by the background service worker. */
export type BackgroundRequest =
  | { type: 'frame:hello'; isTop: boolean }
  | { type: 'frame:status'; status: Omit<FrameStatus, 'frameId'> }
  | { type: 'frame:gone' }
  | { type: 'translate:units'; videoKey: string; units: UnitPayload[]; context: string[]; priority?: number; format?: 'subtitle' | 'markup' }
  | { type: 'translate:cancel'; videoKey: string }
  | { type: 'translate:test' }
  | { type: 'tab:status'; tabId: number }
  | { type: 'diag:run'; tabId: number }
  | { type: 'backend:check' }
  | { type: 'session:start' }
  // Learning assistant: the top frame's panel reaches the lesson video's frame through the background.
  | { type: 'learning:remote'; op: LearningOp }
  | { type: 'learning:open'; tabId: number; tab: 'transcript' | 'notes' | 'export' }
  // AI Study Notes (user-triggered only; stored locally)
  | { type: 'notes:get'; lessonId: string }
  | { type: 'notes:generate'; transcript: import('../transcript/model').Transcript }
  | { type: 'notes:cancel'; lessonId: string }
  | { type: 'notes:save'; lessonId: string; editedMarkdown: string | null }
  | { type: 'notes:model' }
  | { type: 'usage:get' }
  | { type: 'usage:reset' }
  | { type: 'pricing:set'; rows: import('../translation/pricing').PriceRow[] | null }
  | { type: 'metrics:get' }
  | { type: 'cache:stats' }
  | { type: 'cache:clear' }
  | { type: 'audio:start'; tabId: number; streamId: string }
  | { type: 'audio:stop'; tabId?: number }
  | { type: 'manual:cues'; tabId: number; cues: Cue[]; label: string }
  // from the offscreen document
  // Local lesson store (Phase 5: instant transcript, offline study)
  | { type: 'lesson:get'; lessonId: string }
  | { type: 'lesson:put'; record: Partial<import('../transcript/store').LessonRecord> & { lessonId: string } }
  | { type: 'lesson:list' }
  | { type: 'lesson:delete'; lessonId: string }
  | { type: 'lesson:clear'; includeOffline: boolean }
  | { type: 'lesson:usage' }
  | { type: 'lesson:pack'; lessonId: string }
  | { type: 'reader:open'; lessonId?: string }
  // AI Vietnamese dubbing (Phase 4)
  | { type: 'dub:voices'; provider: import('./types').TtsProviderKind }
  | { type: 'dub:speak'; token: string; segId: string; text: string; voice: string; rate: number; volume: number }
  | { type: 'dub:prepare'; lesson: string; text: string; provider: 'google' | 'mock'; voice: string; rate: number }
  | { type: 'dub:play'; token: string; segId: string; key: string; rate: number; volume: number; offsetSec: number }
  | { type: 'dub:control'; action: 'stop' | 'pause' | 'resume'; token?: string; final?: boolean }
  | { type: 'dub:tabmute'; mute: boolean }
  | { type: 'dub:recover' }
  | { type: 'dub:usage' }
  | { type: 'dub:usage:reset' }
  | { type: 'dub:cache:clear' }
  | { type: 'offscreen:dub'; event: 'started' | 'ended' | 'error'; token: string; segId: string; error?: string }
  | { type: 'offscreen:ready' }
  | { type: 'offscreen:started'; sessionId: string }
  | {
      type: 'offscreen:chunk';
      sessionId: string;
      seq: number;
      wavBase64: string;
      startSec: number;
      endSec: number;
      endedAt: number;
      rms: number;
    }
  | { type: 'offscreen:error'; sessionId: string; error: string }
  | { type: 'offscreen:stopped'; sessionId: string; reason: string };

export type HelloResponse = { active: boolean; frameId: number };
export type TranslateResponse = { results: UnitResult[] };

/** Messages sent from the background to content scripts (chrome.tabs.sendMessage). */
export type ContentMessage =
  | { type: 'frame:ping' }
  | { type: 'live:segment'; id: string; en: string; vi?: string; final: boolean }
  | { type: 'audio:state'; active: boolean; primary: boolean; error?: string }
  | { type: 'manual:cues'; cues: Cue[]; label: string }
  | { type: 'tab:status:changed'; status: TabStatus }
  | { type: 'diag:collect' }
  | { type: 'nav:check' }
  | { type: 'session:start' }
  | { type: 'learning:op'; op: LearningOp }
  | { type: 'dub:event'; token: string; segId: string; kind: 'start' | 'end' | 'error' | 'interrupted'; error?: string }
  | { type: 'learning:open'; tab: 'transcript' | 'notes' | 'export' }
  | { type: 'notes:progress'; lessonId: string; done: number; total: number }
  // text-only lessons (popup ↔ top frame, chrome.tabs.sendMessage frameId 0)
  | { type: 'text:get' }
  | { type: 'text:cmd'; cmd: 'translate' | 'mode' | 'retry'; mode?: import('./types').TextDisplayMode };

/** Operations on the lesson transcript held by the frame that owns the video. */
export type LearningOp =
  | { kind: 'get'; title: string }
  | { kind: 'seek'; sec: number }
  | { kind: 'complete'; timeoutMs: number }
  | { kind: 'acquire' };

/** Messages sent from the background to the offscreen document. */
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'start'; streamId: string; sessionId: string }
  | { target: 'offscreen'; type: 'stop'; sessionId?: string }
  | { target: 'offscreen'; type: 'dub-load'; key: string; audioBase64: string; mime: string }
  | { target: 'offscreen'; type: 'dub-play'; key: string; token: string; segId: string; rate: number; volume: number; offsetSec: number }
  | { target: 'offscreen'; type: 'dub-stop' | 'dub-pause' | 'dub-resume' };

export interface StatusResponse {
  status: TabStatus;
  metrics: MetricsSnapshot;
  cache: CacheStats;
}

const TRANSIENT_PATTERNS = [
  'Receiving end does not exist',
  'message port closed',
  'Could not establish connection',
  'The message port closed before a response was received',
];

export function isTransientMessagingError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

export function isContextInvalidated(e?: unknown): boolean {
  try {
    if (!chrome?.runtime?.id) return true;
  } catch {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return msg.includes('Extension context invalidated');
}

/**
 * Send to the background, retrying while the service worker is (re)starting.
 * MV3 service workers can be terminated at any time; the first message after a
 * restart may fail with a transient "Receiving end does not exist" error.
 */
export async function sendToBackground<T = unknown>(
  msg: BackgroundRequest,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 150;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as T & { __error?: string };
      if (res && typeof res === 'object' && '__error' in res && res.__error) throw new Error(res.__error);
      return res;
    } catch (e) {
      lastErr = e;
      if (isContextInvalidated(e) || !isTransientMessagingError(e) || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, base * 2 ** attempt));
    }
  }
  throw lastErr;
}
