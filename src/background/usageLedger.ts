import type { TokenUsage } from '../translation/types';
import { costOf, type PriceRow } from '../translation/pricing';
import { percentile } from '../shared/util';

/**
 * Persistent API usage ledger (chrome.storage.local; session totals in chrome.storage.session).
 * Aggregated by total, day, provider:model, lesson (privacy-safe hash) and browser session.
 * Only provider-reported tokens count as exact; estimates (provider reported nothing) and
 * tokens of models without a price are kept in separate counters. Cache hits are counted as
 * cache hits — never as API usage.
 */
export interface UsageBucket {
  requests: number;
  failed: number;
  retries: number;
  rateLimited: number;
  segments: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  unpricedTokens: number;
  costUsd: number;
  estimatedCostUsd: number;
  cacheHits: number;
  cacheMisses: number;
  latencyMsTotal: number;
  latencyCount: number;
}

export interface LedgerData {
  version: 1;
  total: UsageBucket;
  days: Record<string, UsageBucket>;
  models: Record<string, UsageBucket>;
  lessons: Record<string, UsageBucket & { lastSeen: number }>;
}

export interface SessionData {
  bucket: UsageBucket;
  latencies: number[];
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface LedgerSnapshot {
  total: UsageBucket;
  today: UsageBucket;
  session: UsageBucket;
  models: Record<string, UsageBucket>;
  lessons: Record<string, UsageBucket>;
  sessionP95LatencyMs: number;
  sessionAvgLatencyMs: number;
  lastError: string | null;
}

export type AccountingEvent =
  | { type: 'request'; size: number }
  | { type: 'success'; size: number; latencyMs: number }
  | { type: 'retry' }
  | { type: 'rate-limited' }
  | { type: 'failure'; size: number; reason: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'cache'; hits: number; misses: number };

export interface Meta {
  provider?: string;
  model?: string;
  lesson?: string;
}

export const emptyBucket = (): UsageBucket => ({
  requests: 0, failed: 0, retries: 0, rateLimited: 0, segments: 0,
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  estimatedInputTokens: 0, estimatedOutputTokens: 0, unpricedTokens: 0,
  costUsd: 0, estimatedCostUsd: 0, cacheHits: 0, cacheMisses: 0, latencyMsTotal: 0, latencyCount: 0,
});

interface Area {
  get(k: string): Promise<Record<string, unknown>>;
  set(v: Record<string, unknown>): Promise<void>;
}

const LEDGER_KEY = 'usageLedger';
const SESSION_KEY = 'usageSession';
const MAX_LESSONS = 300;
const MAX_DAYS = 120;

export class UsageLedger {
  private data: LedgerData = { version: 1, total: emptyBucket(), days: {}, models: {}, lessons: {} };
  private session: SessionData = { bucket: emptyBucket(), latencies: [], lastError: null, lastErrorAt: null };
  private loaded: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly local: Area,
    private readonly sessionArea: Area,
    private readonly getPricing: () => Promise<PriceRow[]>,
    private readonly now: () => number = Date.now,
  ) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const [l, s] = await Promise.all([this.local.get(LEDGER_KEY), this.sessionArea.get(SESSION_KEY)]);
      if (l[LEDGER_KEY]) this.data = l[LEDGER_KEY] as LedgerData;
      if (s[SESSION_KEY]) this.session = s[SESSION_KEY] as SessionData;
    } catch {
      /* first run */
    }
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private buckets(meta: Meta = {}): UsageBucket[] {
    const d = this.day();
    const out = [this.data.total, (this.data.days[d] ??= emptyBucket()), this.session.bucket];
    if (meta.provider && meta.model) out.push((this.data.models[`${meta.provider}:${meta.model}`] ??= emptyBucket()));
    if (meta.lesson) {
      const l = (this.data.lessons[meta.lesson] ??= { ...emptyBucket(), lastSeen: 0 });
      l.lastSeen = this.now();
      out.push(l);
    }
    return out;
  }

  async record(e: AccountingEvent, meta: Meta = {}): Promise<void> {
    await this.loaded;
    const pricing = e.type === 'usage' ? await this.getPricing() : [];
    const bs = this.buckets(meta);
    for (const b of bs) {
      switch (e.type) {
        case 'request':
          b.requests++;
          break;
        case 'success':
          b.segments += e.size;
          b.latencyMsTotal += e.latencyMs;
          b.latencyCount++;
          break;
        case 'retry':
          b.retries++;
          break;
        case 'rate-limited':
          b.rateLimited++;
          break;
        case 'failure':
          b.failed++;
          break;
        case 'cache':
          b.cacheHits += e.hits;
          b.cacheMisses += e.misses;
          break;
        case 'usage': {
          const u = e.usage;
          const cost = costOf(meta.model ?? '', u, pricing);
          if (u.estimated) {
            b.estimatedInputTokens += u.inputTokens;
            b.estimatedOutputTokens += u.outputTokens;
            if (cost !== null) b.estimatedCostUsd += cost;
          } else {
            b.inputTokens += u.inputTokens;
            b.outputTokens += u.outputTokens;
            b.cachedInputTokens += u.cachedInputTokens ?? 0;
            b.cacheWriteTokens += u.cacheWriteTokens ?? 0;
            b.reasoningTokens += u.reasoningTokens ?? 0;
            if (cost !== null) b.costUsd += cost;
          }
          if (cost === null) b.unpricedTokens += u.inputTokens + u.outputTokens;
          break;
        }
      }
    }
    if (e.type === 'success') {
      this.session.latencies.push(e.latencyMs);
      if (this.session.latencies.length > 200) this.session.latencies.shift();
    }
    if (e.type === 'failure') {
      this.session.lastError = e.reason.slice(0, 200);
      this.session.lastErrorAt = this.now();
    }
    this.persistSoon();
  }

  private prune(): void {
    const lessons = Object.entries(this.data.lessons);
    if (lessons.length > MAX_LESSONS) {
      lessons.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [k] of lessons.slice(0, lessons.length - MAX_LESSONS)) delete this.data.lessons[k];
    }
    const days = Object.keys(this.data.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete this.data.days[d];
  }

  private persistSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1000);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.prune();
    await Promise.all([this.local.set({ [LEDGER_KEY]: this.data }), this.sessionArea.set({ [SESSION_KEY]: this.session })]).catch(() => undefined);
  }

  async snapshot(): Promise<LedgerSnapshot> {
    await this.loaded;
    const lat = this.session.latencies;
    return {
      total: this.data.total,
      today: this.data.days[this.day()] ?? emptyBucket(),
      session: this.session.bucket,
      models: this.data.models,
      lessons: this.data.lessons,
      sessionP95LatencyMs: Math.round(percentile(lat, 95)),
      sessionAvgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      lastError: this.session.lastError,
    };
  }

  async reset(): Promise<void> {
    await this.loaded;
    this.data = { version: 1, total: emptyBucket(), days: {}, models: {}, lessons: {} };
    this.session = { bucket: emptyBucket(), latencies: [], lastError: null, lastErrorAt: null };
    await this.flush();
  }
}
