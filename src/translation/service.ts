import type { MetricsSnapshot, Secrets, Settings } from '../shared/types';
import type { UnitPayload, UnitResult } from '../shared/messages';
import { hash53 } from '../shared/hash';
import { TranslationCache } from '../cache/translationCache';
import { TranslationQueue, type QueueOptions } from './queue';
import { PROMPT_VERSION } from './prompt';
import { glossaryVersion, parseGlossary } from './glossary';
import { supportsThinkingLevel } from './providers/gemini';
import { estimateCostUsd } from './pricing';
import { createProvider } from './providers';
import type { TranslationProvider } from './types';
import { ConfigError, HttpError } from './errors';
import { translationIsRemote } from '../shared/settings';
import { percentile } from '../shared/util';

export interface ServiceDeps {
  cache: TranslationCache;
  getSettings: () => Promise<Settings>;
  getSecrets: () => Promise<Secrets>;
  /** Checks that the extension may contact the endpoint (host permission). */
  hasEndpointPermission?: (endpoint: string) => Promise<boolean>;
  providerFactory?: (s: Settings, secrets: Secrets) => TranslationProvider;
  queueOptions?: Partial<QueueOptions>;
}

/** Settings fingerprint that participates in the cache key. */
export function settingsFingerprint(s: Settings): string {
  return hash53(
    [
      s.provider.kind,
      s.provider.endpoint,
      s.provider.model,
      s.provider.temperature,
      s.provider.kind === 'gemini' && supportsThinkingLevel(s.provider.model) ? 'think:minimal' : '',
      PROMPT_VERSION,
      glossaryVersion(s.glossary),
      'en',
      'vi',
      s.mergeFragments ? 'merge' : 'nomerge',
    ].join('|'),
  );
}

export function cacheKey(fingerprint: string, videoKey: string, text: string): string {
  return `${fingerprint}|${hash53(videoKey)}|${hash53(text.trim().toLowerCase())}:${text.length}`;
}

export class Metrics {
  requests = 0;
  failedRequests = 0;
  retries = 0;
  rateLimited = 0;
  segmentsTranslated = 0;
  cacheHits = 0;
  cacheMisses = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** Cost of tokens with a known model price (USD). */
  estimatedCostUsd = 0;
  pricedModel = true;
  private latencies: number[] = [];

  recordUsage(model: string, input: number, output: number) {
    this.inputTokens += input;
    this.outputTokens += output;
    const c = estimateCostUsd(model, input, output);
    if (c === null) this.pricedModel = false;
    else this.estimatedCostUsd += c;
  }

  recordLatency(ms: number) {
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();
  }

  snapshot(): MetricsSnapshot {
    const avg = this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0;
    return {
      requests: this.requests,
      failedRequests: this.failedRequests,
      retries: this.retries,
      rateLimited: this.rateLimited,
      segmentsTranslated: this.segmentsTranslated,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      avgLatencyMs: Math.round(avg),
      medianLatencyMs: Math.round(percentile(this.latencies, 50)),
      p95LatencyMs: Math.round(percentile(this.latencies, 95)),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUsd: this.pricedModel ? Math.round(this.estimatedCostUsd * 1e6) / 1e6 : null,
    };
  }
}

/** Cache → queue → provider orchestration used by the background worker. */
export class TranslationService {
  readonly metrics = new Metrics();
  readonly queue: TranslationQueue;
  private currentModel = '';
  private writesSincePrune = 0;

  constructor(private readonly deps: ServiceDeps) {
    this.queue = new TranslationQueue({
      ...deps.queueOptions,
      onEvent: (e) => {
        if (e.type === 'request') this.metrics.requests++;
        else if (e.type === 'success') {
          this.metrics.segmentsTranslated += e.size;
          this.metrics.recordLatency(e.latencyMs);
        } else if (e.type === 'retry') this.metrics.retries++;
        else if (e.type === 'rate-limited') this.metrics.rateLimited++;
        else if (e.type === 'failure') this.metrics.failedRequests++;
        else if (e.type === 'usage') this.metrics.recordUsage(this.currentModel, e.usage.inputTokens, e.usage.outputTokens);
        deps.queueOptions?.onEvent?.(e);
      },
    });
  }

  async checkConfig(s: Settings): Promise<void> {
    if (translationIsRemote(s) && !s.consent.remoteTranslation) {
      throw new ConfigError(
        'Chưa cho phép gửi phụ đề tới dịch vụ dịch từ xa. Mở Cài đặt → bật "Cho phép gửi phụ đề" (remote translation consent required).',
      );
    }
    if (s.provider.kind !== 'mock' && this.deps.hasEndpointPermission && !(await this.deps.hasEndpointPermission(s.provider.endpoint))) {
      throw new ConfigError('Chưa cấp quyền truy cập endpoint dịch. Mở Cài đặt và bấm "Lưu" để cấp quyền (host permission missing).');
    }
  }

  async translateUnits(videoKey: string, units: UnitPayload[], context: string[], priority = 2): Promise<UnitResult[]> {
    const settings = await this.deps.getSettings();
    this.currentModel = settings.provider.kind === 'mock' ? 'mock' : settings.provider.model;
    try {
      await this.checkConfig(settings);
    } catch (e) {
      return units.map((u) => ({ id: u.id, error: (e as Error).message, fatal: true }));
    }
    const fp = settingsFingerprint(settings);
    const keyed = units.map((u) => ({ ...u, key: cacheKey(fp, videoKey, u.text) }));
    let hits = new Map<string, string>();
    try {
      hits = await this.deps.cache.getMany(keyed.map((k) => k.key));
    } catch {
      /* cache unavailable → translate anyway */
    }
    const results = new Map<string, UnitResult>();
    const misses = keyed.filter((k) => {
      const vi = hits.get(k.key);
      if (vi !== undefined) {
        results.set(k.id, { id: k.id, vi, cached: true });
        return false;
      }
      return true;
    });
    this.metrics.cacheHits += keyed.length - misses.length;
    this.metrics.cacheMisses += misses.length;

    if (misses.length) {
      const secrets = await this.deps.getSecrets();
      let provider: TranslationProvider;
      try {
        provider = this.deps.providerFactory ? this.deps.providerFactory(settings, secrets) : createProvider(settings.provider, secrets);
      } catch (e) {
        for (const m of misses) results.set(m.id, { id: m.id, error: (e as Error).message, fatal: true });
        return units.map((u) => results.get(u.id)!);
      }
      const out = await this.queue.translate(
        misses.map((m) => ({ key: m.key, text: m.text })),
        {
          provider,
          context: context.slice(-Math.max(0, settings.contextWindow)),
          glossary: parseGlossary(settings.glossary),
          group: videoKey,
          priority,
        },
      );
      const toCache: { key: string; videoKey: string; vi: string }[] = [];
      for (const m of misses) {
        const r = out.get(m.key);
        if (r?.vi !== undefined) {
          results.set(m.id, { id: m.id, vi: r.vi });
          toCache.push({ key: m.key, videoKey, vi: r.vi });
        } else {
          const err = r?.error;
          const fatal = err instanceof ConfigError || (err instanceof HttpError && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 400));
          results.set(m.id, { id: m.id, error: err?.message ?? 'Translation failed', fatal });
        }
      }
      this.deps.cache.putMany(toCache).catch(() => undefined);
      // Bounded cleanup during long sessions too (not only on install/startup).
      this.writesSincePrune += toCache.length;
      if (this.writesSincePrune >= 500) {
        this.writesSincePrune = 0;
        this.deps.cache.prune().catch(() => undefined);
      }
    }
    return units.map((u) => results.get(u.id)!);
  }

  cancel(videoKey: string): void {
    this.queue.cancelGroup(videoKey);
  }
}
