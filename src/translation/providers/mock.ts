import type { BatchRequest, CompleteRequest, TranslationProvider } from '../types';
import { sleep } from '../../shared/util';

const MERGE_MARKER = '<<PARTIAL_NOTES_JSON>>';

/** Deterministic offline provider for tests and UI demos: "[VI] <text>". */
export class MockProvider implements TranslationProvider {
  readonly id = 'mock';
  calls = 0;
  completeCalls = 0;
  constructor(private readonly latencyMs = 0) {}

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    this.calls++;
    if (this.latencyMs) await sleep(this.latencyMs, req.signal);
    const out: Record<string, string> = {};
    for (const s of req.segments) out[s.id] = `[VI] ${s.text}`;
    return out;
  }

  /** Deterministic "study notes" built only from the lines it was given (refs = their labels). */
  async complete(req: CompleteRequest): Promise<string> {
    this.completeCalls++;
    if (this.latencyMs) await sleep(this.latencyMs, req.signal);
    const title = /^Lesson title: (.*)$/m.exec(req.user)?.[1] ?? '';
    const empty = { title, summary: '', objectives: [], concepts: [], insights: [], steps: [], terminology: [], takeaways: [], checklist: [], moments: [] };
    const i = req.user.indexOf(MERGE_MARKER);
    if (i >= 0) {
      const parts = JSON.parse(req.user.slice(i + MERGE_MARKER.length)) as Record<string, unknown[] | string>[];
      const out: Record<string, unknown> = { ...empty };
      for (const k of Object.keys(empty)) {
        if (k === 'title') continue;
        if (k === 'summary') out.summary = parts.map((p) => p.summary).filter(Boolean).join(' ');
        else {
          const seen = new Set<string>();
          out[k] = parts.flatMap((p) => (p[k] as unknown[]) ?? []).filter((x) => {
            const key = JSON.stringify(typeof x === 'object' && x ? (x as { text?: string; term?: string }).text ?? (x as { term?: string }).term : x);
            return seen.has(key) ? false : (seen.add(key), true);
          });
        }
      }
      return JSON.stringify(out);
    }
    const lines = [...req.user.matchAll(/^\[([SP]\d+)(?: [\d:]+)?\] (.*)$/gm)].map((m) => ({ label: m[1], text: m[2] }));
    req.onUsage?.({ inputTokens: Math.ceil(req.user.length / 4), outputTokens: 200, estimated: true });
    return JSON.stringify({
      ...empty,
      summary: lines.length ? `[VI] ${lines.slice(0, 2).map((l) => l.text).join(' ')}` : '',
      objectives: lines.length ? [`[VI] Hiểu: ${lines[0].text}`] : [],
      takeaways: lines.slice(0, 5).map((l) => ({ text: `[VI] ${l.text}`, refs: [l.label] })),
      moments: lines.filter((_, k) => k % 5 === 0).map((l) => ({ text: `[VI] ${l.text}`, refs: [l.label] })),
    });
  }
}
