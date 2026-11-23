import type { Settings } from '../shared/types';
import { clamp } from '../shared/util';
import { OVERLAY_CSS } from './styles';
import { addFullscreenListener, apiFullscreenElement, mountParent } from './fullscreen';

export interface OverlayContent {
  vi?: string;
  en?: string;
}

export type OverlayStyle = Pick<
  Settings,
  'displayMode' | 'fontScale' | 'bottomOffsetPct' | 'background' | 'backgroundOpacity' | 'outline' | 'shadow'
>;

export const OVERLAY_HOST_ATTR = 'data-sst-overlay';

/**
 * Subtitle overlay positioned over a target element (video or player iframe).
 * - Shadow DOM isolates styles from Skool's CSS (and vice-versa).
 * - pointer-events: none so player controls stay clickable.
 * - Follows the target with ResizeObserver + scroll/resize listeners (rAF-throttled).
 * - Re-parents itself into the fullscreen element when the target goes fullscreen.
 * - Only touches the DOM when the displayed text actually changes.
 */
export class SubtitleOverlay {
  readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly box: HTMLDivElement;
  private readonly viEl: HTMLDivElement;
  private readonly enEl: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private target: Element | null = null;
  private ro: ResizeObserver | null = null;
  private rafPending = false;
  private style: OverlayStyle;
  private lastKey = '';
  private visible = true;
  private height = 0;
  private readonly fsListeners = new Set<() => void>();
  private readonly containerListeners = new Set<(el: Element) => void>();
  private offFs: () => void;
  private destroyed = false;

  constructor(
    private readonly doc: Document,
    style: OverlayStyle,
  ) {
    this.style = style;
    this.host = doc.createElement('div');
    this.host.setAttribute(OVERLAY_HOST_ATTR, '');
    const shadow = this.host.attachShadow({ mode: 'open' });
    const css = doc.createElement('style');
    css.textContent = OVERLAY_CSS;
    this.root = doc.createElement('div');
    this.root.className = 'root';
    this.box = doc.createElement('div');
    this.box.className = 'box';
    this.viEl = doc.createElement('div');
    this.viEl.className = 'line vi hidden';
    this.viEl.setAttribute('lang', 'vi');
    this.enEl = doc.createElement('div');
    this.enEl.className = 'line en hidden';
    this.enEl.setAttribute('lang', 'en');
    this.badge = doc.createElement('div');
    this.badge.className = 'badge hidden';
    this.box.append(this.viEl, this.enEl);
    this.root.append(this.box, this.badge);
    shadow.append(css, this.root);
    this.mount();
    this.offFs = addFullscreenListener(doc, this.onFullscreen);
    doc.defaultView?.addEventListener('resize', this.schedule, { passive: true });
    doc.addEventListener('scroll', this.schedule, { passive: true, capture: true });
    this.applyStyle();
  }

  /** Element that currently hosts the overlay (body or fullscreen element). */
  get container(): Element | null {
    return this.host.parentElement;
  }

  /** Notified whenever the overlay moves to another container (fullscreen enter/exit). */
  onContainerChange(cb: (el: Element) => void): () => void {
    this.containerListeners.add(cb);
    return () => this.containerListeners.delete(cb);
  }

  onFullscreenChange(cb: () => void): () => void {
    this.fsListeners.add(cb);
    return () => this.fsListeners.delete(cb);
  }

  setTarget(el: Element | null): void {
    if (el === this.target) return;
    this.ro?.disconnect();
    this.target = el;
    if (el && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(this.schedule);
      this.ro.observe(el);
    }
    this.mount();
    this.schedule();
  }

  setStyle(style: OverlayStyle): void {
    this.style = style;
    this.lastKey = '';
    this.applyStyle();
    this.schedule();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  setIndicator(text: string | null): void {
    this.badge.textContent = text ?? '';
    this.badge.classList.toggle('hidden', !text);
  }

  /**
   * Show subtitle content. In Vietnamese-only mode, an untranslated segment is
   * shown as dimmed English so the viewer is never left without text.
   */
  show(content: OverlayContent | null): void {
    const bilingual = this.style.displayMode === 'bilingual';
    let vi = content?.vi ?? '';
    let en = bilingual ? content?.en ?? '' : '';
    let pending = false;
    if (!vi && content?.en) {
      if (bilingual) {
        en = content.en;
      } else {
        vi = content.en;
        pending = true;
      }
    }
    const key = `${vi}\u0000${en}\u0000${pending}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.viEl.textContent = vi;
    this.viEl.classList.toggle('hidden', !vi);
    this.viEl.classList.toggle('pending', pending);
    this.enEl.textContent = en;
    this.enEl.classList.toggle('hidden', !en);
  }

  get text(): { vi: string; en: string } {
    return { vi: this.viEl.textContent ?? '', en: this.enEl.textContent ?? '' };
  }

  /** True when the <video> element itself is fullscreen — overlays cannot render above it. */
  isNativeVideoFullscreen(): boolean {
    const fs = this.fullscreenElement();
    return !!fs && fs.tagName === 'VIDEO';
  }

  destroy(): void {
    this.destroyed = true;
    this.ro?.disconnect();
    this.offFs();
    this.doc.defaultView?.removeEventListener('resize', this.schedule);
    this.doc.removeEventListener('scroll', this.schedule, { capture: true } as EventListenerOptions);
    this.host.remove();
    this.fsListeners.clear();
    this.containerListeners.clear();
  }

  private fullscreenElement(): Element | null {
    return apiFullscreenElement(this.doc);
  }

  private onFullscreen = () => {
    this.mount();
    this.schedule();
    for (const l of this.fsListeners) l();
  };

  /**
   * Place the host inside the active fullscreen element (API or CSS pseudo-fullscreen), else <body>.
   * Moving the same node never duplicates it; `contains()` is not required because the player's
   * <video> may live inside a shadow root of the fullscreen element.
   */
  private mount(): void {
    if (this.destroyed) return; // a pending rAF/fullscreen callback must not resurrect the host
    const parent = mountParent(this.doc, this.target);
    if (this.host.parentElement === parent) return;
    parent.appendChild(this.host);
    for (const l of this.containerListeners) l(parent);
  }

  private schedule = () => {
    if (this.rafPending) return;
    this.rafPending = true;
    const raf = this.doc.defaultView?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    raf(() => {
      this.rafPending = false;
      this.layout();
    });
  };

  /**
   * Geometry source: the target element, or — page-level fallback when no media element is
   * accessible — the fullscreen element or the viewport.
   */
  private rect(): { left: number; top: number; width: number; height: number } | null {
    if (this.target) return this.target.getBoundingClientRect();
    const fs = this.fullscreenElement();
    if (fs && fs.tagName !== 'IFRAME' && fs.tagName !== 'VIDEO') return fs.getBoundingClientRect();
    const w = this.doc.defaultView;
    return w ? { left: 0, top: 0, width: w.innerWidth, height: w.innerHeight } : null;
  }

  /** True when positioned over the page/viewport instead of a media element. */
  get pageLevel(): boolean {
    return !this.target;
  }

  /** Recompute geometry. Public for tests. */
  layout(): void {
    if (this.destroyed) return;
    const r = this.rect();
    if (!r || r.width < 2 || r.height < 2) {
      this.root.style.width = '0px';
      this.root.style.height = '0px';
      return;
    }
    // CSS pseudo-fullscreen has no event: re-check the container when the target fills the viewport
    // or when we are currently mounted in such a container.
    const w = this.doc.defaultView;
    if (w && !this.fullscreenElement() && (this.host.parentElement !== this.doc.body || (r.width >= w.innerWidth * 0.95 && r.height >= w.innerHeight * 0.95))) {
      this.mount();
    }
    this.root.style.left = `${r.left}px`;
    this.root.style.top = `${r.top}px`;
    this.root.style.width = `${r.width}px`;
    this.root.style.height = `${r.height}px`;
    if (Math.abs(r.height - this.height) > 1) {
      this.height = r.height;
      this.applyStyle();
    }
  }

  private applyStyle(): void {
    const s = this.style;
    // Page-level mode: size text as if over a ~600px tall player, not the full viewport.
    const h = Math.min(this.height || 360, this.target ? Infinity : 600);
    const fontPx = clamp(h * 0.05 * s.fontScale, 12, 72);
    this.box.style.fontSize = `${fontPx.toFixed(1)}px`;
    this.box.style.bottom = `${clamp(s.bottomOffsetPct, 2, 60)}%`;
    const bg = s.background ? `rgba(0,0,0,${clamp(s.backgroundOpacity, 0, 1)})` : 'transparent';
    const shadows: string[] = [];
    if (s.shadow) shadows.push('0 0 4px rgba(0,0,0,.9)', '0 2px 3px rgba(0,0,0,.8)');
    for (const el of [this.viEl, this.enEl]) {
      el.style.background = bg;
      el.style.textShadow = shadows.join(', ') || 'none';
      el.style.webkitTextStroke = s.outline ? `${Math.max(0.6, fontPx / 28).toFixed(2)}px rgba(0,0,0,.85)` : '0';
      (el.style as CSSStyleDeclaration & { paintOrder?: string }).paintOrder = 'stroke fill';
    }
    this.root.classList.toggle('hidden', !this.visible);
  }
}
