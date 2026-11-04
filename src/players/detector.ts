import type { ProviderId } from '../shared/types';
import { adapterForIframe, providerForVideo, type PlayerAdapter } from './adapters';
import { findEnglishTrack } from '../subtitles/sources';

/**
 * Detection targets:
 *  - video:  a visible HTMLVideoElement (overlay drawn over it)
 *  - media:  an accessible HTMLMediaElement without a usable box (e.g. an <audio> element, or a
 *            hidden <video>) — used only as a time/caption source; overlay goes to the page anchor
 *  - iframe: a known player iframe (Loom/Vimeo/YouTube/Wistia)
 * When none exists (e.g. the player lives in a closed shadow root or is otherwise inaccessible),
 * `primary` is null and only the page-level overlay (Audio Mode) is possible.
 */
export type Target =
  | { kind: 'video'; el: HTMLVideoElement; provider: ProviderId; area: number }
  | { kind: 'media'; el: HTMLMediaElement; provider: ProviderId; area: number }
  | { kind: 'iframe'; el: HTMLIFrameElement; provider: ProviderId; area: number };

export interface DetectionResult {
  primary: Target | null;
  videos: HTMLVideoElement[];
  audios: HTMLAudioElement[];
  embeds: { el: HTMLIFrameElement; provider: ProviderId }[];
  /** Visible element that probably hosts an inaccessible player (positioning only). */
  anchor: Element | null;
}

const MIN_AREA = 160 * 90;
const MAX_NODES = 25_000;

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect();
  const w = r.width || (el as HTMLElement).offsetWidth || 0;
  const h = r.height || (el as HTMLElement).offsetHeight || 0;
  return w * h;
}

/** All OPEN shadow roots in the document (nested ones included), bounded. */
export function openShadowRoots(doc: Document): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const stack: (Document | ShadowRoot)[] = [doc];
  let visited = 0;
  while (stack.length) {
    const r = stack.pop()!;
    const walker = (r instanceof Document ? r : r.ownerDocument!).createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (++visited > MAX_NODES) return out;
      const sr = (n as Element).shadowRoot;
      if (sr) {
        out.push(sr);
        stack.push(sr);
      }
    }
  }
  return out;
}

/** querySelectorAll that also descends into OPEN shadow roots (closed ones are not accessible, by design). */
export function deepQueryAll<T extends Element>(root: Document | ShadowRoot, selector: string): T[] {
  const out: T[] = [...root.querySelectorAll<T>(selector)];
  const stack: (Document | ShadowRoot)[] = [root];
  let visited = 0;
  while (stack.length) {
    const r = stack.pop()!;
    const walker = (r instanceof Document ? r : r.ownerDocument!).createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (++visited > MAX_NODES) return out;
      const sr = (n as Element).shadowRoot;
      if (sr) {
        out.push(...sr.querySelectorAll<T>(selector));
        stack.push(sr);
      }
    }
  }
  return out;
}

const ANCHOR_SELECTOR = 'canvas, [class*="player" i], [class*="video" i], [id*="player" i], [id*="video" i]';

/** Largest visible, roughly video-shaped element — where an inaccessible player is likely rendered. */
export function findPlayerAnchor(doc: Document): Element | null {
  const vw = doc.defaultView?.innerWidth ?? 1280;
  const vh = doc.defaultView?.innerHeight ?? 800;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of doc.querySelectorAll(ANCHOR_SELECTOR)) {
    if (el.closest('[data-sst-overlay],[data-sst-panel]')) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const ratio = r.width / Math.max(1, r.height);
    if (r.width < 320 || r.height < 180 || ratio < 1.2 || ratio > 2.5) continue;
    if (area > vw * vh * 0.95) continue; // whole-page wrappers
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function mediaScore(m: HTMLMediaElement): number {
  let s = 0;
  if (findEnglishTrack(m)) s += 1000;
  if (!m.paused) s += 100;
  if (Number.isFinite(m.duration) && m.duration > 60) s += 10;
  return s;
}

/** Synchronous scan of a document for lesson media and player iframes. */
export function detect(doc: Document, frameAdapter: PlayerAdapter): DetectionResult {
  let videos = [...doc.querySelectorAll('video')];
  let audios = [...doc.querySelectorAll('audio')];
  if (!videos.length) {
    videos = deepQueryAll<HTMLVideoElement>(doc, 'video');
    if (!audios.length) audios = deepQueryAll<HTMLAudioElement>(doc, 'audio');
  }
  const embeds: DetectionResult['embeds'] = [];
  for (const el of doc.querySelectorAll('iframe')) {
    const a = adapterForIframe(el, doc.baseURI);
    if (a) embeds.push({ el, provider: a.id });
  }
  const candidates: Target[] = [];
  const hidden: HTMLMediaElement[] = [];
  for (const v of videos) {
    const area = visibleArea(v);
    const hasMedia = !!(v.currentSrc || v.src || v.querySelector('source') || v.srcObject || v.textTracks?.length);
    if (area >= MIN_AREA || (hasMedia && area > 0)) {
      candidates.push({ kind: 'video', el: v, provider: providerForVideo(v, frameAdapter), area: area + (v.paused ? 0 : 1e7) });
    } else hidden.push(v);
  }
  for (const e of embeds) {
    const area = visibleArea(e.el);
    if (area >= MIN_AREA) candidates.push({ kind: 'iframe', el: e.el, provider: e.provider, area });
  }
  candidates.sort((a, b) => b.area - a.area);
  let primary: Target | null = candidates[0] ?? null;
  let anchor: Element | null = null;
  if (!primary) {
    // Non-visual media (e.g. <audio>) can still provide time + text tracks. Only accept media
    // that is plausibly the lesson: has an English track, is playing, or is long.
    const media = [...hidden, ...audios].filter((m) => mediaScore(m) > 0).sort((a, b) => mediaScore(b) - mediaScore(a));
    if (media[0]) primary = { kind: 'media', el: media[0], provider: frameAdapter.id === 'html5' ? 'html5' : frameAdapter.id, area: 0 };
    anchor = findPlayerAnchor(doc);
  }
  return { primary, videos, audios, embeds, anchor };
}

/**
 * Watches the DOM for added/removed media and player iframes and reports when the primary target
 * changes. Uses a single MutationObserver (childList + media src changes) — no polling.
 */
export class VideoDetector {
  private observer: MutationObserver | null = null;
  /** Open shadow roots we also observe: mutations and non-composed media events inside a shadow
   *  root never reach document-level observers/listeners (real Skool page has 7 such roots). */
  private shadowRoots = new Set<ShadowRoot>();
  private scheduled = false;
  lastScanAt = 0;
  private last: DetectionResult = { primary: null, videos: [], audios: [], embeds: [], anchor: null };
  private readonly listeners = new Set<(r: DetectionResult, changed: boolean) => void>();

  constructor(
    private readonly doc: Document,
    private readonly adapter: PlayerAdapter,
    private readonly schedule: (cb: () => void) => void = (cb) => setTimeout(cb, 120),
  ) {}

  get result(): DetectionResult {
    return this.last;
  }

  onChange(cb: (r: DetectionResult, changed: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): DetectionResult {
    this.scan();
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        const attrHit = r.type === 'attributes' && /^(VIDEO|AUDIO|IFRAME|SOURCE)$/.test((r.target as Element).tagName);
        if (attrHit || this.touchesMedia(r.addedNodes) || this.touchesMedia(r.removedNodes)) {
          this.requestScan();
          return;
        }
      }
    });
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    this.watchShadowRoots();
    // Media becoming playable/visible after metadata loads (also catches <audio> starting to play).
    this.doc.addEventListener('loadedmetadata', this.onMedia, true);
    this.doc.addEventListener('play', this.onMedia, true);
    return this.last;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('loadedmetadata', this.onMedia, true);
    this.doc.removeEventListener('play', this.onMedia, true);
    for (const sr of this.shadowRoots) {
      sr.removeEventListener('loadedmetadata', this.onMedia, true);
      sr.removeEventListener('play', this.onMedia, true);
    }
    this.shadowRoots.clear();
  }

  get observedShadowRoots(): number {
    return this.shadowRoots.size;
  }

  /** Observe newly found open shadow roots (bounded); forget ones that left the document. */
  private watchShadowRoots(): void {
    if (!this.observer) return;
    for (const sr of this.shadowRoots) if (!sr.host.isConnected) this.shadowRoots.delete(sr);
    for (const sr of openShadowRoots(this.doc)) {
      if (this.shadowRoots.has(sr) || this.shadowRoots.size >= 100) continue;
      this.shadowRoots.add(sr);
      this.observer.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      sr.addEventListener('loadedmetadata', this.onMedia, true);
      sr.addEventListener('play', this.onMedia, true);
    }
  }

  private onMedia = () => this.requestScan();

  private touchesMedia(nodes: NodeList): boolean {
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (/^(VIDEO|AUDIO|IFRAME|CANVAS)$/.test(el.tagName)) return true;
      if (el.firstElementChild && el.querySelector('video, audio, iframe, canvas')) return true;
    }
    return false;
  }

  requestScan(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.scan();
    });
  }

  scan(): DetectionResult {
    const next = detect(this.doc, this.adapter);
    this.lastScanAt = Date.now();
    this.watchShadowRoots();
    const changed =
      next.primary?.el !== this.last.primary?.el ||
      (!!this.last.primary && !this.last.primary.el.isConnected) ||
      next.embeds.length !== this.last.embeds.length ||
      next.anchor !== this.last.anchor ||
      next.audios.length !== this.last.audios.length;
    this.last = next;
    for (const l of this.listeners) l(next, changed);
    return next;
  }
}
