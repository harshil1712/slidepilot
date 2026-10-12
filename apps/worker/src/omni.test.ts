import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "./audio";
import { OmniListener, evaluateNavigationAudio } from "./omni";
import { join, silence, tone } from "./test-audio";
import type { NavigationDecision, SlideContext } from "./types";

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

describe("OmniListener", () => {
  /** Clef-omni stand-in whose answers resolve only when the test says so. */
  function deferredClefOmni() {
    const { AI: immediate } = fakeClefOmni();
    const requests: { inputs: any; signal: AbortSignal; answer(): void }[] = [];
    const AI = {
      run: (model: string, inputs: any, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
          requests.push({
            inputs,
            signal: options.signal,
            answer: () => resolve(immediate.run(model, inputs, options)),
          });
        }),
    } as unknown as Ai;
    return { AI, requests };
  }

  function setup(initialSlide: SlideContext | null = slide) {
    const { AI, requests } = deferredClefOmni();
    const events: string[] = [];
    const decisions: NavigationDecision[] = [];
    let current = initialSlide;
    const listener = new OmniListener({
      env: { AI },
      getSlide: () => current,
      onSpeech: () => events.push("speech"),
      onDecision: (decision) => decisions.push(decision),
      onError: (message) => events.push(`error: ${message}`),
    });
    const session = listener.transcriber.createSession();
    const say = (...parts: Int16Array[]) => session.feed(join(...parts).buffer as ArrayBuffer);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      listener,
      session,
      say,
      flush,
      requests,
      events,
      decisions,
      showSlide: (next: SlideContext) => (current = next),
    };
  }

  it("evaluates at each pause and forwards the decision", async () => {
    const t = setup();
    t.say(tone(1_000, 0.2), silence(800));
    expect(t.events).toEqual(["speech"]);
    expect(t.requests).toHaveLength(1);

    t.requests[0].answer();
    await t.flush();
    expect(t.decisions).toHaveLength(1);
    expect(t.decisions[0].shouldAdvance).toBe(true);
  });

  it("drops the decision when the presenter resumes speaking", async () => {
    const t = setup();
    t.say(tone(1_000, 0.2), silence(800));
    t.say(tone(200, 0.2));

    expect(t.events).toEqual(["speech", "speech"]);
    expect(t.requests[0].signal.aborted).toBe(true);
    await t.flush();
    expect(t.decisions).toEqual([]);
  });

  it("drops the decision when the slide changed during evaluation", async () => {
    const t = setup();
    t.say(tone(1_000, 0.2), silence(800));
    t.showSlide({ ...slide, clicks: 1, totalClicks: 2 });

    t.requests[0].answer();
    await t.flush();
    expect(t.decisions).toEqual([]);
  });

  it("only sends audio from the current slide", () => {
    const t = setup();
    t.say(tone(2_000, 0.2));
    t.listener.resetSlide();
    t.say(tone(1_000, 0.2), silence(800));

    const wavBytes = atob(t.requests[0].inputs.audio[0].base64).length;
    expect(wavBytes).toBe(44 + SAMPLE_RATE * 1.8 * 2);
  });

  it("reports an error when no slide context has arrived", () => {
    const t = setup(null);
    t.say(tone(1_000, 0.2), silence(800));
    expect(t.events).toContain("error: No slide context received yet.");
    expect(t.requests).toHaveLength(0);
  });

  it("stops listening and cancels evaluation when the session closes", () => {
    const t = setup();
    t.say(tone(1_000, 0.2), silence(800));
    t.session.close();
    expect(t.requests[0].signal.aborted).toBe(true);

    t.say(tone(1_000, 0.2), silence(800));
    expect(t.requests).toHaveLength(1);
  });
});
