import { percentile } from '../shared/util';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

/** TTS usage, kept separate from translation tokens. Costs are estimates from list prices. */
export interface TtsBucket {
  requests: number;
  failures: number;
  chars: number;
  cacheHits: number;
  cacheMisses: number;
  latencyMsTotal: number;
  latencyCount: number;
  estCostUsd: number;
}
export const emptyTts = (): TtsBucket => ({ requests: 0, failures: 0, chars: 0, cacheHits: 0, cacheMisses: 0, latencyMsTotal: 0, latencyCount: 0, estCostUsd: 0 });

export interface TtsLedgerData {
  total: TtsBucket;
  days: Record<string, TtsBucket>;
  providers: Record<string, TtsBucket>;
  lessons: Record<string, TtsBucket & { lastSeen: number }>;
}

export type TtsEvent =
  | { type: 'request'; chars: number; latencyMs: number; costUsd: number }
  | { type: 'failure' }
  | { type: 'cache'; hit: boolean };

const KEY = 'ttsUsage';
const SKEY = 'ttsUsageSession';

export class TtsLedger {
  private data: TtsLedgerData = { total: emptyTts(), days: {}, providers: {}, lessons: {} };
  private session: TtsBucket & { latencies: number[] } = { ...emptyTts(), latencies: [] };
  private readonly loaded: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly local: Area,
    private readonly sessionArea: Area,
    private readonly now: () => number = Date.now,
  ) {
    this.loaded = Promise.all([local.get(KEY), sessionArea.get(SKEY)]).then(([l, s]) => {
      if (l[KEY]) this.data = { ...this.data, ...(l[KEY] as TtsLedgerData) };
      if (s[SKEY]) this.session = { ...this.session, ...(s[SKEY] as typeof this.session) };
    }).catch(() => undefined);
  }

  async record(e: TtsEvent, meta: { provider: string; lesson?: string }): Promise<void> {
    await this.loaded;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const buckets: TtsBucket[] = [this.data.total, (this.data.days[day] ??= emptyTts()), (this.data.providers[meta.provider] ??= emptyTts()), this.session];
    if (meta.lesson) {
      const l = (this.data.lessons[meta.lesson] ??= { ...emptyTts(), lastSeen: 0 });
      l.lastSeen = this.now();
      buckets.push(l);
    }
    for (const b of buckets) {
      if (e.type === 'request') {
        b.requests++;
        b.chars += e.chars;
        b.latencyMsTotal += e.latencyMs;
        b.latencyCount++;
        b.estCostUsd += e.costUsd;
      } else if (e.type === 'failure') b.failures++;
      else if (e.hit) b.cacheHits++;
      else b.cacheMisses++;
    }
    if (e.type === 'request') {
      this.session.latencies.push(e.latencyMs);
      if (this.session.latencies.length > 200) this.session.latencies.shift();
    }
    this.prune();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  private prune(): void {
    const days = Object.keys(this.data.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 120))) delete this.data.days[d];
    const lessons = Object.entries(this.data.lessons).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    for (const [k] of lessons.slice(300)) delete this.data.lessons[k];
  }

  async flush(): Promise<void> {
    await Promise.all([this.local.set({ [KEY]: this.data }), this.sessionArea.set({ [SKEY]: this.session })]).catch(() => undefined);
  }

  async snapshot() {
    await this.loaded;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const { latencies, ...session } = this.session;
    return {
      total: this.data.total,
      today: this.data.days[day] ?? emptyTts(),
      session,
      providers: this.data.providers,
      sessionMedianLatencyMs: Math.round(percentile(latencies, 50)),
      sessionP95LatencyMs: Math.round(percentile(latencies, 95)),
    };
  }

  async reset(): Promise<void> {
    this.data = { total: emptyTts(), days: {}, providers: {}, lessons: {} };
    this.session = { ...emptyTts(), latencies: [] };
    await this.flush();
  }
}
