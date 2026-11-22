# freellmapi v0.16.38: attack surface and auth analysis for a "gateway gate" fork

Paths are relative to `C:\My Folder\Projects\ai-gateway\server\src\`. Line numbers are from the tree as cloned. The analysis was read-only: nothing was executed.

---

## 1. Route inventory (mount order)

**Answer:** everything is mounted in `createApp()` in `app.ts`. `index.ts` mounts no routes; it only calls `createApp` (index.ts:79) and `app.listen` (index.ts:128, 139). Nothing registers `upgrade` handlers or a second server. For the pre-parser gate, the insertion point is right after `app.set('trust proxy', …)` (app.ts:114) and before `createHostGuard` (app.ts:121). For the post-parse hook, it is between `app.use(express.json({limit:'10mb'}))` (app.ts:224) and `clientContextMiddleware` (app.ts:228).

### Global middleware

| # | Line | What | Notes |
|---|---|---|---|
| 0 | app.ts:114 | `app.set('trust proxy', cfg.trustProxy)` | This is a setting, not middleware. `req.ip` reads it lazily, so its position doesn't matter. |
| 1 | app.ts:121 | `createHostGuard(cfg.allowedHosts)` (DNS-rebinding guard) | Applies to every path. It does nothing unless `ALLOWED_HOSTS` is set. |
| 2 | app.ts:144-167 | `helmet` (CSP, HSTS off, COOP/OAC off) | Every path. |
| 3 | app.ts:177-195 | Per-request re-issue of CSP `upgrade-insecure-requests`, COOP and Origin-Agent-Cluster | Every path. |
| 4 | app.ts:203 | `collapseDoubledV1Prefix` (doubled-v1.ts:17-22) | Rewrites `req.url` from `/v1/v1/...` to `/v1/...`. |
| 5 | app.ts:204-208 | `cors` (origin allowlist: localhost:5173 plus `DASHBOARD_ORIGINS`) | Also answers OPTIONS preflights for every path. |
| 6 | app.ts:220-223 | `express.json({limit: REQUEST_BODY_LIMIT_MB, default 25MB})` | Mounted on `/v1`, `/v1beta`, `/mcp`, `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`. |
| 7 | app.ts:224 | `express.json({limit:'10mb'})` | Everything else. body-parser skips a body that is already parsed (`req._body`). |
| 8 | app.ts:228 | `clientContextMiddleware` | AsyncLocalStorage holding IP/UA. IP comes from `req.ip` (client-context.ts:26-30). |

### Routers and handlers

| # | Line | Path(s) | What | Auth | Body parser | Recommendation |
|---|---|---|---|---|---|---|
| 9 | app.ts:237-240 | `/api/tags`, `/api/version`, `/api/show`, `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings` | Per-IP proxy rate limiter (`PROXY_RATE_LIMIT_RPM`) | none | #6 (25MB) for chat/generate/embed/embeddings, #7 for the rest | n/a |
| 10 | app.ts:241 | Same 7 exact paths at root (ollama.ts:85,108,116,375,490,584,591) | **Ollama emulation.** Mounted BEFORE admin auth. | `authorize()` at ollama.ts:28-50 checks the setting `ollama_emulation`: `off` (the default) gives 404, `open-loopback` accepts any loopback caller (isLoopbackRequest), `key-required` accepts the unified key only. A URL-token request is always allowed (ollama.ts:29-31). `/api/embeddings` falls through to the dashboard when a session is valid (ollama.ts:591-606). | #6 or #7 | **Block on public. Keep emulation `off` in server mode.** |
| 11 | app.ts:254-255 | `/api` | Admin rate limiter (`ADMIN_RATE_LIMIT_RPM`, default 600) | n/a | n/a | n/a |
| 12 | app.ts:260 | `/api/auth/*` | `authRouter`: `status`, `desktop-session`, `setup`, `login`, `logout`, `me`, `change-email`, `change-password`, `forgot-password`, `reset-password` (auth.ts:174-386) | **No session needed** for status, desktop-session, setup, login, forgot-password and reset-password. The others validate the session themselves. Loopback trust applies to setup and desktop-session (see item 6). | #7 | Admin only |
| 13 | app.ts:266 | `/api/keys/export` | Tight limiter, 10 rpm | n/a | n/a | Admin only |
| 14 | app.ts:267-274 | `POST /api/keys/:id/reveal` | Limiter, 60 rpm | n/a | n/a | Admin only |
| 15 | app.ts:276-306 | `/api/keys`, `/api/client-profiles`, `/api/conversations`, `/api/logs`, `/api/models`, `/api/profiles`, `/api/fallback`, `/api/embeddings`, `/api/media`, `/api/search`, `/api/decisions`, `/api/analytics`, `/api/health`, `/api/free-tier`, `/api/settings`, `/api/premium`, `/api/backups`, `/api/cache`, `/api/compression`, `/api/update` | Dashboard admin API | `requireAuth`: dashboard session token from `Authorization: Bearer` or `x-dashboard-token` (requireAuth.ts:8-18). Profile keys and the unified key are never valid here. | #7 (10MB) | Admin only |
| 16 | app.ts:309-311 | `GET /api/ping` | Health ping | **none** | #7 | Admin only. The public port has `/livez`. |
| 17 | app.ts:317 | `GET /v1/docs`, `GET /v1/openapi.json` (docs.ts:14,20) | Static API reference. Mounted BEFORE the `/v1` rate limiter. | **none** | #6 | Block on public |
| 18 | app.ts:323 | `GET /v1/providers`, `GET /v1/quota-forecast` (status.ts:116,225) | Upstream status and quota. Mounted BEFORE the rate limiter. | Unified key only (status.ts:117-122, 226-231) | #6 | Admin only |
| 19 | app.ts:326-327 | `/v1/t/:token/*` | **URL-token router.** A valid URL token causes the unified key to be injected into `Authorization` (url-tokens.ts:32). It then re-mounts proxyRouter, responsesRouter and ollamaRouter (url-tokens.ts:38-42). | URL token in the path | #6 | **Block everywhere in server mode** (at minimum on public) |
| 20 | app.ts:332 | `/v1` | Per-IP proxy rate limiter. It sits after docs, providers and `/v1/t`. | n/a | n/a | n/a |
| 21 | app.ts:338 | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` (only when an `anthropic-version` header is sent) (anthropic.ts:487,1259,1298-1299) | Anthropic wire format | `resolveAuth` (unified or profile) at anthropic.ts:240 | #6 | Block on public (not in the allowlist) |
| 22 | app.ts:339 | proxyRouter: `GET /models`, `GET /codex/models`, `GET /models/:id` and `/models/*rest`, `GET /usage`, `POST /embeddings`, `/rerank`, `/search`, `GET /search/engines`, `GET /text/models`, `POST /text/<task>`, `POST /decisions`, `/systemone`, `GET /decisions/models`, `POST /images/generations`, `/videos/generations`, `/audio/speech`, `/audio/transcriptions`, `/completions`, `/chat/completions` (proxy.ts:348-1896) | OpenAI-compatible surface | `requireInferenceAuth` (unified or profile) at proxy.ts:72-79. `/usage` is unified only (proxy.ts:586-601). | #6 (multer for transcriptions) | **Public:** `POST /v1/chat/completions`, `POST /v1/audio/transcriptions`, `POST /v1/embeddings`, `GET /v1/models`. Everything else is admin only. |
| 23 | app.ts:341 | `POST /v1/moderations` (moderation.ts:25) | Moderation shim | `resolveAuth` (moderation.ts:10-18) | #6 | Admin only |
| 24 | app.ts:343 | `POST /v1/responses` (responses.ts:681) | Responses API (Codex) | `resolveAuth` (responses.ts:693) | #6 | Admin only |
| 25 | app.ts:346-347 | `/v1beta/models...` (gemini.ts:83,98,234,236,238) | Native Gemini wire format | `resolveAuth(extractApiToken(req) ?? ?key=)`. **This is the only path that accepts a query-string key** (gemini.ts:50-64). | #6 | Block on public |
| 26 | app.ts:354-355 | `POST/GET/DELETE /mcp` (mcp.ts:669-708) | MCP JSON-RPC server. Its tools include `set_routing_strategy`, `clear_cache` and `ask_freellmapi`. | Off unless `enable_mcp=1` (mcp.ts:661-677), then unified key only (mcp.ts:638-650) | #6 | Admin only, or block |
| 27 | app.ts:361 | `GET /livez`, `GET /readyz` (status.ts:41,68) | Probes | **none** | #7 | `/livez` public. `/readyz` admin only. |
| 28 | app.ts:364 | `errorHandler` | Masks 5xx messages only when `NODE_ENV=production` (errorHandler.ts:10,41) | n/a | n/a | n/a |
| 29 | app.ts:371-409 | `compression()`, `express.static(client/dist)`, SPA fallback (`index.html` for anything not under `/api/`, `/v1/` or `/v1beta/`) | Dashboard | none | n/a | Admin only |

### Where the cross-cutting pieces are mounted

- **helmet:** app.ts:144.
- **CORS:** app.ts:204.
- **allowed-hosts:** app.ts:121.
- **Rate limiters:** app.ts:239 (Ollama), 255 (`/api`), 266 (export), 267-274 (reveal), 326 (`/v1/t`), 332 (`/v1`), 346 (`/v1beta`), 354 (`/mcp`). Each `createProxyRateLimiter()` call owns its own Map, so each mount has its own buckets (rateLimit.ts:34-36).
- **collapseDoubledV1Prefix:** app.ts:203.
- **Static client:** app.ts:381-408, gated by `cfg.serveStaticAssets`, which is hard-coded `true` at config.ts:94.

### Insertion points

- **Pre-parser gate:** insert right after app.ts:114 (or before :121). That is one line, for example `if (cfg.gatewayGate) app.use(cfg.gatewayGate);`. You can avoid editing app.ts entirely by wrapping the app in index.ts: `http.createServer((req,res)=>gate(req,res,()=>app(req,res)))`, or with an outer `express()` that does `use(gate)` then `use(app)`. The inner app keeps its own `trust proxy` because app.ts:114 sets it explicitly.
- **Post-JSON-parse hook:** between app.ts:224 and app.ts:228. There is a zero-edit alternative. The gate can itself run `express.json({limit})` for the two public JSON routes after it has checked the key. body-parser then marks `req._body`, so the upstream parsers at app.ts:222 and 224 skip the body (the comment at app.ts:217-219 says so). The gate can then inspect `req.body.model` and other fields before `next()`.

---

## 2. Q3 (profile keys per endpoint) and Q4 (token extraction)

**Q3 answer:** yes. Profile keys authenticate `POST /v1/audio/transcriptions` (proxy.ts:1283), `POST /v1/embeddings` (proxy.ts:872) and `POST /v1/chat/completions` (proxy.ts:1905), plus `GET /v1/models` (proxy.ts:349). All of them call the same `requireInferenceAuth`, which accepts any non-null `ResolvedAuth`.

The profile `system_prompt` is only applied to chat (proxy.ts:2072) and legacy completions (proxy.ts:1475). Embeddings and transcriptions ignore it.

Upstream has **no per-profile model allowlist, rate limit or budget**. The `client_profiles` table has only `id, name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled, created_at, updated_at` (migrations/20260805_000002_client_profiles.ts:19-30).

**Q4 answer:** `extractApiToken(req)` (proxy.ts:84-95) is **exported**, so the gate should import it rather than copy it. Its precedence:

1. `req.headers.authorization?.replace(/^Bearer\s+/i,'').trim()`. If the result is non-empty it **wins**, even when the scheme isn't Bearer. For example, `Authorization: Basic xyz` yields the token `"Basic xyz"`, and the other headers are then ignored.
2. `x-api-key`: the first element if it is an array, then trimmed.
3. `x-goog-api-key`: the first element if it is an array, then trimmed. Otherwise the result is `undefined`.

There is no query-parameter support in `extractApiToken`. The only other token sources are:

- `?key=` on `/v1beta` only (gemini.ts:51-58).
- The path token on `/v1/t/:token` (url-tokens.ts:11-35). It validates with `validateUrlToken`, then **overwrites `req.headers.authorization` with `Bearer <unified key>`** and sets `req.urlTokenAuthenticated = true`.
- `x-dashboard-token` and Bearer session tokens, but only for `/api` admin routes (requireAuth.ts:9-10; auth.ts:100-103).

`requireInferenceAuth` (proxy.ts:72-79) does `resolveAuth(extractApiToken(req))`. On null it sends `401 {"error":{"message":"Invalid API key","type":"authentication_error"}}`.

`resolveAuth` (lib/system-prompt.ts:56-70):

```ts
export function resolveAuth(token: string | undefined): ResolvedAuth | null
export type ResolvedAuth =
  | { kind: 'unified'; systemPrompt: null }
  | { kind: 'profile'; profileId: number; name: string; systemPrompt: string | null };
```

It checks in this order:

- An empty token returns null.
- A timing-safe match against `getUnifiedApiKey()` returns `unified`.
- A token without the `sk-cp-` prefix (`CLIENT_PROFILE_KEY_PREFIX`, system-prompt.ts:11) returns null.
- Otherwise it runs `SELECT id,name,system_prompt,enabled FROM client_profiles WHERE token_hash = sha256(token)`. A missing or disabled row returns null. A blank prompt is normalised to null.

The lookup is synchronous, so it is safe to call in a pre-parser gate, but it requires `initDb` to have run. **Gate rule:** `const a = resolveAuth(extractApiToken(req)); if (a?.kind !== 'profile') → 401/404`. Using the identical extractor guarantees the gate and the downstream `requireInferenceAuth` see the same token.

---

## 3. Q10: probe bodies

**Answer:** the bodies are small. The only things they reveal are uptime, whether stored keys decrypt, a count of ready upstreams, and a static spec version. They contain no secrets.

- **`GET /livez`** (status.ts:41-62):
  - 200: `{"status":"ok","version":"0.4.1","uptime_s":<int>,"stored_keys_decryptable":<bool>}`
  - 503 (DB unreachable or encryption key not loaded): `{"status":"unavailable","version":"0.4.1","uptime_s":<int>,"checks":{"db":<bool>,"encryption_key":<bool>}}`
  - `version` is `openapiSpec.info.version`, a static `'0.4.1'` (docs/openapi.ts:21), not the app version.
  - **Leaks:** uptime (restart timing) and `stored_keys_decryptable` (a misconfiguration signal). Consider having the gate answer `/livez` itself on the public port with `{"status":"ok"}`, or with 503 when it fails.
- **`GET /readyz`** (status.ts:68-101):
  - 200: `{"status":"ok","ready_upstreams":<int>}`
  - 503: `{"status":"unavailable","reason":"db_unreachable"|"no_upstreams_configured"|"all_upstreams_rate_limited"|"all_upstreams_unhealthy"}`
  - **Leaks:** the number of provider platforms and quota state. Keep it admin only.
- **`GET /api/ping`** (app.ts:309-311): `{"status":"ok","timestamp":"<ISO>"}`. This is harmless, but keep it admin only.

---

## 4. Q13: `model` on `/v1/audio/transcriptions`

**Answer:** `model` is **required** (a 400 if it is empty, proxy.ts:1307-1311). `auto` and `whisper-1` (case-insensitive) mean "the whole STT chain" (media.ts:1504, 1554). Any other value must exactly equal the `model_id` of an **enabled `media_models` row with `modality='transcription'`**, or the request gets a 400 (media.ts:1540-1562 via `listMediaModels`, media.ts:237-241: `WHERE modality = ? AND enabled = 1`).

A caller **cannot** reach chat models or arbitrary providers this way. They can reach any enabled STT row, including custom STT endpoints the admin registered (media.ts:1465-1469), and pick between them by `model_id`. The response headers `X-Provider` and `X-Model` disclose the platform and model that served the request (proxy.ts:1347-1348). The other fields go upstream as-is: `prompt` (any length up to multer's fieldSize), `language`, `temperature` (0-1), and `response_format` (proxy.ts:1312-1345).

**Multer** (proxy.ts:1269-1272): `multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TRANSCRIPTION_BYTES, files: 1 } })`, where `MAX_TRANSCRIPTION_BYTES = 25 MiB` (media.ts:1458). Per-model `meta.maxBytes` can only lower that, and is enforced in `runTranscription` (media.ts:1816-1820).

Other multer limits are left at their defaults: `fields` and `parts` are unlimited, and `fieldSize` is 1MB. A caller can stream many 1MB text fields into memory, so cap the body size in Caddy (`request_body max_size`). Auth runs **before** multer parses anything (proxy.ts:1281-1284). The route is a `.single('file')` upload, so multipart passes untouched through `express.json`.

To restrict STT models per app you cannot inspect the multipart body pre-parse. Either disable unwanted STT rows in the admin DB, or accept the global registry.

---

## 5. Q12: stateful features

**Answer:** four mechanisms carry content between requests: the response cache, idempotency replay, reasoning memory, and context handoff. The last two are scoped to the credential (profile id) plus a session key. That key is the client-supplied `x-session-id`, or otherwise a SHA-1 of the first user message. So **different end users behind one app key can collide** (identical first message, or the same `x-session-id`).

The response cache and idempotency are **not caller-scoped at all**, but they need an identical request fingerprint to hit.

| Feature | Enabled by / default | Scope key | Content leak between end users on one app key? |
|---|---|---|---|
| **Response cache** (services/cache.ts) | Settings `response_cache_enabled`, else env `RESPONSE_CACHE` (default **off**) (cache.ts:75-81). **A per-request `X-FreeLLM-Cache: on` forces it even when it is globally off** (cache.ts:126-144; proxy.ts:2304-2308). Persisted to SQLite as plaintext only when globally on and `RESPONSE_CACHE_PERSIST` is not false (cache.ts:89-91). TTL `RESPONSE_CACHE_TTL_SECONDS` (3600), `RESPONSE_CACHE_MAX_TEMPERATURE` (1.0), `RESPONSE_CACHE_MAX_ENTRIES` (5000). Loaded from the DB at boot (index.ts:56). | SHA-256 of `model`, `messages` (**after** the profile system prompt is prepended, proxy.ts:2072 then 2309), sampling knobs and the compression fingerprint (cache.ts:204-237). **No caller or credential component.** | Only for identical request content, in which case user B gets user A's stored answer to the same prompt. Profiles with the same or empty system prompt share entries across apps. Low risk, but strip `X-FreeLLM-Cache` and `Cache-Control` on public requests and keep the cache off. |
| **Idempotency replay** (services/idempotency.ts) | **Always active** when a non-stream request carries `Idempotency-Key` (proxy.ts:2375-2411). No env switch. TTL `IDEMPOTENCY_TTL_MS` (24h). Full response bodies are persisted to the SQLite `idempotency_claims` table (idempotency.ts:127-163). | `sha256(Idempotency-Key)` only, **global across all callers** (idempotency.ts:46-48, 99-104). The comment's claim that it is "scoped per caller" is wrong. A fingerprint mismatch gives a 409. | A replay requires the same key and the same content. However, anyone who knows or guesses another user's key gets a replay-or-409 oracle, and can pre-claim a key to force 409s. **Strip `Idempotency-Key` on public requests** unless you need it. |
| **Reasoning memory** (#797, proxy.ts:188-261) | Always on, in memory. 30-minute TTL, 1000-entry cap. | `callerScopedSessionKey(auth, getSessionKey(...))`, which gives `profile:<id>:hdr:<x-session-id>[::strategy]` or `profile:<id>:<sha1(first user msg)[::strategy]>` (proxy.ts:281-302, 2451). | **Yes, within one profile.** If two users' conversations share a first user message (for example a fixed template opener) or an `x-session-id`, user A's thinking trace is restored into user B's outbound payload when B's newest assistant turn lacks `reasoning_content` and the routed model matches (proxy.ts:226-260, 2628-2631). It reaches the model, not B directly, but the model can echo it. Mitigations: give every end user a unique `x-session-id` (the gate could derive one), or strip the header and accept the collision risk. Disabling it needs a code edit. |
| **Context handoff** (services/context-handoff.ts) | Env `FREELLMAPI_CONTEXT_HANDOFF=on_model_switch`. Default **off** (context-handoff.ts:27-30). Auto-routed requests only (proxy.ts:2430-2431). 3-hour TTL, 500 entries. | Same caller-scoped session key (proxy.ts:2432-2433). | **Yes if enabled.** The last 12 trimmed messages of a session are injected as a system message on a model switch (context-handoff.ts:111-157). The current request overwrites the store first (proxy.ts:2435), but two concurrent requests on the same key race. **Keep it off.** |
| **Sticky sessions** (proxy.ts:173-177, 304-344) | Always on. 30-minute TTL, 1000 entries. | `getSessionKey(...)` **without** the caller prefix (proxy.ts:308, 322): header or first-message hash plus strategy, **shared across all credentials**. | No content leak: it stores only `modelDbId`. One caller can steer another's routing. |
| **Compression** (services/compression/*) | Settings `compression`, else env `FREELLMAPI_COMPRESSION` (off, lossless, standard or aggressive). Default **off** (compression/config.ts:31-36, 64-69). A request header can only lower the mode, never raise it (config.ts:146-155). | The global `prefixOccurrences` map of SHA-256 hashes of system messages (pipeline.ts:44-77) decides prefix freezing. `toolfilter` clears its cache per call (toolfilter.ts:113,154). Stats are aggregated globally (compression/stats.ts:19-20). | No content leak (hashes and counts only). |
| **Conversations** (`/api/conversations`) | Dashboard Playground transcripts | Admin session | n/a: admin only, not reachable by profile keys. |
| **Responses API** | Stateless. `previous_response_id` is ignored (responses.ts:98). | n/a | n/a |
| **Request analytics** (lib/request-log.ts:126-128) | Always on | Rows per request: IP, UA, agent, model and tokens. **No prompt content.** `REQUEST_ANALYTICS_LOG_CLIENT=false` stores nulls for IP and UA (client-context.ts:35-42). | No |
| **Rate-limit and cooldown state, key health, routing scores** | Global | Provider keys | No content. One app's traffic exhausts shared quota for every app. |

---

## 6. Local trust (L4)

**Answer:** everything that trusts loopback can be neutralised **without code edits**:

1. The gate blocks every non-allowlisted path on the public port.
2. Don't set `FREEAPI_DESKTOP=1`.
3. Keep Ollama emulation `off`.
4. Complete first-run setup before exposing anything.
5. Optionally set `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true` to stop the in-process SSRF to loopback.

`TRUST_PROXY` has **no effect** on `isLoopbackRequest`, because that function reads the socket peer and the raw `X-Forwarded-For`, never `req.ip`.

### Every loopback or local trust point

- **`isLoopbackRequest`** (lib/loopback.ts:35-45). It returns false unless the socket peer `remoteAddress` is `::1`, a real 127/8 address, or `::ffff:127.x` (loopback.ts:14-22, 39). If it is loopback, the function looks at the **right-most** XFF hop (loopback.ts:25-33, 40). No hop means local. A hop is local only if it is itself loopback. A hop with a port, or anything unparseable, is refused (loopback.ts:44). Callers:
  - `auth.ts:117` → `desktopSignInAllowed` (auth.ts:163-169). This requires `FREEAPI_DESKTOP === '1'`, loopback, a localhost Host header, and not cross-site. It is used by `GET /api/auth/status` (field `desktop`, auth.ts:180) and **`POST /api/auth/desktop-session`**, which mints a session for the hidden desktop user (auth.ts:184-190). This is dead code unless `FREEAPI_DESKTOP=1`.
  - `auth.ts:205`: **setup-code bypass.** `POST /api/auth/setup` with zero users accepts a loopback caller without the setup code. Any other caller must present the code that is logged at boot (index.ts:71-73; lib/setup-code.ts:38). Once a user exists, setup returns 409 (auth.ts:195-199).
  - `keys.ts:603, 612-614`: `skipsReauth` lets export and reveal of plaintext provider keys skip the password check, but only with `FREEAPI_DESKTOP === '1'` **and** loopback. Dead code in server mode.
  - `ollama.ts:26, 37-38`: Ollama `open-loopback` mode accepts any loopback caller with no key.
- **Host guard** (allowed-hosts.ts:25, 56-59) always allows the Host values `localhost`, `127.0.0.1`, `::1` and `*.localhost`. Host is caller-controlled, so this is a rebinding defence and **not access control**.
- **`app.ts:86, 102-104`** (`LOOPBACK_HOST_RE`) only decides whether COOP and OAC headers are emitted. No trust is involved.
- **Outbound URL guard** (lib/url-guard.ts:20-24, 207-209, 254-268) allows loopback and private targets unless `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true`. This matters because of the image fetch in item 11, which is a public in-process SSRF and can hit `127.0.0.1:3002` with no XFF, making it look loopback. Those fetches are GET-only and carry no auth, so the only loopback-trusting GETs they could reach are `/api/auth/status` and Ollama `open-loopback` `/api/tags`. Low impact, but set the flag.
- **MCP self-call** (mcp.ts:262-272, 307-313) is not a trust point. `ask_freellmapi` POSTs to `http://<localAddress>:<req.socket.localPort>/v1/chat/completions` with the **unified key**. On the admin port the gate must therefore let the unified key through on `/v1/chat/completions`. If `/mcp` were ever exposed on the public port, the self-call would hit the public port with the unified key and the profile-only gate would reject it.
- **Chat completions explicitly do not trust loopback** (proxy.ts:1901-1906).

### How `isLoopbackRequest` behaves behind Caddy with X-Forwarded-For

- **Caddy as a separate container on the compose network:** the socket peer is Caddy's bridge IP (172.x), so `isLoopbackAddress` is false and the function returns false at loopback.ts:39 before XFF is read. No locality is ever granted.
- **Caddy in the same network namespace** (host networking or a shared netns): the peer is loopback. Caddy sets or appends `X-Forwarded-For` with the real client IP as the right-most hop (without `trusted_proxies` Caddy replaces any incoming XFF with the client IP). The right-most hop is then not loopback, so the result is false.
- The only way a proxied request is "local" is when the client itself connected to Caddy from loopback, for example a process on the VM calling `https://localhost`. That still hits the gate, which blocks `/api/*` on the public port.
- **Admin port over Tailscale:** if traffic arrives from a non-loopback peer (a 100.x address, or the docker gateway), there is no locality. If you front it with something in the same netns that forwards plain TCP from 127.0.0.1 with **no** XFF (for example `tailscale serve --tcp` or socat in a shared-netns sidecar), every admin request looks local. Then setup works without a code and Ollama `open-loopback` opens. Desktop paths still need `FREEAPI_DESKTOP`. Avoid that topology, or finish setup and keep Ollama off.

---

## 7. index.ts and boot

**Answer:** there is a single `app.listen(Number(PORT), HOST, onReady(HOST))`, with `PORT` defaulting to 3001 and `HOST` to `'::'`. `onReady` starts eight schedulers plus wake detection. **Four of them are not idempotent**, so a second server must not call `onReady`. Create it with `app.listen(adminPort, adminHost)` (no callback), or `http.createServer(app)`, and `servers.push()` it into the existing array. The shutdown hook reads that array lazily.

### Boot order (index.ts:32-131)

1. `loadConfig()` (index.ts:33-34).
2. `warnOnEnvDrift`, `installProcessSafetyNet`.
3. `new NodeScheduler()` (index.ts:41).
4. `restoreDbBackupIfNeeded` (index.ts:43-47), then `initDb` (index.ts:48).
5. `applyDeclarativeConfigFromEnv` (`FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH`) (index.ts:49).
6. `warnOnRoutingOverrideDrift`.
7. `loadCacheFromDb` (index.ts:56).
8. `cleanupExpiredCooldowns` (index.ts:63).
9. `generateSetupCode()` if there are 0 users (index.ts:71-73).
10. `restoreProxySettings()` (index.ts:77).
11. `createApp(config)` (index.ts:79).

### What `onReady(host)` starts (index.ts:81-114)

| Job | Where | Idempotent? | External contact |
|---|---|---|---|
| `startHealthChecker(scheduler)` | health.ts:696-698 | Yes (`healthCheckerRunning`) | Provider APIs, key probes |
| `startCatalogSync(scheduler)` | catalog-sync.ts:1286-1298 | Yes (`cancelInterval`) | `CATALOG_BASE_URL`, default `https://api.freellmapi.co` (catalog-sync.ts:44, 71-73). License refresh and sync 10s after boot, then every 12h. `CATALOG_SYNC_DISABLED=1` turns it off. |
| `startCooldownProbe(scheduler)` | cooldown-probe.ts:201-213 | Yes. `COOLDOWN_PROBE_DISABLED=1` turns it off. | Providers |
| `startModelProbe(scheduler)` | model-probe.ts:322-333 | Yes. Only runs with `MODEL_PROBE_ENABLED=1`. | Providers |
| `startDbBackupPump(getDb(), scheduler, dbPath)` | lib/db-backup.ts:263-272 | **No.** It runs immediately and then every interval when `FREEAPI_DB_BACKUP_TARGET`, `_URL` or `_PATH` is set. | Optional remote backup URL or token |
| `startBackupScheduler(scheduler)` | services/backups.ts:605 | **No** | Writes dump files locally |
| `startCustomModelSync(getDb(), scheduler)` | custom-model-sync.ts:142-146 | **No** | Custom endpoints |
| `startBuiltinModelDiscovery(getDb(), scheduler)` | builtin-model-discovery.ts:364-368 | **No** | Providers |
| `startWakeDetect({onWake})` | lib/wake-detect.ts:82-91 | Yes (`installed`). Registers SIGCONT and SIGUSR2 handlers. | Flushes the proxy cache and runs `checkAllKeys` |

Other `index.ts` details:

- `tuneKeepAlive` sets keepAliveTimeout to 75s and headersTimeout to 76s (index.ts:123-126).
- `const servers = [server]` (index.ts:130).
- `installGracefulShutdown({ servers: () => servers.filter(s => s.listening), closeDb: () => getDb().close?.() })` (index.ts:131).
- The IPv6 fallback re-listens on `0.0.0.0` only when `HOST` is unset and the error is EAFNOSUPPORT or EADDRNOTAVAIL, and pushes the new server into `servers` (index.ts:132-146). `onReady` still runs only once, because the first listen failed. Any other error calls `process.exit(1)`.

### `installGracefulShutdown`

The signature (lib/graceful-shutdown.ts:10-16):

```ts
installGracefulShutdown(options: { servers: () => Server[]; closeDb: () => void; graceMs?: number /*8000*/; proc?; logger? }): void
```

On SIGTERM or SIGINT it calls `servers()` **at signal time** (graceful-shutdown.ts:32). It then runs `close()` and `closeIdleConnections()` on each server, closes the DB when all of them are done, and exits 0. After 8s it forces `exit(1)`.

### Adding the admin server

Add this after index.ts:131:

```ts
const adminServer = app.listen(Number(ADMIN_PORT), ADMIN_HOST); // no onReady → no double schedulers
tuneKeepAlive(adminServer);
servers.push(adminServer);   // picked up by the lazy servers() closure
adminServer.on('error', err => { console.error(...); process.exit(1); });
```

Both servers share one app, one DB and one set of in-memory maps, which is fine. For role detection, prefer binding a role per server rather than reading `req.socket.localPort`, so a port remap can't confuse it. For example, `http.createServer((req,res)=>publicGate(req,res,()=>app(req,res)))` for the public port and `http.createServer(app)` (or an admin gate) for the admin port. `localPort` does work: it is the container-side port, and MCP already relies on it (mcp.ts:263).

---

## 8. Dangerous routes

**Answer:** only `/api/update` executes a process: `git rev-parse HEAD` via `execFile`, with fixed arguments. File writes happen via `/api/backups` and the DB-backup pump. Several admin routes contact external services. Every one of those is behind `requireAuth`. The surfaces mounted **before** admin auth are Ollama (`/api/*` exact paths), `/api/auth/*`, `/api/ping`, `/v1/*`, `/v1beta`, `/mcp`, `/livez` and `/readyz`.

- **`/api/update/*`** (routes/update.ts, behind requireAuth at app.ts:306):
  - `GET /release` contacts the GitHub releases API, only when the setting `update_check_enabled=1` (update.ts:584-599).
  - `GET /check` runs `execFile('git', ['rev-parse','HEAD'])` with a 5s timeout and fixed arguments, so there is **no injection** (update.ts:398-403). The git call is skipped when `FREELLMAPI_INSTALL_METHOD` is docker or desktop. It then contacts the GitHub compare API or Atom feed (update.ts:441-471). `FREELLMAPI_UPDATE_CHECK=off` disables it.
  - `GET /status` (update.ts:635).
  - **`POST /apply`** calls `${FREELLMAPI_SELF_UPDATE_URL}/v1/update?async=true` with `FREELLMAPI_SELF_UPDATE_TOKEN`, i.e. a Watchtower sidecar that recreates the container (update.ts:664-692). Leave those env vars unset.
- **`/api/premium/*`** (premium.ts, behind requireAuth):
  - `GET /` (36).
  - `POST /key` validates against the catalog service, stores the key and syncs (46-74).
  - `DELETE /key` (77).
  - `POST /sync` (87).
  - `POST /portal` creates a Stripe billing-portal session via `catalogBaseUrl()/v1/portal` (98-120).
  - It is external-contact only, with no exec.
- **`/mcp`** (mounted before admin auth with its own unified-key check):
  - Disabled unless `enable_mcp=1`.
  - The tools include the state-changing `set_routing_strategy` (mcp.ts:222-229, 512-524) and `clear_cache` (mcp.ts:562-568).
  - `web_search` contacts search providers (mcp.ts:532-547).
  - `ask_freellmapi` self-calls the chat endpoint with the unified key (mcp.ts:283-357).
  - It also reads usage, quota and provider health. **Block it on public.**
- **`/v1beta`** (Gemini; before admin auth): accepts the `?key=` query credential and profile keys. It is an inference surface. Block it on public.
- **Ollama emulation** (before admin auth): see item 1 #10. Its `open-loopback` mode is unauthenticated for loopback callers.
- **`/v1/messages`** (Anthropic) and **`/v1/responses`** are inference surfaces that accept profile keys. Anthropic can serve server-side web search (`maybeServeAnthropicWebSearch`, anthropic.ts:488), which contacts search providers, and so can Responses (lib/responses-web-search.ts). Block both on public.
- **Other `/v1` routes that contact external services with a profile key:**
  - `/v1/search` (search providers)
  - `/v1/rerank`
  - `/v1/images/generations` and `/v1/videos/generations`
  - `/v1/audio/speech`
  - `/v1/text/*` (specialists)
  - `/v1/decisions` and `/v1/systemone`
  - `/v1/completions`
  - `/v1/moderations`
  - `/v1/codex/models`, `/v1/models/:id`
  - All of these are blocked by the allowlist.
- **`/v1/t/:token/*`** (before admin auth): **escalates to the unified key** (url-tokens.ts:32). Block it.
- **`/v1/docs` and `/v1/openapi.json`:** unauthenticated, before the rate limiter.
- **`/v1/providers` and `/v1/quota-forecast`:** unified key, before the rate limiter.
- **File writes:**
  - `/api/backups` writes and deletes dumps (services/backups.ts:318, 460).
  - The DB-backup pump writes or POSTs the DB (lib/db-backup.ts:139-236).
  - The crypto keyfile (lib/crypto.ts:78-80).
- **exec at boot:** `lib/proxy.ts:174-243` runs `scutil` or `gsettings` to detect system proxy settings on macOS or GNOME. This happens via `restoreProxySettings` and is not triggered by a route.
- **Admin routes reachable from the dashboard** that make outbound calls to admin-supplied URLs (custom endpoints, key tests, catalog) are SSRF-guarded by url-guard and are admin only.

---

## 9. `/v1/models`

**Answer:** the list is produced by `proxyRouter.get('/models')` (proxy.ts:348-371) via the **non-exported** `buildCatalogEntries()` (proxy.ts:426-564). If the caller sends `anthropic-version`, `anthropicRouter.get('/models')` answers first (anthropic.ts:1298-1299).

The gate can serve a per-key filtered list without touching proxy.ts, in either of two ways.

- **(a) Wrap and filter (simplest, identical shape).** For `GET /v1/models`, delete `req.headers['anthropic-version']` so the OpenAI handler answers. Then wrap `res.json`, for example `const orig = res.json.bind(res); res.json = b => orig({ ...b, data: b.data.filter(m => allowed(profileId, m.id)) })`, and call `next()`. The upstream handler still runs `requireInferenceAuth`, and a profile key passes. Also force or ignore `?available` if you want only usable models.
- **(b) Your own handler.** Call `buildModelListing()` from `services/model-listing.ts:90`. It returns `{ models: NormalizedModel[], autoContextWindow }`, where each model has `id, name, ownedBy, available, enabled, contextWindow, platforms, supportsTools, supportsVision, executionStatus` (model-listing.ts:11-32). Optionally add `supportedParametersForPlatforms(m.platforms, {tools: m.supportsTools})` from `lib/sampling-params.ts` (used at proxy.ts:561) and build entries like proxy.ts:542-562.
  - The upstream list also includes the virtual entries `auto` and `fusion` (proxy.ts:501-526).
  - It includes Claude-family aliases, from `claudeFamilyDiscoveryEntries()` in services/anthropic-map.ts (proxy.ts:467-481).
  - It includes `auto:<chain-name>` for every custom routing profile, via a SQL query on `profiles` and `profile_models` (proxy.ts:434-454, 528-541). This exposes the names of admin-defined fallback chains.

By default the upstream list includes **unavailable** models too (`?available=true` narrows it). A filtered list is cosmetic unless chat also enforces the allowlist (see item 11).

---

## 10. Env var semantics

| Var | Read at | Semantics |
|---|---|---|
| `PORT` | config.ts:80 (`process.env.PORT ?? 3001`), used at index.ts:34, 128, 139 | A single port, coerced with `Number()`. |
| `HOST` | config.ts:84 (`?? '::'`, dual-stack), used at index.ts:34, 128. index.ts:137 checks `process.env.HOST` directly for the IPv4 fallback. | A single bind address. An explicit HOST disables the fallback. |
| `ALLOWED_HOSTS` | config.ts:104-115 (split on commas, trimmed, lowercased); allowed-hosts.ts:48-86 | Unset or empty turns the guard **off**. The value is a comma-separated list of **exact hostnames**, case-insensitive. The port is ignored (the Host header is parsed with `new URL`, and brackets are stripped from IPv6). **There are no wildcards.** The JSDoc at allowed-hosts.ts:44-46 is garbled, but the code is an exact `Set.has`. A single `*` turns the guard off. Once enabled, `localhost`, `127.0.0.1`, `::1` and `*.localhost` are always allowed in addition (allowed-hosts.ts:25, 56-59). A disallowed host gets a 403 JSON response. It applies to **both** ports, so list the public domain and the Tailscale MagicDNS name or IP. |
| `TRUST_PROXY` | config.ts:117-134, applied at app.ts:114 | Unset, empty, `false` or `no` → false (the default). `true` or `yes` → trust all hops. An integer N>0 → trust N hops. Anything else is a comma-separated list of addresses or CIDRs (Express also accepts `loopback`, `linklocal` and `uniquelocal`). It only affects `req.ip` and therefore the rate limiters (rateLimit.ts:45, 112) and analytics IP (client-context.ts:27), plus `req.secure`. **It does not affect** `isLoopbackRequest` or the CSP X-Forwarded-Proto check (app.ts:91-96 reads the header raw). |
| `PROXY_RATE_LIMIT_RPM` | config.ts:22-28 (default 120; 0 disables; invalid input falls back to 120). rateLimit.ts:26-32 has a duplicate parser used only when no argument is passed, and app.ts always passes `cfg.proxyRateLimitRpm`. | Per IP, in a fixed 60s window, with a separate Map per mount (`/v1`, `/v1/t`, `/v1beta`, `/mcp`, Ollama). Over the limit it returns 429 with `Retry-After` and `X-RateLimit-*` headers. |
| `ADMIN_RATE_LIMIT_RPM` | rateLimit.ts:93-99 | Default 600 per IP on `/api`. |
| `REQUEST_BODY_LIMIT_MB` | config.ts:30-36 | Default 25. Applies to the JSON surfaces listed at app.ts:221. |

---

## 11. Other things that break or weaken the plan

1. **Shared rate-limit bucket behind Caddy.** With `TRUST_PROXY` unset, every public request has `req.ip` = Caddy's address, so **all apps share one 120 rpm bucket** (rateLimit.ts:45). Set `TRUST_PROXY` to Caddy's compose IP or CIDR rather than `true` or `1`. That setting also applies to the admin port, and the list form stops a direct Tailscale caller from spoofing XFF. There is no per-profile rate limit or budget upstream, so put one in the gate if you need it.
2. **Profile keys can reach any model.** `model` on chat may be any catalog id, `auto`, `auto:<chain>`, a Claude alias, or **`fusion`**, which fans out to a panel of models plus a judge and multiplies quota use (proxy.ts:2165-2293). Enforcing per-app models needs the post-parse hook (item 1). Filtering `/v1/models` alone doesn't restrict anything.
3. **In-process SSRF via image URLs.** A chat message with `image_url: http(s)://...` routed to the Google provider is fetched server-side (providers/google.ts:356-405). Metadata and link-local addresses are always blocked. **Loopback, RFC1918 and CGNAT/Tailscale (100.64/10) are allowed** unless `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true` (url-guard.ts:66, 207-209, 263). That flag also blocks custom providers on private addresses, which matters only if you use one. This is a blind GET SSRF from the public port into the compose network, the admin port and the tailnet.
4. **Express matching is case-insensitive and ignores trailing slashes.** `/V1/Chat/Completions/` reaches the chat handler. An exact lowercase allowlist in the gate then gives a harmless 404 (fail-closed). Don't use prefix matching in the gate. Use `req.path` (parseurl), or parse it exactly as Express does. Absolute-form request targets (`GET http://x/api/keys`) are parsed to a pathname by Express's router, so a gate that does naive string work on `req.url` will just 404 them, which is still safe. `HEAD` is routed to `GET` handlers, so treat `HEAD /v1/models` and `HEAD /livez` explicitly. `OPTIONS` would normally be answered by CORS (app.ts:204), but a gate in front 404s it, which is fine for server-to-server traffic.
5. **The gate must reject `kind: 'unified'` on public.** `requireInferenceAuth` accepts it. Also strip `x-dashboard-token`, which is irrelevant on public but harmless to drop.
6. **Client-controlled behaviour headers to strip on public:**
   - `X-FreeLLM-Cache` and `Cache-Control`: either can force caching on (cache.ts:126-144).
   - `X-FreeLLM-Compress`: can only lower the compression mode.
   - `Idempotency-Key`: global, persisted 24h (item 5).
   - `x-session-id`: controls reasoning memory and stickiness. Consider replacing it with a gate-derived per-end-user value.
   - `x-request-id`: echoed back as `X-Request-ID` (proxy.ts:108-113).
   - `anthropic-version`: switches the `/v1/models` handler.
7. **Response headers leak routing internals:** `X-Routed-Via`, `X-Fallback-Trail`, `X-FreeLLM-Cache`, `X-FreeLLM-Compress`, `X-Provider`, `X-Model` (proxy.ts:1347-1348, 2065, 2347-2348), and `X-RateLimit-*`. The gate can wrap `res.setHeader` or `writeHead` to drop them on public responses.
8. **Error masking needs `NODE_ENV=production`** (errorHandler.ts:10, 41). Otherwise raw `err.message` is returned for 5xx responses.
9. **Body size.** The public JSON limit is 25MB per request (config.ts:20). Multer has unlimited fields (item 4). Cap `request_body` in Caddy and consider lowering `REQUEST_BODY_LIMIT_MB`.
10. **Doubled prefix.** If the gate runs before `collapseDoubledV1Prefix` (app.ts:203), `/v1/v1/chat/completions` 404s. That's fine, but clients with a wrong base URL will fail loudly.
11. **ALLOWED_HOSTS is not access control.** Any caller can send `Host: localhost` (allowed-hosts.ts:56-58). It applies to both ports, so remember the admin hostname.
12. **First-run setup code is printed to stdout** (index.ts:71-73), and the forgot-password reset code is logged too (auth.ts:342-357). Anyone with container-log access can claim or reset the dashboard. Complete setup before exposing, and protect the logs.
13. **Outbound phone-home by default:** catalog and license sync to `api.freellmapi.co` every 12h (set `CATALOG_SYNC_DISABLED=1` or `CATALOG_BASE_URL` for a fork). The provider health checker runs regardless. The update check is opt-in. Leave `FREELLMAPI_SELF_UPDATE_*` unset.
14. **The idempotency comment is misleading.** It says "scoped per caller (key)", but the code is global (idempotency.ts:12-15 versus 99-104). Persisted response bodies are plaintext in SQLite. `IDEMPOTENCY_TTL_MS=0` makes claims expire instantly, but rows are still written. Stripping the header is the clean way to disable it.
15. **Embeddings and transcriptions don't apply the profile's system prompt** and have no model restriction. Every profile key can use the whole embedding family set (services/embeddings.ts:502-512) and STT registry (item 4).
16. **Gate ordering relative to `clientContextMiddleware`.** If the gate runs first and rejects, there's no analytics row, which is fine. If the gate parses JSON itself for the post-parse check, keep it synchronous or async-safe. The AsyncLocalStorage context is created later (app.ts:228), so gate work is outside it.
17. **`/v1/models` lists admin-defined chain names** (`auto:<name>`) and the entire catalog, including unavailable models (proxy.ts:528-563). Filter it if those names or the catalog are sensitive.
