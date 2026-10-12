# SlidePilot

[![CI](https://github.com/harshil1712/slidepilot/actions/workflows/ci.yml/badge.svg)](https://github.com/harshil1712/slidepilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Experimental:** SlidePilot is an early proof of concept built on experimental voice APIs. Rehearse with it before using it in a live presentation, and always keep manual navigation available.

**Your voice is the clicker.** SlidePilot listens to a presenter, asks [Clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/) on Workers AI whether the current slide is semantically complete, and advances a [Slidev](https://sli.dev/) deck only when deterministic safety checks pass.

```text
Slidev addon → VoiceClient → Cloudflare Voice Input Agent → pause detector
                                                        ↘ Workers AI Clef-omni (slide audio) → policy → Slidev navigation
```

## How it works

1. The Slidev addon streams microphone audio to a Cloudflare Agent over WebSockets.
2. The Worker keeps the current slide's audio and runs a pause detector on it.
3. Each time the presenter pauses for about 700 ms, Clef-omni hears the slide's audio, up to the most recent 60 seconds, and gets the slide's content and notes. It answers four typed questions: whether advancing feels natural, whether the core idea is complete, whether the presenter is continuing, and whether this is a natural slide boundary. Because it hears the audio rather than a transcript, intonation and trailing off count as evidence.
4. TypeScript—not the model—applies the navigation policy.
5. The addon checks cooldown and stale-decision guards before calling `useNav().next()`, which reveals the next click or, after the last click, moves to the next slide.

Explicit phrases such as “next slide” are not required. Semantic completion is the primary signal, while positive evidence that the presenter is continuing remains a hard veto. If the presenter resumes speaking while Clef-omni is evaluating or during the short navigation delay, the decision is dropped and the pending advance is cancelled.

A transcript-based engine (Flux speech-to-text with Clef-flash) is also available; see [Engines](#engines).

Manual keyboard and clicker navigation always continue to work.

## Install in a Slidev deck

> The `slidev-addon-slidepilot` package is prepared for npm and will become installable when the first package release is published. Until then, clone this repository to run the included demo and Worker.

SlidePilot follows Slidev's [addon installation conventions](https://sli.dev/guide/theme-addon#use-addon). Install the addon package:

```bash
pnpm add slidev-addon-slidepilot
```

Then add it to your deck's headmatter. Because the package follows the `slidev-addon-*` naming convention, the short name is sufficient:

```yaml
---
addons:
  - slidepilot

slidePilot:
  host: slidepilot.example.workers.dev
  agent: SlidePilot
  session: my-talk
---
```

You can also add `slidepilot` to `addons` first and let Slidev prompt you to install it when the development server starts. The full package name, `slidev-addon-slidepilot`, is accepted as well.

The addon needs a SlidePilot Worker backend. Deploy your own using the instructions below and replace `slidepilot.example.workers.dev` with its hostname.

## Deploy the Worker backend

### Prerequisites

- Node.js 20 or newer
- pnpm
- A Cloudflare account with Workers AI access

Clone and install the repository:

```bash
git clone https://github.com/harshil1712/slidepilot.git
cd slidepilot
pnpm install
```

Enter the Worker workspace, authenticate Wrangler, and select an account when necessary:

```bash
cd apps/worker
pnpm wrangler login
export CLOUDFLARE_ACCOUNT_ID=your_account_id
```

Deploy the Worker:

```bash
pnpm deploy
```

Clef-omni (`@cf/cloudflare/clef-omni`), and Flux with Clef-flash for the `flux` engine, run through the Worker's existing Workers AI binding, so no extra API key is needed.

Copy the `*.workers.dev` hostname printed by Wrangler into your deck's `slidePilot.host` setting. Do not include a path; both hostname-only and `https://` forms are accepted.

Verify the deployment before opening your deck:

```bash
curl https://slidepilot.<your-subdomain>.workers.dev/health
```

A successful response resembles:

```json
{"ok":true,"service":"slidepilot"}
```

## Run the included demo locally

```bash
pnpm install

# Terminal 1
pnpm dev:worker

# Terminal 2
pnpm dev:slides
```

Open the URL printed by Slidev, enter **Presenter Mode**, click the **MIC OFF** indicator in the lower-right (or press **Shift+V**), and grant microphone permission. The indicator is never mounted in viewer/play mode. The cover and final slides are intentionally manual; leave the cover with the keyboard before testing automatic navigation.

Both engines work with a local Durable Object and Wrangler's remote Workers AI binding. The browser console logs which engine is active when the microphone starts. If nothing happens when you speak, check that the browser is using the intended microphone.

## Configuration

```yaml
slidePilot:
  enabled: true
  host: localhost:8787
  agent: SlidePilot
  session: my-talk
  advanceThreshold: 0.68
  completeThreshold: 0.65
  stillExplainingCeiling: 0.55
  confidence: 0.30
  cooldownMs: 2000
  advanceDelayMs: 1000
```

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Mount the SlidePilot indicator in presenter mode. |
| `host` | Current page host | Worker hostname used by `VoiceClient`. |
| `agent` | `SlidePilot` | Exported Cloudflare Agent class name. |
| `session` | Deck title | Durable Agent instance name for this talk. |
| `advanceThreshold` | `0.68` | Minimum Clef probability that advancing is natural. |
| `completeThreshold` | `0.65` | Minimum probability that the slide's core idea is complete. |
| `stillExplainingCeiling` | `0.55` | Maximum probability that the presenter is continuing. |
| `confidence` | `0.30` | Minimum confidence in Clef's action choice. |
| `cooldownMs` | `2000` | Minimum interval between automatic advances. |
| `advanceDelayMs` | `1000` | Cancellable delay before navigation. |
| `engine` | Worker default (`omni`) | `omni` or `flux`; see [Engines](#engines). Applies when the microphone starts. |

### Engines

| Engine | When it evaluates | What Clef hears | Model |
| --- | --- | --- | --- |
| `omni` (default) | At each pause of about 700 ms, found by an energy-based pause detector | The current slide's audio, up to the most recent 60 seconds | Clef-omni |
| `flux` | At each end of turn detected by Flux speech-to-text | The text of the last 12 utterances on the slide | Clef-flash |

Both engines ask the same four questions and use the same TypeScript policy and thresholds. To use the transcript engine for a deck:

```yaml
slidePilot:
  engine: flux
```

To change the default for every deck, set a `SLIDEPILOT_ENGINE` variable (`omni` or `flux`) on the Worker. A deck's `engine` setting overrides it. Restart the microphone after changing the engine.

The Worker logs each decision, and why a decision was dropped (for example, because the presenter resumed speaking). To tune the pause detector, set `SLIDEPILOT_DEBUG_AUDIO=1` (for example, in `apps/worker/.dev.vars`) to also log each detected speech start and pause, and input levels every 5 seconds. The thresholds are in `DEFAULTS` in `apps/worker/src/audio.ts`.

Disable automatic navigation for an individual slide:

```yaml
---
slidePilot:
  mode: manual
---
```

Controls:

- **Click the indicator** or press **Shift+V** — start or stop the microphone
- **Shift+A** — arm or pause automatic navigation

The indicator shows one of `offline`, `mic off`, `listening`, `paused`, or `error`. Hover over it to see the error message. To inspect Clef's signals for each decision, use `pnpm wrangler tail` or the evaluation endpoint below.

## Test decisions without a microphone

The Worker exposes an evaluation endpoint for policy testing:

```bash
curl http://localhost:8787/api/evaluate \
  -H 'content-type: application/json' \
  --data '{
    "slide": {
      "page": "2",
      "title": "Voice hears",
      "content": "The voice layer produces completed utterances.",
      "notes": "Explain streaming STT, then conclude.",
      "nextSlideTitle": "Clef decides",
      "manual": false,
      "thresholds": {
        "advance": 0.68,
        "confidence": 0.3,
        "complete": 0.65,
        "stillExplainingCeiling": 0.55
      }
    },
    "utterances": [
      "The voice agent streams audio and returns completed utterances.",
      "Only completed thoughts are sent to the decision layer."
    ]
  }'
```

## Authentication, privacy, and cost

SlidePilot mounts the microphone indicator only in Slidev presenter mode; viewers cannot enable it from the viewer UI. **This is not an authorization boundary:** without separate access controls, anyone who can open the deck's presenter URL can enter presenter mode, and the Worker does not currently authenticate its WebSocket or evaluation endpoint. A publicly deployed Worker can be reached by other clients and may incur Workers AI usage for Clef-omni audio evaluation (or, with the `flux` engine, speech-to-text and Clef-flash). To ensure only the actual presenter can use the voice agent, restrict access to the presenter route **and** the Worker with an authentication layer (for example, Cloudflare Access) appropriate for your deployment. Do not put a shared secret in deck headmatter: it is delivered to viewers.

If `curl` returns `403` with `error code: 1050`, the Cloudflare account's Access default-deny policy is blocking the hostname before requests reach the Worker. For a protected deployment, create a self-hosted Access application with an Allow policy for the presenter; unauthenticated `curl` requests will still be blocked. An exemption or Bypass policy is suitable only for an intentionally public demo.

With the default `omni` engine, the current slide's raw audio (up to the most recent 60 seconds) and the slide's visible content and speaker notes are sent to Clef-omni on Workers AI at each pause. The audio is held in Worker memory only until the slide changes or the call ends. With the `flux` engine, audio is transcribed by Workers AI using Deepgram Flux, and completed transcripts plus the slide's content and notes are sent to Clef-flash. No model credentials are sent to the Slidev client.

## Repository layout

```text
apps/worker                         Cloudflare Voice Input Agent + Clef policy
apps/demo                           Demonstration Slidev deck
packages/slidev-addon-slidepilot    Reusable Slidev addon
```

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

Policy tests cover semantic completion without magic words, explicit continuation, incomplete slides, manual slides, and the Clef request/response mapping. Audio tests cover pause detection, the per-slide audio window, WAV encoding, and the Clef-omni request.

## Current limitations

- On slides with clicks, Clef knows how many clicks are revealed but still receives the whole slide's content and notes, so it has to infer which part is on screen.
- Thresholds are starting values, originally tuned on Flux transcripts. Calibrate them with rehearsals.
- The omni engine has no transcript. Its pause detector uses fixed loudness thresholds that assume a close presenter microphone. Applause or audience noise registers as speech and conservatively cancels pending advances.
- On long slides, the omni engine hears only the last 60 seconds, so earlier explanation is invisible to `slide_complete`.
- The `/api/evaluate` endpoint tests the text-based `flux` decision path only.
- Slide content and notes are sent as text; very large values are truncated server-side.
- `agents/voice` is experimental and pinned to an exact version.
- Presenter-only UI is not authentication; protect the presenter route and Worker separately in non-demo deployments.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report security concerns according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Harshil Agrawal
