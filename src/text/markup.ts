/**
 * Lightweight markup for translating formatted text blocks without HTML:
 *   <b> <i> <u> <s>  emphasis      <aN> links (N = index into the block's links)
 *   <br>             line break    ⟦CN⟧ inline code (never translated)   ⟦IN⟧ inline image
 * Serialisation reads the DOM; rendering builds DOM nodes with createElement/textNode only
 * (never innerHTML). If the model breaks the tags, rendering falls back to plain text.
 */
export interface BlockParts {
  markup: string;
  /** Plain text (no tags; code kept) — for notes, exports and context. */
  plain: string;
  links: Element[];
  codes: string[];
  images: Element[];
}

const EMPH: Record<string, string> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', DEL: 's', STRIKE: 's' };

const esc = (t: string) => t.replace(/[<>⟦⟧]/g, (c) => ({ '<': '‹', '>': '›', '⟦': '[', '⟧': ']' })[c]!);

/**
 * Serialise the inline content of `el`. `skip(child)` returns true for nested block children
 * (handled as their own blocks) and excluded UI.
 */
export function serializeInline(el: Element, skip: (child: Element) => boolean): BlockParts {
  const links: Element[] = [];
  const codes: string[] = [];
  const images: Element[] = [];
  let plain = '';
  const walk = (node: Node): string => {
    let out = '';
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 3) {
        const t = (c.textContent ?? '').replace(/\s+/g, ' ');
        out += esc(t);
        plain += t;
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      if (skip(e)) continue;
      const tag = e.tagName;
      if (tag === 'BR') {
        out += '<br>';
        plain += '\n';
      } else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
        out += `⟦C${codes.length}⟧`;
        codes.push(e.textContent ?? '');
        plain += e.textContent ?? '';
      } else if (tag === 'IMG' || tag === 'SVG' || tag === 'svg' || tag === 'PICTURE') {
        out += `⟦I${images.length}⟧`;
        images.push(e);
      } else if (tag === 'A') {
        const n = links.length + 1;
        links.push(e);
        out += `<a${n}>${walk(e)}</a${n}>`;
      } else if (EMPH[tag]) {
        const inner = walk(e);
        out += inner.trim() ? `<${EMPH[tag]}>${inner}</${EMPH[tag]}>` : inner;
      } else if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') {
        continue;
      } else {
        out += walk(e); // span, mark, font… → transparent
      }
    }
    return out;
  };
  const markup = walk(el).replace(/\s+/g, ' ').trim();
  return { markup, plain: plain.replace(/[ \t]+/g, ' ').trim(), links, codes, images };
}

const TOKEN = /<(\/?)(b|i|u|s|a\d+)>|<br\s*\/?>|⟦([CI])(\d+)⟧/g;

/** Tags balanced, link indexes valid? */
export function markupValid(m: string, parts: Pick<BlockParts, 'links' | 'codes' | 'images'>): boolean {
  const stack: string[] = [];
  for (const t of m.matchAll(TOKEN)) {
    if (t[0].startsWith('<br')) continue;
    if (t[3]) {
      const i = Number(t[4]);
      if (t[3] === 'C' ? i >= parts.codes.length : i >= parts.images.length) return false;
      continue;
    }
    const name = t[2];
    if (name.startsWith('a') && (Number(name.slice(1)) < 1 || Number(name.slice(1)) > parts.links.length)) return false;
    if (t[1]) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

/** Strip tags, keep code/image placeholders resolvable. */
export const stripTags = (m: string) => m.replace(/<\/?(b|i|u|s|a\d+)>/g, '').replace(/<br\s*\/?>/g, '\n');

/**
 * Build DOM nodes for a translated block. Links are re-created from the ORIGINAL anchors
 * (href/target/rel only) so destinations can never come from the model. Code and images are
 * the original ones (cloned). Missing placeholders are appended so nothing is lost.
 */
export function renderMarkup(doc: Document, translated: string, parts: Pick<BlockParts, 'links' | 'codes' | 'images'>): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const text = markupValid(translated, parts) ? translated : stripTags(translated).replace(/<|>/g, '');
  const usedC = new Set<number>();
  const usedI = new Set<number>();
  const stack: Node[] = [frag];
  const top = () => stack[stack.length - 1];
  let last = 0;
  const pushText = (t: string) => {
    if (t) top().appendChild(doc.createTextNode(t.replace(/‹/g, '<').replace(/›/g, '>')));
  };
  for (const m of text.matchAll(TOKEN)) {
    pushText(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[0].startsWith('<br')) {
      top().appendChild(doc.createElement('br'));
    } else if (m[3] === 'C') {
      const i = Number(m[4]);
      usedC.add(i);
      top().appendChild(Object.assign(doc.createElement('code'), { textContent: parts.codes[i] ?? '' }));
    } else if (m[3] === 'I') {
      const i = Number(m[4]);
      usedI.add(i);
      if (parts.images[i]) top().appendChild(parts.images[i].cloneNode(true));
    } else if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const name = m[2];
      let e: Element;
      if (name.startsWith('a')) {
        const src = parts.links[Number(name.slice(1)) - 1];
        e = doc.createElement('a');
        for (const attr of ['href', 'target', 'rel', 'title']) {
          const v = src?.getAttribute(attr);
          if (v === null || v === undefined) continue;
          if (attr === 'href' && /^\s*(javascript|data|vbscript):/i.test(v)) continue;
          e.setAttribute(attr, v);
        }
        if (e.getAttribute('target') === '_blank' && !e.getAttribute('rel')) e.setAttribute('rel', 'noopener noreferrer');
      } else e = doc.createElement(name === 'b' ? 'strong' : name === 'i' ? 'em' : name);
      top().appendChild(e);
      stack.push(e);
    }
  }
  pushText(text.slice(last));
  parts.codes.forEach((c, i) => {
    if (!usedC.has(i)) frag.append(' ', Object.assign(doc.createElement('code'), { textContent: c }));
  });
  parts.images.forEach((img, i) => {
    if (!usedI.has(i)) frag.append(img.cloneNode(true));
  });
  return frag;
}
