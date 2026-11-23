import type { FrameStatus } from '../shared/types';
import { deepQueryAll, type DetectionResult } from '../players/detector';
import { safeUrl } from '../players/adapters';

/**
 * Read-only page diagnostics: what media/player structures are ACCESSIBLE to the extension.
 * Collects no page text, no cookies, and strips query strings from URLs. Closed shadow roots are
 * not (and cannot be) inspected; custom elements without an open shadow root are only listed as
 * possible hosts.
 */
export interface FrameDiagnostics {
  url: string;
  isTop: boolean;
  videoLight: number;
  videoInOpenShadow: number;
  audioLight: number;
  audioInOpenShadow: number;
  media: {
    tag: string;
    inShadow: boolean;
    paused: boolean;
    currentTime: number;
    duration: number | null;
    readyState: number;
    src: string;
    size: string;
    textTracks: { kind: string; language: string; label: string; mode: string; cues: number | null }[];
  }[];
  iframes: { host: string; size: string }[];
  canvases: { size: string }[];
  openShadowRoots: number;
  customElementsWithoutOpenShadow: { tag: string; size: string }[];
  pageAnchor: string | null;
  detection: { primaryKind: string | null; provider: string | null; primaryConnected: boolean | null; primaryInShadow: boolean | null };
  /** URL has a lesson id (?md=…) — the value itself is not reported. */
  lessonParam: boolean;
  status: Pick<FrameStatus, 'mode' | 'captionState' | 'captionSource' | 'targetKind'>;
}

const size = (el: Element) => {
  const r = el.getBoundingClientRect();
  return `${Math.round(r.width)}x${Math.round(r.height)}`;
};

const cleanSrc = (s: string) => {
  if (!s) return '';
  if (s.startsWith('blob:')) return 'blob: (MediaSource stream)';
  if (s.startsWith('data:')) return 'data:';
  const u = safeUrl(s);
  return u ? u.origin + u.pathname : '(invalid)';
};

const describe = (el: Element | null) =>
  el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : ''} ${size(el)}` : null;

export function collectDiagnostics(doc: Document, det: DetectionResult, status: Omit<FrameStatus, 'frameId'>): FrameDiagnostics {
  const lightVideos = new Set(doc.querySelectorAll('video'));
  const lightAudios = new Set(doc.querySelectorAll('audio'));
  const allVideos = deepQueryAll<HTMLVideoElement>(doc, 'video');
  const allAudios = deepQueryAll<HTMLAudioElement>(doc, 'audio');
  let openShadowRoots = 0;
  const customNoShadow: FrameDiagnostics['customElementsWithoutOpenShadow'] = [];
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  let n = 0;
  for (let node = walker.nextNode(); node && n < 25_000; node = walker.nextNode(), n++) {
    const el = node as Element;
    if (el.shadowRoot) openShadowRoots++;
    else if (el.tagName.includes('-') && customNoShadow.length < 20) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 100) customNoShadow.push({ tag: el.tagName.toLowerCase(), size: size(el) });
    }
  }
  const media = [...allVideos, ...allAudios].map((m) => {
    const tracks: FrameDiagnostics['media'][number]['textTracks'] = [];
    for (let i = 0; i < (m.textTracks?.length ?? 0); i++) {
      const t = m.textTracks[i];
      tracks.push({ kind: t.kind, language: t.language, label: t.label, mode: t.mode, cues: t.cues ? t.cues.length : null });
    }
    return {
      tag: m.tagName.toLowerCase(),
      inShadow: !(lightVideos.has(m as HTMLVideoElement) || lightAudios.has(m as HTMLAudioElement)),
      paused: m.paused,
      currentTime: Math.round(m.currentTime * 10) / 10,
      duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null,
      readyState: m.readyState,
      src: m.srcObject ? 'srcObject (MediaStream)' : cleanSrc(m.currentSrc || m.src),
      size: size(m),
      textTracks: tracks,
    };
  });
  return {
    url: cleanSrc(doc.location.href),
    isTop: doc.defaultView?.top === doc.defaultView,
    videoLight: lightVideos.size,
    videoInOpenShadow: allVideos.length - lightVideos.size,
    audioLight: lightAudios.size,
    audioInOpenShadow: allAudios.length - lightAudios.size,
    media,
    iframes: [...doc.querySelectorAll('iframe')].map((f) => ({ host: safeUrl(f.src)?.host ?? '(none)', size: size(f) })),
    canvases: [...doc.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 100).map((c) => ({ size: size(c) })),
    openShadowRoots,
    customElementsWithoutOpenShadow: customNoShadow,
    pageAnchor: describe(det.anchor),
    detection: {
      primaryKind: det.primary?.kind ?? null,
      provider: det.primary?.provider ?? null,
      primaryConnected: det.primary ? det.primary.el.isConnected : null,
      primaryInShadow: det.primary ? det.primary.el.getRootNode() instanceof ShadowRoot : null,
    },
    lessonParam: new URL(doc.location.href).searchParams.has('md'),
    status: { mode: status.mode, captionState: status.captionState, captionSource: status.captionSource, targetKind: status.targetKind },
  };
}
