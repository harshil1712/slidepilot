<script setup lang="ts">
import { configs, useNav } from "@slidev/client";
import { VoiceClient, type VoiceStatus } from "agents/voice/client";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

interface SlidePilotConfig {
  enabled?: boolean;
  host?: string;
  agent?: string;
  session?: string;
  presenterOnly?: boolean;
  confidence?: number;
  advanceThreshold?: number;
  completeThreshold?: number;
  stillExplainingCeiling?: number;
  cooldownMs?: number;
  advanceDelayMs?: number;
  showTranscript?: boolean;
}

interface NavigationDecision {
  type: "slidepilot:decision";
  id: string;
  page: string;
  action: "stay" | "next_slide";
  shouldAdvance: boolean;
  reason: string;
  signals: {
    recommendedAction: "stay" | "next_slide";
    actionProbabilities: { stay: number; next_slide: number };
    actionConfidence: number;
    slideComplete: number;
    stillExplaining: number;
    transitioning: number;
  };
  latestUtterance: string;
  provider: "jev" | "mock";
  model: string;
  latencyMs: number;
}

type ServerMessage =
  | NavigationDecision
  | { type: "slidepilot:ready"; provider: "jev" | "mock" }
  | { type: "slidepilot:context-accepted"; page: string }
  | { type: "slidepilot:error"; message: string };

const nav = useNav();
const {
  currentSlideNo,
  currentSlideRoute,
  nextRoute,
  isPresenter,
  nextSlide,
} = nav;

const config = computed<SlidePilotConfig>(() =>
  ((configs as Record<string, unknown>).slidePilot || {}) as SlidePilotConfig,
);
const visible = computed(
  () =>
    config.value.enabled !== false &&
    (config.value.presenterOnly === false || isPresenter.value),
);

const status = ref<VoiceStatus>("idle");
const connected = ref(false);
const active = ref(false);
const armed = ref(true);
const expanded = ref(false);
const interimTranscript = ref("");
const decision = ref<NavigationDecision | null>(null);
const error = ref("");
const provider = ref<"jev" | "mock" | "unknown">("unknown");
const audioLevel = ref(0);
const contextAccepted = ref(false);

let client: VoiceClient | null = null;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let lastAdvancedAt = 0;

const statusLabel = computed(() => {
  if (error.value) return "error";
  if (!connected.value) return "offline";
  if (!active.value) return "ready";
  if (!armed.value) return "paused";
  return status.value === "idle" ? "listening" : status.value;
});

const actionProbability = computed(
  () => decision.value?.signals.actionProbabilities.next_slide || 0,
);

function normalizeHost(host?: string) {
  return (host || window.location.host)
    .replace(/^https?:\/\//, "")
    .replace(/^wss?:\/\//, "")
    .replace(/\/$/, "");
}

function sessionName() {
  const raw = config.value.session || String(configs.title || "slidepilot-demo");
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function initializeClient() {
  if (client || !visible.value) return;

  client = new VoiceClient({
    agent: config.value.agent || "SlidePilot",
    name: sessionName() || "default",
    host: normalizeHost(config.value.host),
    silenceDurationMs: 600,
  });

  client.addEventListener("statuschange", (value) => {
    status.value = value;
  });
  client.addEventListener("connectionchange", (value) => {
    connected.value = value;
    if (value) sendSlideContext();
  });
  client.addEventListener("interimtranscript", (value) => {
    interimTranscript.value = value || "";
    // A resumed explanation cancels a decision that has not navigated yet.
    if (value && advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  });
  client.addEventListener("audiolevelchange", (value) => {
    audioLevel.value = value;
  });
  client.addEventListener("error", (value) => {
    error.value = value || "";
    if (value) active.value = false;
  });
  client.addEventListener("voiceerror", (value) => {
    error.value = value.message;
    active.value = false;
  });
  client.addEventListener("custommessage", handleServerMessage);
  client.connect();
}

async function toggleListening() {
  error.value = "";
  if (!client) initializeClient();
  if (!client) return;

  if (active.value) {
    client.endCall();
    active.value = false;
    return;
  }

  try {
    if (!client.connected) client.connect();
    await client.startCall();
    active.value = true;
    sendSlideContext();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not start the microphone.";
  }
}

function handleServerMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  const message = value as ServerMessage;

  if (message.type === "slidepilot:ready") {
    provider.value = message.provider;
    sendSlideContext();
    return;
  }
  if (message.type === "slidepilot:context-accepted") {
    contextAccepted.value = message.page === String(currentSlideNo.value);
    return;
  }
  if (message.type === "slidepilot:error") {
    error.value = message.message;
    return;
  }
  if (message.type === "slidepilot:decision") {
    if (message.page !== String(currentSlideNo.value)) return;
    decision.value = message;
    provider.value = message.provider;
    maybeAdvance(message);
  }
}

function maybeAdvance(result: NavigationDecision) {
  if (!result.shouldAdvance || !active.value || !armed.value) return;
  if (Date.now() - lastAdvancedAt < (config.value.cooldownMs ?? 2_000)) return;

  if (advanceTimer) clearTimeout(advanceTimer);
  const decisionId = result.id;
  const decisionPage = result.page;
  advanceTimer = setTimeout(async () => {
    if (
      decision.value?.id !== decisionId ||
      String(currentSlideNo.value) !== decisionPage ||
      !active.value ||
      !armed.value
    ) return;

    lastAdvancedAt = Date.now();
    await nextSlide();
  }, config.value.advanceDelayMs ?? 1_000);
}

function sendSlideContext() {
  if (!client?.connected) return;

  const slide = currentSlideRoute.value?.meta?.slide;
  const next = nextRoute.value?.meta?.slide;
  const override = slide?.frontmatter?.slidePilot;
  const manual =
    override === false ||
    override?.mode === "manual" ||
    override?.manual === true;

  contextAccepted.value = false;
  client.sendJSON({
    type: "slidepilot:context",
    context: {
      page: String(currentSlideNo.value),
      title: String(slide?.title || slide?.frontmatter?.title || `Slide ${currentSlideNo.value}`),
      content: String(slide?.content || override?.summary || ""),
      notes: String(slide?.note || override?.notes || ""),
      nextSlideTitle: String(next?.title || next?.frontmatter?.title || ""),
      manual,
      thresholds: {
        advance: override?.advanceThreshold ?? config.value.advanceThreshold ?? 0.68,
        confidence: override?.confidence ?? config.value.confidence ?? 0.3,
        complete: override?.completeThreshold ?? config.value.completeThreshold ?? 0.65,
        stillExplainingCeiling:
          override?.stillExplainingCeiling ??
          config.value.stillExplainingCeiling ??
          0.55,
      },
    },
  });
}

function onKeydown(event: KeyboardEvent) {
  if (event.shiftKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    void toggleListening();
  }
  if (event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    armed.value = !armed.value;
  }
}

watch(currentSlideNo, () => {
  decision.value = null;
  interimTranscript.value = "";
  if (advanceTimer) clearTimeout(advanceTimer);
  sendSlideContext();
});

onMounted(() => {
  initializeClient();
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  if (advanceTimer) clearTimeout(advanceTimer);
  window.removeEventListener("keydown", onKeydown);
  client?.endCall();
  client?.disconnect();
  client = null;
});
</script>

<template>
  <aside v-if="visible" class="slidepilot" :class="{ expanded, listening: active, armed }">
    <header class="pilot-header">
      <button class="pilot-mark" type="button" :aria-label="expanded ? 'Collapse SlidePilot' : 'Expand SlidePilot'" @click="expanded = !expanded">
        <span class="pilot-ring" :style="{ '--level': audioLevel }">
          <span class="pilot-core" />
        </span>
        <span class="pilot-wordmark">SLIDE<span>PILOT</span></span>
      </button>

      <span class="pilot-status" :data-status="statusLabel">
        <i />{{ statusLabel }}
      </span>
    </header>

    <div v-if="expanded" class="pilot-body">
      <div class="verdict">
        <span class="eyebrow">Jev recommends</span>
        <strong>{{ decision?.signals.recommendedAction === 'next_slide' ? 'ADVANCE' : 'HOLD' }}</strong>
        <span class="probability">{{ Math.round(actionProbability * 100) }}%</span>
      </div>

      <div class="meter" aria-label="Advance probability">
        <span :style="{ width: `${actionProbability * 100}%` }" />
        <i :style="{ left: `${(config.advanceThreshold ?? 0.68) * 100}%` }" />
      </div>

      <dl class="signals">
        <div>
          <dt>complete</dt>
          <dd>{{ Math.round((decision?.signals.slideComplete || 0) * 100) }}</dd>
        </div>
        <div>
          <dt>transition</dt>
          <dd>{{ Math.round((decision?.signals.transitioning || 0) * 100) }}</dd>
        </div>
        <div>
          <dt>still talking</dt>
          <dd>{{ Math.round((decision?.signals.stillExplaining || 0) * 100) }}</dd>
        </div>
      </dl>

      <blockquote v-if="config.showTranscript !== false && (interimTranscript || decision?.latestUtterance)">
        {{ interimTranscript || decision?.latestUtterance }}<span v-if="interimTranscript" class="cursor" />
      </blockquote>

      <p v-if="error" class="pilot-error">{{ error }}</p>
      <p v-else class="pilot-reason">{{ decision?.reason || 'Waiting for a completed utterance…' }}</p>

      <footer>
        <span>{{ provider }}<template v-if="decision"> · {{ decision.latencyMs }}ms</template></span>
        <span>{{ contextAccepted ? `slide ${currentSlideNo}` : 'syncing' }}</span>
      </footer>
    </div>

    <div class="pilot-controls">
      <button type="button" class="listen-button" @click="toggleListening">
        {{ active ? 'Stop mic' : 'Start mic' }}
        <kbd>⇧V</kbd>
      </button>
      <button type="button" class="arm-button" :aria-pressed="armed" @click="armed = !armed">
        {{ armed ? 'Auto' : 'Paused' }}
        <kbd>⇧A</kbd>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.slidepilot {
  --ink: #f4f1e8;
  --muted: #98978f;
  --acid: #d8ff47;
  --danger: #ff5c46;
  position: fixed;
  z-index: 9999;
  right: 18px;
  bottom: 18px;
  width: 292px;
  overflow: hidden;
  color: var(--ink);
  background: #10110f;
  border: 1px solid #35372f;
  border-radius: 7px;
  box-shadow: 0 18px 60px #0008, 0 2px 0 #000;
  font-family: "IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: .02em;
  transition: width .2s ease, border-color .2s ease;
}

.slidepilot:not(.expanded) { width: 246px; }
.slidepilot.listening { border-color: #626754; }
.pilot-header, .pilot-controls, footer { display: flex; align-items: center; justify-content: space-between; }
.pilot-header { min-height: 43px; padding: 0 11px; border-bottom: 1px solid #2b2d28; }
.pilot-mark { display: flex; align-items: center; gap: 9px; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.pilot-wordmark { font-weight: 800; letter-spacing: -.04em; }
.pilot-wordmark span { color: var(--acid); }

.pilot-ring {
  --level: 0;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid color-mix(in srgb, var(--acid) calc(30% + var(--level) * 70%), #56594e);
  border-radius: 50%;
  transform: scale(calc(1 + var(--level) * .16));
  transition: transform 80ms linear;
}
.pilot-core { width: 6px; height: 6px; border-radius: 50%; background: #5d6055; }
.listening .pilot-core { background: var(--acid); box-shadow: 0 0 14px var(--acid); }

.pilot-status { display: flex; align-items: center; gap: 6px; color: var(--muted); text-transform: uppercase; font-size: 9px; }
.pilot-status i { width: 5px; height: 5px; border-radius: 50%; background: #565850; }
.pilot-status[data-status="listening"] i, .pilot-status[data-status="ready"] i { background: var(--acid); }
.pilot-status[data-status="error"] i { background: var(--danger); }

.pilot-body { padding: 14px 13px 12px; background-image: repeating-linear-gradient(0deg, transparent 0 20px, #fff/[.025] 20px 21px); }
.verdict { display: grid; grid-template-columns: 1fr auto; align-items: end; }
.verdict .eyebrow { grid-column: 1 / -1; color: var(--muted); text-transform: uppercase; font-size: 8px; letter-spacing: .12em; }
.verdict strong { margin-top: 3px; font-family: "Arial Black", Impact, sans-serif; font-size: 31px; line-height: .95; letter-spacing: -.07em; }
.probability { color: var(--acid); font-weight: 700; font-size: 17px; }

.meter { position: relative; height: 5px; margin: 12px 0 11px; background: #292b26; }
.meter span { display: block; height: 100%; max-width: 100%; background: var(--acid); transition: width .25s ease; }
.meter i { position: absolute; top: -3px; width: 1px; height: 11px; background: #fff; opacity: .8; }

.signals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin: 0; background: #30322c; border: 1px solid #30322c; }
.signals div { padding: 7px; background: #171815; }
.signals dt { color: var(--muted); font-size: 8px; text-transform: uppercase; white-space: nowrap; }
.signals dd { margin: 3px 0 0; font-size: 15px; font-weight: 700; }
.signals dd::after { content: "%"; margin-left: 1px; color: var(--muted); font-size: 8px; }

blockquote { margin: 11px 0 0; padding: 8px 9px; color: #d5d3ca; background: #090a08; border-left: 2px solid #5d6055; font-size: 9px; line-height: 1.45; }
.cursor { display: inline-block; width: 5px; height: 10px; margin-left: 3px; vertical-align: -1px; background: var(--acid); animation: blink .8s steps(1) infinite; }
.pilot-reason, .pilot-error { min-height: 28px; margin: 10px 0 0; line-height: 1.4; }
.pilot-reason { color: var(--muted); }
.pilot-error { color: #ff8c79; }
footer { margin-top: 10px; padding-top: 8px; color: #6f7169; border-top: 1px solid #292b26; font-size: 8px; text-transform: uppercase; }

.pilot-controls { gap: 1px; padding: 1px; background: #292b26; }
.pilot-controls button { flex: 1; display: flex; justify-content: space-between; align-items: center; height: 32px; padding: 0 9px; color: var(--ink); background: #181916; border: 0; cursor: pointer; font: inherit; font-size: 9px; text-transform: uppercase; }
.pilot-controls button:hover { background: #23251f; }
.listen-button { color: var(--acid) !important; }
kbd { padding: 2px 4px; color: #73766b; background: #0d0e0c; border: 1px solid #35372f; border-radius: 2px; font: inherit; font-size: 7px; }

@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .slidepilot, .pilot-ring, .meter span { transition: none; } .cursor { animation: none; } }
</style>
