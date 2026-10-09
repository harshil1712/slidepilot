# Changelog

All notable changes to SlidePilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - Unreleased

### Added

- Cloudflare Voice Input Agent using Workers AI Flux streaming STT.
- Typed evaluation of semantic slide completion with Workers AI Clef.
- Deterministic navigation policy with manual-slide, confidence, continuation, cooldown, and stale-decision safeguards.
- Click-aware navigation: SlidePilot reveals the next click before moving to the next slide.
- Reusable `slidev-addon-slidepilot` presenter-only status indicator and shortcuts.
- Six-slide demonstration deck.
- Local and deployed Worker setup documentation.
- Experimental `omni` engine (`slidePilot.engine: omni` or `SLIDEPILOT_ENGINE`): server-side pause detection plus Workers AI Clef-omni judging the presenter's audio directly, with speech-start cancellation of pending advances.
