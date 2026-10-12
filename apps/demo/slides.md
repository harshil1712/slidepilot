---
theme: default
layout: cover
title: SlidePilot — Cloudflare Clef × Slidev
addons:
  - slidev-addon-slidepilot
slidePilot:
  enabled: true
  host: localhost:8787
  agent: SlidePilot
  session: slidepilot-poc
  advanceThreshold: 0.68
  completeThreshold: 0.65
  stillExplainingCeiling: 0.55
  confidence: 0.3
  cooldownMs: 2000
  advanceDelayMs: 1000
  # engine: flux  # default is omni; flux uses Flux STT + Clef-flash on transcripts
  mode: manual
fonts:
  sans: IBM Plex Sans
  mono: IBM Plex Mono
---

<div class="kicker">A LIVE PROOF OF CONCEPT</div>

# Your voice is<br><span class="acid">the clicker.</span>

<p class="lede">Cloudflare hears. Clef decides. Slidev moves.</p>

<div class="instructions">
  <span>01</span> Open presenter mode
  <span>02</span> Start the mic, then advance manually
  <span>03</span> Present without saying “next slide”
</div>

<!--
Open Slidev presenter mode, then start the SlidePilot microphone by clicking the indicator in the lower-right or pressing Shift+V. This cover is deliberately manual. Move to the next slide with the keyboard when you are ready.
-->

---
title: Voice hears
---

<div class="chapter-no">01 / 03</div>

# Voice<br><span class="outline">hears.</span>

<div class="statement">
A pause detector listens to the presenter’s microphone and marks every moment they stop speaking.
</div>

<div class="technical">
<span>Cloudflare Agent</span>
<span>Pause detection</span>
<span>WebSocket audio</span>
</div>

<!--
The first job belongs to Cloudflare's Voice SDK. It streams microphone audio to a durable voice input agent, which keeps the audio for the current slide. Before we move on, there is one more detail. A simple pause detector decides when to ask for a decision, but it never decides whether a thought is finished. With that, the voice layer is complete and we can look at Clef.
-->

---
title: Clef decides
---

<div class="chapter-no">02 / 03</div>

# Clef<br><span class="outline">decides.</span>

<div class="decision-grid">
  <div><small>SLIDE COMPLETE</small><b>?</b></div>
  <div><small>STILL EXPLAINING</small><b>?</b></div>
  <div><small>TRANSITIONING</small><b>?</b></div>
</div>

<p class="caption">One state. Four typed questions. One conservative code path.</p>

<!--
At each pause, Clef-omni receives the current slide, its notes, the next slide title, and the presenter's audio for this slide. Because it hears the audio, tone of voice counts as evidence. It answers several narrow questions in parallel. Code then combines those probabilities using conservative safety thresholds. The model provides judgment, but ordinary code remains in control. That is the entire decision layer. Now let's look at how Slidev acts.
-->

---
title: Slidev acts
---

<div class="chapter-no">03 / 03</div>

# Slidev<br><span class="outline">acts.</span>

```ts {all|2|3-6|8}
const safeToAdvance =
  action.next_slide >= 0.68 &&
  action.confidence >= 0.30 &&
  slideComplete >= 0.65 &&
  stillExplaining <= 0.55

if (safeToAdvance)
  await nav.next()
```

<!--
The Slidev addon receives a typed navigation decision. It verifies every safety gate, checks that we are still on the same slide, waits through a short cooldown, and then uses Slidev's navigation API. A keyboard or clicker always remains available as the fallback. That completes the loop. With that, let's see the full architecture.
-->

---
title: The complete loop
---

<div class="kicker">THE COMPLETE LOOP</div>

# Four parts.<br>One <span class="acid">smart if.</span>

<div class="pipeline">
  <div><b>MIC</b><small>16 kHz PCM</small></div>
  <i>→</i>
  <div><b>VOICE AGENT</b><small>speech → pauses</small></div>
  <i>→</i>
  <div><b>CLEF-OMNI</b><small>audio → probabilities</small></div>
  <i>→</i>
  <div><b>SLIDEV</b><small>decision → action</small></div>
</div>

<!--
The microphone captures audio. A Cloudflare voice input agent detects pauses. Clef-omni listens and evaluates whether the presenter has completed the current thought. The Slidev addon applies a conservative policy and advances. Each component has exactly one job. That's the whole proof of concept.
-->

---
layout: center
slidePilot:
  mode: manual
---

<div class="end-mark">●</div>

# No clicker.<br>No magic words.

<p class="lede">Just a decision the software can depend on.</p>
