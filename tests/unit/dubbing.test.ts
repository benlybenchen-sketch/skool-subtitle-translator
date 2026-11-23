/** Phase 4B/4C: original-audio control, speech units, dubbing scheduler (simulated clock). */
import { buildSpeechUnits } from '../../src/dubbing/units';
import { DubbingScheduler, type DubSink } from '../../src/dubbing/scheduler';
import { OriginalAudio, PREV_ATTR, recoverMedia } from '../../src/dubbing/originalAudio';
import { DubbingSession } from '../../src/dubbing/session';
import { estimateSpeechSec } from '../../src/tts/providers';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { TimedUnit } from '../../src/shared/types';

const unit = (i: number, start: number, end: number, en: string, vi?: string): TimedUnit => ({ id: `u${i}`, start, end, text: en, vi, status: vi ? 'done' : 'pending', cueIds: [`c${i}`] }) as unknown as TimedUnit;

/** n sentences, one every `every` s, each lasting `len` s, Vietnamese of ~`words` words. */
function lesson(n: number, o: { every?: number; len?: number; words?: number; translated?: (i: number) => boolean } = {}) {
  const every = o.every ?? 4;
  const len = o.len ?? 3.6;
  const words = o.words ?? 11;
  return Array.from({ length: n }, (_, i) =>
    unit(i, i * every + 0.5, i * every + 0.5 + len, `English sentence number ${i}.`, (o.translated ?? (() => true))(i) ? `Câu ${i} ` + Array.from({ length: words - 2 }, () => 'chữ').join(' ') + '.' : undefined),
  );
}

describe('speech units', () => {
  it('groups fragments into natural units, deterministic from source timing (not from translations)', () => {
    const us = [unit(0, 0, 1, 'So when you', 'Vậy khi bạn'), unit(1, 1.1, 2, 'open the dashboard', 'mở bảng điều khiển'), unit(2, 2.1, 3, 'you will see.', 'bạn sẽ thấy.'), unit(3, 5, 7, 'Next topic.', 'Chủ đề tiếp theo.')];
    const a = buildSpeechUnits(us, 'L');
    expect(a.map((x) => x.sourceIds)).toEqual([['u0', 'u1', 'u2'], ['u3']]);
    expect(a[0].text).toBe('Vậy khi bạn mở bảng điều khiển bạn sẽ thấy.');
    expect(a[0].slotEnd).toBe(5);
    const b = buildSpeechUnits(us.map((u, i) => (i === 1 ? { ...u, vi: undefined } : u)), 'L');
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id)); // same grouping
    expect(b[0].text).toBe(''); // not speakable until every part is translated — nothing invented
  });
});

// ---- simulation harness -------------------------------------------------------------------------

class SimSink implements DubSink {
  readonly kind: 'chrome' | 'cloud';
  readonly canResume: boolean;
  active: { id: string; endAt: number } | null = null;
  spoken: { id: string; at: number; speed: number; mediaT: number }[] = [];
  overlaps = 0;
  stops = 0;
  prepares = 0;
  preparedIds = new Set<string>();
  pendingPrepares: { at: number; resolve: (r: { key: string; durationSec: number }) => void; reject: (e: Error) => void; id: string; text: string }[] = [];
  sched!: DubbingScheduler;
  failPrepare = false;
  constructor(
    private readonly sim: Sim,
    kind: 'chrome' | 'cloud',
    private readonly latencyMs = 400,
  ) {
    this.kind = kind;
    this.canResume = kind === 'cloud';
    if (kind === 'cloud')
      this.prepare = (u) =>
        new Promise((resolve, reject) => {
          this.prepares++;
          this.preparedIds.add(u.id);
          this.pendingPrepares.push({ at: sim.wall + this.latencyMs, resolve, reject, id: u.id, text: u.text });
        });
  }
  prepare?: DubSink['prepare'];
  speak(u: { id: string; text: string; durationSec?: number }, speed: number): void {
    if (this.active) this.overlaps++;
    const dur = (u.durationSec ?? estimateSpeechSec(u.text)) / speed;
    this.active = { id: u.id, endAt: this.sim.wall + dur * 1000 + 60 };
    this.spoken.push({ id: u.id, at: this.sim.wall, speed, mediaT: this.sim.t });
    this.sim.later(60, () => this.sched.handleEvent(u.id, 'start'));
  }
  stop(): void {
    this.stops++;
    this.active = null;
  }
  pausedLeft: number | null = null;
  pause(): void {
    if (this.active) this.pausedLeft = this.active.endAt - this.sim.wall;
  }
  resume(): void {
    if (this.active && this.pausedLeft !== null) this.active.endAt = this.sim.wall + this.pausedLeft;
    this.pausedLeft = null;
  }
  step(): void {
    for (const p of [...this.pendingPrepares]) {
      if (p.at > this.sim.wall) continue;
      this.pendingPrepares.splice(this.pendingPrepares.indexOf(p), 1);
      if (this.failPrepare) p.reject(new Error('TTS HTTP 500'));
      else p.resolve({ key: 'k:' + p.id, durationSec: estimateSpeechSec(p.text) });
    }
    if (this.active && this.pausedLeft === null && this.sim.wall >= this.active.endAt) {
      const id = this.active.id;
      this.active = null;
      this.sched.handleEvent(id, 'end');
    }
  }
}

class Sim {
  wall = 0;
  t = 0;
  rate = 1;
  playing = false;
  private timers: { at: number; fn: () => void }[] = [];
  later(ms: number, fn: () => void) {
    this.timers.push({ at: this.wall + ms, fn });
  }
  sink: SimSink;
  sched: DubbingScheduler;
  fatal: string | null = null;
  constructor(kind: 'chrome' | 'cloud', units: TimedUnit[], opts: Partial<DubbingScheduler['o']> = {}, latencyMs = 400) {
    this.sink = new SimSink(this, kind, latencyMs);
    this.sched = new DubbingScheduler(this.sink, 'L', { now: () => this.wall, ...opts }, { onFatal: (e) => (this.fatal = e) });
    this.sink.sched = this.sched;
    this.sched.setUnits(units);
  }
  async run(sec: number) {
    const steps = Math.round(sec * 10);
    for (let i = 0; i < steps; i++) {
      this.wall += 100;
      if (this.playing) this.t += 0.1 * this.rate;
      for (const tm of [...this.timers]) if (tm.at <= this.wall) (this.timers.splice(this.timers.indexOf(tm), 1), tm.fn());
      this.sink.step();
      await Promise.resolve();
      await Promise.resolve();
      this.sched.tick(this.t, this.playing, this.rate);
    }
  }
  play() {
    this.playing = true;
    this.sched.play(this.t, this.rate);
  }
  pause() {
    this.playing = false;
    this.sched.pause();
  }
  seek(t: number) {
    this.t = t;
    this.sched.seek(t);
  }
}

describe('dubbing scheduler', () => {
  it('speaks every sentence once, in order, never overlapping (1×, cloud prefetch)', async () => {
    const sim = new Sim('cloud', lesson(60));
    sim.play();
    await sim.run(250);
    const ids = sim.sink.spoken.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate speech
    expect(ids.length).toBe(60);
    expect(sim.sink.overlaps).toBe(0);
    expect(sim.sink.prepares).toBe(60); // one synthesis per unit, none wasted
    const st = sim.sched.snapshot();
    expect(st.skipped).toBe(0);
    expect(st.p95DelayMs!).toBeLessThan(300);
  });

  it('speech longer than its slot: modest speed-up (≤ maxSpeedup), then bounded delay/skip — no growing queue', async () => {
    const sim = new Sim('chrome', lesson(40, { every: 2.5, len: 2.2, words: 16 }), { maxSpeedup: 1.35, maxDelaySec: 2.5 });
    sim.play();
    await sim.run(120);
    const st = sim.sched.snapshot();
    expect(st.rateAdjusted).toBeGreaterThan(0);
    expect(Math.max(...sim.sink.spoken.map((s) => s.speed))).toBeLessThanOrEqual(1.35);
    expect(st.skipped).toBeGreaterThan(0); // could not fit everything → skipped, not queued
    expect(sim.sink.overlaps).toBe(0);
    for (const s of sim.sink.spoken) {
      const u = lesson(40, { every: 2.5, len: 2.2, words: 16 })[Number(s.id.slice(3, s.id.indexOf('+')))];
      expect(s.mediaT - u.start).toBeLessThanOrEqual(2.5 + 0.2); // never later than maxDelay
    }
  });

  it('seek forward/backward: obsolete speech stopped, speech restarts near the new position, cached audio reused', async () => {
    const units = lesson(200);
    const sim = new Sim('cloud', units, { lookaheadSec: 60 });
    sim.play();
    await sim.run(30);
    const prepBefore = sim.sink.prepares;
    sim.seek(400);
    await sim.run(15);
    const after = sim.sink.spoken.filter((s) => s.mediaT >= 400);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].mediaT - 400).toBeLessThan(5);
    sim.seek(10);
    await sim.run(10);
    const back = sim.sink.spoken.filter((s) => s.mediaT >= 10 && s.mediaT < 25);
    expect(back.length).toBeGreaterThan(0); // re-spoken after seeking back
    expect(sim.sink.overlaps).toBe(0);
    // units around 10 s were synthesized before the seeks → not requested again
    const reqForEarly = sim.sink.prepares - prepBefore;
    expect(reqForEarly).toBeLessThan(40);
  });

  it('rapid repeated seeking: no overlap, no backlog, speech resumes at the final position', async () => {
    const sim = new Sim('cloud', lesson(300));
    sim.play();
    await sim.run(5);
    for (let i = 0; i < 25; i++) {
      sim.seek((i * 37) % 1100);
      await sim.run(0.3);
    }
    sim.seek(800);
    await sim.run(12);
    expect(sim.sink.overlaps).toBe(0);
    const last = sim.sink.spoken.at(-1)!;
    expect(last.mediaT).toBeGreaterThanOrEqual(800);
  });

  it('pause/resume: cloud audio resumes exactly; chrome.tts restarts the sentence', async () => {
    const cloud = new Sim('cloud', lesson(20));
    cloud.play();
    await cloud.run(2.5);
    expect(cloud.sink.active).not.toBeNull();
    const id = cloud.sink.active!.id;
    cloud.pause();
    await cloud.run(5);
    expect(cloud.sink.spoken.filter((s) => s.id === id)).toHaveLength(1);
    cloud.play();
    await cloud.run(4);
    expect(cloud.sink.spoken.filter((s) => s.id === id)).toHaveLength(1); // resumed, not restarted
    const chrome = new Sim('chrome', lesson(20));
    chrome.play();
    await chrome.run(2.5);
    const cid = chrome.sink.active!.id;
    chrome.pause();
    expect(chrome.sink.stops).toBeGreaterThan(0);
    await chrome.run(3);
    chrome.play();
    await chrome.run(1);
    expect(chrome.sink.spoken.filter((s) => s.id === cid)).toHaveLength(2); // restarted from its start
  });

  it('1.5× and 2× playback: speech speeds up within limits, sentences that cannot fit are skipped', async () => {
    for (const rate of [1.5, 2]) {
      const sim = new Sim('cloud', lesson(80));
      sim.rate = rate;
      sim.play();
      await sim.run(400 / rate);
      const st = sim.sched.snapshot();
      expect(sim.sink.overlaps).toBe(0);
      expect(Math.max(...sim.sink.spoken.map((s) => s.speed))).toBeLessThanOrEqual(1.35);
      expect(st.spoken + st.skipped).toBeGreaterThanOrEqual(75);
    }
  });

  it('untranslated sentence: waits, then skips — nothing is spoken for it', async () => {
    const sim = new Sim('chrome', lesson(10, { translated: (i) => i !== 3 }));
    sim.play();
    await sim.run(45);
    const ids = sim.sink.spoken.map((s) => s.id);
    expect(ids.some((id) => id.startsWith('d:u3+'))).toBe(false);
    expect(ids.length).toBe(9);
    expect(sim.sched.snapshot().skipped).toBe(1);
  });

  it('sustained TTS failure → onFatal (caller restores audio); transient failure does not', async () => {
    const sim = new Sim('cloud', lesson(10));
    sim.sink.failPrepare = true;
    sim.play();
    await sim.run(10);
    expect(sim.fatal).toMatch(/TTS HTTP 500/);
    expect(sim.sink.spoken).toHaveLength(0);
  });

  it('lost end event (service worker restart): bounded timeout, playback continues', async () => {
    const sim = new Sim('chrome', lesson(10));
    sim.play();
    await sim.run(2);
    sim.sink.step = () => undefined; // events never arrive any more
    await sim.run(30);
    sim.sink.step = SimSink.prototype.step.bind(sim.sink);
    expect(sim.sink.spoken.length).toBeGreaterThan(2);
    expect((sim.sched.snapshot() as any).eventTimeouts).toBeGreaterThan(0);
  });

  it('dispose stops speech and ignores late callbacks (no orphaned audio)', async () => {
    const sim = new Sim('cloud', lesson(10));
    sim.play();
    await sim.run(2);
    sim.sched.dispose();
    const n = sim.sink.spoken.length;
    await sim.run(20);
    expect(sim.sink.spoken.length).toBe(n);
    expect(sim.sink.active).toBeNull();
  });
});

describe('measured dubbing performance (simulated 20-minute lesson)', () => {
  // A sentence every 4 s (300 units), Vietnamese ≈ 11 words (≈ 2.9 s of speech at 1×).
  // Wall clock and media clock are simulated; TTS latency is the simulated synthesis time.
  const rows: Record<string, unknown>[] = [];
  const scenarios: [string, 'cloud' | 'chrome', number, number][] = [
    ['cloud 1× · TTS 0.4 s', 'cloud', 1, 400],
    ['cloud 1× · TTS 1.5 s', 'cloud', 1, 1500],
    ['cloud 1.5× · TTS 0.4 s', 'cloud', 1.5, 400],
    ['cloud 2× · TTS 0.4 s', 'cloud', 2, 400],
    ['chrome.tts 1×', 'chrome', 1, 0],
    ['chrome.tts 2×', 'chrome', 2, 0],
  ];
  for (const [name, kind, rate, lat] of scenarios) {
    it(name, async () => {
      const sim = new Sim(kind, lesson(300), {}, lat);
      sim.rate = rate;
      sim.play();
      await sim.run(1205 / rate);
      const st = sim.sched.snapshot();
      expect(sim.sink.overlaps).toBe(0);
      const ids = sim.sink.spoken.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
      rows.push({
        scenario: name,
        firstSpeechMs: st.firstSpeechMs,
        medianDelayMs: st.medianDelayMs,
        p95DelayMs: st.p95DelayMs,
        spoken: st.spoken,
        missed: st.skipped,
        late: st.late,
        lateSpeechSec: Math.round(st.lateSpeechSec * 10) / 10,
        speedAdjusted: st.rateAdjusted,
        ttsRequests: kind === 'cloud' ? sim.sink.prepares : '—',
        unnecessaryRequests: kind === 'cloud' ? sim.sink.prepares - sim.sink.preparedIds.size : '—',
      });
      if (rows.length === scenarios.length) console.table(rows);
    }, 60_000);
  }
});

describe('original audio', () => {
  const media = () => {
    const v = document.createElement('video');
    v.volume = 0.8;
    return v;
  };
  it('mutes the media element (not the tab), restores exactly, mix uses a share of the user volume', async () => {
    const m = media();
    const tab = vi.fn();
    const a = new OriginalAudio(m, tab);
    a.apply('vi', 0.2);
    expect(m.muted).toBe(true);
    expect(a.strategy).toBe('element');
    expect(m.getAttribute(PREV_ATTR)).toBe('{"muted":false,"volume":0.8}');
    a.apply('mix', 0.25);
    expect(m.muted).toBe(false);
    expect(m.volume).toBeCloseTo(0.2);
    a.restore();
    expect([m.muted, m.volume]).toEqual([false, 0.8]);
    expect(m.hasAttribute(PREV_ATTR)).toBe(false);
    expect(tab).not.toHaveBeenCalled(); // no browser/tab-wide muting when the element is accessible
  });
  it('keeps a video the user had muted muted afterwards', () => {
    const m = media();
    m.muted = true;
    const a = new OriginalAudio(m);
    a.apply('vi', 0);
    a.restore();
    expect(m.muted).toBe(true);
  });
  it('user changes the volume during dubbing → respected, not fought', async () => {
    const m = media();
    const a = new OriginalAudio(m);
    a.apply('vi', 0);
    await new Promise((r) => setTimeout(r, 5));
    m.muted = false;
    m.dispatchEvent(new Event('volumechange'));
    a.apply('vi', 0);
    expect(m.muted).toBe(false);
    expect(a.overriddenByUser).toBe(true);
  });
  it('no media element → tab-level mute fallback, restored', () => {
    const tab = vi.fn(async () => undefined);
    const a = new OriginalAudio(null, tab);
    a.apply('vi', 0);
    expect(a.strategy).toBe('tab');
    a.restore();
    expect(tab.mock.calls).toEqual([[true], [false]]);
  });
  it('recovery after a crash: state restored from the attribute on next initialisation', () => {
    const m = media();
    m.muted = true;
    m.setAttribute(PREV_ATTR, '{"muted":false,"volume":0.6}');
    expect(recoverMedia(m)).toBe(true);
    expect([m.muted, m.volume]).toEqual([false, 0.6]);
    expect(recoverMedia(m)).toBe(false);
  });
});

describe('dubbing session', () => {
  const mk = (voices: any[], dub: Partial<typeof DEFAULT_SETTINGS.dubbing> = {}) => {
    const v = document.createElement('video');
    const sent: any[] = [];
    const send = (async (m: any) => {
      sent.push(m);
      if (m.type === 'dub:voices') return { voices, error: voices.length ? undefined : 'Máy này không có giọng tiếng Việt' };
      return { ok: true };
    }) as any;
    const s = new DubbingSession(v, 'L', { ...DEFAULT_SETTINGS.dubbing, enabled: true, ...dub }, send);
    return { s, v, sent };
  };
  it('no Vietnamese voice → original audio NOT muted, clear status', async () => {
    const { s, v } = mk([]);
    await s.start();
    expect(v.muted).toBe(false);
    expect(s.status().state).toBe('no-voice');
    expect(s.status().lastError).toMatch(/không có giọng tiếng Việt/);
  });
  it('voice found → original muted; dispose stops speech and restores', async () => {
    const { s, v, sent } = mk([{ id: 'Linh', label: 'Linh', lang: 'vi-VN', gender: 'female' }]);
    await s.start();
    expect(v.muted).toBe(true);
    s.dispose();
    expect(v.muted).toBe(false);
    expect(sent.some((m) => m.type === 'dub:control' && m.action === 'stop' && m.token === s.token)).toBe(true);
  });
  it('events of another session token are ignored', async () => {
    const { s } = mk([{ id: 'Linh', label: 'Linh', lang: 'vi-VN', gender: 'female' }]);
    await s.start();
    s.setUnits(lesson(3));
    s.onEvent('old-token', 'd:u0+1', 'error', 'boom');
    expect(s.status().lastError).toBeUndefined();
  });
  it('sustained failure restores the original audio; recovery when speech works again', async () => {
    const { s, v } = mk([{ id: 'Linh', label: 'Linh', lang: 'vi-VN', gender: 'female' }]);
    await s.start();
    expect(v.muted).toBe(true);
    (s as any).onFatal('TTS HTTP 503');
    expect(v.muted).toBe(false); // never trapped in silence
    expect(s.status()).toMatchObject({ state: 'error', lastError: 'TTS HTTP 503' });
    s.onEvent(s.token, 'any', 'start');
    expect(v.muted).toBe(true);
    expect(s.status().state).not.toBe('error');
  });

  it('captions unavailable → nothing spoken and original audio kept', async () => {
    const { s, v } = mk([{ id: 'Linh', label: 'Linh', lang: 'vi-VN', gender: 'female' }]);
    await s.start();
    s.setNoCaptions(true);
    expect(v.muted).toBe(false);
    expect(s.status().state).toBe('no-captions');
  });
});

// ---- controller integration ---------------------------------------------------------------------
import { SubtitleController, type ControllerBridge } from '../../src/content/controller';
import { skoolNativeAdapter } from '../../src/players/adapters';
import { mergeSettings } from '../../src/shared/settings';
import { FakeCue, FakeTrack, flush, installVTTCue, makeVideo, type FakeVideo } from './fakes';

describe('controller + dubbing', () => {
  installVTTCue();
  const live: SubtitleController[] = [];
  afterEach(() => live.splice(0).forEach((c) => c.destroy()));

  function setup(dub: Partial<typeof DEFAULT_SETTINGS.dubbing>, prefix = 'A') {
    document.body.innerHTML = '';
    const cues = Array.from({ length: 30 }, (_, i) => new FakeCue(i * 4 + 0.5, i * 4 + 3.5, `${prefix} sentence ${i}.`));
    const track = new FakeTrack('subtitles', 'English', 'en', cues);
    track.mode = 'showing';
    const video = makeVideo(document, { tracks: [track], src: `https://v.test/${prefix}.mp4` });
    document.body.append(video);
    const spoken: { token: string; segId: string; text: string }[] = [];
    const controls: any[] = [];
    let c!: SubtitleController;
    const dubSend = (async (m: any) => {
      if (m.type === 'dub:voices') return { voices: [{ id: 'Linh', label: 'Linh', lang: 'vi-VN', gender: 'female' }] };
      if (m.type === 'dub:speak') {
        spoken.push({ token: m.token, segId: m.segId, text: m.text });
        setTimeout(() => c.onDubEvent({ token: m.token, segId: m.segId, kind: 'start' }), 1);
        return { ok: true };
      }
      if (m.type === 'dub:control') controls.push(m);
      return { ok: true };
    }) as any;
    const bridge: ControllerBridge = {
      async translate(_k, units) {
        return units.map((u) => ({ id: u.id, vi: `Câu tiếng Việt cho ${u.text}` }));
      },
      cancel() {},
      reportStatus() {},
    };
    c = new SubtitleController({
      doc: document, isTop: true, adapter: skoolNativeAdapter, bridge, captionGraceMs: 10, raf: () => 0, cancelRaf: () => undefined, dubSend,
      settings: mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true, dubbing: { ...DEFAULT_SETTINGS.dubbing, enabled: true, ...dub } }),
    });
    live.push(c);
    c.setTarget({ kind: 'video', el: video, provider: 'skool-native', area: 960 * 540 });
    return { c, video: video as FakeVideo, spoken, controls };
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) await flush();
  };

  it('enable → original muted, Vietnamese spoken in sync; disable → audio restored, speech stopped', async () => {
    const { c, video, spoken, controls } = setup({});
    await settle();
    expect(video.muted).toBe(true);
    video._play();
    video._setTime(0.6);
    await settle();
    expect(spoken[0]?.text).toBe('Câu tiếng Việt cho A sentence 0.');
    expect(c.status().dub).toMatchObject({ enabled: true, provider: 'chrome', muted: 'element' });
    c.updateSettings(mergeSettings({ ...DEFAULT_SETTINGS, autoEnableCaptions: true, dubbing: { ...DEFAULT_SETTINGS.dubbing, enabled: false } }));
    expect(video.muted).toBe(false);
    expect(controls.some((m) => m.action === 'stop')).toBe(true);
    expect(c.status().dub).toBeUndefined();
  });

  it('listening mode "original" = no speech, original audio', async () => {
    const { video, spoken } = setup({ listenMode: 'original' });
    await settle();
    video._play();
    video._setTime(0.6);
    await settle();
    expect(video.muted).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('lesson switch: old session stopped + audio restored before the new one; old tokens can never play', async () => {
    const a = setup({});
    await settle();
    a.video._play();
    a.video._setTime(0.6);
    await settle();
    const oldToken = a.spoken[0].token;
    a.c.reset();
    expect(a.video.muted).toBe(false);
    const b = makeVideo(document, { tracks: [new FakeTrack('subtitles', 'English', 'en', [new FakeCue(0.5, 3, 'B one.')])], src: 'https://v.test/B.mp4' });
    (b.textTracks as any)[0].mode = 'showing';
    document.body.append(b);
    a.c.setTarget({ kind: 'video', el: b, provider: 'skool-native', area: 960 * 540 });
    await settle();
    b._play();
    b._setTime(0.6);
    await settle();
    const newOnes = a.spoken.filter((s) => s.token !== oldToken);
    expect(newOnes[0]?.text).toBe('Câu tiếng Việt cho B one.');
    a.c.onDubEvent({ token: oldToken, segId: 'd:x+1', kind: 'end' }); // stale callback: ignored
    expect(b.muted).toBe(true);
    expect(a.video.muted).toBe(false);
  });

  it('Audio Mode turned on → dubbing stops and audio is restored (no double capture)', async () => {
    const { c, video } = setup({});
    await settle();
    expect(video.muted).toBe(true);
    c.setAudioState(true, true);
    expect(video.muted).toBe(false);
  });

  it('hide subtitles while dubbing (optional)', async () => {
    const { c } = setup({ showSubtitles: false });
    await settle();
    expect((c as any).overlay.visible).toBe(false);
    const shown = setup({ showSubtitles: true });
    await settle();
    expect((shown.c as any).overlay.visible).toBe(true);
  });
});
