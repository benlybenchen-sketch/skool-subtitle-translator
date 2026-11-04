import type { BatchSegment, GlossaryEntry, TokenUsage, TranslationProvider } from './types';
import { ConfigError, HttpError, ParseError } from './errors';
import { abortError, isAbortError, sleep as defaultSleep } from '../shared/util';
import { relevantGlossary } from './glossary';

export interface QueueItem {
  /** Cache/dedupe key. Identical keys are translated once. */
  key: string;
  text: string;
}

export interface QueueContext {
  provider: TranslationProvider;
  context: string[];
  glossary: GlossaryEntry[];
  /** Group (video) — all jobs of a group can be cancelled together. */
  group: string;
  sourceLang?: string;
  targetLang?: string;
  /** 1 = needed now … 4 = background. Lower numbers get free request slots first. */
  priority?: number;
}

export type QueueEvent =
  | { type: 'request'; size: number }
  | { type: 'success'; size: number; latencyMs: number }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  | { type: 'rate-limited'; delayMs: number }
  | { type: 'failure'; size: number; reason: string }
  | { type: 'usage'; usage: TokenUsage };

export interface QueueOptions {
  concurrency: number;
  maxBatchItems: number;
  maxBatchChars: number;
  minBatchChars: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
  onEvent?: (e: QueueEvent) => void;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  concurrency: 2,
  maxBatchItems: 24,
  maxBatchChars: 2600,
  minBatchChars: 200,
  maxRetries: 4,
  baseDelayMs: 800,
  maxDelayMs: 20_000,
  timeoutMs: 45_000,
  sleep: defaultSleep,
  random: Math.random,
  now: () => Date.now(),
};

export interface ItemResult {
  vi?: string;
  error?: Error;
}

/**
 * Translation job queue:
 * - request deduplication (same key in flight → shared promise)
 * - adaptive batching by character budget (shrinks on parse failures/timeouts, grows on success)
 * - concurrency limit
 * - exponential backoff with jitter, honouring Retry-After on HTTP 429
 * - per-group cancellation with AbortController
 */
export class TranslationQueue {
  readonly opts: QueueOptions;
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly groups = new Map<string, AbortController>();
  private active = 0;
  private readonly waiters: { priority: number; seq: number; wake: () => void }[] = [];
  private waiterSeq = 0;
  /** After an HTTP 429, NO request is sent until this time (shared by all batches/tabs). */
  private cooldownUntil = 0;

  get rateLimitedForMs(): number {
    return Math.max(0, this.cooldownUntil - this.opts.now());
  }
  private budget: number;

  constructor(opts: Partial<QueueOptions> = {}) {
    this.opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
    this.budget = this.opts.maxBatchChars;
  }

  get batchBudget(): number {
    return this.budget;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  cancelGroup(group: string): void {
    this.groups.get(group)?.abort();
    this.groups.delete(group);
  }

  private groupSignal(group: string): AbortSignal {
    let c = this.groups.get(group);
    if (!c || c.signal.aborted) {
      c = new AbortController();
      this.groups.set(group, c);
    }
    return c.signal;
  }

  async translate(items: QueueItem[], ctx: QueueContext): Promise<Map<string, ItemResult>> {
    const signal = this.groupSignal(ctx.group);
    const waits = new Map<string, Promise<string>>();
    const fresh: QueueItem[] = [];
    for (const it of items) {
      if (waits.has(it.key)) continue;
      const existing = this.inflight.get(it.key);
      if (existing) waits.set(it.key, existing);
      else {
        fresh.push(it);
        waits.set(it.key, null as unknown as Promise<string>); // placeholder, filled below
      }
    }

    for (const batch of this.makeBatches(fresh)) {
      const deferreds = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
      for (const it of batch) {
        const p = new Promise<string>((resolve, reject) => deferreds.set(it.key, { resolve, reject }));
        p.catch(() => undefined); // handled by caller via allSettled
        this.inflight.set(it.key, p);
        waits.set(it.key, p);
        p.finally(() => {
          if (this.inflight.get(it.key) === p) this.inflight.delete(it.key);
        }).catch(() => undefined);
      }
      void this.runBatch(batch, ctx, signal, 0)
        .then((res) => {
          for (const it of batch) {
            const d = deferreds.get(it.key)!;
            const r = res.get(it.key);
            if (r?.vi !== undefined) d.resolve(r.vi);
            else d.reject(r?.error ?? new Error('Translation missing'));
          }
        })
        .catch((e: Error) => {
          for (const d of deferreds.values()) d.reject(e);
        });
    }

    const out = new Map<string, ItemResult>();
    await Promise.all(
      [...waits.entries()].map(async ([key, p]) => {
        try {
          out.set(key, { vi: await p });
        } catch (e) {
          out.set(key, { error: e as Error });
        }
      }),
    );
    return out;
  }

  private makeBatches(items: QueueItem[]): QueueItem[][] {
    const batches: QueueItem[][] = [];
    let cur: QueueItem[] = [];
    let chars = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= this.opts.maxBatchItems || chars + it.text.length > this.budget)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(it);
      chars += it.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  private async acquire(signal: AbortSignal, priority: number): Promise<void> {
    // Global rate-limit cooldown: waiting here (instead of each batch retrying on its own
    // schedule) stops a 429 storm from burning more quota.
    const wait = this.rateLimitedForMs;
    if (wait > 0) await this.opts.sleep(wait, signal); // single bounded wait (no spin)
    while (this.active >= this.opts.concurrency) {
      await new Promise<void>((wake) => this.waiters.push({ priority, seq: this.waiterSeq++, wake }));
      if (signal.aborted) throw abortError();
    }
    this.active++;
  }

  /** Wake the most urgent waiter (lowest priority number, then FIFO). */
  private release(): void {
    this.active--;
    if (!this.waiters.length) return;
    let best = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const b = this.waiters[best];
      if (w.priority < b.priority || (w.priority === b.priority && w.seq < b.seq)) best = i;
    }
    this.waiters.splice(best, 1)[0].wake();
  }

  private async runBatch(
    batch: QueueItem[],
    ctx: QueueContext,
    signal: AbortSignal,
    attempt: number,
  ): Promise<Map<string, ItemResult>> {
    if (signal.aborted) throw abortError();
    await this.acquire(signal, ctx.priority ?? 2);
    const started = Date.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.opts.timeoutMs);
    const combined = anySignal([signal, timeout.signal]);
    const segments: BatchSegment[] = batch.map((it, i) => ({ id: 's' + i, text: it.text }));
    let error: unknown;
    let raw: Record<string, string> | undefined;
    try {
      this.opts.onEvent?.({ type: 'request', size: batch.length });
      raw = await ctx.provider.translateBatch({
        segments,
        context: ctx.context,
        glossary: relevantGlossary(ctx.glossary, batch.map((b) => b.text)),
        sourceLang: ctx.sourceLang ?? 'en',
        targetLang: ctx.targetLang ?? 'vi',
        signal: combined,
        onUsage: (usage) => this.opts.onEvent?.({ type: 'usage', usage }),
      });
    } catch (e) {
      error = timeout.signal.aborted && !signal.aborted ? Object.assign(new Error('Translation request timed out'), { name: 'TimeoutError' }) : e;
    } finally {
      clearTimeout(timer);
      this.release();
    }

    if (raw) {
      const out = new Map<string, ItemResult>();
      const missing: QueueItem[] = [];
      batch.forEach((it, i) => {
        const v = raw![segments[i].id];
        if (typeof v === 'string' && v.trim()) out.set(it.key, { vi: v.trim() });
        else missing.push(it);
      });
      this.opts.onEvent?.({ type: 'success', size: batch.length - missing.length, latencyMs: Date.now() - started });
      if (!missing.length) {
        this.budget = Math.min(this.opts.maxBatchChars, Math.round(this.budget * 1.25));
        return out;
      }
      // Model skipped some segments: retry them on their own (smaller batch).
      if (attempt < this.opts.maxRetries) {
        const retried = await this.retryLater(missing, ctx, signal, attempt, new ParseError('Model omitted segments'));
        for (const [k, v] of retried) out.set(k, v);
      } else for (const m of missing) out.set(m.key, { error: new ParseError('Model omitted this segment') });
      return out;
    }

    if (signal.aborted || (isAbortError(error) && (error as Error).name === 'AbortError')) throw abortError();
    const err = error as Error;
    const retryable =
      (err instanceof HttpError && err.retryable) ||
      err instanceof ParseError ||
      err.name === 'TimeoutError' ||
      err instanceof TypeError; // fetch network failure
    if (!retryable || err instanceof ConfigError || attempt >= this.opts.maxRetries) {
      this.opts.onEvent?.({ type: 'failure', size: batch.length, reason: err.message });
      const out = new Map<string, ItemResult>();
      for (const it of batch) out.set(it.key, { error: err });
      return out;
    }
    if (err instanceof ParseError || err.name === 'TimeoutError') {
      this.budget = Math.max(this.opts.minBatchChars, Math.round(this.budget / 2));
    }
    return this.retryLater(batch, ctx, signal, attempt, err);
  }

  private async retryLater(
    batch: QueueItem[],
    ctx: QueueContext,
    signal: AbortSignal,
    attempt: number,
    err: Error,
  ): Promise<Map<string, ItemResult>> {
    let delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** attempt) * (0.75 + this.opts.random() * 0.5);
    if (err instanceof HttpError && err.status === 429) {
      if (err.retryAfterMs !== undefined) delay = Math.min(this.opts.maxDelayMs * 3, err.retryAfterMs);
      this.cooldownUntil = Math.max(this.cooldownUntil, this.opts.now() + delay);
      this.opts.onEvent?.({ type: 'rate-limited', delayMs: delay });
    }
    delay = Math.round(delay);
    this.opts.onEvent?.({ type: 'retry', attempt: attempt + 1, delayMs: delay, reason: err.message });
    // 429: the shared cooldown (in acquire) is the wait — for this and every other batch.
    if (!(err instanceof HttpError && err.status === 429)) await this.opts.sleep(delay, signal);
    // Split large batches that failed to parse into halves.
    if ((err instanceof ParseError || err.name === 'TimeoutError') && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const [a, b] = await Promise.all([
        this.runBatch(batch.slice(0, mid), ctx, signal, attempt + 1),
        this.runBatch(batch.slice(mid), ctx, signal, attempt + 1),
      ]);
      return new Map([...a, ...b]);
    }
    return this.runBatch(batch, ctx, signal, attempt + 1);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      break;
    }
    s.addEventListener('abort', () => c.abort(), { once: true });
  }
  return c.signal;
}
