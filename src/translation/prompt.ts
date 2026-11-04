import type { BatchRequest } from './types';
import { ParseError } from './errors';

export const PROMPT_VERSION = 'p4';

export const SYSTEM_PROMPT = `You are a professional English→Vietnamese subtitle translator for online courses (marketing, digital advertising, e-commerce, dropshipping, software engineering, business strategy, AI and automation, technical tutorials).

Rules:
- Translate each segment into natural, fluent, spoken Vietnamese that a Vietnamese learner would understand immediately. Avoid stiff word-for-word translation, but never change the instructor's meaning.
- Keep technical terms, product names, brand names, people's names, code, commands, URLs and acronyms (ROAS, CTR, API, SEO…) unchanged unless the glossary says otherwise.
- Preserve all numbers, percentages, currencies, units and dates exactly (e.g. "$1,500" stays "$1,500", "30%" stays "30%").
- Follow the glossary strictly.
- Segments may be incomplete spoken sentences; translate them as natural incomplete Vietnamese, consistent with neighbouring segments. Use the context only for understanding — do NOT translate the context.
- Subtitles must be short and easy to read: keep each translation about as long as the original (or shorter). No explanations, notes or quotation marks.
- Return ONLY JSON: {"translations":[{"subtitle_id":"<id>","translated_text":"<vietnamese>"}]} with exactly one item per input id, same ids, no extra items.`;

/** JSON schema for providers that support structured output (Gemini responseSchema). */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    translations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { subtitle_id: { type: 'STRING' }, translated_text: { type: 'STRING' } },
        required: ['subtitle_id', 'translated_text'],
      },
    },
  },
  required: ['translations'],
} as const;

/** Extra rules for written (text-only) lessons; part of the request, so subtitle prompts are unchanged. */
export const MARKUP_RULES = `These segments are headings, paragraphs and list items of a WRITTEN lesson, not subtitles: translate each one completely and faithfully (the length rule does not apply).
Segments may contain lightweight markup: <b>…</b>, <i>…</i>, <u>…</u>, <s>…</s>, link tags <a1>…</a1>, <a2>…</a2>…, line breaks <br> and placeholders such as ⟦C0⟧ (code) or ⟦I0⟧ (image). Keep every tag and placeholder exactly as written (same names, same count), wrapped around the corresponding Vietnamese words; never translate, add or remove them.`;

export function buildUserPrompt(req: BatchRequest): string {
  const parts: string[] = [];
  if (req.glossary.length) {
    parts.push(
      'Glossary:\n' +
        req.glossary.map((g) => (g.translation ? `- ${g.term} => ${g.translation}` : `- ${g.term} => (keep as "${g.term}")`)).join('\n'),
    );
  }
  if (req.context.length) parts.push('Context (previous lines, do not translate):\n' + req.context.map((c) => `> ${c}`).join('\n'));
  if (req.format === 'markup') parts.push(MARKUP_RULES);
  parts.push(
    'Segments:\n' + JSON.stringify(req.segments.map((s) => ({ subtitle_id: s.id, text: s.text }))),
  );
  return parts.join('\n\n');
}

/** Extract the first JSON object from a model reply (tolerates code fences). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    throw new ParseError('Model reply is not valid JSON');
  }
}

/**
 * Validates and maps a model reply. Accepts {"translations":[{"subtitle_id","translated_text"}]}
 * (preferred) and legacy shapes. Unknown IDs, duplicates and empty strings are discarded, so the
 * caller sees them as missing and retries only those — nothing is fabricated or silently kept.
 */
export function parseTranslations(data: unknown, expectedIds: string[]): Record<string, string> {
  let list: unknown = data;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.translations ?? o.t ?? o.items ?? o.segments;
  }
  if (!Array.isArray(list)) throw new ParseError('Model reply has no translation list');
  const out: Record<string, string> = {};
  const expected = new Set(expectedIds);
  list.forEach((item, idx) => {
    if (typeof item === 'string') {
      if (expectedIds[idx]) out[expectedIds[idx]] = item;
      return;
    }
    if (!item || typeof item !== 'object') return;
    const o = item as Record<string, unknown>;
    const id = String(o.subtitle_id ?? o.i ?? o.id ?? expectedIds[idx] ?? '');
    const v = o.translated_text ?? o.v ?? o.vi ?? o.text ?? o.translation;
    if (expected.has(id) && !(id in out) && typeof v === 'string' && v.trim()) out[id] = v.trim();
  });
  return out;
}
