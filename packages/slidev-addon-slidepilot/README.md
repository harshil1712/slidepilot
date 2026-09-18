# slidev-addon-slidepilot

Voice-driven semantic auto-advance for [Slidev](https://sli.dev/), powered by Cloudflare Agents and TypeSafe AI's Jev.

> Experimental: this addon requires a separately deployed SlidePilot Worker. Keep manual navigation available during presentations.

## Installation

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
  presenterOnly: true
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

- **Shift+V** — start or stop the microphone
- **Shift+A** — arm or pause automatic navigation

Keyboard and clicker navigation remain available at all times.

## License

[MIT](LICENSE) © 2026 Harshil Agrawal
