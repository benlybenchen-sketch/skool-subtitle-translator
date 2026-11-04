import type { TokenUsage } from './types';

/**
 * Price table (USD per 1M tokens) used ONLY for cost ESTIMATES. Defaults are starting values with
 * their source noted; prices change — the user edits them on the dashboard page (stored in
 * chrome.storage.local). Matching is by model-id prefix, longest match wins.
 */
export interface PriceRow {
  match: string;
  input: number;
  output: number;
  /** Input tokens served from the provider cache (default: input price). */
  cachedInput?: number;
  /** Input tokens written to the provider cache (default: input price). */
  cacheWrite?: number;
  note?: string;
}

export const DEFAULT_PRICES: PriceRow[] = [
  { match: 'gemini-3.5-flash-lite', input: 0.3, output: 2.5, cachedInput: 0.03, note: 'public pricing pages (web search), Nov 2026' },
  { match: 'gpt-4o-mini', input: 0.15, output: 0.6, cachedInput: 0.075, note: 'OpenAI list price (training data) — verify' },
  { match: 'claude-opus-5-5', input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5, note: 'Claude API reference cached 2026-10-06; cache write = 1.25× input' },
  { match: 'claude-sonnet-5-5', input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5, note: 'Claude API reference cached 2026-10-06; cache write = 1.25× input' },
  { match: 'claude-haiku-5-5', input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: 0.125, note: 'Claude API reference cached 2026-10-06 (≤100K-token prompts)' },
];

export function findPrice(model: string, table: PriceRow[] = DEFAULT_PRICES): PriceRow | null {
  const id = model.replace(/^models\//, '').toLowerCase();
  let best: PriceRow | null = null;
  for (const r of table) if (r.match && id.startsWith(r.match.toLowerCase()) && (!best || r.match.length > best.match.length)) best = r;
  return best;
}

/** Cost of one usage record; null when the model has no price (kept as "unpriced" tokens). */
export function costOf(model: string, u: TokenUsage, table: PriceRow[] = DEFAULT_PRICES): number | null {
  if (model === 'mock') return 0;
  const p = findPrice(model, table);
  if (!p) return null;
  const cached = u.cachedInputTokens ?? 0;
  const written = u.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, u.inputTokens - cached - written);
  return (uncached * p.input + cached * (p.cachedInput ?? p.input) + written * (p.cacheWrite ?? p.input) + u.outputTokens * p.output) / 1e6;
}

/** Back-compat helper (plain input/output tokens). */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, table: PriceRow[] = DEFAULT_PRICES): number | null {
  return costOf(model, { inputTokens, outputTokens }, table);
}

const PRICING_KEY = 'pricingTable';

export async function loadPricing(): Promise<PriceRow[]> {
  try {
    const d = await chrome.storage.local.get(PRICING_KEY);
    const rows = d[PRICING_KEY];
    return Array.isArray(rows) && rows.length ? (rows as PriceRow[]) : DEFAULT_PRICES;
  } catch {
    return DEFAULT_PRICES;
  }
}

export async function savePricing(rows: PriceRow[] | null): Promise<void> {
  if (!rows) await chrome.storage.local.remove(PRICING_KEY);
  else await chrome.storage.local.set({ [PRICING_KEY]: rows.filter((r) => r.match.trim()) });
}
