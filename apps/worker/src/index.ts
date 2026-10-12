import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents";
import { withVoiceInput, WorkersAIFluxSTT } from "agents/voice";
import { evaluateNavigation, isSameView, logDecision } from "./decision";
import { OmniListener } from "./omni";
import type {
  ClientMessage,
  Engine,
  PilotState,
  SlideContext,
} from "./types";

interface Env {
  AI: Ai;
  SlidePilot: DurableObjectNamespace;
  /** Default engine when the deck does not set `slidePilot.engine`. */
  SLIDEPILOT_ENGINE?: string;
  /** "1" logs omni input levels every 5 s for pause-detector tuning. */
  SLIDEPILOT_DEBUG_AUDIO?: string;
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

  // One omni listener per active call; audio stays in memory, never in state.
  private omniListeners = new Map<string, OmniListener>();

  /**
   * Picks the engine at call start. Returning null keeps the Flux
   * `transcriber`; the omni engine replaces it with a pause detector.
   */
  createTranscriber(connection: Connection) {
    if (this.resolveEngine() !== "omni") {
      this.omniListeners.delete(connection.id);
      return null;
    }

    const listener = new OmniListener({
      env: this.env,
      getSlide: () => this.state.slide,
      onSpeech: () => this.send(connection, { type: "slidepilot:speech" }),
      onDecision: (decision) => {
        this.setState({ ...this.state, lastDecision: decision });
        this.send(connection, decision);
      },
      onError: (message) => this.send(connection, { type: "slidepilot:error", message }),
      debug: this.env.SLIDEPILOT_DEBUG_AUDIO === "1",
    });
    this.omniListeners.set(connection.id, listener);
    return listener.transcriber;
  }

  afterTranscribe(transcript: string) {
    const normalized = transcript.trim();
    return normalized.length >= 2 ? normalized : null;
  }

  onCallStart(connection: Connection) {
    const engine: Engine = this.omniListeners.has(connection.id) ? "omni" : "flux";
    console.log("SlidePilot call started", { connectionId: connection.id, engine });
    this.send(connection, { type: "slidepilot:ready", engine });
  }

  onCallEnd(connection: Connection) {
    this.omniListeners.delete(connection.id);
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
      logDecision(decision, { engine: "flux" });

      // Ignore a decision if the presenter navigated while Clef was evaluating.
      if (!isSameView(slide, this.state.slide)) return;

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

  private resolveEngine(): Engine {
    return this.state.engine ?? normalizeEngine(this.env.SLIDEPILOT_ENGINE) ?? "flux";
  }

  private resetOmniSlide() {
    for (const listener of this.omniListeners.values()) listener.resetSlide();
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
      this.resetOmniSlide();
      this.setState({ ...this.state, utterances: [], lastDecision: null });
      return;
    }

    if (parsed.type === "slidepilot:context") {
      const context = normalizeSlideContext(parsed.context);
      const changedSlide = this.state.slide?.page !== context.page;
      // Like the transcript, slide audio spans clicks but resets per slide.
      if (changedSlide) this.resetOmniSlide();
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
