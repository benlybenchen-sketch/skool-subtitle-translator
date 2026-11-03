export interface GlossaryEntry {
  term: string;
  /** Undefined means "keep the term exactly as written". */
  translation?: string;
}

export interface BatchSegment {
  id: string;
  text: string;
}

export interface BatchRequest {
  segments: BatchSegment[];
  /** Preceding source segments (oldest first) for context only. */
  context: string[];
  glossary: GlossaryEntry[];
  sourceLang: string;
  targetLang: string;
  signal: AbortSignal;
}

/** Returns a map id → translation. Missing IDs are treated as failures. */
export interface TranslationProvider {
  readonly id: string;
  translateBatch(req: BatchRequest): Promise<Record<string, string>>;
}
