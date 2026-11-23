import type { Transcript } from '../transcript/model';
import { generateNotes, type CompleteFn, type NotesBudget } from '../notes/generate';
import type { NotesRecord } from '../notes/render';
import { hash53 } from '../shared/hash';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

const KEY = (lessonId: string) => `notes:${lessonId}`;
const MAX_TRANSCRIPT_SEGMENTS = 20_000;

export interface NotesDeps {
  storage: Area;
  /** Structured completion with the current provider (low priority, consent-checked). */
  complete: (req: Parameters<CompleteFn>[0], o: { signal: AbortSignal; lesson: string }) => Promise<string>;
  activeModel: () => Promise<{ provider: string; model: string }>;
  glossary: () => Promise<string>;
  now?: () => number;
  budget?: Partial<NotesBudget>;
}

/** Saved AI Study Notes (local only) + generation with cancellation and intermediate reuse. */
export class NotesManager {
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly d: NotesDeps) {}

  async get(lessonId: string): Promise<NotesRecord | null> {
    const k = KEY(lessonId);
    const r = (await this.d.storage.get(k))[k] as NotesRecord | undefined;
    if (!r) return null;
    const { chunks: _c, ...rest } = r; // intermediate results stay in the worker
    return rest;
  }

  async saveEdit(lessonId: string, editedMarkdown: string | null): Promise<NotesRecord | null> {
    const k = KEY(lessonId);
    const r = (await this.d.storage.get(k))[k] as NotesRecord | undefined;
    if (!r) return null;
    if (editedMarkdown && editedMarkdown.trim()) {
      r.editedMarkdown = editedMarkdown.slice(0, 200_000);
      r.editedAt = (this.d.now ?? Date.now)();
    } else {
      delete r.editedMarkdown;
      delete r.editedAt;
    }
    await this.d.storage.set({ [k]: r });
    return this.get(lessonId);
  }

  async remove(lessonId: string): Promise<void> {
    await this.d.storage.remove(KEY(lessonId));
  }

  isRunning(lessonId: string): boolean {
    return this.running.has(lessonId);
  }

  cancel(lessonId: string): void {
    this.running.get(lessonId)?.abort();
  }

  /** Generate (or regenerate) notes. Only ever called on an explicit user request. */
  async generate(t: Transcript, onProgress?: (done: number, total: number) => void): Promise<NotesRecord> {
    if (!t || !Array.isArray(t.segments) || !t.lessonId) throw new Error('Thiếu bản ghi bài học.');
    if (this.running.has(t.lessonId)) throw new Error('Đang tạo ghi chú cho bài này.');
    const transcript: Transcript = { ...t, segments: t.segments.slice(0, MAX_TRANSCRIPT_SEGMENTS) };
    const ac = new AbortController();
    this.running.set(t.lessonId, ac);
    try {
      const k = KEY(t.lessonId);
      const prev = (await this.d.storage.get(k))[k] as NotesRecord | undefined;
      const { provider, model } = await this.d.activeModel();
      const res = await generateNotes({
        transcript,
        glossary: await this.d.glossary().catch(() => ''),
        fingerprint: `${provider}|${model}`,
        previousChunks: prev?.chunks,
        budget: this.d.budget,
        onProgress: (done, total) => onProgress?.(Math.min(done, total), total),
        complete: (req) => this.d.complete(req, { signal: ac.signal, lesson: hash53(t.lessonId) }),
      });
      const rec: NotesRecord = {
        lessonId: t.lessonId,
        title: t.title,
        kind: t.kind,
        notes: res.notes,
        refStarts: res.refStarts,
        transcriptVersion: res.transcriptVersion,
        coverage: res.coverage,
        provider,
        model,
        createdAt: (this.d.now ?? Date.now)(),
        calls: res.calls,
        truncated: res.truncated,
        chunks: res.chunks,
      };
      await this.d.storage.set({ [k]: rec });
      const { chunks: _c, ...out } = rec;
      return out;
    } finally {
      this.running.delete(t.lessonId);
    }
  }
}
