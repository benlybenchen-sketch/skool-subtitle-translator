import type { UnitPayload, UnitResult } from '../shared/messages';
import type { TextDisplayMode } from '../shared/types';
import type { Transcript, TranscriptSegment } from '../transcript/model';
import { hash53 } from '../shared/hash';
import { extractBlocks, isExcluded, resolvePath, type TextBlock } from './article';
import { renderMarkup, stripTags } from './markup';

export type TextTranslate = (units: UnitPayload[], context: string[], priority: number) => Promise<UnitResult[]>;

export interface TextState {
  total: number;
  done: number;
  failed: number;
  started: boolean;
  translating: boolean;
  mode: TextDisplayMode;
  error?: string;
}

export const TEXT_HIDDEN_ATTR = 'data-sst-text-hidden';
export const TEXT_CLONE_ATTR = 'data-sst-text';
const STYLE_ATTR = 'data-sst-text-style';
const CSS = `[${TEXT_HIDDEN_ATTR}]{display:none!important}
[${TEXT_CLONE_ATTR}] [data-sst-vi]{opacity:.93;border-left:3px solid rgba(31,111,235,.35);padding-left:8px;margin-top:2px}
[${TEXT_CLONE_ATTR}] li>[data-sst-vi]{display:block}
[${TEXT_CLONE_ATTR}] [data-sst-pending]{opacity:.7}`;

const BLOCKISH = /^(H[1-6]|P|LI|TD|TH|DT|DD|FIGCAPTION|SUMMARY|CAPTION|DIV|SECTION|ARTICLE|MAIN|BLOCKQUOTE|UL|OL|DL|TABLE|THEAD|TBODY|TFOOT|TR|FIGURE|DETAILS|PRE|HR|CENTER)$/;
const isNestedBlock = (c: Element) => BLOCKISH.test(c.tagName) || isExcluded(c) || !!c.querySelector('p, h1, h2, h3, h4, h5, h6, li, div, pre, blockquote, table, ul, ol');

/**
 * Translates one text-only lesson article.
 *
 * The page's own DOM is never rewritten (React keeps working): the translated view is a CLONE
 * of the article inserted right before it, and the original is hidden with one attribute.
 * "Original" mode removes the clone and the attribute → exact restoration without reload.
 * Translations are kept per block content hash, so switching modes and re-renders of the same
 * content never call the API again; edited blocks are the only ones re-translated.
 */
export class TextLessonTranslator {
  private article: Element | null = null;
  private blocks: TextBlock[] = [];
  private readonly vi = new Map<string, string>();
  private readonly failed = new Map<string, string>();
  private readonly inflight = new Set<string>();
  private clone: Element | null = null;
  private cloneEls = new Map<number, Element>();
  private companions = new Map<number, Element>();
  private started = false;
  private workers = 0;
  private generation = 0;
  private error: string | undefined;
  private observer: MutationObserver | null = null;
  private parentObserver: MutationObserver | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(s: TextState) => void>();
  private version = 0;

  constructor(
    private readonly doc: Document,
    private readonly translateFn: TextTranslate,
    private mode: TextDisplayMode = 'vi',
    private readonly opts: { batchChars?: number; batchItems?: number; concurrency?: number; debounceMs?: number; onLost?: () => void } = {},
  ) {}

  get attached(): Element | null {
    return this.article;
  }

  onState(cb: (s: TextState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  state(): TextState {
    const t = this.blocks.filter((b) => b.translatable);
    const uniq = new Set(t.map((b) => b.hash));
    return {
      total: t.length,
      done: t.filter((b) => this.vi.has(b.hash)).length,
      failed: [...uniq].filter((h) => this.failed.has(h)).length,
      started: this.started,
      translating: this.workers > 0,
      mode: this.mode,
      error: this.error,
    };
  }

  private emit(): void {
    this.version++;
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  /** Attach to an article (no API call yet). */
  attach(article: Element): void {
    if (this.article === article) return;
    this.detach();
    this.article = article;
    this.blocks = extractBlocks(article);
    this.observe();
    this.emit();
  }

  /** Start (or resume) translating; renders the translated view. */
  start(): void {
    if (!this.article) return;
    this.started = true;
    this.error = undefined;
    this.render();
    this.pump();
    this.emit();
  }

  /** Retry blocks that failed with a non-permanent error. */
  retry(): void {
    this.failed.clear();
    this.error = undefined;
    this.start();
  }

  setMode(mode: TextDisplayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.render();
    this.emit();
  }

  /** Remove everything we added; the page is exactly as before. */
  detach(): void {
    this.generation++;
    clearTimeout(this.debounce);
    this.observer?.disconnect();
    this.parentObserver?.disconnect();
    this.observer = this.parentObserver = null;
    this.removeView();
    this.article = null;
    this.blocks = [];
    this.started = false;
    this.error = undefined;
    this.inflight.clear();
    this.emit();
  }

  private removeView(): void {
    this.clone?.remove();
    this.clone = null;
    this.cloneEls.clear();
    this.companions.clear();
    this.article?.removeAttribute(TEXT_HIDDEN_ATTR);
  }

  private ensureStyle(): void {
    if (this.doc.querySelector(`style[${STYLE_ATTR}]`)) return;
    const s = this.doc.createElement('style');
    s.setAttribute(STYLE_ATTR, '');
    s.textContent = CSS;
    (this.doc.head ?? this.doc.documentElement).appendChild(s);
  }

  private observe(): void {
    const a = this.article!;
    const schedule = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.refresh(), this.opts.debounceMs ?? 600);
    };
    this.observer = new MutationObserver(schedule);
    this.observer.observe(a, { childList: true, subtree: true, characterData: true });
    if (a.parentElement) {
      // Article replaced/removed, or our clone removed by a re-render.
      this.parentObserver = new MutationObserver(schedule);
      this.parentObserver.observe(a.parentElement, { childList: true });
    }
  }

  /** Content edited (or re-rendered): re-extract, keep translations of unchanged blocks. */
  private refresh(): void {
    const a = this.article;
    if (!a) return;
    if (!a.isConnected) {
      const onLost = this.opts.onLost;
      this.detach();
      onLost?.();
      return;
    }
    const before = this.blocks.map((b) => b.hash).join(',');
    this.blocks = extractBlocks(a);
    const changed = before !== this.blocks.map((b) => b.hash).join(',');
    if (this.started && (changed || (this.mode !== 'original' && !this.clone?.isConnected))) {
      this.render();
      this.pump();
    }
    if (changed) this.emit();
  }

  private render(): void {
    this.removeView();
    const a = this.article;
    if (!a || !this.started || this.mode === 'original' || !a.parentNode) return;
    this.ensureStyle();
    const c = a.cloneNode(true) as Element;
    c.setAttribute(TEXT_CLONE_ATTR, '');
    c.setAttribute('lang', 'vi');
    for (const b of this.blocks) {
      const el = resolvePath(c, b.path);
      if (el) this.cloneEls.set(b.index, el);
    }
    // Never duplicate players or scripts; no duplicate ids.
    c.querySelectorAll('iframe, video, audio, script, object, embed').forEach((e) => e.remove());
    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    this.clone = c;
    for (const b of this.blocks) this.apply(b);
    a.parentNode.insertBefore(c, a);
    a.setAttribute(TEXT_HIDDEN_ATTR, '');
  }

  private apply(b: TextBlock): void {
    if (!b.translatable) return;
    const el = this.cloneEls.get(b.index);
    if (!el) return;
    const vi = this.vi.get(b.hash);
    if (!vi) {
      el.setAttribute('data-sst-pending', '');
      return;
    }
    el.removeAttribute('data-sst-pending');
    const nested = Array.from(el.children).filter((c) => isNestedBlock(c) && !c.hasAttribute('data-sst-vi'));
    const frag = renderMarkup(this.doc, vi, b);
    if (this.mode === 'vi') {
      el.replaceChildren(frag, ...nested);
      return;
    }
    // bilingual: Vietnamese right below the original block
    let comp = this.companions.get(b.index);
    if (!comp) {
      const inside = b.kind === 'li' || b.kind === 'oli' || b.kind === 'cell';
      comp = this.doc.createElement(inside ? 'div' : el.tagName.toLowerCase());
      const cls = el.getAttribute('class');
      if (cls && !inside) comp.setAttribute('class', cls);
      comp.setAttribute('data-sst-vi', '');
      if (inside) el.insertBefore(comp, nested[0] ?? null);
      else el.after(comp);
      this.companions.set(b.index, comp);
    }
    comp.replaceChildren(frag);
  }

  private priorityOf(b: TextBlock): number {
    const el = this.cloneEls.get(b.index) ?? b.el;
    const r = el.getBoundingClientRect();
    const h = this.doc.defaultView?.innerHeight ?? 800;
    if (!r.height && !r.width) return 3;
    if (r.bottom >= 0 && r.top <= h) return 1;
    if (r.top <= h * 3 && r.bottom >= -h) return 2;
    return 3;
  }

  private pump(): void {
    const want = this.opts.concurrency ?? 2;
    const gen = this.generation;
    while (this.workers < want) {
      this.workers++;
      void this.work(gen).finally(() => {
        this.workers--;
        this.emit();
      });
    }
  }

  private nextBatch(): TextBlock[] {
    const seen = new Set<string>();
    const pending = this.blocks.filter((b) => {
      if (!b.translatable || this.vi.has(b.hash) || this.failed.has(b.hash) || this.inflight.has(b.hash) || seen.has(b.hash)) return false;
      seen.add(b.hash);
      return true;
    });
    if (!pending.length) return [];
    const prio = new Map(pending.map((b) => [b, this.priorityOf(b)]));
    pending.sort((x, y) => prio.get(x)! - prio.get(y)! || x.index - y.index);
    const maxChars = this.opts.batchChars ?? 2400;
    const maxItems = this.opts.batchItems ?? 12;
    const batch: TextBlock[] = [];
    let chars = 0;
    for (const b of pending) {
      if (batch.length && (chars + b.markup.length > maxChars || batch.length >= maxItems || prio.get(b) !== prio.get(batch[0]))) break;
      batch.push(b);
      chars += b.markup.length;
    }
    return batch;
  }

  private async work(gen: number): Promise<void> {
    while (gen === this.generation && this.started && !this.error) {
      const batch = this.nextBatch();
      if (!batch.length) return;
      for (const b of batch) this.inflight.add(b.hash);
      const first = batch[0].index;
      const context = this.blocks.slice(Math.max(0, first - 2), first).map((b) => b.plain).filter(Boolean);
      const prio = this.priorityOf(batch[0]);
      let results: UnitResult[] = [];
      try {
        results = await this.translateFn(batch.map((b) => ({ id: b.hash, text: b.markup })), context, prio === 1 ? 1 : prio === 2 ? 3 : 4);
      } catch (e) {
        results = batch.map((b) => ({ id: b.hash, error: (e as Error).message }));
      }
      for (const b of batch) this.inflight.delete(b.hash);
      if (gen !== this.generation) return;
      for (const r of results) {
        if (r.vi) {
          this.vi.set(r.id, r.vi);
          this.failed.delete(r.id);
        } else {
          this.failed.set(r.id, r.error ?? 'Translation failed');
          if (r.fatal) this.error = r.error;
        }
      }
      const ids = new Set(results.map((r) => r.id));
      for (const b of this.blocks) if (ids.has(b.hash)) this.apply(b);
      this.emit();
    }
  }

  /** Text lesson as a transcript (no timestamps: start/end are block order only). */
  transcript(lessonId: string, title: string): Transcript | null {
    if (!this.article || !this.blocks.length) return null;
    const plainVi = (b: TextBlock): string | undefined => {
      const v = this.vi.get(b.hash);
      if (!v) return b.translatable ? undefined : b.plain;
      return stripTags(v)
        .replace(/⟦C(\d+)⟧/g, (_, i) => b.codes[Number(i)] ?? '')
        .replace(/⟦I\d+⟧/g, '')
        .replace(/‹/g, '<')
        .replace(/›/g, '>')
        .trim();
    };
    const segments: TranscriptSegment[] = this.blocks.map((b, i) => ({
      id: `b${i}-${b.hash}`,
      lessonId,
      start: i,
      end: i + 1,
      en: b.plain,
      vi: plainVi(b),
      status: this.vi.has(b.hash) || !b.translatable ? 'done' : this.failed.has(b.hash) ? 'error' : 'pending',
      source: 'text',
      block: b.kind,
    }));
    return {
      lessonId,
      title,
      kind: 'text',
      segments,
      coverage: {
        state: 'complete',
        sourceUntilSec: 0,
        durationSec: null,
        segments: segments.length,
        translated: segments.filter((s) => !!s.vi).length,
        failed: segments.filter((s) => s.status === 'error').length,
      },
      version: hash53(segments.map((s) => `${s.id}:${s.vi ? 1 : 0}`).join('|')),
    };
  }
}
