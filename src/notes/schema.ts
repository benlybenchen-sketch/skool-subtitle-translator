/**
 * AI Study Notes — data model, strict JSON schema and validation.
 * Every item that can point at the source carries `refs` (segment labels in the prompt,
 * segment ids after validation). Labels that do not exist in the source are DROPPED, so a
 * timestamp can never be fabricated by the model.
 */
export interface NoteItem {
  text: string;
  refs: string[];
}
export interface ConceptItem {
  term: string;
  explanation: string;
  refs: string[];
}
export interface TermItem {
  term: string;
  vi: string;
  explanation: string;
}

export interface StudyNotes {
  /** 1. Lesson title */
  title: string;
  /** 2. Concise Vietnamese summary */
  summary: string;
  /** 3. Main learning objectives */
  objectives: string[];
  /** 4. Key concepts and explanations */
  concepts: ConceptItem[];
  /** 5. Important instructor insights */
  insights: NoteItem[];
  /** 6. Practical steps and procedures */
  steps: NoteItem[];
  /** 7. Technical terminology with Vietnamese explanations */
  terminology: TermItem[];
  /** 8. Key takeaways */
  takeaways: NoteItem[];
  /** 9. Practical application checklist */
  checklist: string[];
  /** 10. Key moments (timestamps come only from refs) */
  moments: NoteItem[];
}

export const NOTES_PROMPT_VERSION = 'n1';

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const item = obj({ text: str, refs: strArr });

/** Strict-mode compatible (all properties required, no additional properties). */
export const NOTES_SCHEMA: Record<string, unknown> = obj({
  title: str,
  summary: str,
  objectives: strArr,
  concepts: { type: 'array', items: obj({ term: str, explanation: str, refs: strArr }) },
  insights: { type: 'array', items: item },
  steps: { type: 'array', items: item },
  terminology: { type: 'array', items: obj({ term: str, vi: str, explanation: str }) },
  takeaways: { type: 'array', items: item },
  checklist: strArr,
  moments: { type: 'array', items: item },
});

export const emptyNotes = (title = ''): StudyNotes => ({
  title,
  summary: '',
  objectives: [],
  concepts: [],
  insights: [],
  steps: [],
  terminology: [],
  takeaways: [],
  checklist: [],
  moments: [],
});

const s = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * Coerce a model reply into StudyNotes. `mapRef` returns the canonical ref for a label, or null
 * when the label is unknown (→ dropped). Empty items are removed.
 */
export function coerceNotes(raw: unknown, mapRef: (label: string) => string | null, fallbackTitle: string): StudyNotes {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const refs = (v: unknown): string[] => {
    const out: string[] = [];
    for (const r of arr(v, 6)) {
      const m = typeof r === 'string' ? mapRef(r.trim().replace(/^\[|\]$/g, '').split(/\s+/)[0]) : null;
      if (m && !out.includes(m)) out.push(m);
    }
    return out;
  };
  const items = (v: unknown, max = 40): NoteItem[] =>
    arr(v, max)
      .map((x) => {
        const r = (x && typeof x === 'object' ? x : { text: x }) as Record<string, unknown>;
        return { text: s(r.text), refs: refs(r.refs) };
      })
      .filter((x) => x.text);
  const strings = (v: unknown, max = 30) => arr(v, max).map((x) => s(x, 600)).filter(Boolean);
  return {
    title: s(o.title, 200) || fallbackTitle,
    summary: s(o.summary, 4000),
    objectives: strings(o.objectives),
    concepts: arr(o.concepts, 40)
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        return { term: s(r.term, 200), explanation: s(r.explanation), refs: refs(r.refs) };
      })
      .filter((c) => c.term && c.explanation),
    insights: items(o.insights),
    steps: items(o.steps, 60),
    terminology: arr(o.terminology, 60)
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        return { term: s(r.term, 200), vi: s(r.vi, 300), explanation: s(r.explanation, 1000) };
      })
      .filter((t) => t.term),
    takeaways: items(o.takeaways),
    checklist: strings(o.checklist, 40),
    moments: items(o.moments, 40),
  };
}
