# Upstream touchpoints

Every upstream file this fork edits, why, and what to check when merging an upstream release.
Each edit in code is marked with a `// GATEWAY:` comment. Search for it to find them all:

```sh
git grep -n "GATEWAY:" -- server client
```

Our own code lives in `server/src/gateway/` and `server/src/__tests__/gateway/`; it never conflicts with upstream.

| File | Edit | Why | Added in |
|---|---|---|---|
| `server/src/index.ts` | 2 imports; `loadGatewayRuntime(config)` after `loadConfig()`; `createGatewayApp` instead of `createApp` when server mode is on; admin listener pushed into `servers`; `graceMs: 50_000` in server mode | Server mode: gate in front of upstream's app, second (admin) port, longer drain for streams. With `GATEWAY_SERVER_MODE` off every line is a no-op | M1 |

**Not touched, on purpose:** `server/src/app.ts`. The gate wraps upstream's `createApp()` from the outside (`server/src/gateway/app.ts`), and upstream's JSON parsers skip a body the gate already parsed.

**When merging upstream:** if `index.ts` conflicts, keep upstream's version and re-apply the four marked `// GATEWAY:` spots. Then run `npm test -w server -- src/__tests__/gateway` — the route-inventory test fails if upstream added a mount point that needs a decision.

Planned: `server/src/providers/google.ts` (forward `input_audio` to Gemini, M4).
