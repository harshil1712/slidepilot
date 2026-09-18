export interface SlideContext {
  page: string;
  title: string;
  content: string;
  notes: string;
  nextSlideTitle: string;
  manual: boolean;
  thresholds: {
    advance: number;
    confidence: number;
    complete: number;
    stillExplainingCeiling: number;
  };
}

export interface JevSignals {
  recommendedAction: "stay" | "next_slide";
  actionProbabilities: {
    stay: number;
    next_slide: number;
  };
  actionConfidence: number;
  slideComplete: number;
  stillExplaining: number;
  transitioning: number;
}

export interface NavigationDecision {
  type: "slidepilot:decision";
  id: string;
  page: string;
  action: "stay" | "next_slide";
  shouldAdvance: boolean;
  reason: string;
  signals: JevSignals;
  latestUtterance: string;
  provider: "jev" | "mock";
  model: string;
  latencyMs: number;
}

export interface PilotState {
  slide: SlideContext | null;
  utterances: string[];
  lastDecision: NavigationDecision | null;
}

export type ClientMessage =
  | { type: "slidepilot:context"; context: SlideContext }
  | { type: "slidepilot:reset" };
