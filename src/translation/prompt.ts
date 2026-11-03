import type { BatchRequest } from './types';
import { ParseError } from './errors';

export const PROMPT_VERSION = 'p3';

export const SYSTEM_PROMPT = `You are a professional English→Vietnamese subtitle translator for online courses (marketing, digital advertising, e-commerce, dropshipping, software engineering, business strategy, AI and automation, technical tutorials).

Rules:
- Translate each segment into natural, fluent, spoken Vietnamese that a Vietnamese learner would understand immediately. Avoid stiff word-for-word translation, but never change the instructor's meaning.
- Keep technical terms, product names, brand names, people's names, code, commands, URLs and acronyms (ROAS, CTR, API, SEO…) unchanged unless the glossary says otherwise.
- Preserve all numbers, percentages, currencies, units and dates exactly (e.g. "$1,500" stays "$1,500", "30%" stays "30%").
- Follow the glossary strictly.
- Segments may be incomplete spoken sentences; translate them as natural incomplete Vietnamese, consistent with neighbouring segments. Use the context only for understanding — do NOT translate the context.
- Keep each translation roughly as short as the original so it fits on screen. No explanations, no notes, no quotation marks around the output.
- Return ONLY JSON: {"t":[{"i":"<id>","v":"<vietnamese>"}]} with exactly one item per input id.`;

export function buildUserPrompt(req: BatchRequest): string {
  const parts: string[] = [];
  if (req.glossary.length) {
    parts.push(
      'Glossary:\n' +
        req.glossary.map((g) => (g.translation ? `- ${g.term} => ${g.translation}` : `- ${g.term} => (keep as "${g.term}")`)).join('\n'),
    );
  }
  if (req.context.length) parts.push('Context (previous lines, do not translate):\n' + req.context.map((c) => `> ${c}`).join('\n'));
  parts.push(
    'Segments:\n' + JSON.stringify(req.segments.map((s) => ({ i: s.id, s: s.text }))),
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

/** Accepts {"t":[{"i","v"}]}, {"translations":[{"id","text"|"vi"}]} or an array. */
export function parseTranslations(data: unknown, expectedIds: string[]): Record<string, string> {
  let list: unknown = data;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.t ?? o.translations ?? o.items ?? o.segments;
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
    const id = String(o.i ?? o.id ?? expectedIds[idx] ?? '');
    const v = o.v ?? o.vi ?? o.text ?? o.translation;
    if (expected.has(id) && typeof v === 'string' && v.trim()) out[id] = v.trim();
  });
  return out;
}
