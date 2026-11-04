export interface GlossaryEntry {
  term: string;
  /** Undefined means "keep the term exactly as written". */
  translation?: string;
}

export interface BatchSegment {
  id: string;
  text: string;
}

export interface TokenUsage {
  /** All input tokens of the request (cached ones included). */
  inputTokens: number;
  /** Output tokens including any thinking/reasoning tokens (billed as output). */
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (subset of inputTokens). */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache (subset of inputTokens; Anthropic). */
  cacheWriteTokens?: number;
  /** Reasoning/thinking tokens (subset of outputTokens), when reported. */
  reasoningTokens?: number;
  /** true = the provider reported no usage; counts were estimated from text length. */
  estimated?: boolean;
}

export interface BatchRequest {
  segments: BatchSegment[];
  /** Preceding source segments (oldest first) for context only. */
  context: string[];
  glossary: GlossaryEntry[];
  sourceLang: string;
  targetLang: string;
  signal: AbortSignal;
  /** Providers report token usage here when the API returns it. */
  onUsage?: (u: TokenUsage) => void;
}

/** Returns a map id → translation. Missing IDs are treated as failures. */
export interface TranslationProvider {
  readonly id: string;
  translateBatch(req: BatchRequest): Promise<Record<string, string>>;
}
