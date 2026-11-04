import type { BackgroundRequest, OffscreenMessage } from '../shared/messages';
import { arrayBufferToBase64, base64ToUint8 } from '../shared/util';
import { SpeechChunker } from './chunker';
import { encodeWav, resample } from './wav';

/**
 * Offscreen document (MV3): owns the tab-capture MediaStream.
 * - Plays the captured audio back so the user still hears the video
 *   (tab capture otherwise mutes the tab).
 * - Splits speech into utterance chunks (VAD), encodes 16 kHz WAV and sends
 *   them to the background worker for STT + translation.
 * Only chrome.runtime is available here, so all configuration and secrets
 * stay in the background.
 */
interface Session {
  id: string;
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  chunker: SpeechChunker;
  seq: number;
}

let session: Session | null = null;

const sendRuntime = (msg: BackgroundRequest) => chrome.runtime.sendMessage(msg).catch(() => undefined);

// Dubbing playback events go through a long-lived Port: one-off runtime messages from this
// document can be dropped by Chrome while the worker is still handling the request that
// triggered playback (reproduced in Chromium). Reconnects when the worker restarts.
let port: chrome.runtime.Port | null = null;
function connect(): void {
  try {
    port = chrome.runtime.connect({ name: 'sst-offscreen-dub' });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  } catch {
    port = null;
  }
}
connect();
const send = (msg: BackgroundRequest) => {
  if (msg.type === 'offscreen:dub' && port) {
    try {
      port.postMessage(msg);
      return;
    } catch {
      port = null;
    }
  }
  void sendRuntime(msg);
};

async function start(streamId: string, sessionId: string): Promise<void> {
  await stop('restart');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
      video: false,
    });
  } catch (e) {
    send({ type: 'offscreen:error', sessionId, error: `Không thể thu âm thanh tab: ${(e as Error).message}` });
    return;
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination); // keep the video audible
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
  const node = new AudioWorkletNode(ctx, 'sst-capture');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink).connect(ctx.destination); // keep the worklet pulled

  const s: Session = {
    id: sessionId,
    stream,
    ctx,
    node,
    seq: 0,
    chunker: new SpeechChunker({ sampleRate: ctx.sampleRate }, (chunk) => {
      const pcm16k = resample(chunk.samples, ctx.sampleRate, 16000);
      const wav = encodeWav(pcm16k, 16000);
      send({
        type: 'offscreen:chunk',
        sessionId,
        seq: s.seq++,
        wavBase64: arrayBufferToBase64(wav),
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        endedAt: Date.now(),
        rms: chunk.rms,
      });
    }),
  };
  node.port.onmessage = (e: MessageEvent<Float32Array>) => s.chunker.push(e.data);
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      void stop('ended');
    });
  }
  session = s;
  send({ type: 'offscreen:started', sessionId });
}

async function stop(reason: string): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  try {
    s.chunker.flush();
  } catch {
    /* ignore */
  }
  s.node.port.onmessage = null;
  s.node.disconnect();
  for (const t of s.stream.getTracks()) t.stop();
  await s.ctx.close().catch(() => undefined);
  if (reason !== 'restart') send({ type: 'offscreen:stopped', sessionId: s.id, reason });
}

// ---- AI Vietnamese dubbing player ---------------------------------------------------------------
// Extension-owned audio (not the Skool tab's audio): unaffected when the tab or the video is muted.
// Bounded: at most 60 decoded clips (LRU), object URLs revoked on eviction; one clip plays at a time.
const clips = new Map<string, { url: string; el: HTMLAudioElement }>();
let current: { el: HTMLAudioElement; token: string; segId: string } | null = null;

function loadClip(key: string, b64: string, mime: string): Promise<number> {
  const old = clips.get(key);
  if (old) {
    clips.delete(key);
    clips.set(key, old); // LRU touch
    return Promise.resolve(old.el.duration || 0);
  }
  const url = URL.createObjectURL(new Blob([base64ToUint8(b64) as Uint8Array<ArrayBuffer>], { type: mime }));
  const el = new Audio();
  el.preload = 'auto';
  (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  el.src = url;
  clips.set(key, { url, el });
  while (clips.size > 60) {
    const [k, v] = clips.entries().next().value!;
    if (current?.el === v.el) break;
    v.el.removeAttribute('src');
    URL.revokeObjectURL(v.url);
    clips.delete(k);
  }
  return new Promise((resolve) => {
    const done = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
    el.addEventListener('loadedmetadata', done, { once: true });
    el.addEventListener('error', () => resolve(0), { once: true });
    setTimeout(done, 3000);
  });
}

function stopClip(): void {
  if (!current) return;
  current.el.pause();
  current.el.onended = current.el.onerror = null;
  current = null;
}

async function playClip(m: Extract<OffscreenMessage, { type: 'dub-play' }>): Promise<{ ok: boolean; error?: string }> {
  stopClip();
  const c = clips.get(m.key);
  if (!c) return { ok: false, error: 'clip not loaded' }; // the worker reloads it and retries
  const el = c.el;
  el.playbackRate = Math.min(2, Math.max(0.5, m.rate));
  el.volume = Math.min(1, Math.max(0, m.volume));
  try {
    el.currentTime = Math.max(0, m.offsetSec);
  } catch {
    /* not seekable yet */
  }
  current = { el, token: m.token, segId: m.segId };
  el.onended = () => {
    if (current?.el !== el) return;
    current = null;
    send({ type: 'offscreen:dub', event: 'ended', token: m.token, segId: m.segId });
  };
  el.onerror = () => send({ type: 'offscreen:dub', event: 'error', token: m.token, segId: m.segId, error: 'audio element error' });
  try {
    await el.play();
    send({ type: 'offscreen:dub', event: 'started', token: m.token, segId: m.segId });
    return { ok: true };
  } catch (e) {
    send({ type: 'offscreen:dub', event: 'error', token: m.token, segId: m.segId, error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'dub-load') {
    void loadClip(msg.key, msg.audioBase64, msg.mime).then((durationSec) => sendResponse({ ok: true, durationSec }));
    return true;
  }
  if (msg.type === 'dub-play') {
    void playClip(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'dub-stop') stopClip();
  else if (msg.type === 'dub-pause') current?.el.pause();
  else if (msg.type === 'dub-resume') void current?.el.play().catch(() => undefined);
  else if (msg.type === 'start') void start(msg.streamId, msg.sessionId);
  else if (msg.type === 'stop') void stop('user');
  sendResponse({ ok: true });
});

send({ type: 'offscreen:ready' });
