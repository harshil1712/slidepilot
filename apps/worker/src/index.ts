import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents";
import { withVoiceInput, WorkersAIFluxSTT } from "agents/voice";
import { SAMPLE_RATE, SlideAudioBuffer } from "./audio";
import { evaluateNavigation } from "./decision";
import {
  OMNI_MAX_AUDIO_SECONDS,
  PauseTranscriber,
  evaluateNavigationAudio,
} from "./omni";
import type {
  ClientMessage,
  Engine,
  NavigationDecision,
  PilotState,
  SlideContext,
} from "./types";

interface Env {
  AI: Ai;
  SlidePilot: DurableObjectNamespace;
  /** Default engine when the deck does not set `slidePilot.engine`. */
  SLIDEPILOT_ENGINE?: string;
}

const VoiceInputAgent = withVoiceInput(Agent, {
  diagnostics: { browserConsole: true },
});

export class SlidePilot extends VoiceInputAgent<Env, PilotState> {
  initialState: PilotState = {
    slide: null,
    utterances: [],
    lastDecision: null,
  };

  transcriber = new WorkersAIFluxSTT(withWebSocketDiagnostics(this.env.AI), {
    // Favor frequent utterances; the conservative navigation policy still decides.
    eotThreshold: 0.6,
    eotTimeoutMs: 1_200,
    keyterms: ["Cloudflare", "Clef", "Slidev", "Workers AI"],
  });

  // Omni engine: in-memory only. Audio is too large for synced agent state.
  private slideAudio = new SlideAudioBuffer(OMNI_MAX_AUDIO_SECONDS * SAMPLE_RATE);
  private omniEvaluation: AbortController | null = null;
  private activeEngines = new Map<string, Engine>();

  /**
   * Chosen at call start. Returning null keeps the Flux `transcriber`; the omni
   * engine swaps in a pause detector so Clef-omni can judge the raw audio.
   */
  createTranscriber(connection: Connection) {
    const engine = this.resolveEngine();
    this.activeEngines.set(connection.id, engine);
    if (engine !== "omni") return null;

    this.resetOmni();
    return new PauseTranscriber({
      onAudio: (pcm) => this.slideAudio.append(pcm),
      onSpeechStart: () => {
        // The presenter resumed: drop any in-flight judgement and tell the
        // addon to cancel a pending advance.
        this.abortOmniEvaluation();
        this.send(connection, { type: "slidepilot:speech" });
      },
      onPause: (pause) => {
        void this.evaluateAudio(connection, pause.speechMs);
      },
    });
  }

  afterTranscribe(transcript: string) {
    const normalized = transcript.trim();
    return normalized.length >= 2 ? normalized : null;
  }

  onCallStart(connection: Connection) {
    const engine = this.activeEngines.get(connection.id) ?? "flux";
    console.log("SlidePilot call started", { connectionId: connection.id, engine });
    this.send(connection, { type: "slidepilot:ready", engine });
  }

  onCallEnd(connection: Connection) {
    this.activeEngines.delete(connection.id);
    this.resetOmni();
  }

  async onTranscript(text: string, connection: Connection) {
    console.log("SlidePilot received completed transcript", {
      connectionId: connection.id,
      characters: text.length,
    });

    const slide = this.state.slide;
    if (!slide) {
      this.send(connection, {
        type: "slidepilot:error",
        message: "No slide context received yet.",
      });
      return;
    }

    const utterances = [...this.state.utterances, text].slice(-12);
    this.setState({ ...this.state, utterances });

    try {
      const decision = await evaluateNavigation(
        { slide, utterances },
        this.env,
      );
      console.log("SlidePilot navigation decision", {
        page: decision.page,
        clicks: decision.clicks,
        action: decision.action,
        shouldAdvance: decision.shouldAdvance,
        reason: decision.reason,
        model: decision.model,
        latencyMs: decision.latencyMs,
        signals: decision.signals,
      });

      // Ignore a decision if the presenter navigated while Clef was evaluating.
      if (
        this.state.slide?.page !== slide.page ||
        this.state.slide?.clicks !== slide.clicks
      ) return;

      this.setState({ ...this.state, utterances, lastDecision: decision });
      this.send(connection, decision);
    } catch (error) {
      console.error("SlidePilot evaluation failed", error);
      this.send(connection, {
        type: "slidepilot:error",
        message:
          error instanceof Error ? error.message : "Clef evaluation failed.",
      });
    }
  }

  private async evaluateAudio(connection: Connection, speechMs: number) {
    const slide = this.state.slide;
    if (!slide) {
      this.send(connection, {
        type: "slidepilot:error",
        message: "No slide context received yet.",
      });
      return;
    }

    const pcm = this.slideAudio.toPcm();
    if (pcm.length === 0) return;

    this.abortOmniEvaluation();
    const controller = new AbortController();
    this.omniEvaluation = controller;

    try {
      const decision = await evaluateNavigationAudio(
        {
          slide,
          pcm,
          truncated: this.slideAudio.truncated,
          sampleRate: SAMPLE_RATE,
        },
        this.env,
        controller.signal,
      );
      // Speech resumed (or the call ended) while Clef-omni was listening.
      if (controller.signal.aborted) return;
      this.logDecision(decision, { engine: "omni", speechMs });

      if (
        this.state.slide?.page !== slide.page ||
        this.state.slide?.clicks !== slide.clicks
      ) return;

      this.setState({ ...this.state, lastDecision: decision });
      this.send(connection, decision);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("SlidePilot omni evaluation failed", error);
      this.send(connection, {
        type: "slidepilot:error",
        message:
          error instanceof Error ? error.message : "Clef-omni evaluation failed.",
      });
    } finally {
      if (this.omniEvaluation === controller) this.omniEvaluation = null;
    }
  }

  private logDecision(decision: NavigationDecision, extra: Record<string, unknown>) {
    console.log("SlidePilot navigation decision", {
      ...extra,
      page: decision.page,
      clicks: decision.clicks,
      action: decision.action,
      shouldAdvance: decision.shouldAdvance,
      reason: decision.reason,
      model: decision.model,
      latencyMs: decision.latencyMs,
      signals: decision.signals,
    });
  }

  private resolveEngine(): Engine {
    return this.state.engine ?? normalizeEngine(this.env.SLIDEPILOT_ENGINE) ?? "flux";
  }

  private abortOmniEvaluation() {
    this.omniEvaluation?.abort();
    this.omniEvaluation = null;
  }

  private resetOmni() {
    this.abortOmniEvaluation();
    this.slideAudio.clear();
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    if (parsed.type === "slidepilot:reset") {
      this.resetOmni();
      this.setState({ ...this.state, utterances: [], lastDecision: null });
      return;
    }

    if (parsed.type === "slidepilot:context") {
      const context = normalizeSlideContext(parsed.context);
      const changedSlide = this.state.slide?.page !== context.page;
      // Like the transcript, slide audio spans clicks but resets per slide.
      if (changedSlide) this.resetOmni();
      this.setState({
        slide: context,
        utterances: changedSlide ? [] : this.state.utterances,
        lastDecision: changedSlide ? null : this.state.lastDecision,
        engine: normalizeEngine(parsed.engine),
      });
    }
  }

  private send(connection: Connection, data: unknown) {
    connection.send(JSON.stringify(data));
  }
}

function withWebSocketDiagnostics(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property !== "run") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        const result = await Reflect.apply(
          value as (...runArgs: unknown[]) => Promise<unknown>,
          target,
          args,
        );
        const options = args[2];
        const requestedWebSocket =
          options !== null &&
          typeof options === "object" &&
          "websocket" in options &&
          options.websocket === true;

        if (requestedWebSocket && result instanceof Response && !result.webSocket) {
          let body = "";
          try {
            body = (await result.clone().text()).slice(0, 2_000);
          } catch {
            body = "<unreadable>";
          }
          console.error("Workers AI WebSocket response diagnostic", {
            status: result.status,
            statusText: result.statusText,
            contentType: result.headers.get("content-type"),
            cfRay: result.headers.get("cf-ray"),
            body,
          });
        }

        return result;
      };
    },
  }) as Ai;
}

function normalizeSlideContext(value: SlideContext): SlideContext {
  const thresholds = value?.thresholds || ({} as SlideContext["thresholds"]);
  return {
    page: String(value?.page || "1"),
    title: String(value?.title || "Untitled slide").slice(0, 500),
    content: String(value?.content || "").slice(0, 20_000),
    notes: String(value?.notes || "").slice(0, 20_000),
    nextSlideTitle: String(value?.nextSlideTitle || "").slice(0, 500),
    clicks: Math.max(0, Math.floor(Number(value?.clicks) || 0)),
    totalClicks: Math.max(0, Math.floor(Number(value?.totalClicks) || 0)),
    manual: Boolean(value?.manual),
    thresholds: {
      advance: clamp(thresholds.advance, 0.68),
      confidence: clamp(thresholds.confidence, 0.3),
      complete: clamp(thresholds.complete, 0.65),
      stillExplainingCeiling: clamp(
        thresholds.stillExplainingCeiling,
        0.55,
      ),
    },
  };
}

function normalizeEngine(value: unknown): Engine | undefined {
  return value === "flux" || value === "omni" ? value : undefined;
}

function clamp(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : fallback;
  return Math.min(1, Math.max(0, number));
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  return Response.json(data, { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "slidepilot" });
    }

    if (url.pathname === "/api/evaluate" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          slide: SlideContext;
          utterances: string[];
        };
        const decision = await evaluateNavigation(
          {
            slide: normalizeSlideContext(body.slide),
            utterances: Array.isArray(body.utterances) ? body.utterances : [],
          },
          env,
        );
        return json(decision);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Evaluation failed.",
          },
          { status: 400 },
        );
      }
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ??
      json({ error: "Not found" }, { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
