import type { Transcript, TranscriptCoverage } from '../transcript/model';
import { fmtClock } from '../transcript/model';
import { hash53 } from '../shared/hash';
import { extractJson } from '../translation/prompt';
import { NOTES_PROMPT_VERSION, NOTES_SCHEMA, coerceNotes, emptyNotes, type StudyNotes } from './schema';

/** One structured generation call (the background routes it through the low-priority queue). */
export type CompleteFn = (req: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; label: string }) => Promise<string>;

export interface NotesBudget {
  /** Transcript characters sent in a single call (above → hierarchical). */
  singleCallChars: number;
  /** Target characters per chunk. */
  chunkChars: number;
  /** Maximum number of chunks (chunk size grows instead). */
  maxChunks: number;
  /** Hard cap on transcript characters used at all (rest is reported as truncated). */
  maxTotalChars: number;
  /** Partial notes merged per merge call. */
  mergeFanIn: number;
  chunkOutputTokens: number;
  finalOutputTokens: number;
}

export const DEFAULT_BUDGET: NotesBudget = {
  singleCallChars: 24_000,
  chunkChars: 14_000,
  maxChunks: 16,
  maxTotalChars: 400_000,
  mergeFanIn: 6,
  chunkOutputTokens: 3_000,
  finalOutputTokens: 8_000,
};

export const NOTES_SYSTEM = `You write study notes for ONE lesson of an online course the learner is enrolled in (marketing, digital advertising, e-commerce, software, business, AI and automation).

Rules:
- Write every note in natural, clear Vietnamese.
- Use ONLY information stated in the provided lesson content. Never add facts, numbers, tools, examples, opinions or claims that are not in it. If a section has no supporting content, return an empty string or empty array for it.
- Keep technical names, product names, code, URLs, commands and meaningful English terms exactly as written (e.g. Mass Desire, Market Awareness, VOC, Psychographics, Research Framework, Hook, MSL, Ad Creative, AI Agent, Workflow) and explain them in Vietnamese as the instructor uses them.
- "refs": cite 1–3 labels (like "S12") copied EXACTLY from the lesson lines that support the item. Never invent labels. Use [] when unsure.
- "terminology": term as written, "vi" = short Vietnamese equivalent (or the same term if it is normally kept in English), "explanation" in Vietnamese.
- "moments": the most important points in lesson order, each with refs.
- Return ONLY a JSON object with exactly these keys: title, summary, objectives[], concepts[{term,explanation,refs[]}], insights[{text,refs[]}], steps[{text,refs[]}], terminology[{term,vi,explanation}], takeaways[{text,refs[]}], checklist[], moments[{text,refs[]}].`;

export interface SourceLine {
  label: string;
  /** Canonical segment id the label maps to. */
  id: string;
  start: number | null;
  text: string;
}

/** Prompt lines with short labels: "[S12 3:05] text" (video) or "[P3] text" (text lesson). */
export function sourceLines(t: Transcript): SourceLine[] {
  const video = t.kind === 'video';
  return [...t.segments]
    .sort((a, b) => a.start - b.start)
    .filter((s) => s.en.trim())
    .map((s, i) => ({ label: `${video ? 'S' : 'P'}${i + 1}`, id: s.id, start: video ? s.start : null, text: s.en.replace(/\s+/g, ' ').trim() }));
}

const fmtLine = (l: SourceLine) => `[${l.label}${l.start !== null ? ' ' + fmtClock(l.start) : ''}] ${l.text}`;

/** Greedy, deterministic chunking on line boundaries (earlier chunks stay stable as the transcript grows). */
export function chunkLines(lines: SourceLine[], b: NotesBudget): { chunks: SourceLine[][]; truncated: boolean } {
  let used = 0;
  let truncated = false;
  const kept: SourceLine[] = [];
  for (const l of lines) {
    const n = l.text.length + 14;
    if (used + n > b.maxTotalChars) {
      truncated = true;
      break;
    }
    used += n;
    kept.push(l);
  }
  if (used <= b.singleCallChars) return { chunks: kept.length ? [kept] : [], truncated };
  const size = Math.max(b.chunkChars, Math.ceil(used / b.maxChunks));
  const chunks: SourceLine[][] = [];
  let cur: SourceLine[] = [];
  let len = 0;
  for (const l of kept) {
    const n = l.text.length + 14;
    if (cur.length && len + n > size) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(l);
    len += n;
  }
  if (cur.length) chunks.push(cur);
  return { chunks, truncated };
}

function coverageNote(t: Transcript): string {
  const c = t.coverage;
  if (c.state === 'complete') return '';
  if (t.kind === 'video')
    return `IMPORTANT: only part of the lesson transcript is available (up to ${fmtClock(c.sourceUntilSec)}${c.durationSec ? ` of ${fmtClock(c.durationSec)}` : ''}). Describe ONLY what is covered; do not present it as the whole lesson.`;
  return 'IMPORTANT: only part of the lesson text is available. Describe ONLY what is covered.';
}

const glossaryNote = (g: string) => (g.trim() ? `\nPreferred Vietnamese terminology (term = Vietnamese; "=" alone keeps the English term):\n${g.trim().slice(0, 3000)}\n` : '');

function chunkPrompt(t: Transcript, chunk: SourceLine[], i: number, n: number, glossary: string): string {
  return [
    `Lesson title: ${t.title}`,
    coverageNote(t),
    glossaryNote(glossary),
    n > 1 ? `Lesson content, part ${i + 1} of ${n} (extract notes for THIS part only; the summary covers this part only):` : 'Lesson content:',
    ...chunk.map(fmtLine),
  ]
    .filter(Boolean)
    .join('\n');
}

export const MERGE_MARKER = '<<PARTIAL_NOTES_JSON>>';

function mergePrompt(t: Transcript, partials: StudyNotes[], glossary: string): string {
  return [
    `Lesson title: ${t.title}`,
    coverageNote(t),
    glossaryNote(glossary),
    'Below are study notes extracted from consecutive parts of the SAME lesson, in lesson order (JSON array).',
    'Merge them into ONE coherent learning document: deduplicate repeated points, keep the practical steps in order with their technical details, write a concise summary of all the available content, and keep the refs of the items you use (only labels that appear below). Do not add anything that is not in these notes.',
    MERGE_MARKER,
    JSON.stringify(partials),
  ]
    .filter(Boolean)
    .join('\n');
}

export interface GenerateArgs {
  transcript: Transcript;
  glossary: string;
  complete: CompleteFn;
  /** provider|model fingerprint; part of the intermediate-result keys. */
  fingerprint: string;
  /** Intermediate results from earlier runs (key → partial notes, with prompt labels). */
  previousChunks?: Record<string, StudyNotes>;
  budget?: Partial<NotesBudget>;
  onProgress?: (done: number, total: number, phase: 'chunk' | 'merge') => void;
}

export interface GenerateResult {
  notes: StudyNotes;
  /** Segment id → start (s) for every ref kept (video lessons only). */
  refStarts: Record<string, number>;
  chunks: Record<string, StudyNotes>;
  calls: number;
  reusedChunks: number;
  truncated: boolean;
  coverage: TranscriptCoverage;
  transcriptVersion: string;
}

/**
 * Grounded, hierarchical study-note generation:
 * short lesson → one call; long lesson → per-chunk notes (cached) → merge (fan-in bounded)
 * → final notes. Refs are validated against the labels actually sent.
 */
export async function generateNotes(a: GenerateArgs): Promise<GenerateResult> {
  const b = { ...DEFAULT_BUDGET, ...a.budget };
  const t = a.transcript;
  const lines = sourceLines(t);
  if (!lines.length) throw new Error('Không có nội dung bài học để tạo ghi chú.');
  const byLabel = new Map(lines.map((l) => [l.label, l]));
  const keepLabel = (label: string) => (byLabel.has(label) ? label : null);
  const { chunks, truncated } = chunkLines(lines, b);
  const chunksOut: Record<string, StudyNotes> = {};
  let calls = 0;
  let reused = 0;
  const total = chunks.length > 1 ? chunks.length + Math.ceil(chunks.length / b.mergeFanIn) + (chunks.length > b.mergeFanIn ? 1 : 0) : 1;
  let done = 0;
  const step = (phase: 'chunk' | 'merge') => a.onProgress?.(++done, total, phase);
  const run = async (user: string, maxTokens: number, label: string): Promise<StudyNotes> => {
    calls++;
    const text = await a.complete({ system: NOTES_SYSTEM, user, schema: NOTES_SCHEMA, maxTokens, label });
    return coerceNotes(extractJson(text), keepLabel, t.title);
  };

  let level: StudyNotes[];
  if (chunks.length === 1) {
    level = [await run(chunkPrompt(t, chunks[0], 0, 1, a.glossary), b.finalOutputTokens, 'notes')];
    step('chunk');
  } else {
    level = [];
    for (let i = 0; i < chunks.length; i++) {
      const user = chunkPrompt(t, chunks[i], i, chunks.length, a.glossary);
      const key = hash53([a.fingerprint, NOTES_PROMPT_VERSION, t.coverage.state, user].join('|'));
      let part = a.previousChunks?.[key];
      if (part) reused++;
      else part = await run(user, b.chunkOutputTokens, `chunk ${i + 1}/${chunks.length}`);
      chunksOut[key] = part;
      level.push(part);
      step('chunk');
    }
    // Merge with bounded fan-in until one document remains.
    while (level.length > 1) {
      const next: StudyNotes[] = [];
      for (let i = 0; i < level.length; i += b.mergeFanIn) {
        const group = level.slice(i, i + b.mergeFanIn);
        next.push(group.length === 1 ? group[0] : await run(mergePrompt(t, group, a.glossary), b.finalOutputTokens, 'merge'));
        step('merge');
      }
      level = next;
    }
  }
  const labelled = level[0] ?? emptyNotes(t.title);
  // Labels → segment ids (+ starts for video).
  const refStarts: Record<string, number> = {};
  const toId = (label: string) => {
    const l = byLabel.get(label);
    if (!l) return null;
    if (l.start !== null) refStarts[l.id] = l.start;
    return l.id;
  };
  const notes = coerceNotes(labelled, toId, t.title);
  return { notes, refStarts, chunks: chunksOut, calls, reusedChunks: reused, truncated, coverage: t.coverage, transcriptVersion: t.version };
}
