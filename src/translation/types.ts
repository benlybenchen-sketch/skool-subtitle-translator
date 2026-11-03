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
  inputTokens: number;
  /** Output tokens including any thinking tokens (billed as output). */
  outputTokens: number;
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
