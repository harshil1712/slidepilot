# slidev-addon-slidepilot

Voice-driven semantic auto-advance for [Slidev](https://sli.dev/), powered by Cloudflare Agents and Workers AI Clef.

> Experimental: this addon requires a separately deployed SlidePilot Worker. Keep manual navigation available during presentations.

## Installation

> The package will become installable when the first npm release is published. Until then, use the addon from the SlidePilot repository workspace.

Install the package using your preferred package manager:

```bash
pnpm add slidev-addon-slidepilot
```

Add the addon to your Slidev headmatter. Slidev resolves the short name because the package follows the `slidev-addon-*` naming convention:

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

You can also add the addon name first and let Slidev prompt you to install it when the development server starts. Using the full name, `slidev-addon-slidepilot`, is supported too.

Deploy the Worker backend and find the complete setup, configuration, security notes, and demo in the [SlidePilot repository](https://github.com/harshil1712/slidepilot).

## Per-slide manual mode

Disable automatic navigation for an individual slide:

```yaml
---
slidePilot:
  mode: manual
---
```

## Controls

A small status indicator in the lower-right shows `offline`, `mic off`, `listening`, `paused`, or `error` (hover for details). The indicator and shortcuts are available only in Slidev presenter mode. Viewers cannot start the voice agent from play mode, even if they know the shortcuts. Presenter mode is not authentication: restrict access to the presenter route and Worker in non-demo deployments.

- **Click the indicator** or press **Shift+V** — start or stop the microphone
- **Shift+A** — arm or pause automatic navigation

Keyboard and clicker navigation remain available at all times.

## License

[MIT](LICENSE) © 2026 Harshil Agrawal
