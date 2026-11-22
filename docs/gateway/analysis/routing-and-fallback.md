# freellmapi v0.16.38: routing, fallback, errors, ids, audio, and lane seeding

Read-only analysis. All paths are relative to `server/src/` unless they start with `node_modules/`. Line numbers are from the fresh clone.

---

## 1. Q8: Named-chain exhaustion and capability filtering

**Answer:** A named chain (`auto:<name>`) is strict. When every model in it fails or is unavailable, upstream stops with an exhaustion error. It does not spill into the global chain or other models, and no setting changes this. Capability filters never fall back to an incapable model either. They can empty the chain, which returns a 429 `routing_exhausted`. The real gap is content stripping. Nothing routes on audio, so the native Google adapter and Cohere silently drop `input_audio` parts.

### Evidence: chain strictness
- `resolveRoutingChain` checks `auto:<suffix>` in this order. First come the reserved global-sort aliases: `smart, smartest, intelligence, fast, fastest, speed, cheap, cheapest, price, budget, reliable, reliability, balanced` (`services/router.ts:1295-1301, 1464-1479`). Only after that does it look up a profile by name (`router.ts:1481-1495`). An unknown profile, or a profile with no enabled models, throws `status=400` (`router.ts:1482-1493`).
- The chat handler resolves the chain once (`routes/proxy.ts:2422-2425`). It passes that chain as `prefetchedChain` on every attempt (`proxy.ts:2594`, argument `groupChain ?? resolvedChain?.chain`).
- `routeRequest` walks only `prefetchedChain ?? getActiveChain(db)` (`router.ts:2222`). When the walk finds nothing, it throws `RouteError(…, 429, diag)` (`router.ts:2454-2458`). No global fallback follows.
- Sticky sessions are filtered against the named chain (`resolveStickyPreference(..., resolvedChain?.chain)`, `proxy.ts:2479-2480`, `router.ts:2574-2580`). So the "inject off-chain pinned model" branch (`router.ts:2297-2325`) only fires for explicit non-auto pins.
- Exploration (`router.ts:2256-2287`) only reorders models already in the chain.
- The loop stops after `MAX_RETRIES = 20` (`proxy.ts:666`), after the time budget, or when the circuit breaker trips (`lib/fallback-loop.ts:1452-1473`, setting `max_consecutive_upstream_fails` / env `MAX_CONSECUTIVE_UPSTREAM_FAILS`, default off, `lib/guardrails.ts:31,55`). A route-throw ends the loop (`fallback-loop.ts:1484-1506`).
- Settings that affect behaviour inside a chain (none of them cause spillover):
  - `profiles.routing_strategy`: a per-chain preset (`router.ts:2229-2233`).
  - The global `routing_strategy`: `priority` means strict order.
  - `FALLBACK_TIME_BUDGET_MS` (see item 5).
  - The breaker above.

### Evidence: capability filtering
- The hard filters inside the walk are:
  - `requireVision && !supports_vision` (`router.ts:2399`)
  - `requireTools && !supports_tools` (`router.ts:2406`)
  - `requireStructured && platformDropsResponseFormat(platform)`, which is platform-level only (`router.ts:2414`)
  - the context window (`router.ts:2427-2435`)
  - the TPM limit (`router.ts:2442`)
- Filtered models are skipped and never used as a last resort.
- Soft deferrals only reorder models; they do not exclude them. Tool-benched models and models that fit the context window but not the safety margin go to the back (`router.ts:2366-2380`).
- Exhaustion caused by capability filters maps to `429 rate_limit_error code=routing_exhausted` (`fallback-loop.ts:1264-1273`). Missing keys map to `503 no_providers_configured` (`fallback-loop.ts:1221-1231`).
- **Gotcha:** the up-front gates `hasEnabledVisionModel()` / `hasEnabledToolsModel()` look at the *active* chain, not the named chain (`router.ts:2585-2596`, used at `proxy.ts:2093-2103, 2120-2130`). They return 422 `no_vision_model` / `no_tools_model` when the active (default) profile has no such model, even if the named chain does. In the opposite case, the request passes the gate and then gets 429 `routing_exhausted`.
- The structured-output requirement is enforced after the fact: a JSON check with failover (non-stream) and held text in stream "json" mode (`proxy.ts:2883-2890`).

### Evidence: silent stripping
- The request schema accepts any content block (`proxy.ts:688-696`). The comment there says audio/vision blocks are not supported.
- `contentToString` drops every non-text block (`lib/content.ts:14-34`). The token estimate therefore ignores audio (`content.ts:43-51`).
- Native Google (Gemini): `userContentToParts` keeps text plus `image_url`/`image` blocks only (`providers/google.ts:410-428`). **`input_audio` is silently dropped**, and the model answers as if no audio was sent. Images that fail to fetch or parse are also silently skipped (`google.ts:380-406, 421-422`).
- Cohere flattens all content to text (`providers/cohere.ts:45, 93`).
- OpenAI-compatible providers forward `content` arrays verbatim, including `input_audio` (`providers/openai-compat.ts:298-333, 383`). An upstream that rejects them returns a 400 (`provider_bad_request`), and the request fails over.
- Fusion strips images for the judge (`services/fusion.ts:635`).
- There is no audio capability flag anywhere. `models` has only `supports_vision` and `supports_tools` (`db/migrations/20260101_000000_legacy_baseline.ts:101-118`, plus `supports_tools` from a later migration). The router selects on those two only.

---

## 2. Q11: HTTP status and error body when everything is exhausted

**Answer:**
- **Chat (non-stream and stream):** JSON `{"error":{message,type,code[,retryAtMs]},"execution_id":…}`. The status comes from a shared ladder: 502, 413, 404, 503, 400, 503 or 429, with a 429 carrying `Retry-After`. Streams hold headers until the first real content, so a stream that exhausts before any content gets the same JSON body, not SSE.
- **Error after commit:** HTTP 200 with an SSE frame `data: {"error":{"message":"Provider error (<name>): …","type":"stream_error"}}`, then `data: [DONE]`, and a `requests` row with `status='error'`.
- **STT:** status 400, 413 or 429, otherwise 502. Body `{"error":{"message":"transcription error: All transcription providers failed (last: …).","type":…,"code"?}}`.
- **Embeddings:** status 429 if the last error was a 429, otherwise 502. Body `{"error":{"message":"embedding error: All providers for embedding family 'X' failed (…)","type":…,"code"?}}`.
- STT and embedding errors carry no `execution_id`.

### Chat
- Rendering: `onRoutingExhausted` and `onExhausted` call `res.status(exhaustion.status).json({ error: exhaustionErrorPayload(exhaustion), execution_id })` (`proxy.ts:3399-3409`). `exhaustionErrorPayload` builds `{message,type,code?,retryAtMs?}` (`fallback-loop.ts:937-945`). `Retry-After` is set only when `retryAtMs` exists (`fallback-loop.ts:953-960`). `X-Fallback-Attempts`, `X-Fallback-Trail` and, if enabled, `X-Fallback-Detail` are set (`fallback-loop.ts:895-911`).
- When at least one attempt ran, `exhaustedRetryError` (`fallback-loop.ts:1013-1162`) picks the first matching case:

  | Condition | Status / type / code | Lines |
  |---|---|---|
  | All attempts failed auth | `502 provider_error provider_authentication_failed` | 1031-1041 |
  | All context too large | `413 invalid_request_error context_length_exceeded` | 1046-1056 |
  | All model not found | `404 invalid_request_error model_not_found` | 1058-1068 |
  | Last error is a degraded deployment | `503 service_unavailable provider_degraded` | 1073-1082 |
  | All provider bad request | `400 invalid_request_error provider_rejected_request` | 1092-1100 |
  | Breaker tripped | `503 service_unavailable upstream_unhealthy` | 1104-1117 |
  | All rate-limited, quota, credits or forbidden | `429 rate_limit_error rate_limit_exceeded` (+`retryAtMs`) | 1121-1137 |
  | Anything else (mixed) | `502 provider_error upstream_failed` | 1154-1161 |
  | APINex check-in special case | `429 provider_checkin_required` | 1023-1029 |

  When the time budget stops the loop, the message gains a budget note, but the status follows the same ladder (`fallback-loop.ts:1017-1019, 1519-1525`).
- When zero attempts ran, `routingExhaustionBody` (`fallback-loop.ts:1204-1274`) applies:

  | Condition | Status / code |
  |---|---|
  | No diagnostics, or only config problems | `503 no_providers_configured` |
  | Too large | `413 context_length_exceeded` |
  | Monthly budget | `429 quota_exceeded` |
  | Time-bound (rate limits) | `429 rate_limit_exceeded` |
  | Otherwise (for example capability filters) | `429 routing_exhausted` |

- Non-retryable provider error: `502 {"error":{"message":"Provider error (<name>): …","type":"provider_error"},"execution_id"}` with no code (`proxy.ts:3388-3398`).
- A named chain that is missing or empty: `resolveRoutingChain` throws with `status=400` (`router.ts:1482-1493`). It is not caught in the handler (`proxy.ts:2423`), so Express's `errorHandler` renders `400 {"error":{"message":"Profile 'x' not found…","type":"Error"}}` with no `execution_id` (`middleware/errorHandler.ts:43-54`).

### Streaming
- Headers are sent only in `flushHeaders` / `sendSseHeaders` (`proxy.ts:2697-2725`), on the first real content. They are also sent after 15 s of reasoning-only output (`REASONING_HOLD_MAX_MS`, `fallback-loop.ts:182`; `proxy.ts:2855`) or on a keep-alive ping (`proxy.ts:2742-2750`).
- Before that commit, any failure is thrown and fails over invisibly (`proxy.ts:3137-3141`). Full exhaustion therefore produces the same JSON `onExhausted` body with its real HTTP status.
- After the commit:
  - An in-band error frame writes `{"error":{"message":"Provider error (X): <msg>","type":"stream_error"}}` plus `[DONE]` (`proxy.ts:2777-2793`).
  - Other mid-stream errors write `"…: stream interrupted"` (`proxy.ts:3118-3135`).
  - Both write a `requests` row via `logRequest(…,'error', estimatedInputTokens, totalOutputTokens, …)` (`proxy.ts:2792, 3134`) and return `'committed'`, which stops the loop with no failover (`fallback-loop.ts:1296-1302, 1713-1717`). The attempt trace records outcome `committed` (`lib/attempt-trace.ts:19-27`). The HTTP status stays 200 because it was already sent.

### STT (`/v1/audio/transcriptions`)
- The route catch writes `res.status(httpStatus).json({ error: { message: 'transcription error: '+msg, type: mediaErrorType(status), ...code } })` (`proxy.ts:1368-1373`).
  - Types: 400/413 map to `invalid_request_error`, 401 to `authentication_error`, 429 to `rate_limit_error`, anything else to `server_error` (`proxy.ts:1130-1135`).
  - `Retry-After` comes from `inferenceBudgetCode` (`proxy.ts:1121-1128`).
- Exhaustion uses `chainError`: status is 400, 413 or 429 when the last error had that status, otherwise 502. An upstream 401 becomes 502 on purpose (`services/media.ts:1310-1330`).
- Other cases:
  - No STT models configured: `503` code `no_transcription_models` (`media.ts:1546-1552`).
  - Unknown model: `400` (`media.ts:1554-1561`).
  - File over every provider's limit: `413` (`media.ts:1816-1820`).
  - Upload over 25 MB at multer: `413 file_too_large` (`proxy.ts:1286-1294`).

### Embeddings (`/v1/embeddings`)
- Body: `{ error: { message: 'embedding error: '+msg, type, ...code } }`. Type is `invalid_request_error` for 400, `rate_limit_error` for 429, `server_error` otherwise (`proxy.ts:888-893`).
- Exhaustion status is `429` only if the last error was a 429, otherwise `502` (an upstream 400 becomes 502) (`services/embeddings.ts:574-579`).
- Other cases:
  - Unknown model or family: `400` (`embeddings.ts:504-507`).
  - No enabled providers: `503` (`embeddings.ts:513-515`).
  - Budget block: `429 quota_exceeded` (`embeddings.ts:526-529`).
- No `execution_id` and no `X-Request-ID`.

---

## 3. Q14: Does a client disconnect stop the upstream call?

**Answer:**
- **Chat, stream and non-stream:** yes. On `res.on('close')` the handler aborts an `AbortController`. Its signal goes into every provider call, so the in-flight fetch or stream read is canceled, and the loop stops without benching the route. A `requests` row with `status='canceled'` is written.
- **STT and embeddings:** no. There is no disconnect handling, so the chain keeps running through providers after the client leaves. Video generation is the only media path that handles it.

### Evidence
- Chat setup (`proxy.ts:2147-2163`): `res.on('close', …)` sets `clientGone = true` and aborts `clientAbort` with `newClientAbortError()`.
- The signal is composed with the hedge abort for both stream and non-stream calls: `signal: AbortSignal.any([clientAbort.signal, hedgeAbort.signal])` (`proxy.ts:2755, 3151`).
- The stream pump also checks `if (clientGone) break` (`proxy.ts:2760`).
- A disconnect before the first token is not counted as a provider failure (`proxy.ts:2951-2960`). A client-abort error during streaming is rethrown (`proxy.ts:3114`).
- Loop behaviour:
  - At the top of each retry, `clientGone` stops the loop when `attempt > 0` (`fallback-loop.ts:1475-1482`).
  - An `isClientAbortError` thrown mid-attempt logs a `'canceled'` row via `logRequest(… 'canceled', 0, 0 …)`. It skips cooldowns, penalties and the failure trace, and returns (`fallback-loop.ts:1588-1607`).
  - A breaker trip after a disconnect does not render a body (`fallback-loop.ts:1464-1467`).
- STT: `runTranscription` never passes a client signal. `mediaFetch` accepts an optional `clientSignal` (`media.ts:264-281`), but the STT adapters call it without one (`media.ts:1625, 1674, 1691, 1731, 1752`). The route registers no `close` handler (`proxy.ts:1301-1374`). Compare video (`proxy.ts:1187-1195`, `media.ts:1394, 1417`).
- Embeddings: `runEmbeddings` takes no signal (`embeddings.ts:502`). The route has no `close` handler (`proxy.ts:871-894`).

---

## 4. Q9: Request ids and joining token usage

**Answer:**
- Chat and legacy completions expose a per-request id:
  - It is the client's `X-Request-ID` header when supplied, otherwise a random UUID.
  - It is returned as the `X-Request-ID` response header (stream and non-stream) and as `execution_id` in JSON bodies (non-stream success and every JSON error).
  - SSE chunks do not include it.
- STT and embeddings expose no id.
- The id is **not stored** anywhere in `requests`. That table has no id column for this.
- `requests` holds **one row per attempt**:
  - Failed attempts store `input_tokens` = the gateway's chars/4 estimate and `output_tokens` = 0.
  - The success row holds the real or estimated usage.
  - Canceled rows hold 0/0.
- A separate `request_attempts` timeline (no tokens) is keyed to the last `requests` row.

**Joining approach (least invasive first):**
1. Set `req.headers['x-request-id']` to our attribution id in our middleware, so `execution_id` and `X-Request-ID` equal our id for chat.
2. Read token totals from the response we relay, not from `requests`:
   - Non-stream bodies always carry `usage`.
   - Streams always end with a usage frame (real or `estimated:true`).
   - Both equal the success row's tokens.
3. If row-level linkage is needed, use our own AsyncLocalStorage, a better-sqlite3 user-defined function, and an `AFTER INSERT ON requests` trigger that writes `(requests.id, attribution_id)` into our own side table. This needs no upstream edits.

### Evidence: the id
- `getRequestGroupId` returns the client's `x-request-id` header, trimmed, or `crypto.randomUUID()` (`proxy.ts:108-113`).
- Chat sets `res.setHeader('X-Request-ID', requestGroupId)` before anything else (`proxy.ts:1896-1899`). Legacy completions do the same (`proxy.ts:1444-1447`). Because the header is set before any SSE is written, streams carry it too.
- The body includes `execution_id` on non-stream success (`proxy.ts:3339-3342`), on cache and idempotency replays (`proxy.ts:128-131`), and on every JSON error and exhaustion (`proxy.ts:3396, 3403, 3408`, etc.).
- The id appears only in console trace lines, shortened to 6 characters (`proxy.ts:115-117, 135-166`). It is never written to the database.
- The id is used only in the chat and completions handlers. No `execution_id` or `X-Request-ID` appears in the STT handler (`proxy.ts:1280-1374`) or the embeddings handler (`proxy.ts:871-894`).

### Evidence: the `requests` table
- Columns:
  - Base: `id, platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at` (`legacy_baseline.ts:133-144`).
  - Added later: `requested_model, ttfb_ms, key_id` (`:282-299`), `request_type` (`:2036`), `client_ip, client_user_agent` (`20260706_000001`), `served_model`, `client_agent`, `caller` (`20260901_000003_request_caller.ts:22-24`), `model_db_id`, `failure_attribution`, `media_model_db_id`.
  - There is no request or execution id column. The `request_caller` migration comment only mentions pairing with `execution_id` "at a glance" (`20260901_000003_request_caller.ts:11-12`).
- Row writers:
  - Chat: `logRequest` (`lib/request-log.ts:81-171`), one INSERT per call (`:125-128`).
  - Failed attempt: `logFailure` writes `'error'` with `estimatedInputTokens, 0` (`proxy.ts:3374-3387`).
  - Success:
    - Stream: `logRequest(... 'success', inputTokens, outputTokens …)` with `inputTokens = upstreamUsage?.prompt_tokens ?? estimatedPromptTokens` (`proxy.ts:3066-3068, 3105`).
    - Non-stream: `prompt_tokens ?? estimatedInputTokens` (`proxy.ts:3281-3284` region, logged at `3369`).
  - Canceled: `fallback-loop.ts:1603`.
  - A zero-attempt routing exhaustion writes **no** row (it only logs to the console, `fallback-loop.ts:1284-1294`).
  - Embeddings: one row per provider attempt, `request_type='embedding'`, `output_tokens=0` (`embeddings.ts:471-491, 544, 560`).
  - STT: one row per attempt, `request_type='transcription'`, tokens 0/0, `media_model_db_id` set (`media.ts:1292-1298, 1850, 1854`).
- `request_attempts`: rows keyed by `request_id` = the last `requests.id` written during the loop (`attempt-trace.ts:54-79`, `request-log.ts:130-133, 182-199`). It has no tokens and is used for chat only.
- Response usage matches the success row:
  - Stream: the usage frame is always written (`proxy.ts:3024-3060`) with the same numbers used for the row (`proxy.ts:3066-3068`).
  - Non-stream: missing `usage` is backfilled with the logged numbers (`proxy.ts:3155-3325` region: `promptTokens`/`completionTokens` and `outboundBody.usage = {…}`).
  - Embeddings: `usage.prompt_tokens = result.inputTokens` (`proxy.ts:886`), the same value that was logged (`embeddings.ts:543-544`).
- Caveat: the response cache (opt-in, off by default, `services/cache.ts:18-19, 68-80`) and idempotency replays return a stored `usage` but write no `requests` row. Detect them with `X-Routed-Via: cache` or `X-Routed-Via: idempotency` (`proxy.ts:2347, 2359, 2395`).

### Option 3 in detail (row-level join without editing upstream)
- The caller context already uses AsyncLocalStorage (`lib/client-context.ts:18, 39-54`), so the async context propagates into `logRequest` and into the direct inserts in the embeddings and media paths (`embeddings.ts:480`, `media.ts:1294`).
- Add our own store: `als.run({attrId}, next)` in our middleware.
- On the raw better-sqlite3 handle (passed through as `Db`, `db/index.ts:32-43`):
  - Register `db.function('gw_attr_id', () => als.getStore()?.attrId ?? null)`.
  - Then create:
    ```sql
    CREATE TABLE IF NOT EXISTS gw_request_rows(request_row_id INTEGER PRIMARY KEY, attr_id TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS gw_requests_attr AFTER INSERT ON requests WHEN gw_attr_id() IS NOT NULL
    BEGIN INSERT INTO gw_request_rows VALUES (NEW.id, gw_attr_id()); END;
    ```
- Join: `SUM(input_tokens/output_tokens) WHERE status='success'` on rows linked to our attribution id.
- Risks:
  - The function must be registered on every connection before any insert. Otherwise the INSERT fails with "no such function", and `logRequest` swallows the error and loses the row (`request-log.ts:167-170`). Register it immediately after `initDb()`, before `createApp`.
  - Clean up the side table when old `requests` rows are pruned (`services/request-retention.ts`).
  - The node:sqlite factory is used only on Android (`db/index.ts:45-47`).

---

## 5. `FALLBACK_TIME_BUDGET_MS`, per-attempt timeouts, `STREAM_KEEPALIVE_MS`

**Answer:**
- **`FALLBACK_TIME_BUDGET_MS`**
  - Default 45 s. The `fallback_time_budget_ms` setting takes precedence over the env var; `0` disables the budget.
  - Enforced only inside `runFallbackLoop`, which serves chat and completions, `/v1/responses`, `/v1/messages`, and the Ollama and Gemini wires.
  - It applies only from attempt index 2 onward. The first attempt and the first retry always run.
  - It does **not** cover STT or embeddings.
- **Per-attempt timeouts:**
  - Chat uses `PROVIDER_TIMEOUT_<PLATFORM>` with per-adapter defaults (OpenAI-compatible 60 s, Google 60 s as registered, base 15 s, custom 120 s). Streams also use `PROVIDER_STREAM_STALL_TIMEOUT_MS` / `PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>` (default 90 s).
  - Embeddings use a hard-coded 30 s per call.
  - STT uses a hard-coded 60 s per call (SpeechFlow has a 120 s deadline).
- **`STREAM_KEEPALIVE_MS`** exists. The default is off (0), the minimum is 1000 ms, and it applies to chat SSE.

### Evidence: the time budget
- Default and resolution: `DEFAULT_FALLBACK_TIME_BUDGET_MS = 45_000` and `getFallbackTimeBudgetMs()` (setting, then env, then default) (`fallback-loop.ts:174, 191-207`).
- Enforcement:
  - Before starting an attempt: `if (attempt > 1 && budgetMs > 0 && elapsed >= budgetMs)` renders a timedOut exhaustion (`fallback-loop.ts:1514-1525`).
  - After a route-throw: `fallback-loop.ts:1490-1496`.
  - Hedge abort of an attempt still waiting for its first byte: `fallback-loop.ts:1571-1579`, handled at `1627-1643`. The surface wires `abortInFlight` at `proxy.ts:2581`. The hedge is disarmed on commit (`proxy.ts:2718, 2748`).
- Per-endpoint widening: for attempts >1, `getEndpointTimeBudgetMs` raises the budget for historically slow endpoints to their P95 TTFB plus `slow_endpoint_buffer_ms` (default 10 s), capped at 3x the base. The window defaults to 7 days with a 2-day half-life and at least 5 samples. `TTFB_BUDGET_DISABLED=1` turns it off (`lib/ttfb-budget.ts:4-21, 55-75, 163-185`).
- Callers of `runFallbackLoop`: `routes/proxy.ts:1583, 2575`, `routes/responses.ts:1214`, `routes/anthropic.ts:738`, `lib/inbound-chat.ts:230`. Embeddings (`embeddings.ts:502-580`) and STT (`media.ts:1814-1867`) run their own simple loops with no wall-clock budget.

### Evidence: per-attempt timeouts
- `PROVIDER_TIMEOUT_<PLATFORM>`: `0` disables it, and it is read when the provider is constructed, so changes need a restart (`lib/provider-timeout.ts:3-6, 43-53`).
- Defaults:
  - Base: `providerTimeoutMs(platform, 15000)` (`providers/base.ts:372`).
  - OpenAI-compatible: 60 000 (`providers/openai-compat.ts:174`).
  - Google: registered with 60 000 (`providers/index.ts:75`); the class default is 15 000 (`google.ts:589`).
  - Custom providers: 120 000 (`providers/index.ts:705, 725`).
  - Some providers use 180 s or 600 s (`providers/index.ts:215, 228, 249`).
- Stream stall: `PROVIDER_STREAM_STALL_TIMEOUT_MS` (default 90 000) with a per-platform override (`provider-timeout.ts:55-70`). The first-byte grace uses the chat timeout (`base.ts:524`).
- Embeddings: `FETCH_TIMEOUT_MS = 30_000`, not configurable (`embeddings.ts:116, 214-215, 243-244`).
- STT and media: `FETCH_TIMEOUT_MS = 60_000` (`media.ts:224, 269`). SpeechFlow has a 120 s deadline (`media.ts:1588`).

### Evidence: keep-alive
- `streamKeepaliveMs`: unset, 0 or invalid means off; positive values are clamped to at least 1000 ms (`lib/stream-keepalive.ts:27-41`).
- Chat stream wiring: the ping flushes the SSE headers (`proxy.ts:2739-2750`). Once a ping has gone out, a later failure ends the stream with an error frame (`proxy.ts:3115-3135`). That attempt can then no longer fail over invisibly (`stream-keepalive.ts:15-21`).

---

## 6. Q2: Does `/v1/chat/completions` forward `input_audio`?

**Answer:**
- **To Gemini (native Google adapter): no.** `input_audio` parts are silently dropped.
- **To OpenAI-compatible providers** (OpenRouter, Mistral, custom endpoints, etc.): the parts are forwarded verbatim, unmodified.
- No audio formats are accepted or converted anywhere; the gateway does no audio processing.
- There is no audio capability flag in the catalog, so routing cannot select audio-capable models.
- The `/v1beta` bug (audio inlineData turned into `image_url`) lives in `lib/gemini-wire.ts`, which only the `/v1beta` Gemini wire uses. It does not affect `/v1`.
- Size limit: the JSON body limit is 25 MB by default (`REQUEST_BODY_LIMIT_MB`).

### Evidence
- The schema accepts any object block (`proxy.ts:688-696`). The only content normalization is for images (`proxy.ts:2074-2077`; `lib/image-normalize.ts:181-198` ignores anything that is not `image/*`).
- Google: `toGeminiContents` (`google.ts:434+`) uses `userContentToParts`, which takes text via `contentToString` and `image_url`/`image` blocks only (`google.ts:410-428`). Both the non-stream and stream paths use it (`google.ts:599, 682`).
- OpenAI-compatible: `messagesForPlatform` passes `content` through unchanged, including for strict platforms such as Mistral, Groq and Cerebras (`openai-compat.ts:297-362, 383`).
- Cohere: flattened to text (`cohere.ts:45, 93`).
- No code references `input_audio` or an audio capability. A repo-wide search for `input_audio`, `supports_audio` or `audio_input` matches only an unrelated Gemini Live STT setup string (`services/media-google-live.ts:27`).
- Capability columns: `supports_vision` (baseline `:116`) and `supports_tools`. The router reads only those (`router.ts:2399, 2406`).
- Body limit: `DEFAULT_REQUEST_BODY_LIMIT_MB = 25` (`lib/config.ts:20, 31-34`), applied to `/v1` (`app.ts:220-223`). The 8 MB cap applies only to fetched http(s) image URLs, not data URLs (`google.ts:335, 381-404`).
- The `/v1beta` bug: `inlineData`/`inline_data` with any mime type is converted to `{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}` (`lib/gemini-wire.ts:329-339`). Importers are `routes/gemini.ts:19` and `providers/google.ts:16` (`sanitizeForGemini` only). `/v1/chat/completions` never uses the inbound converter.
- **Workaround this suggests (data flow verified in code, Gemini format support not verified):** in our middleware, rewrite `{type:'input_audio', input_audio:{data, format}}` to `{type:'image_url', image_url:{url:'data:audio/<fmt>;base64,<data>'}}`.
  - The image normalizer skips non-`image/*` mime types (`image-normalize.ts:187`).
  - The Google adapter turns any data URL into `inlineData {mimeType, data}` unchanged (`google.ts:381-389`). Gemini accepts audio inlineData.
  - The request then counts as an image request, so `requireVision` filters the chain to `supports_vision=1`, which suits an all-Gemini `auto:audio` chain. It is billed at an estimated 1000 tokens per item (`proxy.ts:2104-2112`).
  - Which audio mime types Gemini accepts (wav, mp3, aiff, aac, ogg, flac; probably not webm or m4a) is external API behaviour and not checked here. Transcode webm, m4a or opus in our middleware if needed.
  - The active-chain vision gate (`proxy.ts:2093`) needs at least one vision model enabled in the *active* profile.

---

## 7. Q1: `/v1/audio/transcriptions`, `verbose_json` segments, and STT providers

**Answer:**
- **Groq Whisper:** yes. The gateway forwards `response_format=verbose_json` and returns `{task, language, duration, text, segments}` with Groq's segment objects unchanged.
- **Mistral Voxtral:** effectively no. The adapter sends no `response_format` or timestamp parameter. Segments come back only if Mistral includes them unasked, and Mistral's API returns them only with `timestamp_granularities` (external knowledge). The route then silently falls back to `{text}` only, dropping language and duration.
- **Model selection:** by the multipart `model` field only.
  - `auto` or `whisper-1` uses every enabled STT row in `priority, id` order.
  - Any other value is an exact provider model id, matched across all platforms with that id.
  - There are no named chains. `auto:stt` returns 400 "Unknown transcription model".
  - `verbose_json` does not filter the chain to providers that return segments, so a failover can silently lose segments.

### Evidence
- Route behaviour (`proxy.ts:1263-1268, 1312-1325, 1357-1367`):
  - The `verbose_json` shape is returned only when `result.segments` is a non-empty array; otherwise the response is `{text}`.
  - `srt` returns 400. `vtt` is allowed only from providers that produce it natively (`media.ts:1563-1572`).
- Chain selection (`media.ts:1502-1504, 1540-1574`):
  - `TRANSCRIPTION_AUTO_IDS = {'auto','whisper-1'}`.
  - Otherwise `chain.filter(m => m.modelId === model)`, and an empty result is a 400.
  - Rows come from `media_models WHERE modality='transcription' AND enabled=1 ORDER BY priority, id` (`media.ts:237-241`).
- Groq (`media.ts:1740-1760`): `response_format` is set to `verbose_json` when requested; the response returns `segments: j.segments`.
- Mistral (`media.ts:1683-1698`): only file, model, language and temperature are sent; segments are returned only if present.
- Other adapters:

  | Adapter | Segments? | Lines |
  |---|---|---|
  | SpeechFlow, SilvR, Google `gemini-3.5-transcribe` / `-live`, Typhoon | Text only | 1577-1605, 1615-1634, 1639-1651, 1699-1714 |
  | Rime, Cartesia | Native adapters | 1635-1638 |
  | Free.ai, Cohere, ElectronHub (`voxtral-mini-2602`, `deepgram-nova-3`), OVH (whisper-large-v3 / -turbo, solaria-3) | Only if upstream sends them; ElectronHub is forced to `json` | 1652-1682 |
  | Custom OpenAI-compatible | Forwards `verbose_json` | 1715-1739 |
  | Cloudflare | Whisper segments and native vtt | 1761-1805 |

- The STT registry is populated by catalog sync (`media.ts:1426-1440`) or by custom endpoints (`POST /api/media/custom`, `routes/media.ts:127`).
- Failover: every error tries the next row. `break` exits only the inner per-key do/while, which loops only for `custom` rows (`media.ts:1824-1866`).
- Upload cap: 25 MB at multer (`proxy.ts:1269-1272`, `media.ts:1458`). A per-model `maxBytes` from the catalog can only lower it (`media.ts:1485-1500, 1816-1820`).
- Catalog sync overwrites STT `priority` but keeps a local `enabled=0` (`services/catalog-sync.ts:549-553, 862-869`). Per-lane ordering by priority therefore does not survive a sync; enabling and disabling rows does.

---

## 8. Seeding lanes: named chains, profiles, strategies, embedding families

**Answer:**
- **Where named chains live:** chat named chains are rows in `profiles` plus `profile_models`. They are managed through the dashboard API `/api/profiles` (session auth), and the `fallback_config` table is the chain when no profile exists.
- **Routing strategies:** per-chain `profiles.routing_strategy` ∈ `priority | balanced | smartest | fastest | reliable`, or NULL to inherit the global setting. The global strategy also allows `custom` and `decision`.
- **Declarative config (`FREEAPI_CONFIG_JSON` / `FREEAPI_CONFIG_PATH`) cannot define profiles.** It covers `admin, license, keys, customProviders, models, fallback, routing` only, and the schema is `.strict()`. A `profiles` key makes config apply throw at boot.
- **Embeddings** route by *family*: a family is the chain, holding one model identity at one dimension. A lane can be pinned to a family by sending `model=<family>`. There are no profiles for embeddings.
- **STT** has no chains at all.
- **Seeding at boot** is possible only with our own startup code (direct SQL after `initDb`) or our own admin calls. `auto:fast` and `auto:smart` cannot be profiles (see item 9).

### Evidence: profiles
- Tables:
  - `profiles(id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, created_at)` (`legacy_baseline.ts:174-185`), plus `auto_include_new_models INTEGER NOT NULL DEFAULT 1` (`migrations/20260823_000004_profile_auto_include.ts:18-22`) and `routing_strategy TEXT` (`migrations/20261111_000002_profile_routing_strategy.ts:25-29`).
  - `profile_models(profile_id, model_db_id, priority, enabled, UNIQUE(profile_id, model_db_id))` (`legacy_baseline.ts:187-194`).
  - `fallback_config(model_db_id UNIQUE, priority, enabled)` (`:166-172`).
- Lookup: the router selects profiles by `LOWER(name)` and joins enabled models ordered by `pm.priority` (`router.ts:1378-1395`). The active profile comes from `settings.active_profile_id` (`services/profile-models.ts:3-10`; `router.ts:1340-1376`).
- API (`app.ts:289`, `requireAuth`, `routes/profiles.ts`):
  - `POST /api/profiles {name, emoji?, color?, sourceProfileId?, empty?}` (`:142-198`). `empty:true` creates the chain with no models and with `auto_include_new_models=0`.
  - `PUT /api/profiles/:id {…, routing_strategy, auto_include_new_models}` (`:46-58, 210-275`).
  - `PUT /api/profiles/:id/reorder [{modelDbId, priority, enabled}]` replaces the chain (`:278-309`).
  - `POST /api/profiles/active` (`:87-109`).
- Name rules: `^[a-zA-Z0-9-_]+$`, at most **20 characters**, and these names are reserved: `auto, smart, fast, cheap, budget, intelligence, speed, active, default` (`profiles.ts:15-31`).
- Built-in seeding: only `Default`, which becomes the active profile (`profiles.ts:447-511`).
- Strategy resolution: `router.ts:2223-2233`. The global strategy is set via `routing.strategy` in declarative config (`declarative-config.ts:107-117, 517-524`) or `PUT /api/fallback/routing` (`routes/fallback.ts:98`).

### Evidence: declarative config
- Schema: `declarative-config.ts:25-118` (`.strict()` at `:118`).
- Loading: `readConfigFromEnv` (`:151-159`), applied at boot by `index.ts:49` right after `initDb`.
- The `fallback` entries write `fallback_config` (`:453-464`). Every newly created or touched model is also added to every profile with `auto_include_new_models=1` (`ensureFallbackRow` calls `ensureModelInProfiles`, `:238-254`; `profile-models.ts:19-33`).
- Example of what *is* supported:
  ```json
  {
    "keys": [{ "platform": "google", "key": "…", "label": "env" },
             { "platform": "groq", "key": "…" }],
    "customProviders": [{ "baseUrl": "https://stt.internal/v1", "apiKey": "…",
                          "models": [{ "model": "whisper-large-v3", "supportsTools": false }] }],
    "models": [{ "platform": "google", "modelId": "gemini-2.5-flash", "supportsVision": true, "fallbackEnabled": true }],
    "fallback": [{ "platform": "google", "modelId": "gemini-2.5-flash", "priority": 1 }],
    "routing": { "strategy": "priority" }
  }
  ```

### Evidence: embeddings
- `resolveFamily`: `auto` or empty means the `embeddings_default_family` setting (default `gemini-embedding-001`). A family name maps to itself, and a provider model id maps to its family. `auto:embed-x` matches neither and returns 400 (`embeddings.ts:91-103`).
- The chain is `SELECT * FROM embedding_models WHERE family = ? AND enabled = 1 ORDER BY priority` (`embeddings.ts:510-512`). Table: `legacy_baseline.ts:2017-2029`.
- Admin: `PUT /api/embeddings {defaultFamily?, providers:[{id, priority, enabled}]}` (`routes/embeddings.ts:183-209`) and `POST /api/embeddings/custom` (`:85`).
- Catalog sync overwrites `family` and `priority` but keeps a local `enabled=0` (`catalog-sync.ts:562-568, 819-830`).

### Recommended seeding (our boot hook, run after `initDb()` and before `createApp`)
- Insert `profiles` rows named, for example, `lane-fast`, `lane-smart` and `audio` (not reserved, at most 20 characters), with `type='custom'`, `auto_include_new_models=0` and `routing_strategy` set as needed.
- Fill `profile_models` from the model ids we choose. It is idempotent with `INSERT … ON CONFLICT(profile_id, model_db_id) DO UPDATE`.
- STT and embedding lanes are a mapping inside our middleware: lane name to a family, or to `auto` or a specific STT model id. Provider order comes from enabling and disabling rows.

---

## 9. What breaks the lane design, and the smallest workarounds

1. **`auto:fast` and `auto:smart` are reserved global-sort aliases, not chains.**
   - What happens: they sort the *whole enabled catalog* by an axis (`router.ts:1295-1314, 1397-1421, 1464-1479`). A profile with those names cannot be created (`profiles.ts:15-18`), and one inserted by SQL would be shadowed.
   - Workaround: our middleware rewrites `auto:fast` to `auto:lane-fast` and `auto:smart` to `auto:lane-smart` (any non-reserved name of at most 20 characters) after the allow-check, mutating `req.body.model`. Express already parsed the body at `app.ts:220-224`, before `proxyRouter` validates it at `proxy.ts:1909`.
2. **`auto:audio` with `input_audio` on Gemini silently drops the audio.**
   - What happens: see item 6. Without a fix the request "succeeds" with a hallucinated answer.
   - Workaround: in our middleware, convert `input_audio` parts to `image_url` audio data URLs (item 6), and make the `audio` chain all-Google models with `supports_vision=1`.
   - Alternative: an OpenAI-compatible provider that accepts `input_audio` verbatim (for example OpenRouter Gemini), in which case leave the parts untouched.
   - Our middleware should also check the declared audio format and size, and reject (or route away) `input_audio` on non-audio lanes, as planned.
3. **STT model selection is multipart and has no chains.**
   - What happens: the `model` field lives in `multipart/form-data`, which multer parses *inside* the proxy route (`proxy.ts:1280-1300`). An app-level "after JSON parsing" middleware sees no `req.body.model`. `auto:stt` returns 400 (`media.ts:1554-1561`).
   - Workaround A: pre-parse with our own multer (memory storage, 25 MB, one file), validate the lane, rewrite `req.body.model` to `auto` or a specific model id, then set `req.headers['content-type']` to a non-multipart value. Upstream's multer then calls `next()` and `req.file` and `req.body` are preserved (`node_modules/multer/lib/make-middleware.js:16-18`). Without that header change, multer re-parses an already-consumed stream and hangs.
   - Workaround B: carry the lane in a header for STT.
   - To get guaranteed segments, restrict the STT pool to Groq (or another provider that returns segments) by disabling the other transcription rows (`PUT /api/media/:id`, kept across syncs). This is global, not per lane. Alternatively, pin a model id that only Groq serves.
4. **Embeddings do not accept `auto:embed-<family>`.**
   - What happens: `resolveFamily` returns null and the request gets a 400 (`embeddings.ts:97-103, 504-507`).
   - Workaround: rewrite to `<family>` in our middleware.
5. **The catalog-sync backfill pollutes named chains.**
   - What happens: profiles default to `auto_include_new_models=1` (`20260823_000004…:18-22`), so `ensureAllModelsInProfiles` adds every newly synced model to them (`catalog-sync.ts:892`; `profile-models.ts:12-17, 35-63`). Models added through declarative config also get added (`declarative-config.ts:253`).
   - Workaround: seed lane profiles with `auto_include_new_models=0`.
6. **Vision and tool gates check the active chain, not the lane.**
   - What happens: `proxy.ts:2093, 2120`; `router.ts:2585-2596`.
   - Workaround: keep the active (Default) profile containing at least one vision-capable and one tool-capable model, or our middleware returns its own clear error.
7. **Other inference surfaces bypass `/v1/chat/completions` lane checks.**
   - Affected: `/v1/completions`, `/v1/responses`, `/v1/messages` (also accepts `auto:<name>`), `/v1beta/*` (Gemini wire), Ollama `/api/chat`, `/api/generate`, `/api/embed`, `/api/embeddings`, `/v1/t/:token/*`, plus `/v1/images`, `/v1/videos`, `/v1/audio/speech`, `/v1/rerank`, `/v1/search`, `/v1/decisions`, `/v1/text/*` and `/v1/moderations` (`app.ts:237-241, 326-338`; `proxy.ts` route list).
   - All of them accept the unified key or client-profile keys (`proxy.ts:72-79`).
   - Workaround: our middleware should allow-list paths per app key and return 403 or 404 for everything else, mounted before these routers.
8. **The token join has no id column.**
   - Use the response-usage capture (item 4, options 1–2), and set the `x-request-id` header so chat `execution_id` equals our id.
   - Treat cache and idempotency replays (`X-Routed-Via: cache` / `idempotency`) as zero upstream cost.
   - Zero-attempt exhaustions write no `requests` row.
9. **A chain emptied by the catalog** (all of its models disabled or retired) returns a **400** "Profile '…' has no enabled models" from the generic `errorHandler`, with `type:"Error"` and no `execution_id` (`router.ts:1488-1493`, `errorHandler.ts:43-54`).
   - Workaround: our middleware or monitoring should treat a 400 from a lane as an operator alert, or rewrite it to 503.
10. **The time budget does not cover STT or embeddings, and neither stops on client disconnect** (items 3 and 5).
    - Worst case for embeddings: 30 s multiplied by the number of rows in the family.
    - Worst case for STT: 60 s multiplied by the number of rows.
    - Workaround: enforce our own deadline in our middleware or the app, and keep STT and embedding pools short.
11. **`STREAM_KEEPALIVE_MS`** and the 15 s reasoning commit both disable invisible failover for the attempt they commit (item 5). For `auto:fast`, leave keep-alive off unless clients need it.
