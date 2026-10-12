<script setup lang="ts">
import { configs, useNav } from "@slidev/client";
import { VoiceClient } from "agents/voice/client";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

interface SlidePilotConfig {
  enabled?: boolean;
  host?: string;
  agent?: string;
  session?: string;
  confidence?: number;
  advanceThreshold?: number;
  completeThreshold?: number;
  stillExplainingCeiling?: number;
  cooldownMs?: number;
  advanceDelayMs?: number;
  /** "omni" (default) or "flux". Takes effect when the mic starts. */
  engine?: "flux" | "omni";
}

// Subset of the Worker's NavigationDecision that the addon acts on.
interface NavigationDecision {
  type: "slidepilot:decision";
  id: string;
  page: string;
  clicks: number;
  shouldAdvance: boolean;
}

type ServerMessage =
  | NavigationDecision
  | { type: "slidepilot:ready"; engine?: string }
  | { type: "slidepilot:speech" }
  | { type: "slidepilot:error"; message: string };

const nav = useNav();
const {
  currentSlideNo,
  currentSlideRoute,
  nextRoute,
  isPresenter,
  clicks,
  clicksTotal,
  next,
} = nav;

const config = computed<SlidePilotConfig>(() =>
  ((configs as Record<string, unknown>).slidePilot || {}) as SlidePilotConfig,
);
// Defense in depth: global.vue only mounts this in presenter mode, but guard
// actions here too (including shortcuts and delayed navigation).
const enabled = computed(() => config.value.enabled !== false && isPresenter.value);

const connected = ref(false);
const active = ref(false);
const armed = ref(true);
const error = ref("");

let client: VoiceClient | null = null;
let advanceTimer: ReturnType<typeof setTimeout> | null = null;
let latestDecisionId: string | null = null;
let lastAdvancedAt = 0;

const state = computed(() => {
  if (error.value) return "error";
  if (!connected.value) return "offline";
  if (!active.value) return "mic off";
  return armed.value ? "listening" : "paused";
});

const hint = computed(
  () =>
    `${error.value ? `${error.value} — ` : ""}Click or ⇧V: start/stop mic · ⇧A: pause auto-advance`,
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
  if (client || !enabled.value) return;

  client = new VoiceClient({
    agent: config.value.agent || "SlidePilot",
    name: sessionName() || "default",
    host: normalizeHost(config.value.host),
    silenceDurationMs: 600,
  });

  client.addEventListener("connectionchange", (value) => {
    connected.value = value;
    if (value) sendSlideContext();
  });
  client.addEventListener("interimtranscript", (value) => {
    // A resumed explanation cancels a decision that has not navigated yet.
    if (value) cancelPendingAdvance();
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
  if (!enabled.value) return;
  error.value = "";
  if (!client) initializeClient();
  if (!client) return;

  const voiceClient = client;
  if (active.value) {
    voiceClient.endCall();
    active.value = false;
    return;
  }

  try {
    if (!voiceClient.connected) voiceClient.connect();
    await voiceClient.startCall();
    // Leaving presenter mode while permission is pending must not start a call.
    if (!enabled.value || client !== voiceClient) {
      voiceClient.endCall();
      return;
    }
    active.value = true;
    sendSlideContext();
  } catch (cause) {
    if (enabled.value && client === voiceClient)
      error.value = cause instanceof Error ? cause.message : "Could not start the microphone.";
  }
}

function handleServerMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  const message = value as ServerMessage;

  if (message.type === "slidepilot:ready") {
    console.info(`[SlidePilot] listening with the ${message.engine ?? "unknown"} engine`);
    sendSlideContext();
    return;
  }
  if (message.type === "slidepilot:speech") {
    // Omni engine has no interim transcript; the pause detector reports speech.
    cancelPendingAdvance();
    return;
  }
  if (message.type === "slidepilot:error") {
    error.value = message.message;
    return;
  }
  if (message.type === "slidepilot:decision") {
    if (message.page !== String(currentSlideNo.value) || message.clicks !== clicks.value) return;
    latestDecisionId = message.id;
    maybeAdvance(message);
  }
}

function cancelPendingAdvance() {
  if (!advanceTimer) return;
  clearTimeout(advanceTimer);
  advanceTimer = null;
}

function maybeAdvance(result: NavigationDecision) {
  if (!enabled.value || !result.shouldAdvance || !active.value || !armed.value) return;
  if (Date.now() - lastAdvancedAt < (config.value.cooldownMs ?? 2_000)) return;

  if (advanceTimer) clearTimeout(advanceTimer);
  const decisionId = result.id;
  const decisionPage = result.page;
  advanceTimer = setTimeout(async () => {
    if (
      latestDecisionId !== decisionId ||
      String(currentSlideNo.value) !== decisionPage ||
      !enabled.value ||
      !active.value ||
      !armed.value
    ) return;

    lastAdvancedAt = Date.now();
    // Reveals the next click, or moves to the next slide after the last click.
    await next();
  }, config.value.advanceDelayMs ?? 1_000);
}

function sendSlideContext() {
  if (!client?.connected) return;

  const slide = currentSlideRoute.value?.meta?.slide;
  const nextSlideInfo = nextRoute.value?.meta?.slide;
  const override = slide?.frontmatter?.slidePilot;
  const manual =
    override === false ||
    override?.mode === "manual" ||
    override?.manual === true;

  client.sendJSON({
    type: "slidepilot:context",
    engine: config.value.engine,
    context: {
      page: String(currentSlideNo.value),
      title: String(slide?.title || slide?.frontmatter?.title || `Slide ${currentSlideNo.value}`),
      content: String(slide?.content || override?.summary || ""),
      notes: String(slide?.note || override?.notes || ""),
      nextSlideTitle: String(nextSlideInfo?.title || nextSlideInfo?.frontmatter?.title || ""),
      clicks: clicks.value,
      totalClicks: clicksTotal.value,
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
  if (!enabled.value) return;
  if (event.shiftKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    void toggleListening();
  }
  if (event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    armed.value = !armed.value;
  }
}

watch([currentSlideNo, clicks, clicksTotal], () => {
  latestDecisionId = null;
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
  active.value = false;
});
</script>

<template>
  <button
    v-if="enabled"
    type="button"
    class="slidepilot"
    :data-state="state"
    :title="hint"
    :aria-label="`SlidePilot: ${state}. ${hint}`"
    @click="toggleListening"
  >
    <i />{{ state }}
  </button>
</template>

<style scoped>
.slidepilot {
  position: fixed;
  z-index: 9999;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  color: #c9c7be;
  background: #10110fd9;
  border: 1px solid #35372f;
  border-radius: 999px;
  font: 600 9px/1 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
  cursor: pointer;
}
.slidepilot i { width: 7px; height: 7px; border-radius: 50%; background: #5d6055; }
.slidepilot[data-state="listening"] i { background: #d8ff47; box-shadow: 0 0 8px #d8ff47; }
.slidepilot[data-state="paused"] i { background: #ffb547; }
.slidepilot[data-state="error"] { color: #ff8c79; }
.slidepilot[data-state="error"] i { background: #ff5c46; }
</style>
