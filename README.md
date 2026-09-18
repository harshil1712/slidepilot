# SlidePilot

[![CI](https://github.com/harshil1712/slidepilot/actions/workflows/ci.yml/badge.svg)](https://github.com/harshil1712/slidepilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Experimental:** SlidePilot is an early proof of concept built on experimental voice APIs. Rehearse with it before using it in a live presentation, and always keep manual navigation available.

**Your voice is the clicker.** SlidePilot listens to a presenter, asks [TypeSafe AI's Jev](https://typesafe.ai/) whether the current slide is semantically complete, and advances a [Slidev](https://sli.dev/) deck only when deterministic safety checks pass.

```text
Slidev addon → VoiceClient → Cloudflare Voice Input Agent → Workers AI Flux STT
                                                        ↘ Jev → policy → Slidev navigation
```

## How it works

1. The Slidev addon streams microphone audio to a Cloudflare Agent over WebSockets.
2. Workers AI Flux produces interim text and completed utterances.
3. Jev evaluates four typed questions: whether advancing feels natural, whether the core idea is complete, whether the presenter is continuing, and whether this is a natural slide boundary.
4. TypeScript—not the model—applies the navigation policy.
5. The addon checks cooldown and stale-decision guards before calling `useNav().nextSlide()`.

Explicit phrases such as “next slide” are not required. Semantic completion is the primary signal, while positive evidence that the presenter is continuing remains a hard veto. If the presenter resumes speaking during the short navigation delay, the pending advance is cancelled.

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
  presenterOnly: true
---
```

You can also add `slidepilot` to `addons` first and let Slidev prompt you to install it when the development server starts. The full package name, `slidev-addon-slidepilot`, is accepted as well.

The addon needs a SlidePilot Worker backend. Deploy your own using the instructions below and replace `slidepilot.example.workers.dev` with its hostname.

## Deploy the Worker backend

### Prerequisites

- Node.js 20 or newer
- pnpm
- A Cloudflare account with Workers AI access
- Optional: a TypeSafe API key for real Jev inference. Without one, the Worker transparently uses a deterministic mock policy.

Clone and install the repository:

```bash
git clone https://github.com/harshil1712/slidepilot.git
cd slidepilot
pnpm install
```

Authenticate Wrangler and select an account when necessary:

```bash
pnpm wrangler login
export CLOUDFLARE_ACCOUNT_ID=your_account_id
```

Deploy the Worker:

```bash
cd apps/worker
pnpm deploy

# Optional: omit this to use deterministic mock decisions.
pnpm wrangler secret put TYPESAFE_API_KEY
```

Copy the `*.workers.dev` hostname printed by Wrangler into your deck's `slidePilot.host` setting. Do not include a path; both hostname-only and `https://` forms are accepted.

Verify the deployment before opening your deck:

```bash
curl https://slidepilot.<your-subdomain>.workers.dev/health
```

A successful response resembles:

```json
{"ok":true,"service":"slidepilot","decisionProvider":"jev"}
```

## Run the included demo locally

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Uncomment TYPESAFE_API_KEY in apps/worker/.dev.vars for real Jev inference.

# Terminal 1
pnpm dev:worker

# Terminal 2
pnpm dev:slides
```

Open the URL printed by Slidev, expand the SlidePilot control, click **Start mic**, and grant microphone permission. The cover and final slides are intentionally manual; leave the cover with the keyboard before testing automatic navigation.

Flux streaming STT works with a local Durable Object and Wrangler's remote Workers AI binding. Nova-3 did not return its WebSocket in the same local setup during development, so the project currently uses Flux.

## Configuration

```yaml
slidePilot:
  enabled: true
  host: localhost:8787
  agent: SlidePilot
  session: my-talk
  presenterOnly: true
  advanceThreshold: 0.68
  completeThreshold: 0.65
  stillExplainingCeiling: 0.55
  confidence: 0.30
  cooldownMs: 2000
  advanceDelayMs: 1000
  showTranscript: true
```

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Mount the SlidePilot control. |
| `host` | Current page host | Worker hostname used by `VoiceClient`. |
| `agent` | `SlidePilot` | Exported Cloudflare Agent class name. |
| `session` | Deck title | Durable Agent instance name for this talk. |
| `presenterOnly` | `true` | Show controls only in Slidev presenter mode. |
| `advanceThreshold` | `0.68` | Minimum Jev probability that advancing is natural. |
| `completeThreshold` | `0.65` | Minimum probability that the slide's core idea is complete. |
| `stillExplainingCeiling` | `0.55` | Maximum probability that the presenter is continuing. |
| `confidence` | `0.30` | Minimum confidence in Jev's action choice. |
| `cooldownMs` | `2000` | Minimum interval between automatic advances. |
| `advanceDelayMs` | `1000` | Cancellable delay before navigation. |
| `showTranscript` | `true` | Show interim/final transcript text in the control. |

Disable automatic navigation for an individual slide:

```yaml
---
slidePilot:
  mode: manual
---
```

Controls:

- **Shift+V** — start or stop the microphone
- **Shift+A** — arm or pause automatic navigation

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
      "nextSlideTitle": "Jev decides",
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

Check whether the Worker is using Jev or the mock provider:

```bash
curl http://localhost:8787/health
```

## Authentication, privacy, and cost

SlidePilot does not currently implement application-level authentication. A publicly deployed Worker can be reached by other clients and may incur Workers AI and Jev usage. Protect non-demo deployments with Cloudflare Access or add an authentication layer appropriate for your environment.

If `curl` returns `403` with `error code: 1050`, the Cloudflare account's Access default-deny policy is blocking the hostname before requests reach the Worker. Exempt the hostname under **Zero Trust → Access controls → Access settings**, or create a self-hosted Access application with an appropriate Allow or Bypass policy.

Audio is processed by Workers AI using Deepgram Flux. When a TypeSafe API key is configured, completed transcripts plus the current slide's visible content and speaker notes are sent to Jev for evaluation. The TypeSafe key remains in the Worker and is never sent to the Slidev client.

## Repository layout

```text
apps/worker                         Cloudflare Voice Input Agent + Jev policy
apps/demo                           Demonstration Slidev deck
packages/slidev-addon-slidepilot    Reusable Slidev addon
```

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

Policy tests cover semantic completion without magic words, explicit continuation, incomplete slides, manual slides, and deterministic mock behavior.

## Current limitations

- Navigation operates at slide level, not `v-click` animation level.
- Thresholds are starting values and should be calibrated with rehearsal transcripts.
- Slide content and notes are sent as text; very large values are truncated server-side.
- `agents/voice` is experimental and pinned to an exact version.
- The mock validates interaction and policy, not Jev behavior.
- Authentication is left to the deployer in this experimental release.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report security concerns according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Harshil Agrawal
