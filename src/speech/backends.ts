import type { Secrets, SttSettings } from '../shared/types';
import type { SttBackend, SttRequest, SttResult } from './types';
import { ConfigError, ensureOk } from '../translation/errors';

/**
 * OpenAI-compatible `/audio/transcriptions` (OpenAI Whisper API,
 * faster-whisper-server / speaches, LocalAI, Groq, …).
 */
export class OpenAICompatibleStt implements SttBackend {
  readonly id = 'openai-stt';
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!endpoint) throw new ConfigError('STT endpoint is not configured');
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    const form = new FormData();
    form.append('file', new Blob([req.wav as BlobPart], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', this.model);
    form.append('language', req.language);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (req.prompt) form.append('prompt', req.prompt.slice(-200));
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(this.endpoint.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers,
      body: form,
      signal: req.signal,
    });
    await ensureOk(res, 'STT');
    const data = (await res.json()) as { text?: string; segments?: SttResult['segments'] };
    return { text: (data.text ?? '').trim(), segments: data.segments };
  }
}

/** Repository's local server: POST {endpoint}/transcribe with a raw WAV body. */
export class LocalServerStt implements SttBackend {
  readonly id = 'local-stt';
  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!endpoint) throw new ConfigError('Local STT endpoint is not configured');
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    const headers: Record<string, string> = { 'Content-Type': 'audio/wav', 'X-Language': req.language };
    if (req.prompt) headers['X-Prompt'] = encodeURIComponent(req.prompt.slice(-200));
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(this.endpoint.replace(/\/+$/, '') + '/transcribe', {
      method: 'POST',
      headers,
      body: req.wav as BodyInit,
      signal: req.signal,
    });
    await ensureOk(res, 'Local STT');
    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? '').trim() };
  }
}

/** Offline backend for demos/tests. */
export class MockStt implements SttBackend {
  readonly id = 'mock-stt';
  private n = 0;
  async transcribe(): Promise<SttResult> {
    this.n++;
    return { text: `This is mock speech segment number ${this.n}.` };
  }
}

export function createSttBackend(cfg: SttSettings, secrets: Secrets, fetchImpl?: typeof fetch): SttBackend {
  switch (cfg.kind) {
    case 'openai':
      return new OpenAICompatibleStt(cfg.endpoint, cfg.model, secrets.sttApiKey, fetchImpl);
    case 'local':
      return new LocalServerStt(cfg.endpoint, secrets.sttApiKey, fetchImpl);
    default:
      return new MockStt();
  }
}
