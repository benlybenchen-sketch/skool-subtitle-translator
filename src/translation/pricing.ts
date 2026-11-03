/**
 * List prices in USD per 1M tokens, used ONLY for an on-screen cost ESTIMATE.
 * Prices change; unknown models return null (the popup then shows tokens only).
 * gemini-3.5-flash-lite: $0.30 input / $2.50 output (public pricing pages, Nov 2026).
 */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /^gemini-3\.5-flash-lite/i, input: 0.3, output: 2.5 },
  { match: /^gpt-4o-mini/i, input: 0.15, output: 0.6 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  if (model === 'mock') return 0;
  const p = PRICES.find((x) => x.match.test(model.replace(/^models\//, '')));
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}
