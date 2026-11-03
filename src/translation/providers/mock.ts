import type { BatchRequest, TranslationProvider } from '../types';
import { sleep } from '../../shared/util';

/** Deterministic offline provider for tests and UI demos: "[VI] <text>". */
export class MockProvider implements TranslationProvider {
  readonly id = 'mock';
  calls = 0;
  constructor(private readonly latencyMs = 0) {}

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    this.calls++;
    if (this.latencyMs) await sleep(this.latencyMs, req.signal);
    const out: Record<string, string> = {};
    for (const s of req.segments) out[s.id] = `[VI] ${s.text}`;
    return out;
  }
}
