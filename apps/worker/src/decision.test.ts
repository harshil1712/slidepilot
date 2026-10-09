import { describe, expect, it } from "vitest";
import { evaluateNavigation, makeDecision } from "./decision";
import type { DecisionSignals, SlideContext } from "./types";

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

describe("SlidePilot navigation policy", () => {
  it("advances when every safety gate passes", () => {
    const signals: DecisionSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.04, next_slide: 0.96 },
      actionConfidence: 0.9,
      slideComplete: 0.94,
      stillExplaining: 0.08,
      transitioning: 0.91,
    };

    expect(
      makeDecision(slide, "With that, let's look at the architecture.", signals, "test", 1)
        .shouldAdvance,
    ).toBe(true);
  });

  it("advances after semantic completion without explicit transition language", () => {
    const signals: DecisionSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.26, next_slide: 0.74 },
      actionConfidence: 0.48,
      slideComplete: 0.86,
      stillExplaining: 0.12,
      transitioning: 0.28,
    };

    const result = makeDecision(
      slide,
      "The code keeps control of navigation while the model supplies judgment.",
      signals,
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(true);
  });

  it("stays when the presenter signals unfinished business", () => {
    const signals: DecisionSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.08, next_slide: 0.92 },
      actionConfidence: 0.8,
      slideComplete: 0.9,
      stillExplaining: 0.88,
      transitioning: 0.8,
    };

    const result = makeDecision(
      slide,
      "Before we move on, there is one more detail.",
      signals,
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(false);
    expect(result.reason).toContain("continuing");
  });

  it("stays when transition language is strong but the slide is incomplete", () => {
    const signals: DecisionSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.22, next_slide: 0.78 },
      actionConfidence: 0.56,
      slideComplete: 0.31,
      stillExplaining: 0.08,
      transitioning: 0.92,
    };

    const result = makeDecision(
      slide,
      "Next, we will discuss the architecture.",
      signals,
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(false);
    expect(result.reason).toContain("core idea");
  });

  it("never advances a manual slide", () => {
    const signals: DecisionSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.01, next_slide: 0.99 },
      actionConfidence: 0.98,
      slideComplete: 0.99,
      stillExplaining: 0.01,
      transitioning: 0.99,
    };

    expect(
      makeDecision(
        { ...slide, manual: true },
        "Moving on.",
        signals,
        "test",
        1,
      ).shouldAdvance,
    ).toBe(false);
  });
});

describe("Clef evaluation", () => {
  async function evaluateWithFakeClef(slideContext: SlideContext) {
    const calls: { model: string; inputs: any; options: any }[] = [];
    const AI = {
      run: async (model: string, inputs: unknown, options: unknown) => {
        calls.push({ model, inputs, options });
        return {
          model: "clef-flash",
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

    const result = await evaluateNavigation(
      { slide: slideContext, utterances: ["That is the entire loop."] },
      { AI },
    );
    return { calls, result };
  }

  it("calls clef-flash on Workers AI and maps the answers", async () => {
    const { calls, result } = await evaluateWithFakeClef(slide);

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0].inputs.model).toBe("clef-flash");
    expect(calls[0].inputs.state.current_slide.title).toBe(slide.title);
    expect(calls[0].inputs.state.current_slide.reveal_progress).toBeUndefined();
    expect(calls[0].inputs.state.advancing_now_will).toBe("Move to the next slide");
    expect(Object.keys(calls[0].inputs.questions)).toEqual([
      "action",
      "slide_complete",
      "still_explaining",
      "transitioning",
    ]);
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);

    expect(result.model).toBe("clef-flash");
    expect(result.clicks).toBe(0);
    expect(result.signals.actionProbabilities.next_slide).toBe(0.9);
    expect(result.shouldAdvance).toBe(true);
  });

  it("tells Clef about click progress on progressively revealed slides", async () => {
    const midway = await evaluateWithFakeClef({ ...slide, clicks: 1, totalClicks: 3 });
    expect(midway.calls[0].inputs.state.current_slide.reveal_progress).toEqual({
      clicks_revealed: 1,
      total_clicks: 3,
    });
    expect(midway.calls[0].inputs.state.advancing_now_will).toBe(
      "Reveal the next part of the current slide",
    );
    expect(midway.result.clicks).toBe(1);

    const lastClick = await evaluateWithFakeClef({ ...slide, clicks: 3, totalClicks: 3 });
    expect(lastClick.calls[0].inputs.state.advancing_now_will).toBe("Move to the next slide");
  });
});
