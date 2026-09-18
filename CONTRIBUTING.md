# Contributing to SlidePilot

Thanks for helping improve SlidePilot. The project is experimental, so focused bug reports, reproducible voice transcripts, policy tests, and documentation improvements are especially valuable.

## Development setup

Requirements:

- Node.js 20 or newer
- pnpm
- A Cloudflare account with Workers AI access for live STT testing
- An optional TypeSafe API key for live Jev testing

```bash
git clone https://github.com/harshil1712/slidepilot.git
cd slidepilot
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Run the Worker and demo deck in separate terminals:

```bash
pnpm dev:worker
pnpm dev:slides
```

Do not commit `.env`, `.dev.vars`, API keys, transcripts containing private information, or Wrangler state.

## Before opening a pull request

Run the complete verification suite:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level high
```

For changes to navigation behavior, add policy tests covering both sides of the boundary:

- a completed explanation that should advance;
- a similar but unfinished explanation that should stay.

Model output should remain advisory. Deterministic TypeScript must continue to own navigation, manual-slide protection, cooldowns, and stale-decision checks.

## Pull requests

Keep pull requests focused and describe:

1. the presenter behavior being improved;
2. the expected hold/advance outcome;
3. how the change was tested;
4. any effect on privacy, authentication, or usage cost.

By contributing, you agree that your contributions will be licensed under the repository's MIT License.
