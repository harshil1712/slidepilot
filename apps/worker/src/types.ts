export interface SlideContext {
  page: string;
  title: string;
  content: string;
  notes: string;
  nextSlideTitle: string;
  /** Slidev clicks revealed so far, and the slide's total click count. */
  clicks: number;
  totalClicks: number;
  manual: boolean;
  thresholds: {
    advance: number;
    confidence: number;
    complete: number;
    stillExplainingCeiling: number;
  };
}

export interface DecisionSignals {
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
  clicks: number;
  action: "stay" | "next_slide";
  shouldAdvance: boolean;
  reason: string;
  signals: DecisionSignals;
  latestUtterance: string;
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
