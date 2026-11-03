import type { GlossaryEntry } from './types';
import { hash53 } from '../shared/hash';

export function parseGlossary(text: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [term, translation] = line.split(/\s*(?:=>|→)\s*/, 2);
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ term: term.trim(), translation: translation?.trim() || undefined });
  }
  return out;
}

export function glossaryVersion(text: string): string {
  return hash53(parseGlossary(text).map((e) => `${e.term}=${e.translation ?? ''}`).join('\n'));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only send glossary entries that actually occur in the batch (saves tokens). */
export function relevantGlossary(entries: GlossaryEntry[], texts: string[]): GlossaryEntry[] {
  const hay = texts.join('\n');
  return entries.filter((e) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(e.term)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(hay));
}
