import type { Secrets, Settings } from '../shared/types';
import type { ContentMessage } from '../shared/messages';
import { base64ToUint8 } from '../shared/util';
import { createSttBackend } from '../speech/backends';
import type { SttBackend } from '../speech/types';
import { LiveSegmentAssembler, type LiveSegment } from '../speech/assembler';
import { HttpError } from '../translation/errors';
import { sttIsRemote } from '../shared/settings';
import type { TabRegistry } from './tabRegistry';

export interface AudioDeps {
  registry: TabRegistry;
  getSettings: () => Promise<Settings>;
  getSecrets: () => Promise<Secrets>;
  ensureOffscreen: () => Promise<void>;
  closeOffscreen: () => Promise<void>;
  sendOffscreen: (msg: { type: 'start'; streamId: string; sessionId: string } | { type: 'stop' }) => Promise<void>;
  sendToFrame: (tabId: number, frameId: number | null, msg: ContentMessage) => Promise<void>;
  broadcast: (tabId: number, msg: ContentMessage) => Promise<void>;
  translate: (videoKey: string, text: string, id: string, context: string[]) => Promise<{ vi?: string; error?: string; fatal?: boolean }>;
  setBadge: (tabId: number, text: string) => void;
  hasEndpointPermission?: (endpoint: string) => Promise<boolean>;
  sttFactory?: (s: Settings, secrets: Secrets) => SttBackend;
  sessionStore?: { set(v: Record<string, unknown>): Promise<void>; get(k: string): Promise<Record<string, unknown>> };
  now?: () => number;
}

interface ActiveSession {
  id: string;
  tabId: number;
  startedAt: number;
  assembler: LiveSegmentAssembler;
  context: string[];
  sttInFlight: number;
  consecutiveFailures: number;
  holdTimer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  sttLatencies: number[];
  totalLatencies: number[];
  nextSeqToEmit: number;
  readyBySeq: Map<number, { text: string; startSec: number; endSec: number; rms: number; endedAt: number } | null>;
  seenAny: boolean;
}

const MAX_STT_INFLIGHT = 2;
const MAX_FAILURES = 3;
const KEY = 'audioSession';

/**
 * Audio Mode orchestration in the background worker:
 * offscreen chunk → STT → segment assembly → translation → content overlay.
 * Measures actual latency (chunk end → text, chunk end → Vietnamese).
 */
export class AudioSessionManager {
  private session: ActiveSession | null = null;
  private restored: Promise<void>;

  constructor(private readonly d: AudioDeps) {
    this.restored = this.restore();
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** After a service-worker restart, re-attach to a session the offscreen doc still runs. */
  private async restore(): Promise<void> {
    const data = await this.d.sessionStore?.get(KEY).catch(() => ({}) as Record<string, unknown>);
    const s = data?.[KEY] as { id: string; tabId: number; startedAt: number } | undefined;
    if (s) this.session = this.newSession(s.id, s.tabId, s.startedAt);
  }

  private newSession(id: string, tabId: number, startedAt: number): ActiveSession {
    return {
      id,
      tabId,
      startedAt,
      assembler: new LiveSegmentAssembler(),
      context: [],
      sttInFlight: 0,
      consecutiveFailures: 0,
      abort: new AbortController(),
      sttLatencies: [],
      totalLatencies: [],
      nextSeqToEmit: 0,
      readyBySeq: new Map(),
      seenAny: false,
    };
  }

  get active(): { id: string; tabId: number } | null {
    return this.session ? { id: this.session.id, tabId: this.session.tabId } : null;
  }

  async start(tabId: number, streamId: string): Promise<void> {
    await this.restored;
    const settings = await this.d.getSettings();
    if (sttIsRemote(settings) && !settings.consent.remoteAudio) {
      throw new Error('Chưa cho phép gửi âm thanh tới dịch vụ STT từ xa. Bật trong Cài đặt → Quyền riêng tư (remote audio consent required).');
    }
    if (settings.stt.kind !== 'mock' && this.d.hasEndpointPermission && !(await this.d.hasEndpointPermission(settings.stt.endpoint))) {
      throw new Error('Chưa cấp quyền truy cập endpoint STT. Mở Cài đặt và bấm "Lưu".');
    }
    if (this.session) await this.stop(this.session.tabId, 'replaced');
    const id = `a${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.session = this.newSession(id, tabId, this.now());
    await this.d.sessionStore?.set({ [KEY]: { id, tabId, startedAt: this.session.startedAt } });
    this.d.registry.setAudio(tabId, { active: true, sessionId: id, startedAt: this.session.startedAt, error: undefined, chunks: 0, droppedChunks: 0 });
    this.d.setBadge(tabId, 'REC');
    await this.d.ensureOffscreen();
    await this.d.sendOffscreen({ type: 'start', streamId, sessionId: id });
    await this.notifyState(tabId, true);
  }

  async stop(tabId: number | undefined, _reason = 'user', error?: string): Promise<void> {
    await this.restored;
    const s = this.session;
    if (!s || (tabId !== undefined && s.tabId !== tabId)) return;
    this.session = null;
    s.abort.abort();
    clearTimeout(s.holdTimer);
    await this.d.sessionStore?.set({ [KEY]: null }).catch(() => undefined);
    await this.d.sendOffscreen({ type: 'stop' }).catch(() => undefined);
    await this.d.closeOffscreen().catch(() => undefined);
    this.d.setBadge(s.tabId, '');
    this.d.registry.setAudio(s.tabId, { active: false, error });
    await this.notifyState(s.tabId, false, error);
  }

  private async notifyState(tabId: number, active: boolean, error?: string): Promise<void> {
    const primary = this.d.registry.primaryFrame(tabId);
    const status = this.d.registry.get(tabId);
    await Promise.all(
      (status.frames.length ? status.frames : [{ frameId: 0 }]).map((f) =>
        this.d.sendToFrame(tabId, f.frameId, { type: 'audio:state', active, primary: f.frameId === (primary ?? 0), error }),
      ),
    );
  }

  async onOffscreenError(sessionId: string, error: string): Promise<void> {
    await this.restored;
    if (this.session?.id !== sessionId) return;
    await this.stop(this.session.tabId, 'error', error);
  }

  async onOffscreenStopped(sessionId: string, reason: string): Promise<void> {
    await this.restored;
    if (this.session?.id !== sessionId) return;
    await this.stop(this.session.tabId, reason, reason === 'ended' ? 'Âm thanh tab đã dừng (tab đóng hoặc điều hướng).' : undefined);
  }

  async onChunk(c: { sessionId: string; seq: number; wavBase64: string; startSec: number; endSec: number; endedAt: number; rms: number }): Promise<void> {
    await this.restored;
    const s = this.session;
    if (!s || s.id !== c.sessionId) return;
    const audio = this.d.registry.setAudio(s.tabId, {});
    this.d.registry.setAudio(s.tabId, { chunks: audio.chunks + 1 });
    // A session restored after a worker restart continues at the offscreen doc's sequence.
    if (!s.seenAny && c.seq > s.nextSeqToEmit) s.nextSeqToEmit = c.seq;
    s.seenAny = true;
    if (s.sttInFlight >= MAX_STT_INFLIGHT + 1) {
      // Falling behind real time: drop this chunk rather than drift further.
      this.d.registry.setAudio(s.tabId, { droppedChunks: audio.droppedChunks + 1 });
      s.readyBySeq.set(c.seq, null);
      this.drain(s);
      return;
    }
    s.sttInFlight++;
    const settings = await this.d.getSettings();
    const secrets = await this.d.getSecrets();
    let text = '';
    try {
      const backend = (this.d.sttFactory ?? ((st, sec) => createSttBackend(st.stt, sec)))(settings, secrets);
      text = await this.transcribeWithRetry(backend, base64ToUint8(c.wavBase64), s);
      s.consecutiveFailures = 0;
      const lat = this.now() - c.endedAt;
      s.sttLatencies.push(lat);
      if (s.sttLatencies.length > 30) s.sttLatencies.shift();
      this.d.registry.setAudio(s.tabId, { sttLatencyMs: avg(s.sttLatencies), error: undefined });
    } catch (e) {
      if (s.abort.signal.aborted) return;
      s.consecutiveFailures++;
      const msg = `Lỗi nhận dạng giọng nói (STT): ${(e as Error).message}`;
      this.d.registry.setAudio(s.tabId, { error: msg });
      if (s.consecutiveFailures >= MAX_FAILURES || (e instanceof HttpError && (e.status === 401 || e.status === 403))) {
        await this.stop(s.tabId, 'error', msg + ' — Audio Mode đã dừng. Kiểm tra backend STT trong Cài đặt.');
        return;
      }
    } finally {
      s.sttInFlight--;
    }
    s.readyBySeq.set(c.seq, text ? { text, startSec: c.startSec, endSec: c.endSec, rms: c.rms, endedAt: c.endedAt } : null);
    this.drain(s);
  }

  private async transcribeWithRetry(backend: SttBackend, wav: Uint8Array, s: ActiveSession): Promise<string> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await backend.transcribe({ wav, language: 'en', prompt: s.context.slice(-2).join(' '), signal: s.abort.signal });
        return r.text;
      } catch (e) {
        last = e;
        if (s.abort.signal.aborted) throw e;
        if (e instanceof HttpError && !e.retryable) throw e;
        await new Promise((r) => setTimeout(r, e instanceof HttpError && e.retryAfterMs ? Math.min(e.retryAfterMs, 3000) : 600));
      }
    }
    throw last;
  }

  /** Emit transcripts strictly in capture order. */
  private drain(s: ActiveSession): void {
    while (s.readyBySeq.has(s.nextSeqToEmit)) {
      const item = s.readyBySeq.get(s.nextSeqToEmit);
      s.readyBySeq.delete(s.nextSeqToEmit);
      s.nextSeqToEmit++;
      if (!item) continue;
      const segs = s.assembler.push(item.text, item.startSec, item.endSec, item.rms);
      for (const seg of segs) void this.emitSegment(s, seg, item.endedAt);
      clearTimeout(s.holdTimer);
      if (s.assembler.hasPending) {
        s.holdTimer = setTimeout(() => {
          for (const seg of s.assembler.flush()) void this.emitSegment(s, seg, item.endedAt);
        }, 2500);
      }
    }
  }

  private async emitSegment(s: ActiveSession, seg: LiveSegment, endedAt: number): Promise<void> {
    const primary = this.d.registry.primaryFrame(s.tabId);
    await this.d.sendToFrame(s.tabId, primary, { type: 'live:segment', id: seg.id, en: seg.text, final: false });
    const context = s.context.slice(-3);
    s.context.push(seg.text);
    if (s.context.length > 10) s.context.shift();
    const r = await this.d.translate(`audio:${s.id}`, seg.text, seg.id, context);
    if (this.session !== s) return;
    if (r.vi) {
      s.totalLatencies.push(this.now() - endedAt);
      if (s.totalLatencies.length > 30) s.totalLatencies.shift();
      this.d.registry.setAudio(s.tabId, { totalLatencyMs: avg(s.totalLatencies) });
      await this.d.sendToFrame(s.tabId, primary, { type: 'live:segment', id: seg.id, en: seg.text, vi: r.vi, final: true });
    } else if (r.error) {
      this.d.registry.setAudio(s.tabId, { error: `Lỗi dịch: ${r.error}` });
    }
  }
}

const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : undefined);
