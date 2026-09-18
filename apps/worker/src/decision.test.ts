import { describe, expect, it } from "vitest";
import { evaluateNavigation, makeDecision } from "./decision";
import type { JevSignals, SlideContext } from "./types";

const slide: SlideContext = {
  page: "2",
  title: "The three-part pipeline",
  content: "Voice hears. Jev decides. Slidev acts.",
  notes: "Explain each part and conclude the loop.",
  nextSlideTitle: "Architecture",
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
    const signals: JevSignals = {
      recommendedAction: "next_slide",
      actionProbabilities: { stay: 0.04, next_slide: 0.96 },
      actionConfidence: 0.9,
      slideComplete: 0.94,
      stillExplaining: 0.08,
      transitioning: 0.91,
    };

    expect(
      makeDecision(slide, "With that, let's look at the architecture.", signals, "mock", "test", 1)
        .shouldAdvance,
    ).toBe(true);
  });

  it("advances after semantic completion without explicit transition language", () => {
    const signals: JevSignals = {
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
      "mock",
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(true);
  });

  it("stays when the presenter signals unfinished business", () => {
    const signals: JevSignals = {
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
      "mock",
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(false);
    expect(result.reason).toContain("continuing");
  });

  it("stays when transition language is strong but the slide is incomplete", () => {
    const signals: JevSignals = {
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
      "mock",
      "test",
      1,
    );
    expect(result.shouldAdvance).toBe(false);
    expect(result.reason).toContain("core idea");
  });

  it("never advances a manual slide", () => {
    const signals: JevSignals = {
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
        "mock",
        "test",
        1,
      ).shouldAdvance,
    ).toBe(false);
  });

  it("provides a deterministic no-key mock for local development", async () => {
    const result = await evaluateNavigation(
      {
        slide,
        utterances: [
          "The microphone creates the transcript.",
          "Jev makes the bounded decision and Slidev performs the action.",
          "That is the entire loop. With that, let's move on.",
        ],
      },
      {},
    );

    expect(result.provider).toBe("mock");
    expect(result.shouldAdvance).toBe(true);
  });
});
