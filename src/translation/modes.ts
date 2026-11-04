/**
 * Translation modes — initial tuning values (not guarantees). They change scheduling and context
 * size only; the model changes ONLY if the user configured a per-mode model (never silently).
 */
export type TranslationMode = 'fast' | 'balanced' | 'quality';

export interface ModeProfile {
  /** Urgent first batch (time to first subtitle). */
  firstBatchSize: number;
  /** Batch size for P1/P2 work. */
  batchSize: number;
  /** Batch size for P3 lookahead / background work (fewer requests). */
  backgroundBatchSize: number;
  /** Prefetch horizon in seconds of playback (scaled by playback rate). */
  lookAheadSec: number;
  /** Previous source segments sent as context (never re-translated). */
  contextSize: number;
}

export const MODE_PROFILES: Record<TranslationMode, ModeProfile> = {
  fast: { firstBatchSize: 3, batchSize: 8, backgroundBatchSize: 12, lookAheadSec: 45, contextSize: 1 },
  balanced: { firstBatchSize: 4, batchSize: 10, backgroundBatchSize: 16, lookAheadSec: 90, contextSize: 3 },
  quality: { firstBatchSize: 4, batchSize: 12, backgroundBatchSize: 20, lookAheadSec: 120, contextSize: 6 },
};

export const MODE_LABELS: Record<TranslationMode, string> = {
  fast: 'Nhanh (FAST)',
  balanced: 'Cân bằng (BALANCED)',
  quality: 'Chất lượng (QUALITY)',
};

export function modeProfile(mode: TranslationMode | undefined): ModeProfile {
  return MODE_PROFILES[mode ?? 'balanced'] ?? MODE_PROFILES.balanced;
}
