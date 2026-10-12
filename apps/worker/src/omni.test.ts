import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "./audio";
import { PauseTranscriber, evaluateNavigationAudio } from "./omni";
import type { SlideContext } from "./types";

const slide: SlideContext = {
  page: "2",
  title: "The three-part pipeline",
  content: "Voice hears. Clef decides. Slidev acts.",
  notes: "Explain each part and conclude the loop.",
  nextSlideTitle: "Architecture",
  clicks: 0,
  totalClicks: 0,
  manual: false,
  thresholds: {
    advance: 0.68,
    confidence: 0.3,
    complete: 0.65,
    stillExplainingCeiling: 0.55,
  },
};

function fakeClefOmni() {
  const calls: { model: string; inputs: any; options: any }[] = [];
  const AI = {
    run: async (model: string, inputs: unknown, options: unknown) => {
      calls.push({ model, inputs, options });
      return {
        model: "clef-omni",
        answers: {
          action: {
            type: "choice",
            choice: "next_slide",
            probabilities: { stay: 0.1, next_slide: 0.9 },
            confidence: 0.8,
          },
          slide_complete: { type: "noul", noul: 0.9 },
          still_explaining: { type: "noul", noul: 0.1 },
          transitioning: { type: "noul", noul: 0.85 },
        },
      };
    },
  } as unknown as Ai;
  return { AI, calls };
}

describe("Clef-omni evaluation", () => {
  it("sends slide context and the slide audio as WAV to clef-omni", async () => {
    const { AI, calls } = fakeClefOmni();
    const pcm = new Int16Array(SAMPLE_RATE * 2.5).fill(1_000);
    const controller = new AbortController();

    const result = await evaluateNavigationAudio({ slide, pcm }, { AI }, controller.signal);

    expect(calls).toHaveLength(1);
    const { model, inputs, options } = calls[0];
    expect(model).toBe("@cf/cloudflare/clef-omni");
    expect(inputs.model).toBe("clef-omni");
    expect(inputs.state.current_slide.title).toBe(slide.title);
    expect(inputs.state.advancing_now_will).toBe("Move to the next slide");
    expect(inputs.state.transcript_on_current_slide).toBeUndefined();
    expect(inputs.state.presenter_audio.description).toContain("2.5 seconds");
    expect(Object.keys(inputs.questions)).toEqual([
      "action",
      "slide_complete",
      "still_explaining",
      "transitioning",
    ]);

    expect(inputs.audio).toHaveLength(1);
    expect(inputs.audio[0].content_type).toBe("audio/wav");
    const wav = atob(inputs.audio[0].base64);
    expect(wav.slice(0, 4)).toBe("RIFF");
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(options.signal).toBeInstanceOf(AbortSignal);

    expect(result.model).toBe("clef-omni");
    expect(result.latestUtterance).toBe("[2.5s of presenter audio]");
    expect(result.shouldAdvance).toBe(true);
  });

  it("says when older audio was dropped", async () => {
    const { AI, calls } = fakeClefOmni();
    await evaluateNavigationAudio(
      { slide, pcm: new Int16Array(SAMPLE_RATE), truncated: true },
      { AI },
    );
    expect(calls[0].inputs.state.presenter_audio.description).toContain("most recent 1 seconds");
  });

  it("aborts the request when the caller's signal fires", async () => {
    const { AI, calls } = fakeClefOmni();
    const controller = new AbortController();
    await evaluateNavigationAudio({ slide, pcm: new Int16Array(160) }, { AI }, controller.signal);
    controller.abort();
    expect(calls[0].options.signal.aborted).toBe(true);
  });
});

describe("PauseTranscriber", () => {
  it("reports levels every levelReportMs of audio", () => {
    const levels: number[] = [];
    const session = new PauseTranscriber(
      { onAudio: () => {}, onSpeechStart: () => {}, onPause: () => {}, onLevels: (l) => levels.push(l.ms) },
      { levelReportMs: 1_000 },
    ).createSession();
    for (let i = 0; i < 25; i++) session.feed(new Int16Array(1_600).buffer); // 2.5 s in 100 ms chunks
    expect(levels).toEqual([1_000, 1_000]);
  });

  it("forwards audio and speech/pause events, and stops after close", () => {
    const received: string[] = [];
    let samples = 0;
    const transcriber = new PauseTranscriber({
      onAudio: (pcm) => (samples += pcm.length),
      onSpeechStart: () => received.push("speech_start"),
      onPause: () => received.push("pause"),
    });
    const session = transcriber.createSession();

    const speech = new Int16Array(SAMPLE_RATE).map((_, i) => (i % 2 ? 6_000 : -6_000));
    session.feed(speech.buffer);
    session.feed(new Int16Array(SAMPLE_RATE).buffer);
    expect(received).toEqual(["speech_start", "pause"]);
    expect(samples).toBe(SAMPLE_RATE * 2);

    session.close();
    session.feed(speech.buffer);
    expect(samples).toBe(SAMPLE_RATE * 2);
  });
});
