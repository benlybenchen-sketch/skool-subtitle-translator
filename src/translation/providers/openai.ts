import type { BatchRequest, CompleteRequest, TokenUsage, TranslationProvider } from '../types';
import { ConfigError, ensureOk } from '../errors';
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, parseTranslations } from '../prompt';

export interface OpenAIOptions {
  endpoint: string; // e.g. https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama)
  model: string;
  apiKey?: string;
  temperature: number;
  fetchImpl?: typeof fetch;
}

/** Any OpenAI-compatible Chat Completions API (OpenAI, Azure-compatible gateways, Ollama, LM Studio, vLLM…). */
export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id = 'openai';
  constructor(private readonly o: OpenAIOptions) {
    if (!o.endpoint) throw new ConfigError('OpenAI-compatible endpoint is not configured');
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const f = this.o.fetchImpl ?? fetch;
    const url = this.o.endpoint.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await f(url, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({
        model: this.o.model,
        temperature: this.o.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(req) },
        ],
      }),
    });
    await ensureOk(res, 'OpenAI-compatible');
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const u = data.usage;
    if (u)
      req.onUsage?.({
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens || undefined,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens || undefined,
      });
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseTranslations(extractJson(content), req.segments.map((s) => s.id));
  }

  /** Structured generation (AI Study Notes): same model, JSON object reply, bounded output. */
  async complete(req: CompleteRequest): Promise<string> {
    const f = this.o.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await f(this.o.endpoint.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({
        model: this.o.model,
        temperature: Math.min(this.o.temperature, 0.4),
        max_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });
    await ensureOk(res, 'OpenAI-compatible');
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    if (data.usage) {
      const u: TokenUsage = {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
        cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens || undefined,
      };
      req.onUsage?.(u);
    }
    return data.choices?.[0]?.message?.content ?? '';
  }
}
