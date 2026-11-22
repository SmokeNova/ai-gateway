# AI Gateway

A self-hosted, always-on AI gateway for my apps: one OpenAI-compatible `/v1` endpoint that stacks free-tier AI providers (Groq, Gemini, OpenRouter `:free`, Mistral, Cloudflare Workers AI and more) behind automatic failover, with a separate key, limits and analytics per app.

It's a thin fork of **[freellmapi](https://github.com/tashfeenahmed/freellmapi)** by Tashfeen Ahmed (MIT), which provides the engine: free-tier quota tracking, cooldowns, routing, 80+ provider adapters and the admin dashboard. This fork adds what's needed to run it safely on a public server:

- **Server mode:** only the inference API is public; the admin dashboard is reachable over Tailscale only.
- **A request gate** that checks the app key before reading the request body, and serves a strict allowlist of endpoints.
- **Per-app policies:** rate, daily and concurrency limits, plus an allowlist of capability lanes.
- **Lanes:** `lane:fast`, `lane:smart`, `lane:audio`, `lane:stt`, `lane:embed-*`. Apps ask for a capability, not a provider.
- **Ops:** Docker Compose + Caddy deploy, health checks, alerts, offsite backups, automatic rollback, weekly upstream sync.

**Status:** in development. See [docs/gateway/PLAN.md](../docs/gateway/PLAN.md) for the plan and progress.

## Docs

- [Plan](../docs/gateway/PLAN.md) · [M0 analysis](../docs/gateway/ANALYSIS.md) · [Upstream touchpoints](../docs/gateway/UPSTREAM_TOUCHPOINTS.md) · [Tracking upstream](../docs/gateway/UPSTREAM_SYNC.md)
- Upstream freellmapi's own README and docs: [README.md](../README.md), [docs/en/](../docs/en/)

## License

MIT, same as upstream. See [LICENSE](../LICENSE).
