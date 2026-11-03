export interface ChunkerOptions {
  sampleRate: number;
  /** Analysis window. */
  windowMs: number;
  /** Silence after speech that closes a chunk. */
  minSilenceMs: number;
  /** Minimum voiced audio for a chunk to be kept (filters clicks/noise). */
  minSpeechMs: number;
  /** Force a cut after this long (keeps latency bounded during continuous speech). */
  maxChunkMs: number;
  /** Audio kept before speech onset so first syllables are not clipped. */
  preRollMs: number;
  /** Absolute floor (dBFS) below which audio is always silence. */
  absThresholdDb: number;
  /** Speech must exceed the tracked noise floor by this many dB. */
  marginDb: number;
}

export const DEFAULT_CHUNKER: Omit<ChunkerOptions, 'sampleRate'> = {
  windowMs: 20,
  minSilenceMs: 550,
  minSpeechMs: 300,
  maxChunkMs: 8000,
  preRollMs: 250,
  absThresholdDb: -50,
  marginDb: 9,
};

export interface AudioChunk {
  samples: Float32Array;
  startSec: number;
  endSec: number;
  /** Average RMS of voiced windows (linear). */
  rms: number;
  voicedMs: number;
  forced: boolean;
}

const toDb = (rms: number) => (rms > 0 ? 20 * Math.log10(rms) : -120);

/**
 * Energy-based voice activity chunker. Turns a continuous PCM stream into
 * utterance-sized chunks split at pauses, so the STT backend receives complete
 * phrases with bounded latency. Pure and synchronous — fully unit-testable.
 */
export class SpeechChunker {
  readonly o: ChunkerOptions;
  private readonly win: number;
  private pending: Float32Array = new Float32Array(0);
  private totalSamples = 0; // samples consumed into windows
  private noiseDb = -60;
  private speaking = false;
  private buf: Float32Array[] = [];
  private bufLen = 0;
  private bufStart = 0; // absolute sample index of buf[0]
  private silenceRun = 0; // windows
  private voicedWindows = 0;
  private voicedEnergy = 0;
  private winEnergies: number[] = [];
  private preRoll: Float32Array[] = [];
  private readonly emit: (c: AudioChunk) => void;

  constructor(opts: Partial<ChunkerOptions> & { sampleRate: number }, onChunk: (c: AudioChunk) => void) {
    this.o = { ...DEFAULT_CHUNKER, ...opts };
    this.win = Math.max(1, Math.round((this.o.sampleRate * this.o.windowMs) / 1000));
    this.emit = onChunk;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get noiseFloorDb(): number {
    return this.noiseDb;
  }

  push(input: Float32Array): void {
    let data = input;
    if (this.pending.length) {
      data = new Float32Array(this.pending.length + input.length);
      data.set(this.pending);
      data.set(input, this.pending.length);
    }
    let off = 0;
    while (off + this.win <= data.length) {
      this.processWindow(data.subarray(off, off + this.win));
      off += this.win;
    }
    this.pending = data.slice(off);
  }

  flush(): void {
    if (this.speaking) this.close(false);
  }

  private ms2win(ms: number) {
    return Math.max(1, Math.round(ms / this.o.windowMs));
  }

  private processWindow(w: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
    const rms = Math.sqrt(sum / w.length);
    const db = toDb(rms);
    const threshold = Math.max(this.o.absThresholdDb, this.noiseDb + this.o.marginDb);
    const voiced = db > threshold;
    // Noise floor: falls fast, rises slowly (only during non-speech).
    if (!voiced) this.noiseDb = db < this.noiseDb ? this.noiseDb * 0.7 + db * 0.3 : this.noiseDb * 0.995 + db * 0.005;
    const copy = w.slice();
    const startIdx = this.totalSamples;
    this.totalSamples += w.length;

    if (!this.speaking) {
      this.preRoll.push(copy);
      while (this.preRoll.length > this.ms2win(this.o.preRollMs)) this.preRoll.shift();
      if (voiced) {
        this.speaking = true;
        this.buf = [...this.preRoll];
        this.bufLen = this.buf.reduce((a, b) => a + b.length, 0);
        this.bufStart = startIdx + w.length - this.bufLen;
        this.winEnergies = this.buf.map(() => -120);
        this.winEnergies[this.winEnergies.length - 1] = db;
        this.preRoll = [];
        this.silenceRun = 0;
        this.voicedWindows = 1;
        this.voicedEnergy = rms;
      }
      return;
    }

    this.buf.push(copy);
    this.bufLen += copy.length;
    this.winEnergies.push(db);
    if (voiced) {
      this.silenceRun = 0;
      this.voicedWindows++;
      this.voicedEnergy += rms;
    } else this.silenceRun++;

    if (this.silenceRun >= this.ms2win(this.o.minSilenceMs)) {
      this.close(false);
    } else if (this.buf.length >= this.ms2win(this.o.maxChunkMs)) {
      this.forceCut();
    }
  }

  /** Cut at the quietest window in the last 1.5s to avoid splitting words. */
  private forceCut(): void {
    const look = Math.min(this.buf.length - 1, this.ms2win(1500));
    let best = this.buf.length - 1;
    let bestDb = Infinity;
    for (let i = this.buf.length - 1; i >= this.buf.length - look; i--) {
      if (this.winEnergies[i] < bestDb) {
        bestDb = this.winEnergies[i];
        best = i;
      }
    }
    const keepBufs = this.buf.slice(best + 1);
    const keepEnergies = this.winEnergies.slice(best + 1);
    this.buf = this.buf.slice(0, best + 1);
    this.winEnergies = this.winEnergies.slice(0, best + 1);
    this.bufLen = this.buf.reduce((a, b) => a + b.length, 0);
    const cutStart = this.bufStart + this.bufLen;
    this.close(true);
    // continue speaking with the remainder
    this.speaking = true;
    this.buf = keepBufs;
    this.winEnergies = keepEnergies;
    this.bufLen = keepBufs.reduce((a, b) => a + b.length, 0);
    this.bufStart = cutStart;
    this.silenceRun = 0;
    this.voicedWindows = keepEnergies.filter((d) => d > this.o.absThresholdDb).length;
    this.voicedEnergy = 0;
  }

  private close(forced: boolean): void {
    // Trim trailing silence but keep ~150 ms tail.
    const tailKeep = this.ms2win(150);
    const trimWindows = forced ? 0 : Math.max(0, this.silenceRun - tailKeep);
    const kept = this.buf.slice(0, this.buf.length - trimWindows);
    const len = kept.reduce((a, b) => a + b.length, 0);
    const voicedMs = this.voicedWindows * this.o.windowMs;
    if (voicedMs >= this.o.minSpeechMs && len > 0) {
      const samples = new Float32Array(len);
      let o = 0;
      for (const b of kept) {
        samples.set(b, o);
        o += b.length;
      }
      this.emit({
        samples,
        startSec: this.bufStart / this.o.sampleRate,
        endSec: (this.bufStart + len) / this.o.sampleRate,
        rms: this.voicedWindows ? this.voicedEnergy / this.voicedWindows : 0,
        voicedMs,
        forced,
      });
    }
    this.speaking = false;
    this.buf = [];
    this.bufLen = 0;
    this.winEnergies = [];
    this.silenceRun = 0;
    this.voicedWindows = 0;
    this.voicedEnergy = 0;
  }
}
