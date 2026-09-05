# OpenRouter free-tier support — design

## Problem

The app runs four LLM strategies today — `llm-openai`, `llm-ollama`,
`llm-google`, `llm-groq` — each dispatched against `SupportedModel` rows.
For the three cloud providers a free-usage program keeps trials flowing
without a human re-triggering dispatch every day:

- **OpenAI flagship/mini tiers** (`FreeTierUsageService` +
  `FreeTierDispatchService`) — a shared per-tier *token* budget, reset at
  UTC midnight, burned down by dispatching trials until a caller-chosen
  percentage of the daily allowance is spent.
- **Google AI Studio** (`GoogleRateLimitHoldService` +
  `GoogleFreeDispatchService` + `GoogleRpdResumeService`) — no shared
  token budget; Google enforces a *per-model* requests-per-day (RPD) cap.
  A 429 carrying a per-day `QuotaFailure` parks that one model's runs
  (`StrategyRunStatus.RATE_LIMITED_DAILY`) until the next
  `America/Los_Angeles` midnight, when a cron sweep un-parks them.
- **Groq** (`GroqRateLimitHoldService` + `GroqFreeDispatchService` +
  `GroqRpdResumeService`) — *per-model* RPM + RPD caps, read from Groq's
  own `x-ratelimit-*` response headers. A per-model daily hit parks that
  model until a reset duration parsed from the 429 elapses; a
  self-rescheduling resume job un-parks it. A per-minute hit is not a
  failure — the run waits the header-specified delay and retries.
- The three cloud programs are wired into `DailyAutomationService`, which
  fires a metadata-refresh leg, a judge leg, a mini-tier burn leg, a
  Google burn leg, and a Groq burn leg once a day and records each leg's
  outcome to `AutomationRunLog` for the Activity page.

OpenRouter's free tier (confirmed live against OpenRouter's own limits
documentation and its public `/api/v1/models` and
`/api/v1/models/{slug}/endpoints` catalog as of this spec) does not fit
any of the three existing shapes. Its free-tier caps are **account-wide,
not per-model**:

- **20 requests per minute** across every `:free` model combined. This
  cap does not change, ever.
- **50 requests per day** across every `:free` model combined, until the
  account has made a one-time lifetime purchase of at least $10 in
  credits, after which the daily cap rises to **1,000 requests per day**.
  Credits never expire; the per-minute cap is unaffected by the purchase.
- **Failed attempts still count** toward the daily quota.
- The daily quota resets at **fixed UTC midnight**. A platform-limit 429
  carries `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
  `X-RateLimit-Reset` (a Unix-milliseconds timestamp), and may carry
  `Retry-After` (seconds) on a per-minute hit. Successful responses do
  not carry these headers.

There is no existing way to dispatch `llm-openrouter` trials, no
OpenRouter provider in the orchestrator, and no OpenRouter rows in
`SupportedModel`. (OpenRouter's *catalog* is already consumed —
`OpenRouterClient` + `ModelMetadataRefreshService` read the public model
list for pricing/context metadata — but nothing calls OpenRouter for
inference.)

## Goals

- Add an `llm-openrouter` strategy, dispatched the same way the other
  cloud strategies are (`StrategyService.triggerStrategyRuns`,
  `SupportedModel` rows, its own worker queue and concurrency knob).
- Route the strategy through OpenRouter's OpenAI-compatible API using the
  official `@openrouter/ai-sdk-provider` package, the same way
  `@ai-sdk/groq` was added for Groq.
- Classify an OpenRouter 429 into a per-minute retry (no failure
  recorded, wait and retry) or an account-wide daily park
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, reusing the provider-agnostic
  status Google introduced), using OpenRouter's `X-RateLimit-*` response
  headers rather than string-matching an error body.
- Hold state is a **single account-wide row** for the whole
  `llm-openrouter` strategy, not one row per model — an OpenRouter
  daily-limit 429 means the entire free tier is unavailable until UTC
  midnight, regardless of which model produced it.
- Automatically resume every parked `llm-openrouter` run once the daily
  window resets, driven by a **fixed UTC-midnight cron sweep** (the reset
  clock *is* UTC, so no timezone helper and no per-hit self-rescheduling
  are needed).
- An `OpenRouterFreeDispatchService` that proactively burns the free
  daily allowance across configured OpenRouter models, following
  `GroqFreeDispatchService`'s structure but with an **account-wide
  daily-call budget** as the stop condition (self-counted from
  `SolvePrompt` rows, with a configurable budget and per-trial-cost
  estimate), **dedicated conservative pacing knobs** sized for the fixed
  20 RPM ceiling, and a **global tick-chain cooldown** when a per-minute
  429 is observed.
- An `openRouterBurn` leg in the daily automation chain, alongside
  `metadataRefresh`, `judge`, `miniBurn`, `googleBurn`, and `groqBurn`.
- Seed four confirmed free-tier chat models (see Design §8):
  `z-ai/glm-5.2:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
  `minimax/minimax-m3:free`, `google/gemma-4-31b-it:free`.

## Non-goals

- No shared token-budget tier for OpenRouter (`FreeTierUsageService`'s
  per-tier token model does not fit an account-wide request-count cap).
- No manual "start" endpoint for OpenRouter dispatch — mirrors Google and
  Groq, which are automation-only (`GET`/`DELETE` status/stop, no
  `POST`).
- No per-model hold rows and no per-model resume logic — the free-tier
  cap is account-wide, so a single hold row and a single sweep cover it.
- No self-rescheduling resume job — that was Groq's answer to a
  per-hit reset *duration*. OpenRouter's reset is a fixed clock boundary,
  so a daily cron is both sufficient and simpler.
- No seeding of OpenRouter `:free` entries that are not plain
  text-in/text-out chat models producing structured output: audio,
  safety/guard, embedding, and tools-only models (no `response_format`
  support) are excluded. See Design §8 for the four that were chosen and
  why the near-misses were left out.
- No automatic detection of whether the account has bought $10 in credits
  (there is no API for it). The daily cap is a configuration value
  (`OPENROUTER_FREE_DAILY_BUDGET`, default `50`) the operator raises to
  `1000` after making the purchase.
- No change to `llm-openai` / `llm-ollama` / `llm-google` / `llm-groq`
  behavior beyond the few spots that branch on provider for a
  provider-agnostic status, code, or fallback constant (see Design §2,
  §4).
- No admin UI for inspecting or clearing the `OpenRouterRateLimitHold`
  row by hand — same as Google and Groq, direct database access covers
  it.

## Design

### 1. Provider — orchestrator

`orchestrator/src/provider.ts`:

- `ModelProvider` gains `"openrouter"`.
- New orchestrator dependency `@openrouter/ai-sdk-provider`. `getModel()`
  gains an `"openrouter"` branch:
  `createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  .chat(modelOverride ?? process.env.OPENROUTER_MODEL ??
  DEFAULT_OPENROUTER_MODEL)`. Confirm the exact factory/method name
  (`createOpenRouter`, `.chat(...)` vs calling the provider directly)
  against the package's current published version when wiring — the same
  way this repo avoided guessing the `@ai-sdk/groq` API and OpenRouter
  slugs.
- `DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free"` — the
  small/cheap default role `DEFAULT_OPENAI_MODEL` /
  `DEFAULT_GOOGLE_MODEL` / `DEFAULT_GROQ_MODEL` play for their providers.
- `getModelName()` gains the matching `"openrouter"` branch
  (`modelOverride ?? process.env.OPENROUTER_MODEL ??
  DEFAULT_OPENROUTER_MODEL`).
- `defaultProvider()` gains `if (provider === "openrouter") return
  "openrouter";` so `MODEL_PROVIDER=openrouter` works for the
  provider-less AI Assist path.
- `effectiveContextWindow()` needs no OpenRouter branch — like Google and
  Groq, OpenRouter has no per-call context-window setting; the existing
  `provider !== "ollama"` passthrough already covers it.

### 2. Detecting the hit — orchestrator, header-based

OpenRouter attaches rate-limit state as headers on a platform-limit 429
(not on success):

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | The cap that was hit |
| `X-RateLimit-Remaining` | Requests left in the current window (`"0"` on the hit) |
| `X-RateLimit-Reset` | Unix-**milliseconds** timestamp when the window resets |
| `Retry-After` | Seconds to wait, present on some per-minute 429s |

`orchestrator/src/solver.ts` gains an `openrouter` branch in
`classifyModelCallError`, parallel to the existing `groq` branch:

- When `provider === "openrouter"` and the error is an `APICallError`
  with `statusCode === 429`: read `err.responseHeaders` (already captured
  into `apiDetails` for every provider). Header lookups are
  case-insensitive (normalise keys to lowercase before reading, as the
  Groq branch already does).
  - Parse `x-ratelimit-reset` as an integer of milliseconds since epoch,
    then `resetInSeconds = max(0, ceil((resetMs - Date.now()) / 1000))`.
  - **Account-wide daily vs per-minute**, decided by the reset distance
    rather than by any per-model signal (there is none):
    - `resetInSeconds > DAILY_RESET_THRESHOLD_SECONDS` (a non-configurable
      module constant in `solver.ts`, `120`) → the daily bucket is
      exhausted. Return
      `new SolveError("rate_limited_daily", ..., { ...apiDetails,
      dailyResetSeconds: resetInSeconds })`.
    - Otherwise (a short reset, or only `retry-after` present) → a
      per-minute hit. Return `new SolveError("rate_limited", ...,
      { ...apiDetails, retryAfterSeconds })`, where `retryAfterSeconds`
      is parsed from `retry-after`, falling back to `resetInSeconds`,
      falling back to `undefined` (the backend then applies a config
      constant — see §4). This is the same `"rate_limited"` code and
      `retryAfterSeconds` field Google's and Groq's per-minute paths use;
      the runner's wait-and-retry logic (`state.rateLimitWaitMs`) is
      already provider-agnostic and needs no change.
  - If neither `x-ratelimit-reset` nor `retry-after` is present or
    parseable (a malformed or proxy-mangled 429), fall through to
    `model_error` unchanged — same as the Groq branch's behaviour when
    its headers are absent.
- No new `SolveErrorCode` value — `"rate_limited"` and
  `"rate_limited_daily"` already exist and are provider-agnostic in the
  runner. No new `SolveErrorDetails` field — `dailyResetSeconds` and
  `retryAfterSeconds` already exist (added for Groq).
- `X-RateLimit-Reset` is milliseconds for OpenRouter (Groq's
  `x-ratelimit-reset-requests` was a duration string like `"2h59m59s"` —
  a different format needing a different parser). Confirm the
  milliseconds-epoch interpretation against a real captured 429 before
  finalising the parser, per this repo's never-guess-a-response-shape
  policy.

### 3. Hold state — single account-wide Postgres row

New entity `OpenRouterRateLimitHold`
(`backend/src/modules/strategy/entities/openrouter-rate-limit-hold.entity.ts`):

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `strategyName` | `text` | Always `'llm-openrouter'` today. |
| `heldAt` | `timestamptz` | When the hold was recorded. |
| `resetAt` | `timestamptz` | When the hold lifts. |
| `reason` | `text` | `'daily'` or `'per-minute-cooldown'` (see §5c). |

**Unique constraint on `(strategyName)` alone** — there is ever exactly
one row for the strategy. This is the structural difference from
`GoogleRateLimitHold` / `GroqRateLimitHold`, whose unique constraint is
`(strategyName, modelName)`.

New `OpenRouterRateLimitHoldService`
(`backend/src/modules/strategy/openrouter-rate-limit-hold.service.ts`) —
**simplest of the four hold services**: no timezone math (the reset clock
is UTC) and no per-model set logic.

- `hold(reason: "daily" | "per-minute-cooldown", resetInSeconds: number)`
  — upsert the single row with
  `resetAt = new Date(Date.now() + resetInSeconds * 1000)` and the given
  `reason`. A `'daily'` hold always overwrites a `'per-minute-cooldown'`
  one; a `'per-minute-cooldown'` hold does **not** overwrite a live
  `'daily'` hold (guard on read before writing).
- `isHeld(): Promise<boolean>` — row exists and `resetAt > now`.
- `heldReason(): Promise<"daily" | "per-minute-cooldown" | null>` — the
  reason of the live hold, or `null` when nothing is held.
- `nextResetAt(): Promise<Date | null>` — the live row's `resetAt`, or
  `null`.
- `clearExpired(): Promise<boolean>` — delete the row if
  `resetAt <= now`; returns whether a row was cleared.
- `secondsUntilNextUtcMidnight(now = new Date()): number` — a small pure
  helper (exported for testing) used as the `resetInSeconds` for a
  `'daily'` hold when the orchestrator could not supply a
  `dailyResetSeconds`.

### 4. Runner behavior

`backend/src/modules/strategy/llm-strategy-runner.service.ts`:

- Provider resolution: extend the existing ternary chain with
  `: strategyName === LLM_OPENROUTER ? "openrouter"` before the `"openai"`
  default.
- Inject `OpenRouterRateLimitHoldService` alongside the Google and Groq
  hold services.
- **Top gate**, extended: `... || (strategyName === LLM_OPENROUTER &&
  await openRouterHold.isHeld())` — same park-immediately behaviour
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, zero orchestrator calls). The
  top gate parks on *any* live hold, `'daily'` or `'per-minute-cooldown'`
  alike — a brief cooldown parking a run for ~60s and letting the resume
  sweep pick it up is acceptable and keeps this path simple.
- **On the hit**: the `outcome.error.code === "rate_limited_daily"`
  branch extends its provider check to include `strategyName ===
  LLM_OPENROUTER`, and calls
  `openRouterHold.hold("daily", outcome.error.details.dailyResetSeconds
  ?? openRouterHold.secondsUntilNextUtcMidnight())`.
- `classifyFailedCall`'s `rate_limited_daily` branch is already
  provider-agnostic (parks the run, touches no counter) — no change
  there.
- The per-minute `rate_limited` branch already takes a `provider`
  parameter (added for Groq) to pick a fallback constant. Add a
  `provider === "openrouter"` case selecting
  `llmOpenRouterRateLimitFallbackSeconds()` (§7). Google's and Groq's
  constants are untouched.

### 5. Dispatch — `OpenRouterFreeDispatchService`

New service
(`backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.ts`),
backed by a new single-row `OpenRouterDispatchState` entity (mirrors
`GroqDispatchState`: `id` / `active` / `startedAt`). Its skeleton —
`start` / `stop` / `getStatus` / `runTick`, self-rescheduling tick chain,
least-allocated-model round-robin batching via
`StrategyService.findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` /
`countInFlightByModel` against `LLM_OPENROUTER` — is copied from
`GroqFreeDispatchService`. Three OpenRouter-specific changes:

#### 5a. Stop condition: an account-wide daily-call budget

There is no per-model hold to accumulate toward "every model held". The
stop condition is a single account-wide count of API calls made today
against the configurable daily budget.

- **Today's real spend** is counted from `SolvePrompt` rows (each row is
  one model API call — initial prompt, re-prompt, or backend retry):
  `callsToday = COUNT(SolvePrompt) JOIN StrategyRun ON
  SolvePrompt.strategyRunId = StrategyRun.id WHERE
  StrategyRun.strategyName = 'llm-openrouter' AND SolvePrompt.createdAt >=
  startOfTodayUtc()`. This lives as a new
  `StrategyService.countTodayLlmCalls(strategyName)` method (or a small
  dedicated repository query in the dispatch module — implementation
  planning picks the seam), reusing the existing `startOfTodayUtc()`
  helper so "today" means the same UTC window everywhere.
- **In-flight cost estimate**: `inFlightTrials *
  openRouterCallsPerTrialEstimate()` (default `6` — one Connections solve
  is 4 steps, each 1–2 prompts). `inFlightTrials` is the existing
  `countInFlightByModel(LLM_OPENROUTER, models)` total.
- Each tick, before dispatching: if `callsToday + estimatedInFlight >=
  openRouterFreeDailyBudget()` (default `50`), stop the cycle (`active =
  false`) without dispatching. `start()` short-circuits to the
  `alreadyExhausted` outcome under the same condition, or when
  `openRouterHold.isHeld()`.
- The account-wide 429 `'daily'` hold (§3) is the hard backstop for when
  the estimate drifts below reality: once OpenRouter itself returns a
  daily 429, the runner parks and the next tick sees `isHeld()` and
  stops.

#### 5b. Global RPM pacing via dedicated conservative knobs

The fixed 20 RPM account-wide ceiling is unlike anything the existing
`FREE_TIER_DISPATCH_*` knobs were tuned for, so OpenRouter gets its own
small pacing family (§7):

- `OPENROUTER_DISPATCH_TICK_MS` (default `15000`)
- `OPENROUTER_DISPATCH_MAX_BATCH` (default `3`)
- `OPENROUTER_DISPATCH_MAX_IN_FLIGHT` (default `3`)

Worst case ≈ 3 trials/tick × ~2 prompts fired near-simultaneously per
15s ≈ well under 20/min once `LLM_OPENROUTER_CONCURRENCY=1` serialises
the queue. The tick's in-flight check and batch sizing are otherwise
identical to Groq's.

#### 5c. Per-minute 429 pauses the whole tick chain

A per-minute `rate_limited` during dispatch means the global tick is
outrunning 20/min — continuing would spend the scarce daily budget on
calls that still count. So:

- **The runner writes the cooldown.** When
  `llm-strategy-runner.service.ts` classifies a `provider ===
  "openrouter"` per-minute `rate_limited` outcome, it calls
  `openRouterHold.hold("per-minute-cooldown",
  openRouterDispatchRpmCooldownSeconds())` — one extra line in the
  per-minute branch, guarded to `openrouter`. The runner already has the
  hold service injected (§4) and is the only place that sees the
  per-minute classification directly.
- The dispatch tick then reacts: if a tick observes
  `openRouterHold.heldReason() === "per-minute-cooldown"`, it dispatches
  nothing and reschedules the next tick after the cooldown's
  `nextResetAt()`.
- `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` (default `60000`).

### 6. Resume — fixed UTC-midnight cron sweep

New `OpenRouterRpdResumeService`
(`backend/src/modules/strategy/openrouter-rpd-resume.service.ts`),
`runResume()` shape borrowed from `GoogleRpdResumeService` but with no
`nextResetAt`-based self-rescheduling:

- `runResume()`: `openRouterHold.clearExpired()`, then re-dispatch every
  `StrategyRun` with `status = RATE_LIMITED_DAILY` and `strategyName =
  'llm-openrouter'` (flip to `RUNNING`, re-queue the job, which resumes
  from flushed guesses — the mechanism Google and Groq already use). Job
  ids are date-stamped with the UTC calendar date so a re-dispatch is
  fresh per day but idempotent within one.
- Driven by a fixed cron `upsertJobScheduler` with pattern `5 0 * * *`
  (00:05 UTC — a few minutes past the reset boundary) on a new
  `openrouter-rpd-resume` BullMQ queue.
- `OpenRouterRpdResumeBootstrap` (`OnApplicationBootstrap`, skipped under
  `NODE_ENV=test`): registers the cron and runs `runResume()` once at
  startup to catch anything that expired while the process was down.
- New BullMQ queue `openrouter-rpd-resume`
  (`backend/src/modules/queue/openrouter-rpd-resume.queue.ts` +
  `OPENROUTER_RPD_RESUME_QUEUE` token in `queue.module.ts`), worker
  handler in `backend/src/worker.ts` alongside `groq-rpd-resume`.

### 7. Config

New environment variables, added to `.env.sample` / `env.ts` /
`docker-compose.yml` (backend + orchestrator services) / `README.md`,
mirroring the existing Groq entries where one exists:

- `OPENROUTER_API_KEY` — used by `@openrouter/ai-sdk-provider` in the
  orchestrator.
- `OPENROUTER_MODEL` — default OpenRouter model id for provider-less
  requests (`MODEL_PROVIDER=openrouter`); also add `"openrouter"` to
  `MODEL_PROVIDER`'s accepted values.
- `LLM_OPENROUTER_CONCURRENCY` (default `1`) — worker concurrency for
  `llm-openrouter-runs`.
- `LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS` (default `60`) — used only
  when a per-minute 429's `retry-after` and `x-ratelimit-reset` are both
  absent or unparseable.
- `OPENROUTER_FREE_DAILY_BUDGET` (default `50`) — the account-wide
  requests-per-day cap the dispatch service counts toward. Raise to
  `1000` after making a one-time $10 OpenRouter credit purchase; no code
  change.
- `OPENROUTER_CALLS_PER_TRIAL_ESTIMATE` (default `6`) — assumed API calls
  per solve trial, for the in-flight-cost estimate in §5a.
- `OPENROUTER_DISPATCH_TICK_MS` (default `15000`)
- `OPENROUTER_DISPATCH_MAX_BATCH` (default `3`)
- `OPENROUTER_DISPATCH_MAX_IN_FLIGHT` (default `3`)
- `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` (default `60000`)

`backend/src/strategies.ts` additions: `LLM_OPENROUTER = "llm-openrouter"`,
added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`;
`llmOpenRouterConcurrency()`; `llmOpenRouterRateLimitFallbackSeconds()`;
`openRouterFreeDailyBudget()`; `openRouterCallsPerTrialEstimate()`;
`openRouterDispatchTickMs()`; `openRouterDispatchMaxBatch()`;
`openRouterDispatchMaxInFlight()`; `openRouterDispatchRpmCooldownSeconds()`.
Each new numeric accessor follows the existing
`positiveTrialCount` / `positiveInt` validation pattern with the matching
`DEFAULT_*` constant. `worker.ts` routes `llm-openrouter-runs` into the
`all` / `cloud` roles (never `ollama`), same as `llm-groq-runs`, and adds
the `openrouter-rpd-resume` and `openrouter-free-dispatch` worker
handlers.

### 8. Model seeding

New migration `AddOpenRouterModels<timestamp>`, same shape as
`1781000000000-add-groq-models.ts`:

```sql
INSERT INTO "SupportedModel"
  ("strategyName", "modelName", "supported", "openRouterSlug", "freeTier")
VALUES
  ('llm-openrouter', 'z-ai/glm-5.2:free',                     true, 'z-ai/glm-5.2:free',                     NULL),
  ('llm-openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', true, 'nvidia/nemotron-3-super-120b-a12b:free', NULL),
  ('llm-openrouter', 'minimax/minimax-m3:free',               true, 'minimax/minimax-m3:free',               NULL),
  ('llm-openrouter', 'google/gemma-4-31b-it:free',            true, 'google/gemma-4-31b-it:free',            NULL)
ON CONFLICT ("strategyName", "modelName") DO NOTHING
```

`modelName` **is** the OpenRouter slug for this provider (unlike Groq,
where `modelName` is Groq's own id and `openRouterSlug` was a separate
mapping). `openRouterSlug` is set to the same `:free` id: each `:free`
entry is a real catalog row in `/api/v1/models` with its own
`context_length`, `created`, and pricing, so `ModelMetadataRefreshService`
fills `contextWindow` / `releaseDate` / pricing on its next run.
`freeTier` stays `NULL` — OpenRouter is not part of either OpenAI tier.

**Why these four** (confirmed against `/api/v1/models/{slug}:free/
endpoints` as of this spec — re-confirm at implementation time):

| Slug | Free host | Context | Structured-output params |
|---|---|---|---|
| `z-ai/glm-5.2:free` | Decart | 256K | `response_format`, `structured_outputs`, `tools` |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nvidia | 262K | `response_format`, `structured_outputs`, `tools` |
| `minimax/minimax-m3:free` | GMICloud | 1M | `response_format`, `tools` |
| `google/gemma-4-31b-it:free` | Google AI Studio | 262K | `response_format`, `tools` |

The app's `generateObject` solve prompts need at least `response_format`;
the first two also advertise native `structured_outputs`. Excluded
near-misses: `thinkingmachines/inkling:free` and
`nvidia/nemotron-3.5-lightning:free` (tools-only, no `response_format` —
unreliable for `generateObject`); `minimax/minimax-m2.7:free` (kept as a
future alternate); all audio / safety-guard / embedding `:free` entries.

**Flagged risk — model ids contain `/` and `:`.** The repo recently fixed
slash-encoding in leaderboard links
(`fix/leaderboard-slash-model-ids`, commit `d540f82`) but the colon in a
`:free` suffix is new. Implementation includes an audit before seeding:
leaderboard link building, any backend route that takes a model id as a
path parameter, and frontend `encodeURIComponent` coverage, verifying a
`z-ai/glm-5.2:free`-style id round-trips through every model-id-bearing
URL.

### 9. Daily automation leg

`DailyAutomationService` gains `runOpenRouterBurnLeg`, a direct copy of
`runGroqBurnLeg`: check `openRouterFreeDispatchService.getStatus()`,
record `alreadyActive` if already running, otherwise `start()` and record
`started` or `alreadyExhausted`, catching and recording any thrown error.
Fired in `run()` after the existing Groq leg, independently (no leg
blocks or is blocked by another).

`AutomationRunLog` entity + migration gain `openRouterBurnOutcome` /
`openRouterBurnMessage` columns, same string shape as
`groqBurnOutcome` / `groqBurnMessage`. `AutomationController`'s
`GET /automation/status` assembly includes the OpenRouter leg's live
status alongside the Groq leg's. The service doc comment's leg list is
updated to six legs.

`dispatch.controller.ts` gains `GET /dispatch/openrouter` (status) and
`DELETE /dispatch/openrouter` (stop) — no `POST`, matching Google's and
Groq's automation-only surface.

### 10. Frontend

- `OpenRouterDispatchWidget.tsx`
  (`frontend/src/components/benchmark/OpenRouterDispatchWidget.tsx`) — a
  copy of `GroqDispatchWidget.tsx` (same `bench-free-tier` styling, same
  30s poll cadence, same active/inactive display), **plus** a
  "`{callsToday} / {budget}` calls today" line — unlike Groq and Google,
  OpenRouter's spend is a single countable account-wide number, so it is
  worth surfacing. Fed by a new
  `fetchOpenRouterDispatchStatus` / `stopOpenRouterDispatch` in
  `data/benchmark/api.ts` (the status payload gains `callsToday` and
  `dailyBudget`) and an `OpenRouterDispatchStatus` type in
  `data/benchmark/types.ts`.
- `AutomationStatus` / `AutomationLegDisplay` types, the automation api
  client, and `formatAutomationLine` extended to cover the
  `openRouterBurn` leg, same pattern as `groqBurn`.
- Wired into the Activity page next to `GroqDispatchWidget`.
- No `StrategyRunStatus` display change — `RATE_LIMITED_DAILY` already
  renders ("Paused — daily quota") and is provider-agnostic; an
  OpenRouter run parked by it renders identically.

### 11. Budget reality

At the default `OPENROUTER_FREE_DAILY_BUDGET=50`, one Connections solve
trial costs roughly 4–8 API calls, so the whole account sustains only
**~6–12 trials per day** across all four models combined. Meaningful
benchmark volume needs the one-time $10 OpenRouter credit purchase, which
raises the cap to 1,000/day (`OPENROUTER_FREE_DAILY_BUDGET=1000`),
supporting ~125–250 trials/day. The feature ships working at 50; the knob
is the upgrade path, no redeploy required.

## Testing

TDD throughout, per the repo's normal workflow. New spec files mirror
their Groq-feature counterparts 1:1 unless noted.

### Orchestrator

- `solver.test.ts`: an OpenRouter 429 whose `X-RateLimit-Reset` is more
  than the threshold ahead classifies as `rate_limited_daily` with
  `dailyResetSeconds` computed from it; a 429 whose reset is seconds away
  (or which carries only `Retry-After`) classifies as `rate_limited`
  with `retryAfterSeconds`; a 429 with no parseable rate-limit headers
  falls through to `model_error` without throwing; a non-OpenRouter
  provider's 429 is unaffected by the new branch.
- `provider.test.ts`: `getModel("openrouter", ...)` and
  `getModelName("openrouter", ...)` resolve as expected, including the
  `modelOverride` / `OPENROUTER_MODEL` / `DEFAULT_OPENROUTER_MODEL`
  fallback chain; `defaultProvider()` returns `"openrouter"` for
  `MODEL_PROVIDER=openrouter`.

### Backend

- `openrouter-rate-limit-hold.service.spec.ts`: `hold("daily", n)`
  upserts the single row with `resetAt = now + n`; a
  `'per-minute-cooldown'` hold does not overwrite a live `'daily'` hold
  but a `'daily'` hold overwrites a live cooldown; `isHeld` /
  `heldReason` / `nextResetAt` reflect only a live row; `clearExpired`
  removes an elapsed row and reports it;
  `secondsUntilNextUtcMidnight` is correct across a UTC day boundary and
  never negative.
- `llm-strategy-runner.service.spec.ts`: extends the existing
  Google/Groq `rate_limited_daily` block with an `llm-openrouter`
  variant — top gate parks with zero orchestrator calls when held (for
  either hold reason); a daily hit writes the account-wide hold using
  `dailyResetSeconds`, falling back to `secondsUntilNextUtcMidnight()`
  when that field is absent; a per-minute `openrouter` hit writes a
  `'per-minute-cooldown'` hold and does not record a failure; never
  produces `StrategyRunStatus.ERROR` regardless of repeat count.
- `openrouter-free-dispatch.service.spec.ts`: the Groq dispatch tests
  (already-exhausted no-op, dispatch loop, least-allocated-model
  batching) **plus** OpenRouter-specific cases — the cycle stops when
  `callsToday + estimatedInFlight >= budget`; `start()` returns
  `alreadyExhausted` when already at budget or when the hold is live;
  a live `'per-minute-cooldown'` hold makes a tick dispatch nothing and
  reschedule after the cooldown; the `OPENROUTER_FREE_DAILY_BUDGET` and
  `OPENROUTER_CALLS_PER_TRIAL_ESTIMATE` knobs are honoured.
- `countTodayLlmCalls` (wherever it lands): counts `SolvePrompt` rows
  joined to `llm-openrouter` runs since `startOfTodayUtc()`, excludes
  other strategies and yesterday's rows.
- Resume sweep (`openrouter-rpd-resume` handler): a run parked
  `RATE_LIMITED_DAILY` for `llm-openrouter` is resumed after
  `clearExpired` lifts the hold; a run still under a live hold is not;
  runs of other strategies are untouched; the cron pattern is
  `5 0 * * *`.
- `daily-automation.service.spec.ts`: extends the leg-independence test
  with an `openRouterBurn` leg — mocked `OpenRouterFreeDispatchService`,
  asserting `started` / `alreadyActive` / `alreadyExhausted` / `error`
  outcomes are written to `AutomationRunLog`, and that an
  `openRouterBurn` failure neither blocks nor is blocked by the other
  five legs.
- Queue resolution coverage: `LLM_OPENROUTER_QUEUE`,
  `OPENROUTER_FREE_DISPATCH_QUEUE`, `OPENROUTER_RPD_RESUME_QUEUE` all
  resolve from `QueueModule`.

### Frontend

- `OpenRouterDispatchWidget.test.tsx`, mirroring
  `GroqDispatchWidget.test.tsx`, plus an assertion that the
  "calls today / budget" line renders from the status payload.

### Migration

Three new migrations (`OpenRouterRateLimitHold` + `OpenRouterDispatchState`
tables; the `openRouterBurnOutcome` / `openRouterBurnMessage`
`AutomationRunLog` columns; the model seed from §8). Per repo convention
migrations are not unit-tested; the up / down / up round-trip against a
real database is a manual verification pass once the branch has the dev
DB to itself.

## Open questions for implementation planning

- Exact `@openrouter/ai-sdk-provider` API (`createOpenRouter` signature,
  whether chat models are reached via `.chat(id)` or by calling the
  provider instance directly, current published version) — confirm
  against its published docs/types when wiring
  `orchestrator/src/provider.ts`.
- Exact format and semantics of `X-RateLimit-Reset` (assumed
  Unix-milliseconds epoch) and whether `Retry-After` is reliably present
  on per-minute 429s — confirm against a real captured OpenRouter 429
  before finalising the parser and the daily-vs-per-minute threshold.
- The cleanest seam for `countTodayLlmCalls` — a new method on
  `StrategyService` (alongside `countTodayDispatchByModel`) versus a
  dedicated query in the `openrouter-free-dispatch` module. Both are
  viable; the plan picks one.
- The design places the per-minute-cooldown write in the runner's
  per-minute `rate_limited` branch (§5c). The plan should confirm no
  non-automated `llm-openrouter` path reaches that branch in a way that
  would write an unwanted account-wide cooldown (e.g. a one-off manual
  trial hitting 20 RPM briefly parking the automated cycle) — and if one
  does, gate the write to automated runs only.
- Final re-confirmation of the four seed slugs and their
  `response_format` support against `/api/v1/models/{slug}/endpoints` at
  implementation time, per this repo's never-guess-a-slug policy
  (`1771000000000-backfill-openrouter-slugs.ts`).
- Whether `minimax/minimax-m3:free`'s and `google/gemma-4-31b-it:free`'s
  lack of native `structured_outputs` (only `response_format`) causes
  `generateObject` parse failures in practice — if so, they can be
  marked `supported = false` like `minimax/minimax-m2.7:free` was for
  Groq, leaving the two `structured_outputs`-capable models carrying the
  strategy.
