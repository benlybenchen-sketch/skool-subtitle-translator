export interface SttResult {
  text: string;
  /** Segment timestamps relative to the chunk start, when the backend provides them. */
  segments?: { start: number; end: number; text: string }[];
}

export interface SttRequest {
  wav: Uint8Array;
  /** Previous transcript tail, improves continuity across chunks. */
  prompt?: string;
  language: string;
  signal: AbortSignal;
}

export interface SttBackend {
  readonly id: string;
  transcribe(req: SttRequest): Promise<SttResult>;
}
