# Groq free-tier support — design

## Problem

The app already runs three LLM strategies — `llm-openai`, `llm-ollama`,
`llm-google` — each dispatched against `SupportedModel` rows and, for the
two cloud providers, backed by a free-usage program that keeps trials
flowing without a human re-triggering dispatch every day:

- **OpenAI flagship/mini tiers** (`FreeTierUsageService` +
  `FreeTierDispatchService`) — a shared per-tier *token* budget, reset at
  UTC midnight, burned down by dispatching trials until a caller-chosen
  percentage of the daily allowance is spent.
- **Google AI Studio** (`GoogleRateLimitHoldService` +
  `GoogleFreeDispatchService` + `GoogleRpdResumeService`) — no shared token
  budget; Google enforces a *per-model* requests-per-day (RPD) cap. A 429
  carrying a per-day `QuotaFailure` parks that one model's runs
  (`StrategyRunStatus.RATE_LIMITED_DAILY`) until the next
  `America/Los_Angeles` midnight, when a cron sweep un-parks them. A
  separate per-minute (RPM) 429 is not a failure at all — the run waits the
  server-specified delay and retries.
- Both are wired into `DailyAutomationService`, which fires a judge leg, a
  mini-tier burn leg, and a Google burn leg once a day (00:15 UTC) and
  records each leg's outcome to `AutomationRunLog` for the Activity page.

Groq's free tier (confirmed live against Groq's own rate-limits and
models documentation as of this spec) shapes closer to Google's than
OpenAI's: **per-model** RPM + RPD caps (plus TPM/TPD caps that this design
treats as folding into the same two buckets — see Design §1), not a
shared cross-model token budget. There is no existing way to dispatch
`llm-groq` trials, no Groq provider in the orchestrator, and no Groq rows
in `SupportedModel`.

## Goals

- Add a `llm-groq` strategy, dispatched the same way `llm-openai` /
  `llm-google` are (`StrategyService.triggerStrategyRuns`,
  `SupportedModel` rows, its own worker queue and concurrency knob).
- Classify a Groq 429 into a per-minute retry (no failure recorded, wait
  and retry) or a per-model daily park
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, reusing the status Google
  already introduced — it is provider-agnostic today), using Groq's own
  rate-limit response headers rather than string-matching an error body.
- Automatically resume a parked model once its own daily window resets,
  without depending on a shared fixed reset time the way Google's
  Pacific-midnight cron does — Groq gives each 429 its own reset
  countdown, not a fixed clock boundary.
- A `GroqFreeDispatchService` that proactively burns the free daily
  allowance across configured Groq models, mirroring
  `GoogleFreeDispatchService` exactly (dispatch until every model is
  held or the unrun-puzzle backlog is empty).
- A `groqBurn` leg in the daily automation chain, alongside `judge`,
  `miniBurn`, and `googleBurn`.
- Seed four confirmed free-tier chat models: `openai/gpt-oss-120b`,
  `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`.

## Non-goals

- No shared token-budget tier for Groq (`FreeTierUsageService`'s model
  does not fit its per-model RPD/RPM shape — see Problem).
- No manual "start" endpoint for Groq dispatch — mirrors Google, which is
  automation-only (`GET`/`DELETE` status/stop, no `POST`).
- No seeding of Groq's audio (`whisper-*`), TTS (`canopylabs/orpheus-*`),
  classifier (`meta-llama/llama-prompt-guard-2-*`,
  `openai/gpt-oss-safeguard-20b`), or tool-calling agent
  (`groq/compound`, `groq/compound-mini`) models — none produce plain
  structured solve output the way this app's `generateObject` prompts
  need. Also excluded: `minimaxai/minimax-m2.7`, which has no confirmed
  free-tier rate-limit row in Groq's own documentation as of this spec.
- No change to `llm-openai` / `llm-ollama` / `llm-google` behavior beyond
  the couple of spots that currently hardcode `LLM_GOOGLE` alongside a
  provider-agnostic status or code (see Design §2, §3).
- No admin UI for inspecting/clearing `GroqRateLimitHold` rows by hand —
  same as Google, direct database access covers it.

## Design

### 1. Detecting the daily hit — orchestrator, header-based

Groq's 429 responses carry rate-limit state directly as headers, on
every request, unlike Google's structured-but-buried
`google.rpc.Status` error-body detail array:

| Header | Meaning |
|---|---|
| `x-ratelimit-remaining-requests` | Requests left today (RPD bucket) |
| `x-ratelimit-reset-requests` | Duration until the RPD bucket resets (e.g. `"2h59m59.56s"`) |
| `x-ratelimit-remaining-tokens` | Tokens left this minute (TPM bucket) |
| `x-ratelimit-reset-tokens` | Duration until the TPM bucket resets |
| `retry-after` | Seconds to wait, present only on a 429 |

`orchestrator/src/solver.ts` gains a Groq branch in
`classifyModelCallError`, parallel to the existing Google branch:

- When `provider === "groq"` and the error is an `APICallError` with
  `statusCode === 429`: read `err.responseHeaders` (already captured
  into `apiDetails` for every provider).
  - `x-ratelimit-remaining-requests === "0"` → the RPD bucket is
    exhausted for this model today. Return
    `new SolveError("rate_limited_daily", ..., { ...apiDetails,
    dailyResetSeconds })`, where `dailyResetSeconds` is parsed from
    `x-ratelimit-reset-requests` (falling back to `retry-after` if that
    header is missing or unparseable, and to `undefined` — the backend
    then falls back to a config constant — if neither parses).
  - Otherwise (any other 429 — a per-minute RPM/TPM hit) → return
    `new SolveError("rate_limited", ..., { ...apiDetails,
    retryAfterSeconds })`, parsed from `retry-after` (falling back to
    `x-ratelimit-reset-tokens`). This is the same `"rate_limited"` code
    and the same `retryAfterSeconds` field Google's per-minute path
    already uses — the runner's wait-and-retry logic
    (`state.rateLimitWaitMs`) is already provider-agnostic and needs no
    change.
  - A duration string like `"2h59m59.56s"` needs a small parser (Groq
    mirrors OpenAI's rate-limit header duration format). Implemented
    once and shared if `x-ratelimit-reset-tokens` parsing also needs it.
- A header-based classification has no failure mode symmetric to
  Google's "unparseable body → falls through to `model_error`" case
  *for the values it reads directly* (the headers are either present
  with a number or absent) — but their absence entirely (a malformed or
  proxy-mangled response) still falls through to `model_error`
  unchanged, same as today.
- No new `SolveErrorCode` value — `"rate_limited"` and
  `"rate_limited_daily"` already exist and are provider-agnostic in the
  runner (see §3). `SolveErrorDetails` gains one new optional field,
  `dailyResetSeconds`, alongside the existing `retryAfterSeconds`.

`orchestrator/src/provider.ts`:

- `ModelProvider` gains `"groq"`.
- `DEFAULT_GROQ_MODEL` constant (one of the four seeded models —
  `openai/gpt-oss-20b`, matching the "small/cheap default" role
  `DEFAULT_OPENAI_MODEL`/`DEFAULT_GOOGLE_MODEL` play for their
  providers).
- `getModel()` gains a `"groq"` branch using `@ai-sdk/groq`'s
  `createGroq({ apiKey: process.env.GROQ_API_KEY })` (new orchestrator
  dependency — confirm the exact package name/API against its current
  published version when implementing).
- `getModelName()` gains the matching `"groq"` branch
  (`modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL`).
- `effectiveContextWindow()` needs no Groq branch — like Google, Groq
  has no per-call context-window setting; the existing
  `provider !== "ollama"` passthrough already covers it.

### 2. Hold state — Postgres entity and service

New entity `GroqRateLimitHold`
(`backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts`),
same shape as `GoogleRateLimitHold`:

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `strategyName` | `text` | Always `'llm-groq'` today. |
| `modelName` | `text` | The model that hit its RPD. |
| `heldAt` | `timestamptz` | When the hold was recorded. |
| `resetAt` | `timestamptz` | `heldAt + dailyResetSeconds` (or the fallback constant — see §7 — when the orchestrator couldn't parse a reset duration). |

Unique constraint on `(strategyName, modelName)`, same idempotent-upsert
behavior as Google's.

New `GroqRateLimitHoldService`
(`backend/src/modules/strategy/groq-rate-limit-hold.service.ts`) —
**simpler than `GoogleRateLimitHoldService`**: no timezone math at all,
because Groq's reset is a duration from the moment of the hit, not a
fixed daily clock boundary.

- `hold(strategyName, modelName, resetInSeconds: number)` — upsert with
  `resetAt = new Date(Date.now() + resetInSeconds * 1000)`.
- `isHeld(strategyName, modelName): Promise<boolean>` — identical to
  Google's.
- `heldModels(strategyName): Promise<string[]>` — identical.
- `nextResetAt(strategyName): Promise<Date | null>` — identical (the
  soonest still-future `resetAt` across live holds); needed here for
  the resume sweep's self-rescheduling (§4), where for Google it was
  only a fallback path.
- `clearExpired(): Promise<string[]>` — identical.

### 3. Runner behavior

`backend/src/modules/strategy/llm-strategy-runner.service.ts`:

- Provider resolution: `strategyName === LLM_OLLAMA ? "ollama" :
  strategyName === LLM_GOOGLE ? "google" : strategyName === LLM_GROQ ?
  "groq" : "openai"`.
- Inject `GroqRateLimitHoldService` alongside `GoogleRateLimitHoldService`.
- **Top gate**, extended: `(strategyName === LLM_GOOGLE &&
  await googleHold.isHeld(...)) || (strategyName === LLM_GROQ &&
  await groqHold.isHeld(...))` — same park-immediately behavior.
- **On the hit**: the existing `outcome.error.code ===
  "rate_limited_daily"` branch extends its provider check from
  `strategyName === LLM_GOOGLE` to `strategyName === LLM_GOOGLE ||
  strategyName === LLM_GROQ`, and calls the matching hold service. For
  Groq, `groqHold.hold(strategyName, model, outcome.error.details
  .dailyResetSeconds ?? llmGroqRateLimitFallbackSeconds())`.
- `classifyFailedCall`'s `rate_limited_daily` branch is already
  provider-agnostic (parks the run, touches no counter) — no change
  needed there.
- The per-minute `rate_limited` branch (`state.rateLimitWaitMs =
  (retryAfterSeconds ?? llmGoogleRateLimitFallbackSeconds()) * 1000`)
  currently falls back to a Google-named constant regardless of
  provider. `classifyFailedCall` gains a `provider` parameter so it can
  pick the matching fallback: `llmGoogleRateLimitFallbackSeconds()`
  stays exactly as-is for Google, and a new, separate
  `llmGroqRateLimitFallbackSeconds()` (§7) is used when `provider ===
  "groq"` — Google's constant is never touched or reused for Groq.

### 4. Dispatch — `GroqFreeDispatchService`

New service `GroqFreeDispatchService`
(`backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts`),
a near-verbatim copy of `GoogleFreeDispatchService`
(`start`/`stop`/`getStatus`/`runTick`, self-rescheduling tick chain,
least-allocated-model batching, `findUnrunPuzzleDatesForModel` /
`triggerStrategyRuns` / `countInFlightByModel` calls against
`LLM_GROQ`), backed by a new `GroqDispatchState` entity (mirrors
`GoogleDispatchState`: `id`/`active`/`startedAt`, single fixed-id row).
Reuses the same `FREE_TIER_DISPATCH_*` pacing knobs Google reuses
(tick interval, max batch, max in-flight) — no new pacing env family.

### 5. Resume — self-rescheduling, not a fixed cron

Google's resume sweep runs on a fixed `America/Los_Angeles`
00:01 cron because every Google hold shares the same daily reset
clock. Groq holds do not share a clock — each one's `resetAt` is
`heldAt + <that hit's own reset duration>`, so a fixed-time cron has
nothing meaningful to align to.

New `GroqRpdResumeService`
(`backend/src/modules/strategy/groq-rpd-resume.service.ts`), same
`runResume()` shape as `GoogleRpdResumeService` (clear expired holds,
re-dispatch every `RATE_LIMITED_DAILY` `llm-groq` run whose model is no
longer held), but the **rearm-on-soonest-reset behavior that Google
uses only as a fallback becomes the sole scheduling mechanism here**:

- `GroqRpdResumeBootstrap` (`OnApplicationBootstrap`), skipped under
  `NODE_ENV=test`: runs `runResume()` once at startup (catches anything
  that expired while the process was down) and relies on `runResume`'s
  own `rearm()` call to keep the chain alive afterward — no
  `upsertJobScheduler` cron pattern at all.
- `rearm()` is identical in shape to Google's: schedules a delayed job
  on a new `groq-rpd-resume` queue at `min(soonest live resetAt −
  now, REARM_MAX_DELAY_MS)`, capped the same way, so a hold with a
  distant `resetAt` still gets re-checked periodically rather than
  waiting the full duration in one jump. When no holds are live, the
  chain simply stops rescheduling itself until the next hold (from a
  fresh daily-hit) or dispatch tick starts one again — there being no
  live holds means there's nothing to resume, so an idle chain costs
  nothing.
- New BullMQ queue `groq-rpd-resume`
  (`backend/src/modules/queue/groq-rpd-resume.queue.ts` +
  `GROQ_RPD_RESUME_QUEUE` token in `queue.module.ts`), worker handler
  in `backend/src/worker.ts` alongside `google-rpd-resume`.

### 6. Model seeding

New migration `AddGroqModels<timestamp>`, same shape as
`1774000000000-add-google-models.ts`:

```sql
INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
VALUES
  ('llm-groq', 'openai/gpt-oss-120b', true, NULL),
  ('llm-groq', 'openai/gpt-oss-20b', true, NULL),
  ('llm-groq', 'qwen/qwen3.6-27b', true, NULL),
  ('llm-groq', 'qwen/qwen3.8-27b', true, NULL)
ON CONFLICT ("strategyName", "modelName") DO NOTHING
```

`openRouterSlug` is left `NULL` at migration-authoring time — per this
repo's established policy (`1771000000000-backfill-openrouter-slugs.ts`),
a slug is only ever set once confirmed live against `GET
https://openrouter.ai/api/v1/models/{slug}/endpoints`. Confirming the
correct slug for each of these four models (OpenRouter may list a Groq-
hosted model under a different provider prefix than `groq/`) is
implementation-time work, not part of this design. `freeTier` stays
`NULL` for all four rows — Groq is not part of either OpenAI tier.
`contextWindow`/`paramCount`/pricing backfill from the next
`ModelMetadataRefreshService` run once slugs are set, same as Google's
rows.

### 7. Config

New environment variables, added to `.env.sample` / `env.ts` /
`docker-compose.yml` (backend + orchestrator services) / `README.md`,
mirroring the existing Google entries:

- `GROQ_API_KEY` — used by `@ai-sdk/groq` in the orchestrator.
- `GROQ_MODEL` — default Groq model id for provider-less requests
  (`MODEL_PROVIDER=groq`); also add `"groq"` to `MODEL_PROVIDER`'s
  accepted values.
- `LLM_GROQ_CONCURRENCY` (default `1`) — worker concurrency for
  `llm-groq-runs`, alongside `LLM_OPENAI_CONCURRENCY` /
  `LLM_OLLAMA_CONCURRENCY` / `LLM_GOOGLE_CONCURRENCY`.
- `LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS` (default `60`, matching
  Google's default) — used only when a per-minute 429's `retry-after`
  and `x-ratelimit-reset-tokens` are both absent/unparseable.
- A daily-hold fallback constant (e.g.
  `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS`, a generous value like
  24 hours) for the rare case where `dailyResetSeconds` couldn't be
  parsed from either rate-limit header — this has no Google equivalent
  (Google's daily reset is always computable from the fixed Pacific
  clock; Groq's depends on a header that could theoretically be
  missing).

`backend/src/strategies.ts` additions: `LLM_GROQ = "llm-groq"`, added to
`SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`; `llmGroqConcurrency()`;
`llmGroqRateLimitFallbackSeconds()`. `worker.ts` routes
`llm-groq-runs` into the `all`/`cloud` roles (never `ollama`), same as
`llm-google-runs`.

### 8. Daily automation leg

`DailyAutomationService` gains `runGroqBurnLeg`, a direct copy of
`runGoogleBurnLeg`: check `groqFreeDispatchService.getStatus()`, record
`alreadyActive` if already running, otherwise `start()` and record
`started` or `alreadyExhausted`, catching and recording any thrown
error — fired in `run()` after the existing three legs, independently
(no leg blocks or is blocked by another, per the existing kickoff-order
design).

`AutomationRunLog` entity + migration gain `groqBurnOutcome` /
`groqBurnMessage` columns, same enum-ish string shape as
`googleBurnOutcome`/`googleBurnMessage`. `AutomationController`'s `GET
/automation/status` assembly includes the Groq leg's live status
alongside the Google leg's.

`dispatch.controller.ts` gains `GET /dispatch/groq` (status) and
`DELETE /dispatch/groq` (stop) — no `POST`, matching Google's
automation-only surface.

### 9. Frontend

- `GroqDispatchWidget.tsx`
  (`frontend/src/components/benchmark/GroqDispatchWidget.tsx`) — a
  direct copy of `GoogleDispatchWidget.tsx` (same `bench-free-tier`
  styling, same 30s poll cadence, same active/inactive-only display —
  no token-budget progress bar, matching Google's "no shared budget"
  shape), fed by a new `fetchGroqDispatchStatus`/`stopGroqDispatch` in
  `data/benchmark/api.ts` and a `GroqDispatchStatus` type in
  `data/benchmark/types.ts`.
- `AutomationStatus`/`AutomationLegDisplay` types, the automation api
  client, and `formatAutomationLine` extended to cover the `groqBurn`
  leg, same pattern as `googleBurn`.
- Wired into the Activity page next to `GoogleDispatchWidget`.
- No `StrategyRunStatus` display change needed — `RATE_LIMITED_DAILY`
  already has a label ("Paused — daily quota") from the Google feature,
  and it is provider-agnostic; a Groq run parked by this status renders
  identically.

## Testing

TDD throughout, per the repo's normal workflow. New spec files mirror
their Google-feature counterparts 1:1 unless noted:

### Orchestrator

- `solver.test.ts`: a Groq 429 with `x-ratelimit-remaining-requests:
  "0"` classifies as `rate_limited_daily` with `dailyResetSeconds`
  parsed from `x-ratelimit-reset-requests`; a Groq 429 with nonzero
  remaining requests classifies as `rate_limited` with
  `retryAfterSeconds` parsed from `retry-after`; a Groq 429 with no
  parseable headers at all falls through to `model_error` without
  throwing; a non-Groq provider's 429 is unaffected by the new branch.
- `provider.test.ts`: `getModel("groq", ...)` and
  `getModelName("groq", ...)` resolve as expected, including the
  `modelOverride` / `GROQ_MODEL` / `DEFAULT_GROQ_MODEL` fallback chain.

### Backend

- `groq-rate-limit-hold.service.spec.ts`: `hold` upserts with
  `resetAt = heldAt + resetInSeconds`, refreshing on re-hold; `isHeld`
  true only while live; `heldModels`/`nextResetAt`/`clearExpired`
  match `GoogleRateLimitHoldService`'s test shapes with no timezone
  cases (there is no DST/timezone logic to test here).
- `llm-strategy-runner.service.spec.ts`: extends the existing Google
  `rate_limited_daily` test block with an `llm-groq` variant — top
  gate parks with zero orchestrator calls when held; a daily hit
  writes a `GroqRateLimitHold` row using `dailyResetSeconds` (and
  falls back to the configured constant when that field is absent);
  never produces `StrategyRunStatus.ERROR` regardless of repeat count.
- `groq-free-dispatch.service.spec.ts`: same shape as
  `google-free-dispatch.service.spec.ts` — already-exhausted no-op,
  runs-until-held dispatch loop, least-allocated-model batching.
- Resume sweep (`groq-rpd-resume` handler): same shape as the Google
  resume-sweep test — two parked runs for model A (hold expired) and
  one for model B (hold live) → only A's runs resume; plus a rearm
  test confirming the next delayed job targets the soonest live
  `resetAt` across mixed-duration holds (Google's rearm test only ever
  exercises this as a fallback path — here it's the primary path, so
  covering multiple simultaneously-live holds with different reset
  times is the interesting new case).
- `daily-automation.service.spec.ts`: extends the existing leg-
  independence test with a `groqBurn` leg — mocked
  `GroqFreeDispatchService`, asserting the same
  started/alreadyActive/alreadyExhausted/error outcomes get written to
  `AutomationRunLog`, and that a `groqBurn` failure doesn't block or
  get blocked by the other three legs.
- `queue.module.spec.ts`-equivalent coverage: `LLM_GROQ_QUEUE`,
  `GROQ_FREE_DISPATCH_QUEUE`, `GROQ_RPD_RESUME_QUEUE` all resolve.

### Frontend

- `GroqDispatchWidget.test.tsx`, mirroring
  `GoogleDispatchWidget.test.tsx`'s shape exactly.

### Migration

Two new migrations (`GroqRateLimitHold` + `GroqDispatchState` tables,
and the `groqBurnOutcome`/`groqBurnMessage` `AutomationRunLog`
columns) plus the model-seed migration from §6. Per repo convention,
migrations are not unit-tested; the up/down/up round-trip against a
real database is a manual verification pass once the branch has the
dev DB to itself.

## Open questions for implementation planning

- Exact `@ai-sdk/groq` package API (`createGroq` signature, current
  published version) — confirm against its published docs/types when
  wiring `orchestrator/src/provider.ts`, the same way this spec avoided
  guessing OpenRouter slugs.
- Exact format of `x-ratelimit-reset-requests`/`x-ratelimit-reset-tokens`
  (assumed to mirror OpenAI's `"2h59m59.56s"`-style duration string,
  based on Groq's documented header-naming parallel to OpenAI's own
  rate-limit headers) — confirm against a real captured 429 response
  before finalizing the duration parser, per this repo's
  never-guess-a-response-shape policy already applied to the Google
  RPM/RPD parsing.
- Whether Groq's TPD (tokens-per-day) cap — binding for the two
  `gpt-oss` models with 200K TPD alongside a 1K RPD — ever manifests
  as a *distinct* signal from the RPD headers this design reads, or
  whether it always co-occurs with (or is masked by) an RPD-shaped
  429 in practice. Groq's own header documentation states
  `x-ratelimit-*-requests` "always" means RPD and `x-ratelimit-*-tokens`
  "always" means TPM, with no dedicated TPD header — so a pure TPD
  violation (heavy per-call token usage without exhausting the request
  count) would currently be classified as a per-minute `rate_limited`
  retry rather than a daily park. This is treated as an accepted gap
  for v1 (single Connections-solve prompts are token-light relative to
  200K/day), to be revisited if it causes observed retry-loop behavior
  in practice.
- `minimaxai/minimax-m2.7` and Groq's `groq/compound*` systems can be
  reconsidered for a future pass once free-tier rate limits/behavior
  are confirmed for them.
