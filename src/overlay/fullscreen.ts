/**
 * Where our UI (subtitle overlay + VI control) must be mounted so it stays visible.
 *
 * - Fullscreen API: only the fullscreen element's subtree is rendered (top layer), so UI must be
 *   INSIDE it — a higher z-index on <body> children cannot work.
 * - <video>/<iframe> as the fullscreen element cannot host children: fall back to <body>
 *   (subtitles then use the native TextTrack fallback).
 * - Custom ("pseudo") fullscreen without the API: the player container is made position:fixed and
 *   viewport-sized. We mount inside that container so we share its stacking context.
 */
export function apiFullscreenElement(doc: Document): Element | null {
  const d = doc as Document & { webkitFullscreenElement?: Element | null };
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

const canHost = (el: Element) => el.tagName !== 'VIDEO' && el.tagName !== 'IFRAME';

/** Ancestor of `target` acting as a CSS fullscreen container, if any. Cheap when not fullscreen. */
export function pseudoFullscreenContainer(target: Element | null, doc: Document): Element | null {
  const win = doc.defaultView;
  if (!target || !win) return null;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const covers = (r: DOMRect | { width: number; height: number }) => r.width >= vw * 0.95 && r.height >= vh * 0.95;
  if (!covers(target.getBoundingClientRect())) return null;
  let el: Element | null = target.parentElement;
  for (let i = 0; el && el !== doc.body && i < 15; i++, el = el.parentElement) {
    if (!covers(el.getBoundingClientRect())) continue;
    if (win.getComputedStyle(el).position === 'fixed' && canHost(el)) return el;
  }
  return null;
}

export function mountParent(doc: Document, target: Element | null): Element {
  const body = doc.body ?? doc.documentElement;
  const fs = apiFullscreenElement(doc);
  if (fs) return canHost(fs) ? fs : body;
  return pseudoFullscreenContainer(target, doc) ?? body;
}

export function addFullscreenListener(doc: Document, cb: () => void): () => void {
  doc.addEventListener('fullscreenchange', cb);
  doc.addEventListener('webkitfullscreenchange', cb);
  return () => {
    doc.removeEventListener('fullscreenchange', cb);
    doc.removeEventListener('webkitfullscreenchange', cb);
  };
}
