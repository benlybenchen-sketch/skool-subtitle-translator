import type { BatchRequest, CompleteRequest, TokenUsage, TranslationProvider } from '../types';
import { ConfigError, ensureOk } from '../errors';
import { parseTranslations } from '../prompt';

export interface LocalOptions {
  endpoint: string; // http://localhost:8787
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Locally controlled HTTP backend (see server/ in the repository).
 * POST {endpoint}/translate
 *   { source, target, model, segments:[{id,text}], context:[string], glossary:[{term,translation?}] }
 * → { translations:[{id,text}] }
 */
export class LocalHttpProvider implements TranslationProvider {
  readonly id = 'local';
  constructor(private readonly o: LocalOptions) {
    if (!o.endpoint) throw new ConfigError('Local backend endpoint is not configured');
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const f = this.o.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await f(this.o.endpoint.replace(/\/+$/, '') + '/translate', {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({
        source: req.sourceLang,
        target: req.targetLang,
        model: this.o.model,
        segments: req.segments,
        context: req.context,
        glossary: req.glossary,
        ...(req.format === 'markup' ? { format: 'markup' } : {}),
      }),
    });
    await ensureOk(res, 'Local backend');
    const data = (await res.json()) as { usage?: TokenUsage };
    if (data.usage && (data.usage.inputTokens || data.usage.outputTokens)) req.onUsage?.({ ...data.usage });
    return parseTranslations(data, req.segments.map((s) => s.id));
  }

  /** POST {endpoint}/complete { system, user, schema, maxTokens, model } → { text, usage? } */
  async complete(req: CompleteRequest): Promise<string> {
    const f = this.o.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await f(this.o.endpoint.replace(/\/+$/, '') + '/complete', {
      method: 'POST',
      headers,
      signal: req.signal,
      body: JSON.stringify({ system: req.system, user: req.user, schema: req.schema, maxTokens: req.maxTokens, model: this.o.model }),
    });
    await ensureOk(res, 'Local backend');
    const data = (await res.json()) as { text?: string; usage?: TokenUsage };
    if (data.usage && (data.usage.inputTokens || data.usage.outputTokens)) req.onUsage?.({ ...data.usage });
    return data.text ?? '';
  }
}
