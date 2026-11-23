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

import type { Settings } from '../shared/types';
import { effectiveProvider } from '../shared/settings';
import { estimateCostUsd } from './pricing';

export interface ModeSwitchCheck {
  /** Does the new mode use a different model (user-configured per-mode model)? */
  modelChanges: boolean;
  from: string;
  to: string;
  /** true = more expensive, false = same or cheaper, null = price unknown (treated as needing approval). */
  pricier: boolean | null;
  needsApproval: boolean;
}

/** Never switch to a more expensive (or unknown-price) model without asking the user. */
export function checkModeSwitch(s: Settings, mode: TranslationMode): ModeSwitchCheck {
  const from = effectiveProvider(s).model;
  const to = effectiveProvider({ ...s, translationMode: mode }).model;
  if (from === to) return { modelChanges: false, from, to, pricier: false, needsApproval: false };
  const per = (m: string) => estimateCostUsd(m, 1_000_000, 200_000);
  const a = per(from);
  const b = per(to);
  const pricier = a === null || b === null ? null : b > a;
  return { modelChanges: true, from, to, pricier, needsApproval: pricier !== false };
}
