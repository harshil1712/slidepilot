// Synthetic PCM for tests.
import { SAMPLE_RATE } from "./audio";

/** A constant-amplitude square wave; its RMS equals `amplitude`. */
export function tone(ms: number, amplitude: number): Int16Array {
  const samples = new Int16Array((SAMPLE_RATE * ms) / 1_000);
  const value = Math.round(amplitude * 32_767);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? value : -value;
  return samples;
}

export const silence = (ms: number) => tone(ms, 0);

export function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
