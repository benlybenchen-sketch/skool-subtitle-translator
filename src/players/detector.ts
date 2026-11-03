import type { ProviderId } from '../shared/types';
import { adapterForIframe, providerForVideo, type PlayerAdapter } from './adapters';

export type Target =
  | { kind: 'video'; el: HTMLVideoElement; provider: ProviderId; area: number }
  | { kind: 'iframe'; el: HTMLIFrameElement; provider: ProviderId; area: number };

export interface DetectionResult {
  primary: Target | null;
  videos: HTMLVideoElement[];
  embeds: { el: HTMLIFrameElement; provider: ProviderId }[];
}

const MIN_AREA = 160 * 90;

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect();
  const w = r.width || (el as HTMLElement).offsetWidth || 0;
  const h = r.height || (el as HTMLElement).offsetHeight || 0;
  return w * h;
}

/** Synchronous scan of a document for lesson videos and player iframes. */
export function detect(doc: Document, frameAdapter: PlayerAdapter): DetectionResult {
  const videos = [...doc.querySelectorAll('video')];
  const embeds: DetectionResult['embeds'] = [];
  for (const el of doc.querySelectorAll('iframe')) {
    const a = adapterForIframe(el, doc.baseURI);
    if (a) embeds.push({ el, provider: a.id });
  }
  const candidates: Target[] = [];
  for (const v of videos) {
    const area = visibleArea(v);
    // A video with a real source but no layout yet (lazy) still counts weakly.
    const hasMedia = !!(v.currentSrc || v.src || v.querySelector('source') || v.srcObject || v.textTracks?.length);
    if (area >= MIN_AREA || (hasMedia && area > 0)) {
      candidates.push({ kind: 'video', el: v, provider: providerForVideo(v, frameAdapter), area: area + (v.paused ? 0 : 1e7) });
    }
  }
  for (const e of embeds) {
    const area = visibleArea(e.el);
    if (area >= MIN_AREA) candidates.push({ kind: 'iframe', el: e.el, provider: e.provider, area });
  }
  candidates.sort((a, b) => b.area - a.area);
  return { primary: candidates[0] ?? null, videos, embeds };
}

/**
 * Watches the DOM for added/removed videos and player iframes and reports
 * when the primary target changes. Uses a single MutationObserver (childList +
 * src attribute changes) — no polling. Callbacks are coalesced per frame.
 */
export class VideoDetector {
  private observer: MutationObserver | null = null;
  private scheduled = false;
  private last: DetectionResult = { primary: null, videos: [], embeds: [] };
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
        const attrHit = r.type === 'attributes' && /^(VIDEO|IFRAME|SOURCE)$/.test((r.target as Element).tagName);
        if (attrHit || this.touchesMedia(r.addedNodes) || this.touchesMedia(r.removedNodes)) {
          this.requestScan();
          return;
        }
      }
    });
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    // Videos becoming playable/visible after metadata loads.
    this.doc.addEventListener('loadedmetadata', this.onMedia, true);
    this.doc.addEventListener('play', this.onMedia, true);
    return this.last;
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('loadedmetadata', this.onMedia, true);
    this.doc.removeEventListener('play', this.onMedia, true);
  }

  private onMedia = () => this.requestScan();

  private touchesMedia(nodes: NodeList): boolean {
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') return true;
      if (el.firstElementChild && el.querySelector('video, iframe')) return true;
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
    const changed = next.primary?.el !== this.last.primary?.el || next.embeds.length !== this.last.embeds.length;
    this.last = next;
    for (const l of this.listeners) l(next, changed);
    return next;
  }
}
