import type { Secrets, TranslationProviderSettings } from '../../shared/types';
import type { TranslationProvider } from '../types';
import { GeminiProvider } from './gemini';
import { LocalHttpProvider } from './local';
import { MockProvider } from './mock';
import { OpenAICompatibleProvider } from './openai';

export function createProvider(cfg: TranslationProviderSettings, secrets: Secrets, fetchImpl?: typeof fetch): TranslationProvider {
  const apiKey = secrets.translationApiKey;
  switch (cfg.kind) {
    case 'openai':
      return new OpenAICompatibleProvider({ endpoint: cfg.endpoint, model: cfg.model, apiKey, temperature: cfg.temperature, fetchImpl });
    case 'gemini':
      return new GeminiProvider({ endpoint: cfg.endpoint, model: cfg.model, apiKey, temperature: cfg.temperature, fetchImpl });
    case 'local':
      return new LocalHttpProvider({ endpoint: cfg.endpoint, model: cfg.model, apiKey, fetchImpl });
    case 'mock':
    default:
      return new MockProvider(150);
  }
}
