# Changelog

All notable changes to SlidePilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - Unreleased

### Added

- Cloudflare Voice Input Agent with two engines:
  - `omni` (default): server-side pause detection, with Workers AI Clef-omni judging the presenter's audio directly.
  - `flux`: Workers AI Flux streaming STT, with Workers AI Clef-flash judging the transcript.
- Typed evaluation of semantic slide completion with the same four questions and policy for both engines.
- Deterministic navigation policy with manual-slide, confidence, continuation, cooldown, and stale-decision safeguards.
- Click-aware navigation: SlidePilot reveals the next click before moving to the next slide.
- Reusable `slidev-addon-slidepilot` presenter-only status indicator and shortcuts.
- Six-slide demonstration deck.
- Local and deployed Worker setup documentation.
- Engine selection with `slidePilot.engine` or the Worker `SLIDEPILOT_ENGINE` variable, plus `SLIDEPILOT_DEBUG_AUDIO` for pause-detector tuning.
