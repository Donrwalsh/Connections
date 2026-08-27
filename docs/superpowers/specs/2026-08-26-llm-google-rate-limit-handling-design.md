# LLM Google rate-limit handling — design

## Problem

`llm-google` runs currently fall through `queueForStrategy`'s branching
(only `llm-openai`/`llm-ollama` are special-cased) onto the shared
`strategy-runs` queue, even though `worker.ts` already runs a dedicated
`llm-google-runs` consumer — nothing ever enqueues a job onto it.

Separately, Google AI Studio's free tier enforces several distinct quota
dimensions (most commonly hit in practice: requests-per-minute), and a
request that trips one is functionally different from a real model/network
failure — it clears on its own within the minute. Today, any failed
orchestrator call (including a rate-limit hit) is classified as the generic
`model_error` code, which counts toward `LLM_MAX_MODEL_ERRORS` and can end
the run entirely (`StrategyRunStatus.ERROR`) after enough consecutive hits,
even though the model itself never actually failed.

A live spike against a real Google AI Studio key (burst of 30 concurrent
`gemini-3.6-flash` calls, 21 rate-limited) confirmed the actual error shape.
Google's 429 body is Google Cloud's standard `google.rpc.Status` format:

```json
{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota... Please retry in 3.857116819s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      { "@type": "type.googleapis.com/google.rpc.Help", "links": [...] },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [
          {
            "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            "quotaDimensions": { "location": "global", "model": "gemini-3.6-flash" },
            "quotaValue": "5"
          }
        ]
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "3s" }
    ]
  }
}
```

A `QuotaFailure` violation's `quotaId` is the reliable, machine-readable
signal — the requests-per-minute case observed above contains the literal
substring `"PerMinute"`. Google's own docs separately describe exactly two
*behavioral* buckets for 429s: `rate_limit_exceeded` ("per-minute or
per-second request **or token** limit") and `quota_exceeded` ("daily
quota") — meaning a tokens-per-minute hit almost certainly shares the same
`"PerMinute"` naming convention as the requests-per-minute case just
captured, distinct from a `"PerDay"` pattern for the daily case. This
wasn't independently confirmed live (would require either a single
oversized prompt or a full day of burned quota to reproduce), but is the
documented behavioral split this design relies on.

## Goals

- `llm-google` runs are enqueued onto (and consumed from) their own
  `llm-google-runs` queue, matching `llm-openai`/`llm-ollama`.
- A per-minute rate-limit hit (RPM or TPM — anything with `"PerMinute"` in
  its `quotaId`) never counts as a run failure: the run waits and
  automatically retries the identical request, indefinitely, for as long as
  Google keeps returning that specific error.
- The wait duration uses Google's own server-computed `RetryInfo.retryDelay`
  when present, falling back to a configurable default only when it's
  absent.
- A daily quota hit (`"PerDay"`) — or any other 429/error shape — is
  unaffected: it still classifies as `model_error` and counts toward
  `LLM_MAX_MODEL_ERRORS` exactly as it does today for every provider.

## Non-goals

- No cap on consecutive rate-limit waits. A truly stuck key (e.g.
  misconfigured, or a plan whose RPM limit is permanently below what a run
  needs) waits forever rather than eventually erroring out — accepted
  tradeoff per explicit decision.
- No equivalent handling for `llm-openai`/`llm-ollama`. OpenAI has its own,
  differently-shaped rate-limit signaling; extending this pattern to it is
  a separate effort if it's ever needed.
- No new `SolvePrompt` column for rate-limit telemetry (e.g. a running
  count of how many times a given run got rate-limited). Each rate-limited
  attempt still produces an ordinary `CALL_ERROR`-status `SolvePrompt` row
  via the existing generic failed-call path — same visibility every other
  failed call already gets — just without counting toward any run-ending
  threshold.

## Design

### 1. Queue routing fix

- `backend/src/modules/queue/strategy.queue.ts`: new `llmGoogleQueue = new
  Queue("llm-google-runs", {...})`, mirroring `llmOpenAIQueue`/
  `llmOllamaQueue` exactly (same `defaultJobOptions`). `queueForStrategy`
  gains a fourth queue parameter and a `strategyName === LLM_GOOGLE` branch.
- `backend/src/modules/queue/queue.module.ts`: new `LLM_GOOGLE_QUEUE`
  provider/export, alongside the existing two.
- `backend/src/modules/strategy/strategy.service.ts`: inject
  `LLM_GOOGLE_QUEUE`, pass it into `queueForStrategy`'s new call signature,
  and add it to the existing `queues` array (the cross-queue list used
  elsewhere in this file — same treatment as the other two).

### 2. Orchestrator — classifying the rate-limit error

- `orchestrator/src/types.ts`: `SolveErrorCodeSchema` gains `"rate_limited"`.
- `orchestrator/src/solver.ts`: `classifyModelCallError` gains a `provider:
  ModelProvider` parameter (its caller, `solveAssist`, already has
  `resolvedProvider` in scope). When `provider === "google"` and the error
  is an `APICallError` with `statusCode === 429`, parse `responseBody` (a
  JSON string) for a `details[]` entry whose `@type` ends in `QuotaFailure`;
  if any `violations[].quotaId` contains `"PerMinute"`, return a
  `SolveError("rate_limited", ..., { ...apiDetails, retryAfterSeconds })`.
  `retryAfterSeconds` is parsed from the sibling `RetryInfo` detail entry's
  `retryDelay` (strip the trailing `"s"`, parse as a float, round up) —
  falling back to `DEFAULT_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` (60) if that
  entry or field is missing, the body doesn't parse as JSON, or no
  `QuotaFailure`/`"PerMinute"` violation is found at all (including the
  `"PerDay"` case). Any parse failure or non-Google/non-429 error falls
  straight through to today's unchanged `"model_error"` classification —
  this function never throws on a shape it doesn't recognize.
- `orchestrator/src/types.ts` / wherever `SolveErrorDetails` lives:
  gains `retryAfterSeconds?: number`.
- `orchestrator/src/app.ts`: `ERROR_STATUS` gains `rate_limited: 429`. No
  other change — `err.details` (now including `retryAfterSeconds` when
  present) is already spread wholesale into the error JSON response.

### 3. Backend — the wait-and-retry loop

- `backend/src/modules/strategy/orchestrator.service.ts`: `SolveErrorCode`
  type and `isKnownErrorCode` gain `"rate_limited"`; `extractCallDetail`'s
  picked keys gain `retryAfterSeconds`.
- `backend/src/modules/strategy/llm-strategy-runner.service.ts`:
  - `LlmRunLoopState` gains `rateLimitWaitMs: number | null` (starts
    `null`).
  - `classifyFailedCall` gains a `retryAfterSeconds?: number` parameter and
    a `code === "rate_limited"` branch: sets
    `state.rateLimitWaitMs = (retryAfterSeconds ?? DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_MS / 1000) * 1000`.
    Touches nothing else — no counter increment, no `run.status` change.
  - The run loop's existing post-flush wait step (`if (run.status ===
    RUNNING && state.consecutiveModelErrors > 0) await
    this.delay(this.modelErrorBackoff(...))`) is extended: check
    `state.rateLimitWaitMs !== null` *first* — if set, `await
    this.delay(state.rateLimitWaitMs)` and reset it to `null`, skipping the
    model-error backoff branch entirely for that iteration.
  - The call site passes `outcome.error.retryAfterSeconds` through to
    `classifyFailedCall`.
  - The next loop iteration rebuilds the prompt from unchanged
    `state`/`run` fields (`lockedInGroups`, `lastFailedGuess`,
    `availableWords`) — already byte-for-byte identical to what was just
    attempted, since nothing about guess/group state changes on a failed
    call. No new "resend" mechanism needed.

### 4. Config

- `backend/src/strategies.ts`: new
  `DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_MS = 60000` and
  `llmGoogleRateLimitFallbackMs(env?)`, following the file's existing
  `positiveTrialCount`-backed accessor pattern. Read from
  `LLM_GOOGLE_RATE_LIMIT_FALLBACK_MS`.
- `.env.sample` / `README.md`: document the new env var next to the other
  `LLM_*` settings.

### 5. Testing

TDD throughout:

- Orchestrator: `classifyModelCallError`'s Google-429 branch — the real
  captured error body (PerMinute) classifies as `rate_limited` with
  `retryAfterSeconds` parsed from `retryDelay`; a synthesized `"PerDay"`
  variant still classifies as `model_error`; a malformed/unparseable body
  falls through to `model_error` without throwing; a non-Google provider's
  429 is unaffected (still `model_error`, since the provider check gates
  the branch). `app.test.ts`: a `rate_limited` `SolveError` round-trips as
  HTTP 429 with `retryAfterSeconds` present in the response body's
  `details`.
- Backend: `orchestrator.service.spec.ts` — `retryAfterSeconds` extracted
  from a mocked failure response. `llm-strategy-runner.service.spec.ts` —
  a `rate_limited` failure leaves `consecutiveModelErrors`/
  `duplicateCount`/`malformedCount` at 0 and `run.status` at `RUNNING`;
  the run waits the mocked `retryAfterSeconds` (use a near-zero value so
  the test doesn't actually sleep) and successfully retries; repeated
  `rate_limited` failures never terminate the run regardless of count
  (spot-check well past today's `LLM_MAX_MODEL_ERRORS` default). Queue
  routing: `queueForStrategy`/`strategy.service.spec.ts` — `llm-google`
  resolves to the new `llmGoogleQueue`, mirroring the existing
  `llm-openai`/`llm-ollama` assertions.
