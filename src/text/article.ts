import { hash53 } from '../shared/hash';
import { serializeInline, type BlockParts } from './markup';

/** UI that is never lesson content (Skool chrome, forms, our own UI). */
export const EXCLUDE_SELECTOR = [
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'textarea', 'select', 'label', 'dialog',
  '[contenteditable=""]', '[contenteditable="true"]',
  '[role="navigation"]', '[role="banner"]', '[role="dialog"]', '[role="menu"]', '[role="menubar"]', '[role="toolbar"]',
  '[role="complementary"]', '[role="tablist"]', '[role="search"]', '[role="contentinfo"]', '[aria-hidden="true"]', '[hidden]',
  'script', 'style', 'noscript', 'template', 'iframe', 'video', 'audio', 'canvas',
  '[data-sst-panel]', '[data-sst-learning]', '[data-sst-overlay]', '[data-sst-text]',
].join(',');

/** Class/id fragments of non-content regions (comments, menus, notifications…). */
const NOISE = /(^|[-_\s])(comments?|sidebar|side-bar|navbar|nav-bar|menu|dropdown|tooltip|popover|modal|notification|avatar|user-?name|breadcrumb|toolbar)([-_\sA-Z]|$)/i;

const INTERACTIVE = 'video, iframe, button, form, input, textarea, select, nav, aside, header, footer, [contenteditable="true"], [role="button"]';

export function isExcluded(el: Element): boolean {
  if (el.matches(EXCLUDE_SELECTOR)) return true;
  const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
  return NOISE.test(cls) || NOISE.test(el.id);
}

function excludedChain(el: Element, stop: Element | null, memo: WeakMap<Element, boolean>): boolean {
  const seen: Element[] = [];
  let cur: Element | null = el;
  let result = false;
  while (cur && cur !== stop) {
    const m = memo.get(cur);
    if (m !== undefined) {
      result = m;
      break;
    }
    seen.push(cur);
    if (isExcluded(cur)) {
      result = true;
      break;
    }
    cur = cur.parentElement;
  }
  for (const s of seen) memo.set(s, result);
  return result;
}

const TEXT_BLOCKS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'FIGCAPTION', 'SUMMARY', 'CAPTION']);
const CONTAINERS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BLOCKQUOTE', 'UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'FIGURE', 'DETAILS', 'PRE', 'HR', 'CENTER']);
const isBlockish = (e: Element) => TEXT_BLOCKS.has(e.tagName) || CONTAINERS.has(e.tagName);
const hasLetters = (s: string) => /\p{L}/u.test(s);

/**
 * Find the article container of a text lesson (semantic scoring, no site-specific selectors).
 * Returns null when there is not enough readable text.
 */
export function findArticle(doc: Document, opts: { minChars?: number } = {}): Element | null {
  const root = doc.querySelector('main, [role="main"]') ?? doc.body;
  if (!root) return null;
  const memo = new WeakMap<Element, boolean>();
  const blocks = [...root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, pre, div')].filter((e) => {
    if (e.tagName === 'DIV' && [...e.children].some(isBlockish)) return false; // only leaf divs
    if (e.tagName === 'DIV' && ![...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) return false;
    return !excludedChain(e, root.parentElement, memo);
  });
  const len = new Map<Element, number>();
  const scores = new Map<Element, number>();
  for (const b of blocks) {
    const L = (b.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    if (L < 2) continue;
    len.set(b, L);
    let parent = b.parentElement;
    if (parent && (parent.tagName === 'UL' || parent.tagName === 'OL' || parent.tagName === 'TR' || parent.tagName === 'TBODY')) parent = parent.parentElement;
    if (parent?.tagName === 'TABLE') parent = parent.parentElement;
    const s = (/^H\d$/.test(b.tagName) ? 0.5 : 1) + Math.min(L / 80, 4) + ((b.textContent ?? '').match(/[,.;:]/g)?.length ?? 0) * 0.1;
    if (parent) scores.set(parent, (scores.get(parent) ?? 0) + s);
    const gp = parent?.parentElement;
    if (gp) scores.set(gp, (scores.get(gp) ?? 0) + s / 2);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, s] of scores) if (s > bestScore && root.contains(el)) ((best = el), (bestScore = s));
  if (!best) return null;
  const textIn = (el: Element) => {
    let t = 0;
    for (const [b, L] of len) if (el.contains(b)) t += L;
    return t;
  };
  let t = textIn(best);
  // Grow to the wrapper that also holds the lesson heading, as long as it adds little else.
  for (let p = best.parentElement; p && p !== root.parentElement && p !== doc.body; p = p.parentElement) {
    // Never take in interactive UI (buttons, comment forms…): the translated view is a clone,
    // and cloned controls would not work while the originals are hidden.
    if (excludedChain(p, root.parentElement, memo) || p.querySelector(INTERACTIVE) || [...p.querySelectorAll('[class],[id]')].some((e) => !best!.contains(e) && isExcluded(e))) break;
    const pt = textIn(p);
    if (pt > t * 1.35) break;
    best = p;
    t = pt;
    if (p === root) break;
  }
  const blocksIn = [...len.keys()].filter((b) => best!.contains(b)).length;
  if (t < (opts.minChars ?? 120) || (blocksIn < 2 && t < 300)) return null;
  return best;
}

export type BlockKind = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'li' | 'oli' | 'quote' | 'cell' | 'code';

export interface TextBlock extends BlockParts {
  index: number;
  el: Element;
  kind: BlockKind;
  /** Child-index path from the article root (used to find the same block in a clone). */
  path: number[];
  /** Content hash (markup) — translations are reused while it is unchanged. */
  hash: string;
  translatable: boolean;
}

function pathOf(el: Element, root: Element): number[] {
  const p: number[] = [];
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    const parent = cur.parentElement;
    if (!parent) break;
    p.unshift(Array.prototype.indexOf.call(parent.children, cur));
  }
  return p;
}

export function resolvePath(root: Element, path: number[]): Element | null {
  let cur: Element | null = root;
  for (const i of path) {
    cur = cur?.children[i] ?? null;
    if (!cur) return null;
  }
  return cur;
}

function kindOf(e: Element): BlockKind {
  const t = e.tagName;
  if (/^H[1-6]$/.test(t)) return t.toLowerCase() as BlockKind;
  if (t === 'LI') return e.parentElement?.tagName === 'OL' ? 'oli' : 'li';
  if (t === 'TD' || t === 'TH') return 'cell';
  if (t === 'PRE') return 'code';
  if (e.closest('blockquote')) return 'quote';
  return 'p';
}

/** Translatable blocks of the article in document order (code blocks kept, not translated). */
export function extractBlocks(article: Element): TextBlock[] {
  const out: TextBlock[] = [];
  const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, li, div, pre, blockquote, table, ul, ol';
  const wraps = (c: Element) => !isBlockish(c) && !!c.querySelector(BLOCK_SEL);
  const skip = (c: Element) => isBlockish(c) || isExcluded(c) || wraps(c);
  const visit = (e: Element) => {
    if (isExcluded(e)) return;
    if (e.tagName === 'PRE') {
      const code = e.textContent ?? '';
      if (code.trim()) out.push({ index: out.length, el: e, kind: 'code', path: pathOf(e, article), hash: hash53('pre|' + code), translatable: false, markup: '', plain: code, links: [], codes: [], images: [] });
      return;
    }
    const hasInline = [...e.childNodes].some((n) => (n.nodeType === 3 ? !!(n.textContent ?? '').trim() : n.nodeType === 1 && !skip(n as Element) && !!(n.textContent ?? '').trim()));
    if (TEXT_BLOCKS.has(e.tagName) || (hasInline && e !== article) || (hasInline && e === article && ![...e.children].some(isBlockish))) {
      const parts = serializeInline(e, skip);
      if (hasLetters(parts.plain)) {
        out.push({ ...parts, index: out.length, el: e, kind: kindOf(e), path: pathOf(e, article), hash: hash53(e.tagName + '|' + parts.markup), translatable: true });
      }
    }
    for (const c of Array.from(e.children)) if (isBlockish(c) || wraps(c)) visit(c);
  };
  visit(article);
  return out;
}
