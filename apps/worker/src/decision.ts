import type {
  DecisionSignals,
  NavigationDecision,
  SlideContext,
} from "./types";

export interface DecisionEnv {
  AI: Ai;
}

export interface EvaluateInput {
  slide: SlideContext;
  utterances: string[];
}

const CLEF_MODEL = "clef-flash";

const QUESTIONS = {
  action: {
    type: "choice",
    instructions:
      "Based on everything said since this slide appeared, would advancing now (see advancing_now_will) feel natural to the audience?",
    criteria: {
      stay: "Stay only when a substantive point in what is currently shown remains unexplained or the presenter clearly signals that the current thought will continue.",
      next_slide: "Advance when the point of what is currently shown has been communicated and the latest utterance reaches a natural stopping point. No explicit transition phrase or sign-off is required.",
    },
  },
  slide_complete: {
    type: "noul",
    instructions:
      "Has the transcript communicated the core idea of what is currently shown well enough to advance? If the slide reveals content progressively (see reveal_progress), visible_content also includes parts not yet revealed: judge only the part revealed so far. Treat speaker notes as intent and context, not as a literal checklist or script.",
    criteria: {
      true: "The audience has enough context to understand the main point of what is currently shown, even if optional details were omitted and no explicit closing phrase was used.",
      false: "A central idea in what is currently shown remains unexplained, or the transcript is too thin to establish its purpose.",
    },
  },
  still_explaining: {
    type: "noul",
    instructions:
      "Is there positive evidence that the presenter intends to continue the current thought before advancing?",
    criteria: {
      true: "The presenter starts an unfinished clause or promises another detail, qualification, example, or demo step about what is currently shown.",
      false: "The latest utterance completes its thought. Do not require an explicit sign-off to choose false.",
    },
  },
  transitioning: {
    type: "noul",
    instructions:
      "Has the presenter reached a natural boundary to advance (see advancing_now_will), whether or not they explicitly announce a transition?",
    criteria: {
      true: "The current thought is wrapped up, summarized, or naturally hands off to what comes next.",
      false: "Advancing at this exact point would interrupt the current explanation.",
    },
  },
} as const;

// Workers AI types don't include Clef yet; this is the subset we read.
interface ClefResponse {
  model: string;
  answers: {
    action: {
      choice: string;
      probabilities: Record<"stay" | "next_slide", number>;
      confidence: number;
    };
    slide_complete: { noul: number };
    still_explaining: { noul: number };
    transitioning: { noul: number };
  };
}

export async function evaluateNavigation(
  input: EvaluateInput,
  env: DecisionEnv,
): Promise<NavigationDecision> {
  const startedAt = Date.now();
  const normalizedUtterances = input.utterances
    .map((utterance) => utterance.trim())
    .filter(Boolean)
    .slice(-12);

  const response = (await env.AI.run(
    `@cf/cloudflare/${CLEF_MODEL}`,
    {
      model: CLEF_MODEL,
      state: {
        current_slide: {
          title: input.slide.title || "Untitled slide",
          visible_content: input.slide.content || "No visible text",
          speaker_notes: input.slide.notes || "No speaker notes provided",
          ...(input.slide.totalClicks > 0 && {
            reveal_progress: {
              clicks_revealed: input.slide.clicks,
              total_clicks: input.slide.totalClicks,
            },
          }),
        },
        advancing_now_will:
          input.slide.clicks < input.slide.totalClicks
            ? "Reveal the next part of the current slide"
            : "Move to the next slide",
        next_slide: {
          title: input.slide.nextSlideTitle || "No next slide title provided",
        },
        transcript_on_current_slide: normalizedUtterances,
        latest_completed_utterance:
          normalizedUtterances.at(-1) || "No completed utterance",
      },
      questions: QUESTIONS,
    },
    { signal: AbortSignal.timeout(8_000) },
  )) as unknown as ClefResponse;

  const signals: DecisionSignals = {
    recommendedAction:
      response.answers.action.choice === "next_slide" ? "next_slide" : "stay",
    actionProbabilities: {
      stay: response.answers.action.probabilities.stay,
      next_slide: response.answers.action.probabilities.next_slide,
    },
    actionConfidence: response.answers.action.confidence,
    slideComplete: response.answers.slide_complete.noul,
    stillExplaining: response.answers.still_explaining.noul,
    transitioning: response.answers.transitioning.noul,
  };

  return makeDecision(
    input.slide,
    normalizedUtterances.at(-1) || "",
    signals,
    response.model,
    Date.now() - startedAt,
  );
}

export function makeDecision(
  slide: SlideContext,
  latestUtterance: string,
  signals: DecisionSignals,
  model: string,
  latencyMs: number,
): NavigationDecision {
  const t = slide.thresholds;
  const gates = {
    automatic: !slide.manual,
    probability: signals.actionProbabilities.next_slide >= t.advance,
    confidence: signals.actionConfidence >= t.confidence,
    complete: signals.slideComplete >= t.complete,
    notContinuing: signals.stillExplaining <= t.stillExplainingCeiling,
  };

  const shouldAdvance = Object.values(gates).every(Boolean);
  const failedGate = Object.entries(gates).find(([, passed]) => !passed)?.[0];

  return {
    type: "slidepilot:decision",
    id: crypto.randomUUID(),
    page: slide.page,
    clicks: slide.clicks,
    action: shouldAdvance ? "next_slide" : "stay",
    shouldAdvance,
    reason: shouldAdvance
      ? "All navigation safety gates passed."
      : explainFailedGate(failedGate),
    signals,
    latestUtterance,
    model,
    latencyMs,
  };
}

function explainFailedGate(gate?: string): string {
  const reasons: Record<string, string> = {
    automatic: "This slide is configured for manual navigation.",
    probability: "Clef does not yet consider this a natural point to advance.",
    confidence: "Clef is too uncertain about advancing at this boundary.",
    complete: "The slide's core idea does not appear complete yet.",
    notContinuing: "The presenter appears to be continuing the current thought.",
  };
  return reasons[gate || ""] || "Navigation remained on the current slide.";
}
