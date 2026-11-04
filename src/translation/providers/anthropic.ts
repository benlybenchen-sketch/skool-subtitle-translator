import Anthropic from '@anthropic-ai/sdk';
import type { BatchRequest, TranslationProvider } from '../types';
import { ConfigError, HttpError, ParseError, parseRetryAfter } from '../errors';
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, parseTranslations } from '../prompt';

export interface AnthropicOptions {
  endpoint: string; // https://api.anthropic.com
  model: string; // default claude-opus-5-5
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Structured output schema (Claude structured outputs require additionalProperties: false). */
const JSON_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { subtitle_id: { type: 'string' }, translated_text: { type: 'string' } },
        required: ['subtitle_id', 'translated_text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

/** Current Claude 5-generation models accept output_config.effort. */
const supportsEffort = (m: string) => /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(m);
/** Server-side refusal fallbacks ("default" form) — not offered for Haiku. */
const supportsFallbacks = (m: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(m);

/**
 * Anthropic Claude via the official SDK (Messages API). Runs in the MV3 service worker, so the
 * SDK's browser guard is acknowledged explicitly (the key is the user's own, see PROVIDERS.md).
 * Retries are handled by the extension's queue (shared 429 cooldown), so SDK retries are off.
 */
export class AnthropicProvider implements TranslationProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly o: AnthropicOptions) {
    if (!o.apiKey) throw new ConfigError('Thiếu API key Anthropic (Cài đặt → Anthropic Claude).');
    this.client = new Anthropic({
      apiKey: o.apiKey,
      baseURL: o.endpoint.replace(/\/+$/, '') || undefined,
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
      ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}),
    });
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const model = this.o.model;
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(req) }],
          output_config: {
            ...(supportsEffort(model) ? { effort: 'low' as const } : {}), // speed-first
            format: { type: 'json_schema', schema: JSON_SCHEMA },
          },
          ...(supportsFallbacks(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: req.signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
        const h = e.headers as { get?: (k: string) => string | null } | undefined;
        const hint = e.status === 401 || e.status === 403 ? ' (check the API key / permissions)' : e.status === 429 ? ' (rate limited)' : '';
        throw new HttpError(e.status, `Anthropic HTTP ${e.status}${hint}: ${e.message.slice(0, 300)}`, parseRetryAfter(h?.get?.('retry-after') ?? null));
      }
      throw e;
    }
    // Anthropic reports uncached input separately from cache reads/writes: normalise to totals.
    const cacheRead = res.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = res.usage.cache_creation_input_tokens ?? 0;
    req.onUsage?.({
      inputTokens: (res.usage.input_tokens ?? 0) + cacheRead + cacheWrite,
      outputTokens: res.usage.output_tokens ?? 0,
      cachedInputTokens: cacheRead || undefined,
      cacheWriteTokens: cacheWrite || undefined,
    });
    if (res.stop_reason === 'refusal') throw new ParseError('Claude declined this batch');
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return parseTranslations(extractJson(text), req.segments.map((s) => s.id));
  }
}
