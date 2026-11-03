import type { BatchRequest, TranslationProvider } from '../types';
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
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseTranslations(extractJson(content), req.segments.map((s) => s.id));
  }
}
