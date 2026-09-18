# Security Policy

## Supported versions

SlidePilot is experimental. Security fixes are applied only to the latest release on the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/harshil1712/slidepilot/security/advisories/new) and include reproduction steps, affected components, and potential impact.

## Deployment warning

SlidePilot does not currently provide application-level authentication. A deployed Worker exposes usage-billed Workers AI and, when configured, Jev-backed functionality. Deployers are responsible for protecting the endpoint with Cloudflare Access or another authentication mechanism suitable for their environment.

Never put `TYPESAFE_API_KEY` or another server credential in Slidev headmatter or client-side code. Store secrets with Wrangler or in a local ignored environment file.
