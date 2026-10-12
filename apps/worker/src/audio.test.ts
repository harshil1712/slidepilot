import { describe, expect, it } from "vitest";
import {
  PauseDetector,
  SAMPLE_RATE,
  SlideAudioBuffer,
  encodeWav,
  pcmFromChunk,
  toBase64,
  type PauseEvent,
} from "./audio";
import { join, silence, tone } from "./test-audio";

describe("PauseDetector", () => {
  it("reports speech start and a pause after enough silence", () => {
    const detector = new PauseDetector();
    const events = detector.push(join(silence(200), tone(1_000, 0.2), silence(800)));

    expect(events.map((e) => e.type)).toEqual(["speech_start", "pause"]);
    expect(events[0].atMs).toBe(260); // 200 ms silence + 60 ms onset
    expect(events[1]).toMatchObject({ type: "pause", speechMs: 1_000 });
  });

  it("does not report a pause for silences shorter than pauseMs", () => {
    const detector = new PauseDetector();
    const events = detector.push(join(tone(500, 0.2), silence(400), tone(500, 0.2)));
    expect(events.map((e) => e.type)).toEqual(["speech_start"]);
    expect(detector.isSpeaking).toBe(true);
  });

  it("ignores clicks shorter than speechStartMs", () => {
    const detector = new PauseDetector();
    expect(detector.push(join(tone(40, 0.5), silence(1_000)))).toEqual([]);
  });

  it("starts speech for a cough but suppresses the pause below minSpeechMs", () => {
    const detector = new PauseDetector();
    const events = detector.push(join(tone(120, 0.5), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["speech_start"]);
    expect(detector.isSpeaking).toBe(false);
  });

  it("keeps speaking while the level sits between the two thresholds", () => {
    const detector = new PauseDetector();
    const events = detector.push(join(tone(300, 0.2), tone(1_000, 0.02), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "pause"]);
    expect(events[1]).toMatchObject({ speechMs: 1_300 });
  });

  it("reports input levels for threshold tuning and resets them", () => {
    const detector = new PauseDetector();
    detector.push(join(tone(500, 0.2), silence(500)));
    expect(detector.takeLevels()).toEqual({
      ms: 1_000,
      meanRms: 0.1,
      peakRms: 0.2,
      loudShare: 0.5,
      speaking: true,
    });
    expect(detector.takeLevels()).toMatchObject({ ms: 0, peakRms: 0 });
  });

  it("produces the same events regardless of chunk boundaries", () => {
    const signal = join(silence(130), tone(900, 0.2), silence(750), tone(400, 0.2), silence(900));
    const whole = new PauseDetector().push(signal);

    const chunked = new PauseDetector();
    const events: PauseEvent[] = [];
    for (let i = 0; i < signal.length; i += 777) {
      events.push(...chunked.push(signal.subarray(i, i + 777)));
    }
    expect(events).toEqual(whole);
    expect(whole.map((e) => e.type)).toEqual(["speech_start", "pause", "speech_start", "pause"]);
  });
});

describe("SlideAudioBuffer", () => {
  it("keeps only the most recent samples in order", () => {
    const buffer = new SlideAudioBuffer(5);
    buffer.append(Int16Array.from([1, 2, 3]));
    expect(buffer.truncated).toBe(false);
    buffer.append(Int16Array.from([4, 5, 6]));
    buffer.append(Int16Array.from([7]));

    expect(Array.from(buffer.toPcm())).toEqual([3, 4, 5, 6, 7]);
    expect(buffer.samples).toBe(5);
    expect(buffer.truncated).toBe(true);

    buffer.clear();
    expect(buffer.toPcm()).toHaveLength(0);
    expect(buffer.truncated).toBe(false);
  });
});

describe("encoding", () => {
  it("wraps PCM in a 16 kHz mono 16-bit WAV header", () => {
    const wav = encodeWav(Int16Array.from([1, -1, 32_767]));
    const view = new DataView(wav.buffer);
    const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));

    expect(wav.length).toBe(44 + 6);
    expect(text(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(text(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(48, true)).toBe(32_767);
  });

  it("base64-encodes large payloads without overflowing the stack", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("drops a stray odd byte from incoming chunks", () => {
    const chunk = new Uint8Array([1, 0, 2, 0, 9]).buffer;
    expect(Array.from(pcmFromChunk(chunk))).toEqual([1, 2]);
  });
});
