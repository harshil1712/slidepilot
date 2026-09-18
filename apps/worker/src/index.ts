import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents";
import { withVoiceInput, WorkersAIFluxSTT } from "agents/voice";
import { evaluateNavigation } from "./decision";
import type {
  ClientMessage,
  PilotState,
  SlideContext,
} from "./types";

interface Env {
  AI: Ai;
  SlidePilot: DurableObjectNamespace;
  TYPESAFE_API_KEY?: string;
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
    // Favor frequent utterances; the conservative Jev policy still owns navigation.
    eotThreshold: 0.6,
    eotTimeoutMs: 1_200,
    keyterms: ["Cloudflare", "Jev", "Slidev", "TypeSafe"],
  });

  afterTranscribe(transcript: string) {
    const normalized = transcript.trim();
    return normalized.length >= 2 ? normalized : null;
  }

  onCallStart(connection: Connection) {
    this.send(connection, {
      type: "slidepilot:ready",
      provider: this.env.TYPESAFE_API_KEY ? "jev" : "mock",
    });
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
        action: decision.action,
        shouldAdvance: decision.shouldAdvance,
        reason: decision.reason,
        provider: decision.provider,
        latencyMs: decision.latencyMs,
        signals: decision.signals,
      });

      // Ignore a decision if the presenter navigated while Jev was evaluating.
      if (this.state.slide?.page !== slide.page) return;

      this.setState({ ...this.state, utterances, lastDecision: decision });
      this.send(connection, decision);
    } catch (error) {
      console.error("SlidePilot evaluation failed", error);
      this.send(connection, {
        type: "slidepilot:error",
        message:
          error instanceof Error ? error.message : "Jev evaluation failed.",
      });
    }
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
      this.setState({ ...this.state, utterances: [], lastDecision: null });
      return;
    }

    if (parsed.type === "slidepilot:context") {
      const context = normalizeSlideContext(parsed.context);
      const changedSlide = this.state.slide?.page !== context.page;
      this.setState({
        slide: context,
        utterances: changedSlide ? [] : this.state.utterances,
        lastDecision: changedSlide ? null : this.state.lastDecision,
      });
      this.send(connection, {
        type: "slidepilot:context-accepted",
        page: context.page,
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
      return json({
        ok: true,
        service: "slidepilot",
        decisionProvider: env.TYPESAFE_API_KEY ? "jev" : "mock",
      });
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
