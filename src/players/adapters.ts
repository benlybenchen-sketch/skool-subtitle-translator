import type { ProviderId } from '../shared/types';

/**
 * Provider adapters. Each adapter answers three questions:
 *  1. Does this frame (by its own location) belong to the provider?
 *  2. Does this iframe element (by its src) embed the provider?
 *  3. Given the frame location, what is the stable video identity?
 * plus optional DOM caption selectors for players that render captions as
 * HTML instead of exposing a TextTrack.
 *
 * Only public, documented URL shapes (embed URLs) are used for detection.
 */
export interface PlayerAdapter {
  id: ProviderId;
  label: string;
  matchesFrame(loc: URL): boolean;
  matchesIframeSrc(src: URL): boolean;
  videoIdFromUrl(url: URL): string | null;
  /** Extra check for HTML5 videos inside the page DOM (e.g. JS embeds). */
  ownsVideo?(video: HTMLVideoElement): boolean;
  /**
   * CSS selectors of caption text rendered in the DOM. Used only when no
   * TextTrack is available. Heuristic — must be verified manually.
   */
  domCaptionSelectors?: string[];
}

const host = (u: URL) => u.hostname.toLowerCase();
const isHost = (u: URL, ...hosts: string[]) => hosts.some((h) => host(u) === h || host(u).endsWith('.' + h));

export const loomAdapter: PlayerAdapter = {
  id: 'loom',
  label: 'Loom',
  matchesFrame: (u) => isHost(u, 'loom.com') && /^\/(embed|share)\//.test(u.pathname),
  matchesIframeSrc: (u) => isHost(u, 'loom.com') && /^\/(embed|share)\//.test(u.pathname),
  videoIdFromUrl: (u) => u.pathname.match(/^\/(?:embed|share)\/([a-zA-Z0-9]+)/)?.[1] ?? null,
};

export const vimeoAdapter: PlayerAdapter = {
  id: 'vimeo',
  label: 'Vimeo',
  matchesFrame: (u) => host(u) === 'player.vimeo.com',
  matchesIframeSrc: (u) => host(u) === 'player.vimeo.com' || (isHost(u, 'vimeo.com') && /^\/\d+/.test(u.pathname)),
  videoIdFromUrl: (u) => u.pathname.match(/(?:^\/video\/|^\/)(\d+)/)?.[1] ?? null,
};

export const youtubeAdapter: PlayerAdapter = {
  id: 'youtube',
  label: 'YouTube',
  matchesFrame: (u) => isHost(u, 'youtube.com', 'youtube-nocookie.com') && u.pathname.startsWith('/embed/'),
  matchesIframeSrc: (u) =>
    (isHost(u, 'youtube.com', 'youtube-nocookie.com') && u.pathname.startsWith('/embed/')) || host(u) === 'youtu.be',
  videoIdFromUrl: (u) =>
    u.pathname.match(/^\/embed\/([\w-]{6,})/)?.[1] ?? (host(u) === 'youtu.be' ? u.pathname.slice(1) || null : u.searchParams.get('v')),
  // YouTube renders captions (when the viewer turns CC on) as DOM segments.
  domCaptionSelectors: ['.ytp-caption-window-container .ytp-caption-segment'],
};

export const wistiaAdapter: PlayerAdapter = {
  id: 'wistia',
  label: 'Wistia',
  matchesFrame: (u) => isHost(u, 'wistia.net', 'wistia.com') && /^\/embed\//.test(u.pathname),
  matchesIframeSrc: (u) => isHost(u, 'wistia.net', 'wistia.com') && /^\/embed\//.test(u.pathname),
  videoIdFromUrl: (u) => u.pathname.match(/^\/embed\/(?:iframe|medias)\/([a-z0-9]+)/i)?.[1] ?? null,
  ownsVideo: (v) => !!v.closest('.wistia_embed, [class*="wistia_async_"], .w-chrome') || /wistia/i.test(v.currentSrc || v.src),
};

const SKOOL_HOSTS = ['skool.com'];
export const isSkoolUrl = (u: URL) => isHost(u, ...SKOOL_HOSTS);

/** Skool's own player: an HTML5 <video> inside a skool.com document. */
export const skoolNativeAdapter: PlayerAdapter = {
  id: 'skool-native',
  label: 'Skool Native',
  matchesFrame: (u) => isSkoolUrl(u),
  matchesIframeSrc: (u) => isSkoolUrl(u),
  videoIdFromUrl: (u) => {
    // Classroom lessons look like /{group}/classroom/{courseId}?md={lessonId}
    const md = u.searchParams.get('md');
    return u.pathname + (md ? `?md=${md}` : '');
  },
};

export const html5Adapter: PlayerAdapter = {
  id: 'html5',
  label: 'HTML5 video',
  matchesFrame: () => true,
  matchesIframeSrc: () => false,
  videoIdFromUrl: (u) => u.origin + u.pathname,
};

/** Order matters: specific providers first, generic last. */
export const EMBED_ADAPTERS: PlayerAdapter[] = [loomAdapter, vimeoAdapter, youtubeAdapter, wistiaAdapter];
export const ALL_ADAPTERS: PlayerAdapter[] = [...EMBED_ADAPTERS, skoolNativeAdapter, html5Adapter];

export function adapterById(id: ProviderId): PlayerAdapter {
  return ALL_ADAPTERS.find((a) => a.id === id) ?? html5Adapter;
}

export function safeUrl(src: string | null | undefined, base?: string): URL | null {
  if (!src) return null;
  try {
    return new URL(src, base);
  } catch {
    return null;
  }
}

/** Adapter for the document this content script runs in. */
export function adapterForFrame(loc: URL): PlayerAdapter {
  return EMBED_ADAPTERS.find((a) => a.matchesFrame(loc)) ?? (isSkoolUrl(loc) ? skoolNativeAdapter : html5Adapter);
}

export function adapterForIframe(iframe: HTMLIFrameElement, base: string): PlayerAdapter | null {
  const u = safeUrl(iframe.getAttribute('src') || iframe.src, base);
  if (!u) return null;
  return EMBED_ADAPTERS.find((a) => a.matchesIframeSrc(u)) ?? null;
}

/** Which provider owns a <video> element found in a frame. */
export function providerForVideo(video: HTMLVideoElement, frameAdapter: PlayerAdapter): ProviderId {
  if (frameAdapter.id !== 'skool-native' && frameAdapter.id !== 'html5') return frameAdapter.id;
  if (wistiaAdapter.ownsVideo!(video)) return 'wistia';
  return frameAdapter.id;
}

/** Strip volatile query strings (signed URLs) from a media URL. */
export function stableMediaSrc(src: string): string | null {
  if (!src || src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('mediastream:')) return null;
  const u = safeUrl(src);
  return u ? u.origin + u.pathname : null;
}
