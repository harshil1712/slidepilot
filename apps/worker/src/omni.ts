// Default engine: a pause detector replaces speech-to-text, and Clef-omni hears
// the presenter's audio directly instead of reading a transcript.
import type { Transcriber, TranscriberSession } from "agents/voice";
import {
  PauseDetector,
  SAMPLE_RATE,
  SlideAudioBuffer,
  encodeWav,
  pcmFromChunk,
  toBase64,
  type PauseDetectorOptions,
} from "./audio";
import {
  buildSlideState,
  isSameView,
  logDecision,
  makeDecision,
  toSignals,
  type ClefResponse,
  type DecisionEnv,
} from "./decision";
import type { NavigationDecision, SlideContext } from "./types";

const CLEF_OMNI_MODEL = "clef-omni";

/**
 * Most recent slide audio sent per evaluation. Clef-omni accepts up to 300 s
 * (8 MiB), but latency grows with length: in a smoke test, 60 s took ~1 s
 * while 240 s took 3.5-7.5 s, too slow for navigation and near the timeout.
 */
const OMNI_MAX_AUDIO_SECONDS = 60;

// Same four questions and answer shapes as the Flux engine so the TypeScript
// policy (makeDecision) and thresholds apply unchanged. Wording refers to what
// the model hears instead of a transcript, and names prosodic cues.
const OMNI_QUESTIONS = {
  action: {
    type: "choice",
    instructions:
      "Based on the presenter audio since this slide appeared, would advancing now (see advancing_now_will) feel natural to the audience? The audio ends where the presenter paused.",
    criteria: {
      stay: "Stay only when a substantive point in what is currently shown remains unexplained or the presenter clearly signals that the current thought will continue.",
      next_slide: "Advance when the point of what is currently shown has been communicated and the presenter's last sentence reaches a natural stopping point. No explicit transition phrase or sign-off is required.",
    },
  },
  slide_complete: {
    type: "noul",
    instructions:
      "Has the presenter audio communicated the core idea of what is currently shown well enough to advance? If the slide reveals content progressively (see reveal_progress), visible_content also includes parts not yet revealed: judge only the part revealed so far. Treat speaker notes as intent and context, not as a literal checklist or script.",
    criteria: {
      true: "The audience has enough context to understand the main point of what is currently shown, even if optional details were omitted and no explicit closing phrase was used.",
      false: "A central idea in what is currently shown remains unexplained, or the presenter has said too little to establish its purpose.",
    },
  },
  still_explaining: {
    type: "noul",
    instructions:
      "Is there positive evidence that the presenter intends to continue the current thought after this pause?",
    criteria: {
      true: "The last sentence is unfinished or trails off mid-clause, ends with rising or sustained intonation or a filler such as 'and' or 'so', or promises another detail, qualification, example, or demo step about what is currently shown.",
      false: "The last sentence completes its thought, typically with falling intonation. Do not require an explicit sign-off to choose false.",
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

export interface EvaluateAudioInput {
  slide: SlideContext;
  /** The presenter's 16 kHz audio on the current slide, oldest sample first. */
  pcm: Int16Array;
  /** True when older audio on this slide was dropped to fit the clip limit. */
  truncated?: boolean;
}

export async function evaluateNavigationAudio(
  input: EvaluateAudioInput,
  env: DecisionEnv,
  signal?: AbortSignal,
): Promise<NavigationDecision> {
  const startedAt = Date.now();
  const seconds = Math.round((input.pcm.length / SAMPLE_RATE) * 10) / 10;
  const timeout = AbortSignal.timeout(8_000);

  const response = (await env.AI.run(
    `@cf/cloudflare/${CLEF_OMNI_MODEL}`,
    {
      model: CLEF_OMNI_MODEL,
      state: {
        ...buildSlideState(input.slide),
        presenter_audio: {
          description: input.truncated
            ? `The attached audio is the most recent ${seconds} seconds of the presenter speaking on this slide; earlier audio was omitted. It ends at the presenter's current pause.`
            : `The attached audio is everything the presenter has said since this slide appeared (${seconds} seconds). It ends at the presenter's current pause.`,
          guidance:
            "Judge only the presenter. Ignore audience noise such as applause, laughter, or background conversation.",
        },
      },
      audio: [{ content_type: "audio/wav", base64: toBase64(encodeWav(input.pcm)) }],
      questions: OMNI_QUESTIONS,
    },
    { signal: signal ? AbortSignal.any([timeout, signal]) : timeout },
  )) as unknown as ClefResponse;

  return makeDecision(
    input.slide,
    `[${seconds}s of presenter audio]`,
    toSignals(response),
    response.model,
    Date.now() - startedAt,
  );
}

export interface OmniListenerHost {
  env: DecisionEnv;
  /** The slide currently on screen. */
  getSlide(): SlideContext | null;
  /** The presenter started speaking: cancel any pending advance. */
  onSpeech(): void;
  /** A decision for the slide that is still on screen. */
  onDecision(decision: NavigationDecision): void;
  onError(message: string): void;
  /** Also log speech/pause events and input levels (SLIDEPILOT_DEBUG_AUDIO). */
  debug?: boolean;
  detector?: PauseDetectorOptions;
}

const LEVEL_REPORT_SAMPLES = 5 * SAMPLE_RATE;

/**
 * The omni engine for one voice call. It keeps the current slide's audio,
 * asks Clef-omni at each pause, and drops answers that arrive after the
 * presenter resumed speaking or the slide changed.
 */
export class OmniListener {
  private readonly audio = new SlideAudioBuffer(OMNI_MAX_AUDIO_SECONDS * SAMPLE_RATE);
  private evaluation: AbortController | null = null;

  constructor(private readonly host: OmniListenerHost) {}

  /** Takes the place of an STT provider in agents/voice. */
  readonly transcriber: Transcriber = {
    createSession: () => this.createSession(),
  };

  /** The slide changed: forget its audio and any judgement in flight. */
  resetSlide() {
    this.cancelEvaluation();
    this.audio.clear();
  }

  private createSession(): TranscriberSession {
    const detector = new PauseDetector(this.host.detector);
    let samplesSinceLevels = 0;
    let receivedAudio = false;
    let closed = false;

    return {
      feed: (chunk: ArrayBuffer) => {
        if (closed) return;
        const pcm = pcmFromChunk(chunk);
        if (!receivedAudio) {
          receivedAudio = true;
          console.log("SlidePilot omni receiving audio");
        }
        this.audio.append(pcm);

        for (const event of detector.push(pcm)) {
          if (event.type === "speech_start") {
            const cancelled = this.cancelEvaluation();
            if (this.host.debug) console.log("SlidePilot omni speech", { ...event, cancelled });
            this.host.onSpeech();
          } else {
            if (this.host.debug) console.log("SlidePilot omni pause", event);
            void this.evaluate(event.speechMs);
          }
        }

        samplesSinceLevels += pcm.length;
        if (this.host.debug && samplesSinceLevels >= LEVEL_REPORT_SAMPLES) {
          samplesSinceLevels = 0;
          console.log("SlidePilot omni levels", detector.takeLevels());
        }
      },
      close: () => {
        closed = true;
        this.resetSlide();
      },
    };
  }

  private async evaluate(speechMs: number) {
    const slide = this.host.getSlide();
    if (!slide) {
      this.host.onError("No slide context received yet.");
      return;
    }
    const pcm = this.audio.toPcm();
    if (pcm.length === 0) return;

    this.cancelEvaluation();
    const controller = new AbortController();
    this.evaluation = controller;

    try {
      const decision = await evaluateNavigationAudio(
        { slide, pcm, truncated: this.audio.truncated },
        this.host.env,
        controller.signal,
      );
      if (controller.signal.aborted) {
        console.log("SlidePilot omni decision dropped: presenter resumed speaking");
        return;
      }
      logDecision(decision, { engine: "omni", speechMs });
      if (!isSameView(slide, this.host.getSlide())) {
        console.log("SlidePilot omni decision dropped: slide changed");
        return;
      }
      this.host.onDecision(decision);
    } catch (error) {
      if (controller.signal.aborted) {
        console.log("SlidePilot omni decision dropped: presenter resumed speaking");
        return;
      }
      console.error("SlidePilot omni evaluation failed", error);
      this.host.onError(error instanceof Error ? error.message : "Clef-omni evaluation failed.");
    } finally {
      if (this.evaluation === controller) this.evaluation = null;
    }
  }

  /** Returns true when an evaluation was in flight. */
  private cancelEvaluation() {
    const controller = this.evaluation;
    this.evaluation = null;
    controller?.abort();
    return controller !== null;
  }
}
