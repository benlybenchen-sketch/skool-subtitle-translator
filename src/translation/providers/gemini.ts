import type { BatchRequest, TranslationProvider } from '../types';
import { ConfigError, ensureOk } from '../errors';
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, parseTranslations } from '../prompt';

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
        generationConfig: { temperature: this.o.temperature, responseMimeType: 'application/json' },
      }),
    });
    await ensureOk(res, 'Gemini');
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    if (data.promptFeedback?.blockReason) throw new ConfigError(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return parseTranslations(extractJson(text), req.segments.map((s) => s.id));
  }
}
