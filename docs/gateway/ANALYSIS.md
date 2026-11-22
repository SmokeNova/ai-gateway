# M0 analysis — freellmapi v0.16.38

> **Date:** 2026-11-22 · **Base:** upstream tag `v0.16.38` (`d05c6c33`)
> Answers to the open questions in [PLAN.md](PLAN.md) §12, and the plan changes they force.
> Detailed evidence with `file:line` references (paths relative to `server/src/`) is in [analysis/](analysis/):
> [surface-and-auth.md](analysis/surface-and-auth.md) · [routing-and-fallback.md](analysis/routing-and-fallback.md) · [ops-data-and-ci.md](analysis/ops-data-and-ci.md).
> Those notes were produced by reading code only (nothing run against real providers). The claims that shape the design were spot-checked by hand. Anything marked **live-verify** still needs a real call with real keys (M2/M4).

---

## 1. Baseline

| Step | Result | Time |
|---|---|---|
| `npm ci` | ✅ | 3 m 40 s |
| `npm run build` (server, cli, client) | ✅ | — |
| `npm run lint` | ✅ | — |
| `npm test` (full, serial) | Hooks and bootstrap tests ✅; **server: 5,573 passed, 17 failed, 9 skipped** (428 files; 420 passed, 8 failed). `npm test` stops at the first failing workspace, so the cli and client suites did not run locally | 11 m 50 s (server suite 660 s) |

Environment: Windows 11, Node 24.19 (upstream allows `>=20.18 <25`; `.nvmrc` says 22; the Docker image uses Node 24). **The 17 failures are Windows-environment issues, not real breakage:** upstream CI on the same commit (`d05c6c33`) passes "Test & build" on Node 20, 22 and 24 (Linux). The failing tests hit `*.localhost` DNS resolution, the Windows registry proxy lookup ("unable to find the specified registry key"), an undici "bad port" error, and 5 s timeouts in the timing-heavy `router-bandit` tests. Files: `lib/proxy`, `services/router-bandit`, `routes/proxy-cache`, `routes/keys-desktop-reauth`, `routes/settings-headroom`, `routes/fallback-keycount-parity`, `routes/proxy-rate-limit`, `routes/analytics-client`. **Authoritative baseline = Linux CI** (upstream `ci.yml`, kept enabled in our fork). Locally, the useful check is "same 17 failures before and after our change".

---

## 2. What changes in the plan (summary)

| # | Finding | Plan change |
|---|---|---|
| F1 | `auto:fast`, `auto:smart` (and `fastest`, `cheap`, `balanced`…) are **reserved upstream aliases** that sort the whole catalog; profiles can't use those names | Public lane IDs become **`lane:<name>`**. The gate rewrites them to upstream targets (`lane:fast` → `auto:gw-fast` profile, etc.). Apps never see upstream names |
| F2 | The native **Gemini adapter silently drops `input_audio`** parts and still answers (text-only) | One small patch in `providers/google.ts` mapping `input_audio` → `inlineData` (an upstream-worthy bugfix: send it as a PR). Plus a gateway test that fails if any model in `lane:audio` is served by an adapter that drops audio |
| F3 | **STT has no chains**: `model` is `auto`/`whisper-1` (all enabled STT rows by priority) or an exact provider model ID; `auto:stt` is a 400. `model` is in the multipart body, parsed inside the route | STT is permitted **by path**. Apps send `model: "auto"`; the gate doesn't parse multipart. Which STT providers serve is an ops choice (enable/disable STT rows). Upstream already restricts `model` to STT rows (Q13), so this is safe |
| F4 | **Voxtral ignores `verbose_json`** (returns `{text}` only); Groq returns segments | Apps that need timestamps must check for `segments` and treat their absence as a failure (documented in INTEGRATION.md), or ops disables Voxtral for STT |
| F5 | Embeddings reject `auto:embed-x`; the **family name is the chain** | Gate rewrites `lane:embed-<family>` → the family name |
| F6 | Profiles default to **`auto_include_new_models=1`**, and declarative config has no profiles section (unknown keys are rejected) | Lanes are seeded by **our own boot step** (SQL on upstream's `profiles`/`profile_models`) with `auto_include_new_models=0`, so catalog sync can't fill lanes with unwanted models |
| F7 | Profile keys can call **any model**, including `fusion` (fans out to many models); upstream has no per-key model allowlist | The post-parse lane rule is mandatory, not optional. `fusion` and raw model IDs are not lanes |
| F8 | **Several request headers change behaviour**: `X-FreeLLM-Cache: on` forces the response cache per request; `Idempotency-Key` replays a stored response (global, 24 h); `x-session-id` keys reasoning memory/context handoff; `anthropic-version` changes `/v1/models` | Gate **strips** these on the public port, and sets its own `X-Request-ID`. Internal routing headers are dropped from public responses |
| F9 | **Reasoning memory is always on** (in memory, 30 min TTL, no switch); context handoff is off by default (env). Both are scoped to profile + session key (`x-session-id`, else a hash of the *first user message*) → two end users on one app key could collide | No code edit needed: the gate sets a **fresh random `x-session-id` on every public request**, so the session key is unique per request and nothing carries over. Context handoff stays off (startup check). The cross-request test covers it. *(Corrected 2026-11-22: an earlier draft said reasoning memory was off by default.)* |
| F10 | **Blind SSRF**: image URLs are fetched server-side, and private/loopback/Tailscale ranges are allowed unless `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true` | Already a startup check; value must be `true`. Test: an image URL pointing at `127.0.0.1:3002` is refused |
| F11 | Without `NODE_ENV=production`, 5xx error messages are returned raw | Startup check requires `NODE_ENV=production` |
| F12 | Express routing is **case-insensitive and ignores trailing slashes** | The gate matches method + exact path itself; `HEAD`, `/V1/...`, `/v1/models/` all 404 on the public port |
| F13 | The **body parsers skip already-parsed bodies**, and `extractApiToken` is exported | The gate can parse JSON itself *after* the key check, and run the post-parse rules there. With an outer app wrapping upstream's `createApp()` in `index.ts`, **`app.ts` may need no edit at all** (verify in M1 that upstream's parsers have no `verify`/raw-body side effects we'd skip) |
| F14 | `onReady` starts 8 schedulers; 4 are not idempotent | Admin listener = `app.listen(adminPort, host)` with **no** ready callback; `servers.push()` it into the graceful-shutdown list (read at signal time) |
| F15 | **No usage/request id in `requests`**; one `requests` row per *attempt*. Chat echoes `X-Request-ID` / `execution_id`; STT and embeddings expose no id. Every chat response (streams too) carries final `usage` | Gate sets `X-Request-ID` = our log row ID. Tokens and stream errors are read by a **response tap** (wrapping `res.write`/`res.end`) that picks up the final `usage` and any `stream_error` frame. No join on upstream tables |
| F16 | Stream errors after the first byte arrive as an SSE `{"error":{"type":"stream_error"}}` frame + `[DONE]` at HTTP 200, with no failover | Response tap sets `outcome = stream_error` |
| F17 | `FALLBACK_TIME_BUDGET_MS` (45 s default) applies from the 3rd attempt, **chat only**. STT: fixed 60 s per attempt; embeddings: fixed 30 s; **neither stops on client disconnect** | Keep 55 s for chat. Document that STT/embeddings can take several × 60 s and keep consuming quota after the client gives up. Candidate upstream PR: disconnect handling for STT/embeddings |
| F18 | Data dir `/app/server/data`, DB file **`freeapi.db`**; image is **Node 24**; entrypoint chowns the data dir then drops to `node` | Bind-mount `/srv/gateway/data` → `/app/server/data`. The entrypoint's chown makes restores simpler (no manual uid fix) |
| F19 | Upstream's DB backup writes **one overwritten object** (encrypted AES-256-GCM, gzip), default every 5 min; restores automatically at boot if the DB is missing | Interval 6 h; separate `FREEAPI_DB_BACKUP_KEY`; B2 bucket **versioning** + lifecycle (keep old versions 30 days) gives history. Restore drill = delete DB, boot → upstream restores itself |
| F20 | Upstream workflows in a fork: `ci.yml` is harmless (no secrets, tests on Node 20/22/24); `docker.yml` would push `ghcr.io/<us>/freellmapi`; `cli-release.yml` tries an npm publish; `desktop-release.yml` fires on any `v*` tag | **Keep `ci.yml` enabled** (free upstream test matrix). Disable the other three with `gh workflow disable` (not deleted, to avoid modify/delete merge conflicts). `gateway-ci.yml` only adds gitleaks |
| F21 | Health checker probes every key every ~5 min (no off switch), mostly `GET /models` (not metered); catalog sync calls `api.freellmapi.co` every 12 h with Ed25519-verified payloads | Set `HEALTH_CHECK_INTERVAL_MS=900000`. Keep catalog sync (signed; can't redirect keys). `FREELLMAPI_UPDATE_CHECK=off` |
| F22 | `ALLOWED_HOSTS`: exact names, no ports, no wildcards; loopback names always pass | Compose healthcheck to `127.0.0.1` works without listing it |

---

## 3. Answers to the open questions

| # | Answer | Confidence |
|---|---|---|
| Q1 | Groq Whisper honours `verbose_json` and returns `segments`. Mistral Voxtral is sent no format/timestamp params and returns `{text}` only. Cloudflare/OVH: not checked | Code; **live-verify** |
| Q2 | `/v1` forwards `input_audio` verbatim to OpenAI-compatible providers. The **native Gemini adapter drops it** (`providers/google.ts` `userContentToParts` keeps only text and images — checked by hand). No audio capability flag, no format conversion, 25 MB body limit. The `/v1beta` audio→`image_url` bug doesn't affect `/v1`. Formats Gemini accepts via our patch: **live-verify** (Gemini natively accepts wav, mp3, aiff, aac, ogg, flac) | Code (checked) |
| Q3 | Yes. Profile keys authenticate on chat, transcriptions, embeddings and `/v1/models` (all use `requireInferenceAuth`) | Code |
| Q4 | `extractApiToken` (exported from `routes/proxy.ts`): `Authorization` (strips `Bearer `; any non-empty value wins), then `x-api-key`, then `x-goog-api-key`. `?key=` only on `/v1beta`. `resolveAuth(token)` → `{kind:'unified'}` \| `{kind:'profile', profileId, name, systemPrompt}` \| `null` | Code |
| Q5 | `PUT` raw encrypted bytes (optional `Authorization: Bearer $FREEAPI_DB_BACKUP_TOKEN`), `GET` to restore (404/204 = none). One object, overwritten. Workable with an S3-style presigned URL, but rclone + versioned B2 bucket is simpler and keeps history | Code |
| Q6 | Free tier gets a monthly signed snapshot; the paid live feed is for premium licence holders. Payloads are Ed25519-verified against a pinned key; `CATALOG_SYNC_DISABLED=1` stops it. The catalog has **no URL fields**; provider hosts are hard-coded, so a catalog update can't redirect stored keys | Code |
| Q7 | Not answerable from code. Decided in M2 when creating the VM | Deferred to M2 |
| Q8 | **A named chain is strict**: when it's exhausted the request fails; no spill into the global chain, no setting changes that. Capability filters skip incapable models and never fall back to them (empty → 429 `routing_exhausted`). So the audio lane needs no router patch, only the Gemini adapter fix (F2) | Code |
| Q9 | See F15: no id stored in `requests`; chat echoes `X-Request-ID`; we use a response tap for usage | Code |
| Q10 | `/livez` → `{status, version, uptime_s, stored_keys_decryptable}` (version is a static spec version). Gate serves its own public `/livez` | Code |
| Q11 | Chat: JSON `{error:{message,type,code,retryAtMs?}, execution_id}`; status from one ladder (429 with `Retry-After`, or 502/503/413/404/400). Streams hold headers until the first real content, so early exhaustion is the same JSON; later errors are an SSE `stream_error` frame at 200. STT: 400/413/429 else 502, message prefix `transcription error:`. Embeddings: 429 if the last error was 429, else 502 | Code |
| Q12 | Response cache (off; `X-FreeLLM-Cache: on` forces it), idempotency replay (always on, global, 24 h, needs the same key + identical content), reasoning memory and context handoff (off; profile + session scoped), sticky sessions (model id only), compression (off). See F8/F9 | Code |
| Q13 | Safe. `model` = `auto`/`whisper-1` or an exact enabled STT row; it can't reach chat models or other providers. Multer: in memory, 25 MB, 1 file | Code |
| Q14 | Chat (stream and non-stream): disconnect aborts the in-flight call, stops the fallback loop, logs a `canceled` row. **STT and embeddings: no disconnect handling** | Code |
| Q15 | Health checker (every key, ~5 min, `GET /models` for OpenAI-compatible providers, not metered); cooldown probe (only benched keys); catalog sync (12 h, signed). Model probe and model discovery are opt-in. Update check is manual and points at upstream's GitHub (turn off). No telemetry. Retention pruning piggybacks on request logging | Code |

---

## 4. Route inventory (public-port decision)

All mounted in `createApp()` (`app.ts`); `index.ts` mounts nothing. Full list with line numbers: [surface-and-auth.md §1](analysis/surface-and-auth.md).

| Mount (in order) | Upstream auth | Public port | Admin port |
|---|---|---|---|
| Host guard, helmet, `/v1/v1` collapse, CORS, JSON parsers, client context | — | (runs after the gate) | as upstream |
| Ollama emulation | none | 404 | 404 (blocked) |
| `/api/auth/*` | none / throttled | 404 | allowed, except `/api/auth/desktop-session` (blocked) |
| `/api/*` (dashboard API) | `requireAuth` | 404 | allowed, except `/api/update*`, `/api/premium*` (blocked) |
| `/api/ping` | none | 404 | allowed |
| `/v1/docs`, `/v1/providers` | none | 404 | allowed |
| `/v1/t/:token` | **injects the unified key** | 404 | 404 (blocked) |
| `/v1/chat/completions` | `requireInferenceAuth` | ✅ (lane rules) | allowed |
| `/v1/audio/transcriptions` | `requireInferenceAuth` | ✅ (by path) | allowed |
| `/v1/embeddings` | `requireInferenceAuth` | ✅ (lane rules) | allowed |
| `/v1/models` | `requireInferenceAuth` | ✅ served by the gate | allowed |
| other `/v1/*` (responses, messages, completions, media, search…) | `requireInferenceAuth` | 404 | allowed |
| `/v1beta` | own key handling (`?key=`) | 404 | 404 (blocked) |
| `/mcp` | **state-changing tools**, before admin auth | 404 | 404 (blocked) |
| `/livez`, `/readyz` | none | `/livez` served by the gate | allowed |
| static dashboard | none | 404 | allowed |

---

## 5. Still to verify (carried into later milestones)

- **M1:** upstream's JSON parsers have no `verify`/raw-body side effects that a pre-parsed body would skip (F13).
- **M2:** Q7 (Oracle A1 capacity vs GCP).
- **M4 (live, with real keys):** Q1 segments per STT provider; Q2 Gemini audio formats through the patched adapter; lane exhaustion status codes match Q11.
