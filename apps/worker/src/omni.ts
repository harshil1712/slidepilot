// Experimental engine: a pause detector replaces Flux STT, and Clef-omni hears
// the presenter's audio directly instead of reading a transcript.
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
} from "agents/voice";
import {
  PauseDetector,
  SAMPLE_RATE,
  encodeWav,
  pcmFromChunk,
  toBase64,
  type AudioLevels,
  type PauseDetectorOptions,
  type PauseEvent,
} from "./audio";
import {
  buildSlideState,
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
export const OMNI_MAX_AUDIO_SECONDS = 60;

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
  /** The presenter's audio on the current slide, oldest sample first. */
  pcm: Int16Array;
  /** True when older audio on this slide was dropped to fit the clip limit. */
  truncated?: boolean;
  sampleRate?: number;
}

export async function evaluateNavigationAudio(
  input: EvaluateAudioInput,
  env: DecisionEnv,
  signal?: AbortSignal,
): Promise<NavigationDecision> {
  const startedAt = Date.now();
  const sampleRate = input.sampleRate ?? SAMPLE_RATE;
  const seconds = Math.round((input.pcm.length / sampleRate) * 10) / 10;
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
      audio: [{ content_type: "audio/wav", base64: toBase64(encodeWav(input.pcm, sampleRate)) }],
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

export interface PauseTranscriberHandlers {
  onAudio(pcm: Int16Array): void;
  onSpeechStart(event: Extract<PauseEvent, { type: "speech_start" }>): void;
  onPause(event: Extract<PauseEvent, { type: "pause" }>): void;
  /** Called every `levelReportMs` of received audio, when provided. */
  onLevels?(levels: AudioLevels): void;
}

export interface PauseTranscriberOptions extends PauseDetectorOptions {
  levelReportMs?: number;
}

/**
 * Plugs the pause detector into agents/voice in place of an STT provider.
 * withVoiceInput feeds every PCM chunk to the session; instead of emitting
 * transcripts, the session forwards audio and speech/pause events.
 */
export class PauseTranscriber implements Transcriber {
  constructor(
    private readonly handlers: PauseTranscriberHandlers,
    private readonly options: PauseTranscriberOptions = {},
  ) {}

  createSession(_options?: TranscriberSessionOptions): TranscriberSession {
    const { levelReportMs = 5_000, ...detectorOptions } = this.options;
    const detector = new PauseDetector(detectorOptions);
    const reportSamples = (detector.options.sampleRate * levelReportMs) / 1_000;
    let samplesSinceReport = 0;
    let closed = false;
    return {
      feed: (chunk: ArrayBuffer) => {
        if (closed) return;
        const pcm = pcmFromChunk(chunk);
        this.handlers.onAudio(pcm);
        for (const event of detector.push(pcm)) {
          if (event.type === "speech_start") this.handlers.onSpeechStart(event);
          else this.handlers.onPause(event);
        }
        samplesSinceReport += pcm.length;
        if (this.handlers.onLevels && samplesSinceReport >= reportSamples) {
          samplesSinceReport = 0;
          this.handlers.onLevels(detector.takeLevels());
        }
      },
      close: () => {
        closed = true;
      },
    };
  }
}
