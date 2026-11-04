import { parseGlossary } from '../translation/glossary';

/**
 * Editable glossary (options page). Entries are global or belong to a subject; global entries and
 * the entries of ACTIVE subjects form the effective glossary. Stored in chrome.storage.local
 * (sync items are limited to 8 KB). The compiled text drives translation AND the cache key
 * (glossaryVersion), so the cache is invalidated exactly when the effective glossary changes.
 */
export type GlossarySubject = 'global' | 'marketing' | 'dropshipping' | 'ai' | 'coding';
export const SUBJECTS: GlossarySubject[] = ['global', 'marketing', 'dropshipping', 'ai', 'coding'];
export const SUBJECT_LABELS: Record<GlossarySubject, string> = {
  global: 'Chung (luôn áp dụng)',
  marketing: 'Marketing / Ads / Copywriting',
  dropshipping: 'Dropshipping / E-commerce',
  ai: 'AI / Agents / Automation',
  coding: 'Lập trình',
};

export interface GlossaryEntry {
  term: string;
  /** Preferred Vietnamese; empty/undefined = keep the English term as is. */
  translation?: string;
  subject: GlossarySubject;
}

export interface GlossaryStore {
  version: 1;
  entries: GlossaryEntry[];
  activeSubjects: GlossarySubject[];
}

const e = (subject: GlossarySubject, term: string, translation?: string): GlossaryEntry => ({ term, translation, subject });

/** Starter presets (added on request, never overwriting the user's own entries). */
export const PRESETS: Record<Exclude<GlossarySubject, 'global'>, GlossaryEntry[]> = {
  marketing: [
    e('marketing', 'VOC', 'VOC (tiếng nói khách hàng)'),
    e('marketing', 'Mass Desire', 'Mass Desire (khát khao số đông)'),
    e('marketing', 'Hook', 'Hook (câu móc)'),
    e('marketing', 'ROAS'),
    e('marketing', 'CTR'),
    e('marketing', 'CPC'),
    e('marketing', 'CPM'),
    e('marketing', 'CPA'),
    e('marketing', 'conversion rate', 'tỷ lệ chuyển đổi'),
    e('marketing', 'Facebook Ads'),
    e('marketing', 'ad set', 'nhóm quảng cáo (ad set)'),
    e('marketing', 'creative', 'mẫu quảng cáo (creative)'),
    e('marketing', 'copywriting', 'copywriting (viết nội dung bán hàng)'),
    e('marketing', 'call to action', 'lời kêu gọi hành động (CTA)'),
    e('marketing', 'funnel', 'phễu bán hàng (funnel)'),
    e('marketing', 'landing page', 'landing page (trang đích)'),
    e('marketing', 'retargeting', 'tiếp thị lại (retargeting)'),
    e('marketing', 'lead', 'khách hàng tiềm năng (lead)'),
  ],
  dropshipping: [
    e('dropshipping', 'dropshipping'),
    e('dropshipping', 'Shopify'),
    e('dropshipping', 'winning product', 'sản phẩm thắng (winning product)'),
    e('dropshipping', 'supplier', 'nhà cung cấp'),
    e('dropshipping', 'fulfillment', 'xử lý đơn hàng (fulfillment)'),
    e('dropshipping', 'AOV', 'AOV (giá trị đơn hàng trung bình)'),
    e('dropshipping', 'upsell', 'bán thêm (upsell)'),
    e('dropshipping', 'cross-sell', 'bán chéo'),
    e('dropshipping', 'niche', 'thị trường ngách'),
    e('dropshipping', 'store', 'cửa hàng'),
  ],
  ai: [
    e('ai', 'AI'),
    e('ai', 'AI agent', 'AI agent (tác tử AI)'),
    e('ai', 'Agent Reach'),
    e('ai', 'prompt'),
    e('ai', 'workflow', 'quy trình (workflow)'),
    e('ai', 'automation', 'tự động hóa (automation)'),
    e('ai', 'LLM'),
    e('ai', 'ChatGPT'),
    e('ai', 'Claude'),
    e('ai', 'Gemini'),
    e('ai', 'n8n'),
    e('ai', 'Zapier'),
  ],
  coding: [
    e('coding', 'API'),
    e('coding', 'repository', 'repository (kho mã)'),
    e('coding', 'deploy', 'triển khai (deploy)'),
    e('coding', 'commit'),
    e('coding', 'pull request'),
    e('coding', 'frontend'),
    e('coding', 'backend'),
    e('coding', 'database', 'cơ sở dữ liệu (database)'),
    e('coding', 'bug', 'lỗi (bug)'),
    e('coding', 'TypeScript'),
    e('coding', 'JavaScript'),
  ],
};

const KEY = 'glossaryStore';
export const COMPILED_KEY = 'glossaryCompiled';

const norm = (t: string) => t.trim().toLowerCase();

export function emptyStore(): GlossaryStore {
  return { version: 1, entries: [], activeSubjects: ['marketing', 'dropshipping', 'ai', 'coding'] };
}

/** One-time migration of the legacy text glossary into global entries. */
export function fromLegacyText(text: string): GlossaryStore {
  const s = emptyStore();
  s.entries = parseGlossary(text).map((g) => ({ term: g.term, translation: g.translation, subject: 'global' as const }));
  return s;
}

/** Effective glossary text ("term => vi" / "term"), input of the translator and of the cache key. */
export function compileGlossary(store: GlossaryStore): string {
  const active = new Set<GlossarySubject>(['global', ...store.activeSubjects]);
  const seen = new Set<string>();
  const lines: string[] = [];
  // global entries win over subject entries for the same term
  for (const entry of [...store.entries].sort((a, b) => Number(b.subject === 'global') - Number(a.subject === 'global'))) {
    const k = norm(entry.term);
    if (!k || !active.has(entry.subject) || seen.has(k)) continue;
    seen.add(k);
    lines.push(entry.translation?.trim() ? `${entry.term.trim()} => ${entry.translation.trim()}` : entry.term.trim());
  }
  return lines.join('\n');
}

/** Adds a preset's entries; terms the user already has (any subject) are left untouched. */
export function addPreset(store: GlossaryStore, subject: Exclude<GlossarySubject, 'global'>): { store: GlossaryStore; added: number } {
  const have = new Set(store.entries.map((x) => norm(x.term)));
  const add = PRESETS[subject].filter((x) => !have.has(norm(x.term)));
  const activeSubjects = store.activeSubjects.includes(subject) ? store.activeSubjects : [...store.activeSubjects, subject];
  return { store: { ...store, entries: [...store.entries, ...add.map((x) => ({ ...x }))], activeSubjects }, added: add.length };
}

export function exportGlossary(store: GlossaryStore): string {
  return JSON.stringify({ format: 'skool-vi-glossary', ...store }, null, 2);
}

/** Validates imported JSON; merges without overwriting existing terms unless `replace`. */
export function importGlossary(store: GlossaryStore, json: string, replace = false): { store: GlossaryStore; added: number; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Tệp không phải JSON hợp lệ');
  }
  const raw = (data as { entries?: unknown }).entries ?? data;
  if (!Array.isArray(raw)) throw new Error('Thiếu danh sách "entries"');
  const incoming: GlossaryEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof (r as GlossaryEntry).term !== 'string' || !(r as GlossaryEntry).term.trim()) continue;
    const x = r as GlossaryEntry;
    const subject = SUBJECTS.includes(x.subject) ? x.subject : 'global';
    incoming.push({ term: x.term.trim().slice(0, 100), translation: typeof x.translation === 'string' ? x.translation.trim().slice(0, 200) || undefined : undefined, subject });
  }
  const base = replace ? [] : store.entries;
  const have = new Set(base.map((x) => norm(x.term)));
  const add = incoming.filter((x) => !have.has(norm(x.term)) && (have.add(norm(x.term)), true));
  const activeIn = (data as { activeSubjects?: unknown }).activeSubjects;
  const activeSubjects = Array.isArray(activeIn) ? (activeIn.filter((s) => SUBJECTS.includes(s)) as GlossarySubject[]) : store.activeSubjects;
  return { store: { version: 1, entries: [...base, ...add], activeSubjects: replace ? activeSubjects : store.activeSubjects }, added: add.length, skipped: incoming.length - add.length };
}

export async function loadGlossaryStore(legacyText: string): Promise<GlossaryStore> {
  const data = await chrome.storage.local.get(KEY);
  const s = data[KEY] as GlossaryStore | undefined;
  return s && Array.isArray(s.entries) ? s : fromLegacyText(legacyText);
}

export async function saveGlossaryStore(store: GlossaryStore): Promise<string> {
  const compiled = compileGlossary(store);
  await chrome.storage.local.set({ [KEY]: store, [COMPILED_KEY]: compiled });
  return compiled;
}

/** Effective glossary text for translation: the compiled store, else the legacy settings text. */
export async function loadEffectiveGlossary(legacyText: string): Promise<string> {
  try {
    const data = await chrome.storage.local.get(COMPILED_KEY);
    return typeof data[COMPILED_KEY] === 'string' ? (data[COMPILED_KEY] as string) : legacyText;
  } catch {
    return legacyText;
  }
}
