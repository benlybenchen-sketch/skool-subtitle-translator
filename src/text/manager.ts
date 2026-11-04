import type { Settings, TextDisplayMode } from '../shared/types';
import { isClassroomUrl, lessonKey } from '../skool/navigation';
import { hash53 } from '../shared/hash';
import { findArticle } from './article';
import { TextLessonTranslator, type TextState, type TextTranslate } from './translator';

export interface TextLessonInfo extends TextState {
  lessonId: string;
  auto: boolean;
}

export interface TextManagerDeps {
  settings: () => Settings;
  /** true while the page has (or is loading) a lesson video/player. */
  hasVideo: () => boolean;
  /** Translate with a lesson-specific cache key (the background adds the markup prompt rules). */
  translate: (videoKey: string, ...a: Parameters<TextTranslate>) => ReturnType<TextTranslate>;
  saveMode: (mode: TextDisplayMode) => void;
  onChange: (info: TextLessonInfo | null) => void;
  /** Grace period so a slow video is not mistaken for a text lesson. */
  graceMs?: number;
  /** One more look for lazily rendered content. */
  retryMs?: number;
}

/** Cache namespace for text lessons (separate from subtitles; bump on markup format changes). */
export const TEXT_KEY_PREFIX = 'text:v1:';

/**
 * Text-only lesson lifecycle (top frame): detect after a grace period, attach the translator,
 * auto-start only when the user opted in (or pressed "Dịch bài này" for this lesson), and tear
 * everything down (restoring the page) on navigation or when a video shows up.
 */
export class TextLessonManager {
  readonly translator: TextLessonTranslator;
  private key: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly manual = new Set<string>();
  private offState: () => void;

  constructor(
    private readonly win: Window,
    private readonly d: TextManagerDeps,
  ) {
    const doc = win.document;
    this.translator = new TextLessonTranslator(doc, (units, ctx, prio) => this.d.translate(TEXT_KEY_PREFIX + (this.key ?? ''), units, ctx, prio), d.settings().textDisplayMode, {
      onLost: () => this.check(),
    });
    this.offState = this.translator.onState(() => this.notify());
  }

  get lessonId(): string | null {
    return this.key ? hash53(TEXT_KEY_PREFIX + this.key) : null;
  }

  get active(): boolean {
    return !!this.translator.attached;
  }

  info(): TextLessonInfo | null {
    if (!this.translator.attached || !this.key) return null;
    return { ...this.translator.state(), lessonId: this.lessonId!, auto: this.d.settings().autoTranslateTextLessons };
  }

  private notify(): void {
    this.d.onChange(this.info());
  }

  /** (Re)evaluate the current page: called on start, navigation and detector changes. */
  check(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    const url = new URL(this.win.location.href);
    const key = lessonKey(url);
    if (!isClassroomUrl(url) || !this.d.settings().enabled || this.d.hasVideo()) {
      this.stop();
      return;
    }
    if (key !== this.key && this.translator.attached) this.stop();
    const attempt = (last: boolean) => {
      if (this.d.hasVideo()) return this.stop();
      const art = findArticle(this.win.document);
      if (!art) {
        if (last) this.stop();
        return;
      }
      if (this.translator.attached !== art) {
        this.key = key;
        this.translator.attach(art);
      }
      if (this.d.settings().autoTranslateTextLessons || this.manual.has(key)) this.translator.start();
      this.notify();
    };
    this.timers.push(setTimeout(() => attempt(false), this.d.graceMs ?? 2500));
    this.timers.push(setTimeout(() => attempt(true), (this.d.graceMs ?? 2500) + (this.d.retryMs ?? 3000)));
  }

  /** A video appeared (or the lesson changed): restore the page. */
  stop(): void {
    if (!this.translator.attached && !this.key) return;
    this.translator.detach();
    this.key = null;
    this.notify();
  }

  /** "Dịch bài này" (manual start for this lesson). */
  translateNow(): void {
    if (!this.key) return;
    this.manual.add(this.key);
    this.translator.start();
  }

  setMode(mode: TextDisplayMode): void {
    this.translator.setMode(mode);
    this.d.saveMode(mode);
  }

  retry(): void {
    this.translator.retry();
  }

  /** Settings changed (e.g. auto-translate just enabled, or display mode from another tab). */
  updateSettings(s: Settings): void {
    if (!s.enabled) return this.stop();
    if (this.translator.state().mode !== s.textDisplayMode) this.translator.setMode(s.textDisplayMode);
    if (s.autoTranslateTextLessons && this.translator.attached && !this.translator.state().started) this.translator.start();
    this.notify();
  }

  destroy(): void {
    this.timers.forEach(clearTimeout);
    this.offState();
    this.translator.detach();
  }
}
