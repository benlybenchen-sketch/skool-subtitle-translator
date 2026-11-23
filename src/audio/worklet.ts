// AudioWorklet processor: forwards mono PCM blocks to the offscreen document.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class SstCaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(4096);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    for (let i = 0; i < ch0.length; i++) {
      this.buf[this.n++] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(4096);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('sst-capture', SstCaptureProcessor);
export {};
