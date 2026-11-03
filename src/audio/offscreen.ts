import type { BackgroundRequest, OffscreenMessage } from '../shared/messages';
import { arrayBufferToBase64 } from '../shared/util';
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

const send = (msg: BackgroundRequest) => chrome.runtime.sendMessage(msg).catch(() => undefined);

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

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') void start(msg.streamId, msg.sessionId);
  else if (msg.type === 'stop') void stop('user');
  sendResponse({ ok: true });
});

send({ type: 'offscreen:ready' });
