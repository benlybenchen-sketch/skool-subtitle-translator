/**
 * Locally controlled translation + speech-to-text backend for the extension.
 * Secrets stay in environment variables on YOUR machine; the extension only
 * talks to http://127.0.0.1:8787.
 *
 *   POST /translate   { segments:[{id,text}], context:[], glossary:[] } → { translations:[{id,text}] }
 *   POST /complete    { system, user, schema, maxTokens } → { text, usage }   (AI Study Notes)
 *   POST /transcribe  raw audio/wav body → { text }
 *   GET  /health
 *
 * Environment:
 *   PORT=8787 HOST=127.0.0.1 LOCAL_TOKEN=(optional bearer token)
 *   TRANSLATE_BACKEND=openai|gemini|mock
 *   OPENAI_API_KEY, OPENAI_BASE_URL (default https://api.openai.com/v1; Ollama: http://localhost:11434/v1), OPENAI_MODEL
 *   GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.5-flash-lite)
 *   STT_BASE_URL (OpenAI-compatible, default OPENAI_BASE_URL), STT_API_KEY (default OPENAI_API_KEY), STT_MODEL (default whisper-1)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OpenAICompatibleProvider } from '../src/translation/providers/openai';
import { GeminiProvider } from '../src/translation/providers/gemini';
import { MockProvider } from '../src/translation/providers/mock';
import type { TranslationProvider, GlossaryEntry, TokenUsage } from '../src/translation/types';
import { canComplete } from '../src/translation/types';
import { OpenAICompatibleStt, MockStt } from '../src/speech/backends';
import type { SttBackend } from '../src/speech/types';
import { HttpError } from '../src/translation/errors';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? '127.0.0.1';
const TOKEN = env.LOCAL_TOKEN;
const OPENAI_BASE = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

function pickTranslator(): TranslationProvider {
  const kind = env.TRANSLATE_BACKEND ?? (env.GEMINI_API_KEY && !env.OPENAI_API_KEY ? 'gemini' : env.OPENAI_API_KEY || env.OPENAI_BASE_URL ? 'openai' : 'mock');
  if (kind === 'gemini')
    return new GeminiProvider({
      endpoint: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
      model: env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
      apiKey: env.GEMINI_API_KEY,
      temperature: 0.2,
    });
  if (kind === 'openai')
    return new OpenAICompatibleProvider({ endpoint: OPENAI_BASE, model: env.OPENAI_MODEL ?? 'gpt-4o-mini', apiKey: env.OPENAI_API_KEY, temperature: 0.2 });
  console.warn('[local-server] No translation backend configured → MOCK translations. Set OPENAI_API_KEY, GEMINI_API_KEY or OPENAI_BASE_URL.');
  return new MockProvider();
}

function pickStt(): SttBackend {
  const base = env.STT_BASE_URL ?? (env.OPENAI_API_KEY ? OPENAI_BASE : undefined);
  if (!base || env.STT_BACKEND === 'mock') {
    console.warn('[local-server] No STT backend configured → MOCK transcripts. Set STT_BASE_URL (e.g. a faster-whisper server) or OPENAI_API_KEY.');
    return new MockStt();
  }
  return new OpenAICompatibleStt(base, env.STT_MODEL ?? 'whisper-1', env.STT_API_KEY ?? env.OPENAI_API_KEY);
}

const translator = pickTranslator();
const stt = pickStt();

function allowedOrigin(req: IncomingMessage): string | null | false {
  const origin = req.headers.origin;
  if (!origin) return null; // extension service worker fetches may omit Origin
  if (origin.startsWith('chrome-extension://')) return origin;
  return false; // refuse websites: they must not spend your API quota
}

function send(res: ServerResponse, status: number, body: unknown, origin: string | null): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (origin === false) return send(res, 403, { error: 'Origin not allowed' }, null);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin ?? '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Language, X-Prompt',
    });
    return res.end();
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Unauthorized' }, origin);
  const ac = new AbortController();
  req.on('close', () => !res.writableEnded && ac.abort());
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, translator: translator.id, stt: stt.id }, origin);
    }
    if (req.method === 'POST' && req.url === '/translate') {
      const body = JSON.parse((await readBody(req, 1_000_000)).toString('utf8')) as {
        segments?: { id: string; text: string }[];
        context?: string[];
        glossary?: GlossaryEntry[];
        source?: string;
        target?: string;
      };
      const segments = (body.segments ?? []).filter((s) => s && typeof s.id === 'string' && typeof s.text === 'string').slice(0, 64);
      const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
      const out = await translator.translateBatch({
        onUsage: (u) => {
          usage.inputTokens += u.inputTokens;
          usage.outputTokens += u.outputTokens;
          usage.cachedInputTokens += u.cachedInputTokens ?? 0;
          usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
          usage.reasoningTokens += u.reasoningTokens ?? 0;
        },
        segments,
        context: (body.context ?? []).slice(-8),
        glossary: (body.glossary ?? []).slice(0, 200),
        sourceLang: body.source ?? 'en',
        targetLang: body.target ?? 'vi',
        signal: ac.signal,
      });
      return send(res, 200, { translations: Object.entries(out).map(([id, text]) => ({ subtitle_id: id, translated_text: text })), usage }, origin);
    }
    if (req.method === 'POST' && req.url === '/complete') {
      const body = JSON.parse((await readBody(req, 2_000_000)).toString('utf8')) as { system?: string; user?: string; schema?: Record<string, unknown>; maxTokens?: number };
      if (!canComplete(translator)) return send(res, 501, { error: 'Backend does not support /complete' }, origin);
      let usage: TokenUsage | undefined;
      const text = await translator.complete({
        system: String(body.system ?? '').slice(0, 20_000),
        user: String(body.user ?? '').slice(0, 600_000),
        schema: body.schema ?? {},
        maxTokens: Math.min(16_000, Math.max(256, Number(body.maxTokens) || 4000)),
        signal: ac.signal,
        onUsage: (u) => (usage = u),
      });
      return send(res, 200, { text, usage }, origin);
    }
    if (req.method === 'POST' && req.url === '/transcribe') {
      const wav = await readBody(req, 15_000_000);
      const prompt = req.headers['x-prompt'] ? decodeURIComponent(String(req.headers['x-prompt'])) : undefined;
      const r = await stt.transcribe({ wav: new Uint8Array(wav), language: String(req.headers['x-language'] ?? 'en'), prompt, signal: ac.signal });
      return send(res, 200, { text: r.text }, origin);
    }
    return send(res, 404, { error: 'Not found' }, origin);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error('[local-server]', (e as Error).message);
    const headers: Record<string, string> = {};
    if (e instanceof HttpError && e.retryAfterMs) headers['Retry-After'] = String(Math.ceil(e.retryAfterMs / 1000));
    res.setHeader('Retry-After', headers['Retry-After'] ?? '');
    return send(res, status, { error: (e as Error).message }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[local-server] listening on http://${HOST}:${PORT} — translator=${translator.id}, stt=${stt.id}`);
});
