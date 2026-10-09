// Audio primitives for the experimental Clef-omni engine. Everything here is
// pure and deterministic: time is measured in samples, never wall-clock.

/** agents/voice streams 16 kHz mono 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;

export interface PauseDetectorOptions {
  sampleRate?: number;
  /** Analysis window. */
  frameMs?: number;
  /** RMS (0..1) a frame must reach to count as speech onset. */
  speechThreshold?: number;
  /** RMS below which an ongoing speech frame counts as silence (hysteresis). */
  silenceThreshold?: number;
  /** Consecutive loud audio required before speech is considered started. */
  speechStartMs?: number;
  /** Silence required before speech is considered paused. */
  pauseMs?: number;
  /** Voiced audio required for a pause to be reported (filters coughs, clicks). */
  minSpeechMs?: number;
}

export type PauseEvent =
  | { type: "speech_start"; atMs: number }
  | { type: "pause"; atMs: number; speechMs: number };

const DEFAULTS: Required<PauseDetectorOptions> = {
  sampleRate: SAMPLE_RATE,
  frameMs: 20,
  speechThreshold: 0.03,
  silenceThreshold: 0.015,
  speechStartMs: 60,
  pauseMs: 700,
  minSpeechMs: 300,
};

/**
 * Energy-based voice activity detector with hysteresis. Reports when the
 * presenter starts speaking and when they pause. It deliberately makes no
 * judgement about whether a thought is finished; that is Clef-omni's job.
 */
export class PauseDetector {
  readonly options: Required<PauseDetectorOptions>;
  private readonly frameSamples: number;
  private pending: Int16Array = new Int16Array(0);
  private elapsedMs = 0;
  private speaking = false;
  private loudRunMs = 0;
  private quietRunMs = 0;
  private voicedMs = 0;

  constructor(options: PauseDetectorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.frameSamples = Math.round(
      (this.options.sampleRate * this.options.frameMs) / 1_000,
    );
  }

  get isSpeaking() {
    return this.speaking;
  }

  /** Feed PCM of any length; returns the events it completed. */
  push(pcm: Int16Array): PauseEvent[] {
    const events: PauseEvent[] = [];
    const samples = concat(this.pending, pcm);
    let offset = 0;
    for (; offset + this.frameSamples <= samples.length; offset += this.frameSamples) {
      const event = this.processFrame(rms(samples, offset, this.frameSamples));
      if (event) events.push(event);
    }
    this.pending = samples.slice(offset);
    return events;
  }

  reset() {
    this.pending = new Int16Array(0);
    this.speaking = false;
    this.loudRunMs = 0;
    this.quietRunMs = 0;
    this.voicedMs = 0;
  }

  private processFrame(level: number): PauseEvent | null {
    const { frameMs, speechThreshold, silenceThreshold, speechStartMs, pauseMs, minSpeechMs } =
      this.options;
    this.elapsedMs += frameMs;

    if (!this.speaking) {
      this.loudRunMs = level >= speechThreshold ? this.loudRunMs + frameMs : 0;
      if (this.loudRunMs < speechStartMs) return null;
      this.speaking = true;
      this.voicedMs = this.loudRunMs;
      this.quietRunMs = 0;
      return { type: "speech_start", atMs: this.elapsedMs };
    }

    if (level >= silenceThreshold) {
      this.quietRunMs = 0;
      this.voicedMs += frameMs;
      return null;
    }

    this.quietRunMs += frameMs;
    if (this.quietRunMs < pauseMs) return null;

    const speechMs = this.voicedMs;
    this.speaking = false;
    this.loudRunMs = 0;
    this.quietRunMs = 0;
    this.voicedMs = 0;
    return speechMs >= minSpeechMs
      ? { type: "pause", atMs: this.elapsedMs, speechMs }
      : null;
  }
}

/** Keeps the most recent `maxSamples` of PCM for the current slide. */
export class SlideAudioBuffer {
  private chunks: Int16Array[] = [];
  private total = 0;
  private dropped = false;

  constructor(readonly maxSamples: number) {}

  get samples() {
    return Math.min(this.total, this.maxSamples);
  }

  /** True once older audio has fallen outside the window. */
  get truncated() {
    return this.dropped || this.total > this.maxSamples;
  }

  append(pcm: Int16Array) {
    if (pcm.length === 0) return;
    this.chunks.push(pcm);
    this.total += pcm.length;
    // Drop whole chunks that are entirely older than the window.
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= this.maxSamples) {
      this.total -= this.chunks.shift()!.length;
      this.dropped = true;
    }
  }

  clear() {
    this.chunks = [];
    this.total = 0;
    this.dropped = false;
  }

  /** The most recent audio, oldest sample first. */
  toPcm(): Int16Array {
    const all = concat(...this.chunks);
    return all.length > this.maxSamples ? all.slice(all.length - this.maxSamples) : all;
  }
}

/** Copies an incoming WebSocket chunk into PCM samples, dropping a stray odd byte. */
export function pcmFromChunk(chunk: ArrayBuffer): Int16Array {
  return new Int16Array(chunk.slice(0, chunk.byteLength - (chunk.byteLength % 2)));
}

/** Wraps 16-bit mono PCM in a canonical 44-byte WAV header. */
export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return wav;
}

/** Base64 without node:buffer; chunked so large clips don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function rms(samples: Int16Array, offset: number, length: number) {
  let sum = 0;
  for (let i = offset; i < offset + length; i++) {
    const value = samples[i] / 32_768;
    sum += value * value;
  }
  return Math.sqrt(sum / length);
}

function concat(...parts: Int16Array[]): Int16Array {
  if (parts.length === 1) return parts[0];
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
