import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  JevSignals,
  NavigationDecision,
  SlideContext,
} from "./types";

export interface DecisionEnv {
  TYPESAFE_API_KEY?: string;
}

export interface EvaluateInput {
  slide: SlideContext;
  utterances: string[];
}

const QUESTIONS = {
  action: choice(
    "Based on everything said since this slide appeared, would advancing now feel natural to the audience?",
    {
      stay: "Stay only when a substantive point on this slide remains unexplained or the presenter clearly signals that the current thought will continue.",
      next_slide: "Advance when the slide's core idea has been communicated and the latest utterance reaches a natural stopping point. No explicit transition phrase or sign-off is required.",
    },
  ),
  slide_complete: noul(
    "Has the transcript communicated the current slide's core idea well enough to move on? Treat speaker notes as intent and context, not as a literal checklist or script.",
    {
      true: "The audience has enough context to understand the slide's main point, even if optional details were omitted and no explicit closing phrase was used.",
      false: "A central idea visible on the slide remains unexplained, or the transcript is too thin to establish the slide's purpose.",
    },
  ),
  still_explaining: noul(
    "Is there positive evidence that the presenter intends to continue the current thought on this slide?",
    {
      true: "The presenter starts an unfinished clause or promises another detail, qualification, example, or demo step on this slide.",
      false: "The latest utterance completes its thought. Do not require an explicit sign-off to choose false.",
    },
  ),
  transitioning: noul(
    "Has the presenter reached a natural slide boundary, whether or not they explicitly announce a transition?",
    {
      true: "The current thought is wrapped up, summarized, or naturally hands off to the next slide.",
      false: "Advancing at this exact point would interrupt the current explanation.",
    },
  ),
} as const;

export async function evaluateNavigation(
  input: EvaluateInput,
  env: DecisionEnv,
): Promise<NavigationDecision> {
  const startedAt = Date.now();
  const normalizedUtterances = input.utterances
    .map((utterance) => utterance.trim())
    .filter(Boolean)
    .slice(-12);

  if (!env.TYPESAFE_API_KEY) {
    return mockNavigation(input.slide, normalizedUtterances, startedAt);
  }

  const client = new TypeSafeClient({
    apiKey: env.TYPESAFE_API_KEY,
    defaultModel: "jev-latest",
    timeout: 8_000,
  });

  const response = await client.systemOne({
    state: {
      current_slide: {
        title: input.slide.title || "Untitled slide",
        visible_content: input.slide.content || "No visible text",
        speaker_notes: input.slide.notes || "No speaker notes provided",
      },
      next_slide: {
        title: input.slide.nextSlideTitle || "No next slide title provided",
      },
      transcript_on_current_slide: normalizedUtterances,
      latest_completed_utterance:
        normalizedUtterances.at(-1) || "No completed utterance",
    },
    questions: QUESTIONS,
  });

  const signals: JevSignals = {
    recommendedAction: response.answers.action.choice,
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
    "jev",
    response.model,
    Date.now() - startedAt,
  );
}

export function makeDecision(
  slide: SlideContext,
  latestUtterance: string,
  signals: JevSignals,
  provider: "jev" | "mock",
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
    action: shouldAdvance ? "next_slide" : "stay",
    shouldAdvance,
    reason: shouldAdvance
      ? "All navigation safety gates passed."
      : explainFailedGate(failedGate),
    signals,
    latestUtterance,
    provider,
    model,
    latencyMs,
  };
}

function explainFailedGate(gate?: string): string {
  const reasons: Record<string, string> = {
    automatic: "This slide is configured for manual navigation.",
    probability: "Jev does not yet consider this a natural point to advance.",
    confidence: "Jev is too uncertain about advancing at this boundary.",
    complete: "The slide's core idea does not appear complete yet.",
    notContinuing: "The presenter appears to be continuing the current thought.",
  };
  return reasons[gate || ""] || "Navigation remained on the current slide.";
}

function mockNavigation(
  slide: SlideContext,
  utterances: string[],
  startedAt: number,
): NavigationDecision {
  const latest = utterances.at(-1) || "";
  const text = latest.toLowerCase();
  const all = utterances.join(" ").toLowerCase();

  const holdPatterns = [
    "before we move on",
    "one more",
    "but first",
    "not done",
    "another detail",
    "keep in mind",
  ];
  const transitionPatterns = [
    "that's it",
    "that is it",
    "that's all",
    "that is all",
    "moving on",
    "move on",
    "now let's",
    "now we can",
    "with that",
    "next slide",
    "next up",
  ];

  const holds = holdPatterns.some((pattern) => text.includes(pattern));
  const transitions = transitionPatterns.some((pattern) => text.includes(pattern));
  const hasEnoughContext = all.split(/\s+/).filter(Boolean).length >= 18;

  const nextProbability = holds
    ? 0.08
    : transitions
      ? 0.96
      : hasEnoughContext
        ? 0.42
        : 0.12;

  const signals: JevSignals = {
    recommendedAction: nextProbability >= 0.5 ? "next_slide" : "stay",
    actionProbabilities: {
      stay: 1 - nextProbability,
      next_slide: nextProbability,
    },
    actionConfidence: Math.abs(nextProbability - 0.5) * 2,
    slideComplete: transitions ? 0.95 : hasEnoughContext ? 0.68 : 0.18,
    stillExplaining: holds ? 0.96 : transitions ? 0.05 : 0.58,
    transitioning: transitions ? 0.95 : holds ? 0.03 : 0.2,
  };

  return makeDecision(
    slide,
    latest,
    signals,
    "mock",
    "deterministic-local-mock",
    Date.now() - startedAt,
  );
}
