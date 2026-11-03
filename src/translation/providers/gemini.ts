import type { BatchRequest, TranslationProvider } from '../types';
import { ConfigError, ensureOk } from '../errors';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, extractJson, parseTranslations } from '../prompt';

/** Gemini 3.x models accept thinkingConfig.thinkingLevel; older ones may reject it. */
export const supportsThinkingLevel = (model: string) => /^(models\/)?gemini-3/i.test(model);

export interface GeminiOptions {
  endpoint: string; // https://generativelanguage.googleapis.com/v1beta
  model: string;
  apiKey?: string;
  temperature: number;
  fetchImpl?: typeof fetch;
}

/** Google Gemini `generateContent` REST API (or a compatible gateway). */
export class GeminiProvider implements TranslationProvider {
  readonly id = 'gemini';
  constructor(private readonly o: GeminiOptions) {
    if (!o.endpoint) throw new ConfigError('Gemini endpoint is not configured');
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const f = this.o.fetchImpl ?? fetch;
    const model = this.o.model.replace(/^models\//, '');
    const url = `${this.o.endpoint.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.apiKey) headers['x-goog-api-key'] = this.o.apiKey;
    const res = await f(url, {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(req) }] }],
        generationConfig: {
          temperature: this.o.temperature,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          // Speed-first: minimal thinking (default for 3.5 Flash-Lite; sent explicitly).
          ...(supportsThinkingLevel(model) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
        },
      }),
    });
    await ensureOk(res, 'Gemini');
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
    const u = data.usageMetadata;
    if (u) req.onUsage?.({ inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) });
    if (data.promptFeedback?.blockReason) throw new ConfigError(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return parseTranslations(extractJson(text), req.segments.map((s) => s.id));
  }
}
