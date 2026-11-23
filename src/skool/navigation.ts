/**
 * Detects same-document (SPA) navigations in Skool without patching page
 * scripts and without polling:
 *  - Navigation API `currententrychange` (Chrome 102+) fires for pushState/replaceState
 *  - `popstate` / `hashchange` for back/forward
 *  - `check()` can be called by the DOM observer as a cheap extra safety net
 */
export class NavigationWatcher {
  private last: string;
  private readonly cleanups: (() => void)[] = [];
  private readonly extra = new Set<(url: string, prev: string) => void>();

  /** Additional lesson-change listener (e.g. the text-lesson translator). */
  onNavigate(cb: (url: string, prev: string) => void): () => void {
    this.extra.add(cb);
    return () => this.extra.delete(cb);
  }

  constructor(
    private readonly win: Window,
    private readonly onChange: (url: string, prev: string) => void,
    private readonly keyOf: (url: URL) => string = lessonKey,
  ) {
    this.last = this.key();
  }

  private key(): string {
    try {
      return this.keyOf(new URL(this.win.location.href));
    } catch {
      return this.win.location.href;
    }
  }

  start(): void {
    const check = () => this.check();
    this.win.addEventListener('popstate', check);
    this.win.addEventListener('hashchange', check);
    this.cleanups.push(() => this.win.removeEventListener('popstate', check));
    this.cleanups.push(() => this.win.removeEventListener('hashchange', check));
    const nav = (this.win as Window & { navigation?: EventTarget }).navigation;
    if (nav?.addEventListener) {
      nav.addEventListener('currententrychange', check);
      this.cleanups.push(() => nav.removeEventListener('currententrychange', check));
    }
  }

  check(): boolean {
    const k = this.key();
    if (k === this.last) return false;
    const prev = this.last;
    this.last = k;
    this.onChange(this.win.location.href, prev);
    for (const cb of this.extra) cb(this.win.location.href, prev);
    return true;
  }

  stop(): void {
    for (const c of this.cleanups.splice(0)) c();
  }
}

/** Lesson identity: path + the `md` (lesson) query parameter used by Skool Classroom. */
export function lessonKey(u: URL): string {
  const md = u.searchParams.get('md');
  return u.origin + u.pathname + (md ? `?md=${md}` : '');
}

export function isClassroomUrl(u: URL): boolean {
  return /\/classroom(\/|$)/.test(u.pathname);
}
