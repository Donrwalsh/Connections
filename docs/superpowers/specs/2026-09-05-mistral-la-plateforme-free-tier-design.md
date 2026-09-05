# Mistral (La Plateforme) free-tier support — design

## Problem

The app runs five LLM strategies today — `llm-openai`, `llm-ollama`,
`llm-google`, `llm-groq`, `llm-openrouter` — each dispatched against
`SupportedModel` rows. For the four cloud providers a free-usage program
keeps trials flowing without a human re-triggering dispatch every day:

- **OpenAI flagship/mini tiers** (`FreeTierUsageService` +
  `FreeTierDispatchService`) — a shared per-tier *token* budget, reset at
  UTC midnight, burned down until a caller-chosen percentage of the daily
  allowance is spent.
- **Google AI Studio** (`GoogleRateLimitHoldService` +
  `GoogleFreeDispatchService` + `GoogleRpdResumeService`) — a *per-model*
  requests-per-day cap. A 429 carrying a per-day `QuotaFailure` parks that
  one model's runs (`StrategyRunStatus.RATE_LIMITED_DAILY`) until the next
  `America/Los_Angeles` midnight, when a cron sweep un-parks them.
- **Groq** (`GroqRateLimitHoldService` + `GroqFreeDispatchService` +
  `GroqRpdResumeService`) — *per-model* RPM/TPM + RPD/TPD caps, read from
  Groq's `x-ratelimit-*` response headers and, since commit `0f37cc6`,
  from the 429 body message (`"...on tokens per day (TPD)..."`). A
  per-model daily hit parks that model for a reset duration parsed from
  the 429 (or a fallback constant); a self-rescheduling resume job
  un-parks it. A per-minute hit is not a failure — the run waits and
  retries.
- **OpenRouter** (`OpenRouterRateLimitHoldService` +
  `OpenRouterFreeDispatchService` + `OpenRouterRpdResumeService`) — an
  *account-wide* 20 req/min + 50 (or 1,000) req/day cap, read from
  `X-RateLimit-*` headers. A single account-wide hold row parks the whole
  strategy; a fixed 00:05 UTC cron sweep resumes it.
- The cloud programs are wired into `DailyAutomationService`, which fires
  a metadata-refresh leg, a judge leg, a mini-tier burn leg, a Google burn
  leg, a Groq burn leg, and an OpenRouter burn leg once a day and records
  each leg's outcome to `AutomationRunLog` for the Activity page.

Mistral's La Plateforme free tier (the default "Experiment" mode) does not
fit any existing shape, and is the most information-poor of the five:

- A global **1 request per second** ceiling across every model.
- **Per-pool** tokens-per-minute and tokens-per-month caps (Mistral groups
  its models into free-tier pools — small/standard, medium, dev, legacy —
  each with its own TPM and monthly token allowance). Mistral no longer
  publishes the exact numbers; the operator reads them from the Admin
  Console Limits page.
- **No `X-RateLimit-*` headers on any response.** A 429 carries at most a
  `Retry-After` header, and not always. There is no per-response signal
  that distinguishes a transient per-minute (RPS/TPM) blip from the
  month-long monthly-cap wall.
- **No per-day request cap.** The binding ceilings are the 1 RPS rate, the
  per-minute token throughput, and the monthly token allowance. The
  monthly allowance resets at the start of the calendar month.

There is no existing way to dispatch `llm-mistral` trials, no Mistral
provider in the orchestrator, and no Mistral rows in `SupportedModel`.

## Goals

- Add an `llm-mistral` strategy, dispatched the same way the other cloud
  strategies are (`StrategyService.triggerStrategyRuns`, `SupportedModel`
  rows, its own worker queue and concurrency knob).
- Route the strategy through Mistral's API using the official
  `@ai-sdk/mistral` package, the same way `@ai-sdk/groq` was added for
  Groq.
- Classify a Mistral 429 into a per-minute retry (no failure recorded,
  wait and retry) or a per-model daily park
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, reusing the provider-agnostic
  status Google introduced), using — in order of preference — the 429
  **body message** (mirroring `groqPerDayRateLimitDimension` from
  `0f37cc6`), then a **runner-side consecutive-429 heuristic** as the
  fallback when the body carries no usable signal.
- Hold state is **per-model** (`(strategyName, modelName)` unique
  constraint), identical in shape to `GroqRateLimitHold` — Mistral's
  monthly and TPM caps are per-pool, so one model's pool wall must not
  freeze models sitting in other pools.
- Park a model for a **short fixed fallback duration**
  (`MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`, default 6h), not until
  month-end. The self-rescheduling resume sweep re-checks after it
  expires; a genuine monthly-cap hit simply re-parks each cycle until the
  month rolls, which costs a handful of wasted calls per model per 6h and
  keeps a misclassified multi-minute TPM starvation episode from benching
  a model for weeks.
- Stay under the 1 RPS ceiling with `LLM_MISTRAL_CONCURRENCY=1` and the
  existing shared `FREE_TIER_DISPATCH_*` pacing knobs — no dedicated
  pacing family, no throttle primitive.
- A `MistralFreeDispatchService` that proactively burns the free
  allowance across configured Mistral models, a near-verbatim copy of
  `GroqFreeDispatchService` — dispatch until every model is held or the
  unrun-puzzle backlog is empty. **No token or call budget accounting** —
  Mistral exposes no usage counter and the operator has chosen to rely on
  the 429 backstop rather than a configured monthly-token estimate.
- A `mistralBurn` leg in the daily automation chain, alongside
  `metadataRefresh`, `judge`, `miniBurn`, `googleBurn`, `groqBurn`, and
  `openRouterBurn`.
- Seed four confirmed models — three small plus one mid (see Design §8):
  `mistral-small-latest`, `ministral-8b-latest`, `ministral-3b-latest`,
  `mistral-medium-latest`.

## Non-goals

- No shared token-budget tier for Mistral (`FreeTierUsageService`'s
  per-tier token model does not fit a per-pool monthly cap the app cannot
  observe).
- **No proactive monthly-token budget.** No `SolvePrompt.totalTokens`
  month-to-date accounting, no `MISTRAL_FREE_MONTHLY_TOKEN_BUDGET` knob.
  The dispatch cycle stops only when every model is held or the backlog is
  empty; a monthly-cap 429 is caught by the classification path (§2) and
  parks the model like any other daily hit.
- No manual "start" endpoint for Mistral dispatch — mirrors Google, Groq,
  and OpenRouter, which are automation-only (`GET`/`DELETE` status/stop,
  no `POST`).
- No account-wide hold row and no account-wide resume — the caps are
  per-pool, so per-model holds (one per seeded model) are the right
  granularity. This is the OpenRouter approach rejected; it is the Groq
  approach adopted.
- No fixed resume cron — a 6h fixed park has no shared clock boundary to
  align to, so the self-rescheduling `rearm()` chain (Groq's mechanism) is
  the sole scheduler.
- No dedicated `MISTRAL_DISPATCH_*` pacing family — `LLM_MISTRAL_CONCURRENCY=1`
  plus the shared `FREE_TIER_DISPATCH_*` knobs (as Groq and Google reuse
  them) keep request volume well under 1 RPS.
- No orchestrator-level request throttle. Concurrency 1 serialises the
  queue; a single Connections solve step's calls are naturally spaced by
  model latency.
- No seeding of Mistral's OCR (`mistral-ocr-*`), audio (`voxtral-*`),
  embedding (`mistral-embed`, `codestral-embed`), moderation
  (`mistral-moderation-*`, `shieldstral-*`), or reasoning
  (`magistral-*`) models. The first four do not produce structured solve
  output; reasoning models burn far more tokens per solve against the
  per-pool monthly cap and their `generateObject` reliability is
  unverified. `codestral-*` (code completion) is likewise excluded.
- No admin UI for inspecting or clearing `MistralRateLimitHold` rows by
  hand — same as the other three providers, direct database access covers
  it.
- No change to `llm-openai` / `llm-ollama` / `llm-google` / `llm-groq` /
  `llm-openrouter` behavior beyond the few spots that branch on provider
  for a provider-agnostic status, code, or fallback constant (see Design
  §1, §3).

## Design

### 1. Provider — orchestrator

`orchestrator/src/provider.ts`:

- `ModelProvider` gains `"mistral"`.
- New orchestrator dependency `@ai-sdk/mistral` (the v4 line, matching the
  other `@ai-sdk/*` packages). `getModel()` gains a `"mistral"` branch:
  `createMistral({ apiKey: process.env.MISTRAL_API_KEY })(modelOverride ??
  process.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL)`. Confirm the exact
  factory/callable shape (`createMistral`, whether the provider instance
  is called directly or via a `.chat(...)` / `.languageModel(...)`
  method) against the package's current published version when wiring —
  the same way this repo avoided guessing the `@ai-sdk/groq` and
  `@openrouter/ai-sdk-provider` APIs.
- `DEFAULT_MISTRAL_MODEL = "mistral-small-latest"` — the small/cheap
  default role `DEFAULT_OPENAI_MODEL` / `DEFAULT_GOOGLE_MODEL` /
  `DEFAULT_GROQ_MODEL` / `DEFAULT_OPENROUTER_MODEL` play for their
  providers.
- `getModelName()` gains the matching `"mistral"` branch
  (`modelOverride ?? process.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL`).
- `defaultProvider()` gains `if (provider === "mistral") return
  "mistral";` so `MODEL_PROVIDER=mistral` works for the provider-less AI
  Assist path.
- `effectiveContextWindow()` needs no Mistral branch — like Google, Groq,
  and OpenRouter, Mistral has no per-call context-window setting; the
  existing `provider !== "ollama"` passthrough already covers it.

### 2. Detecting the hit — orchestrator body-message check, then runner heuristic

Mistral gives the classifier far less than Groq or OpenRouter: no
`X-RateLimit-*` headers, and only an intermittent `Retry-After`. The
classification is therefore split across two layers.

#### 2a. `orchestrator/src/solver.ts` — try the 429 body message first

`classifyModelCallError` gains a `mistral` branch, parallel to the `groq`
branch, that runs when `provider === "mistral"` and the error is an
`APICallError` with `statusCode === 429`:

- A small `mistralMonthlyRateLimitFromBody(responseBody, message)` helper,
  modelled directly on `groqPerDayRateLimitDimension` (added in
  `0f37cc6`): it collects the AI SDK's flattened `message`, the raw
  `responseBody` string, and — when the body parses as JSON — the
  structured `error.message` / `error.type` / `error.code` fields, then
  matches them against Mistral's monthly-exhaustion wording. It never
  throws; an absent or unrecognised body yields `null`.
- When the helper returns a monthly signal → return
  `new SolveError("rate_limited_daily", ..., { ...apiDetails })` with
  `dailyResetSeconds` left **unset**, so the backend falls back to
  `mistralModelHoldFallbackSeconds()` (§3). (Mistral's 429 carries no
  reset countdown to compute a real duration from.)
- Otherwise → return `new SolveError("rate_limited", ..., { ...apiDetails,
  retryAfterSeconds })`, where `retryAfterSeconds` is parsed from the
  `retry-after` header when present (case-insensitive lookup, as the Groq
  branch does) and `undefined` when absent — the backend then applies
  `llmMistralRateLimitFallbackSeconds()`.
- If the error is a 429 but the body is unreadable and no `retry-after` is
  present, it still returns `rate_limited` (with `retryAfterSeconds`
  undefined) rather than falling through to `model_error` — a bare 429 is
  unambiguously a rate limit even when nothing else about it is legible,
  and the runner heuristic (§2b) is the safety net for a monthly wall that
  the body failed to announce.
- No new `SolveErrorCode` value and no new `SolveErrorDetails` field —
  `"rate_limited"` / `"rate_limited_daily"` and `retryAfterSeconds` /
  `dailyResetSeconds` all already exist.

**Confirm at implementation** (per this repo's never-guess-a-response-shape
policy, already applied to Google's and Groq's parsing): capture a real
Mistral monthly-cap 429 body *and* a real per-minute 429 body and verify
their `message` / `error` fields differ enough to classify. If Mistral's
bodies do not distinguish the two cases, `mistralMonthlyRateLimitFromBody`
always returns `null` and the runner heuristic below carries the whole
load — the design is correct either way.

#### 2b. `llm-strategy-runner.service.ts` — consecutive-429 heuristic (fallback)

When the orchestrator could not tell a monthly wall from a transient blip
(so every Mistral 429 arrives as `rate_limited`), the runner escalates a
*persistent* streak of them into a park. It already holds per-run retry
state, so this is a small extension:

- `LlmRunLoopState` gains `rateLimitStreak: number` (default `0`) and
  `rateLimitStreakStartedAt: number | null` (default `null`).
- `classifyFailedCall` gains a `provider: ModelProvider` parameter (the
  caller already resolves `provider` once per run). In the existing
  `code === "rate_limited"` branch, when `provider === "mistral"`:
  - increment `state.rateLimitStreak`; stamp
    `state.rateLimitStreakStartedAt = Date.now()` on the transition from
    `0`.
  - if `state.rateLimitStreak >= mistralPersistentRateLimitAttempts()`
    **or** `Date.now() - state.rateLimitStreakStartedAt >=
    mistralPersistentRateLimitElapsedMs()` → treat as a daily hit: set
    `run.status = RATE_LIMITED_DAILY` and `run.finishedAt` (no counter
    bumped, so it never rolls into `ERROR`), exactly as the
    `rate_limited_daily` branch does.
  - otherwise → the existing behaviour:
    `state.rateLimitWaitMs = (retryAfterSeconds ??
    llmMistralRateLimitFallbackSeconds()) * 1000`.
  - for every non-Mistral provider the branch is unchanged.
- The streak resets (`rateLimitStreak = 0`,
  `rateLimitStreakStartedAt = null`) whenever a call for the run succeeds
  — i.e. at the top of the successful-reply path in the run loop, before
  `evaluateProposals`. A `model_error` or any other failure code does
  *not* reset it (those have their own counters; a 429 interleaved with
  unrelated transient errors is still a 429 streak). The exact reset site
  is a plan detail.
- **Caller** (`runLlmStrategy`'s failed-call block): after
  `classifyFailedCall`, add
  `if (strategyName === LLM_MISTRAL && run.status ===
  StrategyRunStatus.RATE_LIMITED_DAILY && model)` →
  `await this.mistralRpdHold.hold(strategyName, model,
  mistralModelHoldFallbackSeconds())`. This fires whether the park came
  from the orchestrator's body classification (`outcome.error.code ===
  "rate_limited_daily"`) or from the runner heuristic converting a
  `rate_limited` — both leave `run.status === RATE_LIMITED_DAILY`, so the
  single check covers both.
- **Open question for planning:** gate the streak-park (and possibly the
  body-classified park) to automated runs only, so a one-off manual trial
  briefly hitting 1 RPS does not bench a model for 6h for every other
  caller. This mirrors the open question the OpenRouter spec raised about
  its per-minute-cooldown write. If gated, a manual run's persistent 429
  streak would instead end the run as `ERROR` via the normal model-error
  path, touching no hold.

### 3. Hold state — Postgres entity and service

New entity `MistralRateLimitHold`
(`backend/src/modules/strategy/entities/mistral-rate-limit-hold.entity.ts`),
**identical in shape to `GroqRateLimitHold`**:

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `strategyName` | `text` | Always `'llm-mistral'` today. |
| `modelName` | `text` | The model that hit its limit. |
| `heldAt` | `timestamptz` | When the hold was recorded. |
| `resetAt` | `timestamptz` | `heldAt + MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`. |

Unique constraint on `(strategyName, modelName)`; idempotent upsert.

New `MistralRateLimitHoldService`
(`backend/src/modules/strategy/mistral-rate-limit-hold.service.ts`) — a
**verbatim copy of `GroqRateLimitHoldService`** (no timezone math, no
per-hit duration parsing):

- `hold(strategyName, modelName, resetInSeconds)` — upsert with
  `resetAt = new Date(Date.now() + resetInSeconds * 1000)`.
- `isHeld(strategyName, modelName)` — row exists and `resetAt > now`.
- `heldModels(strategyName)` — model names of every live hold.
- `nextResetAt(strategyName)` — soonest still-future `resetAt`, or `null`.
- `clearExpired()` — remove every elapsed row, return their model names.

### 4. Runner wiring

`backend/src/modules/strategy/llm-strategy-runner.service.ts`, beyond the
heuristic in §2b:

- Provider resolution: extend the ternary chain with
  `: strategyName === LLM_MISTRAL ? "mistral"` before the `"openai"`
  default.
- Inject `MistralRateLimitHoldService` alongside the Google, Groq, and
  OpenRouter hold services (explicit `@Inject(MistralRateLimitHoldService)`
  per this backend's DI requirement).
- **Top gate**: the `rpdHoldService` ternary extends with
  `strategyName === LLM_MISTRAL ? this.mistralRpdHold : null` — a run
  whose model is currently held parks immediately
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, zero orchestrator calls),
  identical to the Groq path. The resume sweep re-dispatches it.
- The "past the gate with a parked status means the hold lifted — resume"
  normalisation block already handles any strategy; no change.
- `rateLimitFallbackSeconds` resolution extends to pick
  `llmMistralRateLimitFallbackSeconds()` when `strategyName ===
  LLM_MISTRAL`.

### 5. Dispatch — `MistralFreeDispatchService`

New service
(`backend/src/modules/mistral-free-dispatch/mistral-free-dispatch.service.ts`),
a **near-verbatim copy of `GroqFreeDispatchService`**:
`start` / `stop` / `getStatus` / `runTick`, the self-rescheduling tick
chain, least-allocated-model round-robin batching via
`StrategyService.findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` /
`countInFlightByModel` against `LLM_MISTRAL`, backed by a new single-row
`MistralDispatchState` entity (mirrors `GroqDispatchState`:
`id` / `active` / `startedAt`, fixed id `"mistral"`).

- **Stop condition** is Groq's exactly: the cycle deactivates when every
  configured model is held (`heldModels(LLM_MISTRAL)` covers them all) or
  when there are no unrun puzzles left for any model. There is **no**
  budget check — `start()` short-circuits to `alreadyExhausted` only when
  there are no models configured or every model is already held.
- **Pacing** reuses the shared `FREE_TIER_DISPATCH_*` knobs
  (`freeTierDispatchTickMs` / `freeTierDispatchMaxBatch` /
  `freeTierDispatchMaxInFlight`), the same ones Groq and Google reuse. No
  new pacing env family. With `LLM_MISTRAL_CONCURRENCY=1` serialising the
  queue, request volume stays under 1 RPS.
- `getStatus()` returns `{ active, startedAt }` only — no `callsToday` /
  budget fields (those were OpenRouter-specific).

### 6. Resume — self-rescheduling sweep

New `MistralRpdResumeService`
(`backend/src/modules/strategy/mistral-rpd-resume.service.ts`), a
**verbatim copy of `GroqRpdResumeService`**:

- `runResume(triggerJobId)` — `clearExpired()`, then re-dispatch every
  `StrategyRun` with `status = RATE_LIMITED_DAILY` and `strategyName =
  'llm-mistral'` whose `modelName` is no longer held (flip to `RUNNING`,
  re-queue on `llm-mistral-runs` with a `-resume-<triggerJobId>` job-id
  stamp so retried sweeps collapse instead of piling up).
- `rearm()` — schedule a delayed job on a new `mistral-rpd-resume` queue
  at `min(soonest live resetAt − now, REARM_MAX_DELAY_MS)` (15 min cap),
  the sole ongoing scheduler. When no holds are live the chain stops
  rescheduling until a fresh hit or dispatch tick starts one again.
- `MistralRpdResumeBootstrap` (`OnApplicationBootstrap`, skipped under
  `NODE_ENV=test`): one startup catch-up `runResume()`; the `rearm()`
  chain carries it from there. **No `upsertJobScheduler` cron.**
- New BullMQ queue `mistral-rpd-resume`
  (`backend/src/modules/queue/mistral-rpd-resume.queue.ts` +
  `MISTRAL_RPD_RESUME_QUEUE` token in `queue.module.ts`), worker handler
  in `backend/src/worker.ts` alongside `groq-rpd-resume`, passing its own
  `job.id` as `triggerJobId`.

### 7. Config

New environment variables, added to `.env.sample` / `env.ts` /
`docker-compose.yml` (backend + orchestrator services) / `README.md`,
mirroring the existing Groq entries where one exists:

- `MISTRAL_API_KEY` — used by `@ai-sdk/mistral` in the orchestrator.
- `MISTRAL_MODEL` — default Mistral model id for provider-less requests
  (`MODEL_PROVIDER=mistral`); also add `"mistral"` to `MODEL_PROVIDER`'s
  accepted values.
- `LLM_MISTRAL_CONCURRENCY` (default `1`) — worker concurrency for
  `llm-mistral-runs`. This is the 1-RPS guard; keep it at `1`.
- `LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS` (default `60`) — per-retry
  wait when a per-minute 429's `retry-after` header is absent.
- `MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS` (default `4`) — consecutive
  `rate_limited` outcomes on one run before the heuristic (§2b) parks the
  model.
- `MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS` (default `300`) — or the
  wall-clock span of the streak, whichever trips first.
- `MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` (default `21600`, 6h) — how long a
  parked model stays held before the resume sweep re-checks it.

`backend/src/strategies.ts` additions: `LLM_MISTRAL = "llm-mistral"`,
added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`; accessors
`llmMistralConcurrency()`, `llmMistralRateLimitFallbackSeconds()`,
`mistralPersistentRateLimitAttempts()`,
`mistralPersistentRateLimitElapsedMs()` (a `*_SECONDS` env read out as
milliseconds, like `openRouterDispatchRpmCooldownSeconds` inverts its
`*_MS` knob), and `mistralModelHoldFallbackSeconds()`. Each numeric
accessor follows the existing `positiveTrialCount` validation pattern with
a matching `DEFAULT_*` constant. `worker.ts` routes `llm-mistral-runs`
into the `all` / `cloud` roles (never `ollama`), same as `llm-groq-runs`,
and adds the `mistral-rpd-resume` and `mistral-free-dispatch` worker
handlers. The Bull Board queue list gains `llm-mistral-runs` (the repo has
a prior fix, `651c29c`, for a missing Groq queue there — do not repeat
it).

### 8. Model seeding

New migration `AddMistralModels<timestamp>`, same shape as
`1781000000000-add-groq-models.ts`:

```sql
INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
VALUES
  ('llm-mistral', 'mistral-small-latest',  true, 'mistralai/mistral-small-3.2-24b-instruct'),
  ('llm-mistral', 'ministral-8b-latest',   true, 'mistralai/ministral-8b-2512'),
  ('llm-mistral', 'ministral-3b-latest',   true, 'mistralai/ministral-3b-2512'),
  ('llm-mistral', 'mistral-medium-latest', true, 'mistralai/mistral-medium-3.1')
ON CONFLICT ("strategyName", "modelName") DO NOTHING
```

Mistral is **Groq-shaped**, not OpenRouter-shaped: `modelName` is
Mistral's own La Plateforme model id, and `openRouterSlug` is a *separate*
mapping into the OpenRouter catalog that `ModelMetadataRefreshService`
uses to backfill `contextWindow` / `releaseDate` / pricing. (OpenRouter's
own strategy set `modelName === openRouterSlug`; Mistral does not.)
`freeTier` stays `NULL` — Mistral is not part of either OpenAI tier.

**Why these four:**

| `modelName` | OpenRouter slug (metadata) | Context | Structured-output params |
|---|---|---|---|
| `mistral-small-latest` | `mistralai/mistral-small-3.2-24b-instruct` | 131K | `response_format`, `structured_outputs`, `tools` |
| `ministral-8b-latest` | `mistralai/ministral-8b-2512` | 262K | `response_format`, `structured_outputs`, `tools` |
| `ministral-3b-latest` | `mistralai/ministral-3b-2512` | 131K | `response_format`, `structured_outputs`, `tools` |
| `mistral-medium-latest` | `mistralai/mistral-medium-3.1` | 131K | `response_format`, `structured_outputs`, `tools` |

The four OpenRouter slugs were confirmed live against `GET
https://openrouter.ai/api/v1/models` as of this spec — all four advertise
`response_format` and `structured_outputs`, which the app's
`generateObject` solve prompts need. `mistralai/mistral-small-3.1-24b-instruct`
was checked and **excluded**: its catalog row advertises no
structured-output parameters, the same disqualifier the OpenRouter spec
applied to its tools-only near-misses.

The three small models sit in Mistral's small/standard free-tier pool;
`mistral-medium-latest` sits in the medium pool with its own separate TPM
and monthly allowance. Because the design keeps **no proactive budget**,
this pool split needs no code — per-model holds already isolate a
medium-pool wall from the small models, and vice versa.

**Confirm at implementation** (per the repo's never-guess-a-slug policy,
`1771000000000-backfill-openrouter-slugs.ts`): re-verify each
`*-latest` id against Mistral's live model list, and re-confirm each
OpenRouter slug (and its `response_format` support) against `GET
https://openrouter.ai/api/v1/models/{slug}/endpoints`. If a dated id is
preferred over `*-latest` for reproducibility, decide that at
implementation.

**Model-id URL audit:** OpenRouter slugs carry `/`; the repo has a prior
slash-encoding fix for leaderboard links (`d540f82`). Before seeding,
re-run that check for `mistralai/...`-style ids across leaderboard link
building, any backend route taking a model id as a path parameter, and
frontend `encodeURIComponent` coverage. (No `:` suffix here — that was
OpenRouter's `:free` concern only.)

### 9. Daily automation leg

`DailyAutomationService` gains `runMistralBurnLeg`, a **direct copy of
`runGroqBurnLeg`**: check `mistralFreeDispatchService.getStatus()`, record
`alreadyActive` if already running, otherwise `start()` and record
`started` or `alreadyExhausted`, catching and recording any thrown error.
Fired in `run()` after the existing OpenRouter leg, independently (no leg
blocks or is blocked by another). The service doc comment's leg list
becomes seven legs.

`AutomationRunLog` entity + migration gain `mistralBurnOutcome` /
`mistralBurnMessage` columns, same string shape as `groqBurnOutcome` /
`groqBurnMessage`. `AutomationController`'s `GET /automation/status`
assembly includes the Mistral leg's live status alongside the OpenRouter
leg's.

`dispatch.controller.ts` gains `GET /dispatch/mistral` (status) and
`DELETE /dispatch/mistral` (stop) — no `POST`, matching Google, Groq, and
OpenRouter's automation-only surface.

### 10. Frontend

- `MistralDispatchWidget.tsx`
  (`frontend/src/components/benchmark/MistralDispatchWidget.tsx`) — a
  **direct copy of `GroqDispatchWidget.tsx`** (same `bench-free-tier`
  styling, same 30s poll cadence, same active/inactive-only display, **no**
  "calls today / budget" line — that was OpenRouter-specific, and Mistral
  has no countable budget). Fed by a new
  `fetchMistralDispatchStatus` / `stopMistralDispatch` in
  `data/benchmark/api.ts` and a `MistralDispatchStatus` type in
  `data/benchmark/types.ts`.
- `AutomationStatus` / `AutomationLegDisplay` types, the automation api
  client, and `formatAutomationLine` extended to cover the `mistralBurn`
  leg, same pattern as `groqBurn`.
- Wired into the Activity page next to `GroqDispatchWidget` and
  `OpenRouterDispatchWidget`.
- No `StrategyRunStatus` display change — `RATE_LIMITED_DAILY` already
  renders ("Paused — daily quota") and is provider-agnostic; a Mistral run
  parked by it renders identically.

## Testing

TDD throughout, per the repo's normal workflow. New spec files mirror
their Groq-feature counterparts 1:1 unless noted.

### Orchestrator

- `solver.test.ts`:
  - a Mistral 429 whose body message names a monthly/quota exhaustion
    classifies as `rate_limited_daily` with `dailyResetSeconds` unset;
  - a Mistral 429 with a plain rate-limit body and a `Retry-After` header
    classifies as `rate_limited` with `retryAfterSeconds` from the header;
  - a Mistral 429 with an unreadable body and no `Retry-After` classifies
    as `rate_limited` with `retryAfterSeconds` undefined (does **not**
    fall through to `model_error`);
  - `mistralMonthlyRateLimitFromBody` returns `null` for a per-minute
    body, a malformed body, and an empty body, and never throws;
  - a non-Mistral provider's 429 is unaffected by the new branch.
- `provider.test.ts`: `getModel("mistral", ...)` and
  `getModelName("mistral", ...)` resolve as expected, including the
  `modelOverride` / `MISTRAL_MODEL` / `DEFAULT_MISTRAL_MODEL` fallback
  chain; `defaultProvider()` returns `"mistral"` for
  `MODEL_PROVIDER=mistral`.

### Backend

- `mistral-rate-limit-hold.service.spec.ts`: mirrors
  `groq-rate-limit-hold.service.spec.ts` — `hold` upserts with
  `resetAt = heldAt + resetInSeconds`, refreshing on re-hold; `isHeld`
  true only while live; `heldModels` / `nextResetAt` / `clearExpired`
  match Groq's test shapes. No timezone cases (there is no timezone
  logic).
- `llm-strategy-runner.service.spec.ts` — the novel coverage:
  - fewer than `MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS` consecutive
    Mistral `rate_limited` outcomes → each only sets `rateLimitWaitMs`, no
    failure recorded, no hold row written, run stays `RUNNING`;
  - reaching the attempt count → run flips to `RATE_LIMITED_DAILY` and one
    `MistralRateLimitHold` row is written with
    `resetAt ≈ now + MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`;
  - the elapsed-span trip: streak below the count but
    `now − rateLimitStreakStartedAt ≥ elapsed` → same park;
  - a successful call mid-streak resets the streak (a later single 429
    does not immediately re-park);
  - an orchestrator `rate_limited_daily` (body-classified) for
    `llm-mistral` writes the hold on the first hit, no streak needed;
  - never `StrategyRunStatus.ERROR` from a Mistral 429 streak regardless
    of repeat count;
  - top gate: a held model parks with zero orchestrator calls.
- `mistral-free-dispatch.service.spec.ts`: mirrors
  `groq-free-dispatch.service.spec.ts` — already-exhausted no-op
  (no models / every model held), runs-until-every-model-held dispatch
  loop, least-allocated-model batching, `FREE_TIER_DISPATCH_*` knobs
  honoured.
- Resume sweep (`mistral-rpd-resume` handler): mirrors the Groq
  resume-sweep test — two parked runs for model A (hold expired) and one
  for model B (hold live) → only A's runs resume; a rearm test confirming
  the next delayed job targets the soonest live `resetAt` across
  mixed-expiry holds.
- `daily-automation.service.spec.ts`: extends the leg-independence test
  with a `mistralBurn` leg — mocked `MistralFreeDispatchService`,
  asserting `started` / `alreadyActive` / `alreadyExhausted` / `error`
  outcomes are written to `AutomationRunLog`, and that a `mistralBurn`
  failure neither blocks nor is blocked by the other six legs.
- Queue resolution coverage: `LLM_MISTRAL_QUEUE`,
  `MISTRAL_FREE_DISPATCH_QUEUE`, `MISTRAL_RPD_RESUME_QUEUE` all resolve
  from `QueueModule`.

### Frontend

- `MistralDispatchWidget.test.tsx`, mirroring
  `GroqDispatchWidget.test.tsx`'s shape exactly (no calls-today
  assertion).

### Migration

Three new migrations (`MistralRateLimitHold` + `MistralDispatchState`
tables; the `mistralBurnOutcome` / `mistralBurnMessage` `AutomationRunLog`
columns; the model seed from §8). Per repo convention migrations are not
unit-tested; the up / down / up round-trip against a real database is a
manual verification pass once the branch has the dev DB to itself.

### Entity registration

Register `MistralRateLimitHold`, `MistralDispatchState`, and any other new
entity on the **root TypeORM connection** from the start — the repo has a
prior fix (`cdc2b01`) for Groq entities that were only registered on a
feature module's connection and failed to resolve under the worker's
runtime.

## Open questions for implementation planning

- Exact `@ai-sdk/mistral` API — `createMistral` signature, whether chat
  models are reached by calling the provider instance directly or via a
  method, current published version — confirm against its published
  docs/types when wiring `orchestrator/src/provider.ts`.
- Whether the default `classifyModelCallError` path already yields
  `rate_limited` for a bare 429 (so the Mistral branch only adds the
  body-message check and `retry-after` parsing) or whether the branch must
  construct the `rate_limited` result itself — confirm against the current
  `solver.ts`.
- Exact Mistral La Plateforme model ids for the four seeds (`*-latest`
  versus dated) and re-confirmation of their OpenRouter slugs and
  `response_format` support against `/api/v1/models/{slug}/endpoints`.
- Whether Mistral's monthly-cap 429 body and its per-minute 429 body
  differ enough for `mistralMonthlyRateLimitFromBody` to classify
  reliably — capture both against a real account. If they do not differ,
  the runner heuristic (§2b) carries the whole load; the design already
  accounts for this.
- Heuristic default values (`attempts = 4`, `elapsed = 300s`,
  `hold = 6h`) — tune after observing real behaviour on the dev account.
- The exact site in the run loop to reset `rateLimitStreak` on a
  successful call.
- Whether to gate the persistent-429 park (and/or the body-classified
  park) to automated runs only, so a manual trial hitting 1 RPS does not
  write a 6h account-visible hold (mirrors the OpenRouter spec's
  per-minute-cooldown gating question).
- Whether `mistral-medium-latest` should ship `supported = true` from the
  seed or start `supported = false` pending a `generateObject`
  reliability check, the way `minimaxai/minimax-m2.7` was held back for
  Groq.
