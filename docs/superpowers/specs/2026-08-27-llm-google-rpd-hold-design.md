# LLM Google requests-per-day (RPD) hold — design

## Problem

Google AI Studio's free tier enforces several quota dimensions. Per-minute
hits (RPM / TPM) are already handled well: `parseGoogleRateLimit` in
`orchestrator/src/solver.ts` recognizes a `QuotaFailure` violation whose
`quotaId` contains `"PerMinute"`, `classifyModelCallError` returns a
`rate_limited` `SolveError` carrying the server's `RetryInfo.retryDelay`,
and `LlmStrategyRunner`'s loop waits that long and retries the identical
request without counting the hit against any failure threshold (PR #13,
merged).

The per-day case (RPD) is not handled. `parseGoogleRateLimit` returns
`null` for a `"PerDay"` violation, so `classifyModelCallError` falls
through to the generic `model_error` code. In the runner that increments
`consecutiveModelErrors` and ends the run with
`StrategyRunStatus.ERROR` once `LLM_MAX_MODEL_ERRORS` consecutive hits
accumulate. Worse, nothing tells the rest of the queue that the model is
out of daily quota: every other `llm-google` job for that model keeps
getting pulled from `llm-google-runs` and makes its own doomed call,
each producing a quota-denied 429 and counting toward that run's own
`ERROR`. A single exhausted model turns the remaining queue into a run of
guaranteed failures until midnight Pacific, when Google's daily quota
resets.

Google's free-tier RPD is enforced per model per project. A live spike
against a real key (see the per-minute feature's design spec for the
captured 429 body) confirmed the `google.rpc.Status` error shape;
Google's docs describe the daily bucket as `quota_exceeded` with a
`"PerDay"`-style `quotaId`, mirroring the confirmed `"PerMinute"` naming
for the RPM case.

## Goals

- A per-day quota hit for one `llm-google` model places that model on a
  hold: no further `llm-google` runs for that model make a Google call
  until the hold clears.
- The hold is scoped to the single model that hit its RPD. Other
  `llm-google` models with quota remaining keep processing normally.
- The hold clears automatically at the next midnight in
  `America/Los_Angeles` (DST-aware), when Google's daily quota resets,
  and every run parked by the hold resumes from where it left off.
- A run that hits RPD mid-solve is recorded with a distinct, non-error
  status so it does not pollute failure metrics, and it resumes rather
  than restarts.
- Runs already queued for a held model when the hold engages cost at most
  one cheap database read each — not a Google call.

## Non-goals

- No proactive request counting against a configured per-model RPD
  number. Detection is reactive: the hold engages the first time Google
  actually returns a per-day 429 for that model on a given day. One or a
  few doomed calls per model per day slip through before the hold
  engages; that is accepted.
- No change to the per-minute `rate_limited` path.
- No equivalent handling for `llm-openai` / `llm-ollama`. OpenAI's
  rate-limit signaling is shaped differently; extending this is a
  separate effort if ever needed.
- No hold for the provider-less AI Assist path (`/diagnose`). This
  covers dispatched `llm-google` strategy runs only.
- No admin UI to inspect or clear holds by hand. The `GoogleRateLimitHold`
  rows are visible through the ordinary database; a stuck hold can be
  deleted directly.

## Design

### 1. Detect the daily hit — orchestrator

`orchestrator/src/solver.ts`:

- Add a sibling to `parseGoogleRateLimit` (or a second return channel from
  a shared helper) that recognizes a `QuotaFailure` violation whose
  `quotaId` or `quotaMetric` contains `"PerDay"`. It takes the same
  `responseBody` string, never throws, and returns a boolean-ish signal
  ("this is a per-day quota violation"). No `RetryInfo` parsing — the
  daily reset time is not carried in `retryDelay` and is computed
  backend-side.
- `classifyModelCallError`: when `provider === "google"` and the error is
  an `APICallError` with `statusCode === 429`, check per-minute first
  (unchanged), then per-day. A per-day match returns
  `new SolveError("rate_limited_daily", ...)` with the existing
  `apiDetails` spread (`requestBody`, `statusCode`, `responseHeaders`,
  `responseBody`, `isRetryable`, `errorName`) but no `retryAfterSeconds`.
  Anything else still falls through to `model_error`.

`orchestrator/src/types.ts`: `SolveErrorCodeSchema` gains
`"rate_limited_daily"`.

`orchestrator/src/app.ts`: `ERROR_STATUS` gains `rate_limited_daily: 429`.
No other change — `err.details` is already spread wholesale into the
error response.

### 2. Carry the code into the backend

`backend/src/modules/strategy/orchestrator.service.ts`:

- `SolveErrorCode` union gains `"rate_limited_daily"`.
- `isKnownErrorCode` gains the same value, so the code survives the
  `executeCall` mapping instead of being coerced to `model_error`.
- No new `extractCallDetail` key — the daily hit carries no
  `retryAfterSeconds`.

### 3. Hold state — Postgres entity and service

New entity `GoogleRateLimitHold`
(`backend/src/modules/strategy/entities/google-rate-limit-hold.entity.ts`):

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `strategyName` | `text` | Always `'llm-google'` today; kept explicit so the table is not provider-locked. |
| `modelName` | `text` | The model that hit its RPD. |
| `heldAt` | `timestamptz` | When the hold was recorded. |
| `resetAt` | `timestamptz` | The next `America/Los_Angeles` midnight (exact). The one-minute guard against racing Google's own reset lives in the sweep's cron time, not here — see 6. |

Unique constraint on `(strategyName, modelName)` — one live hold per
model. Re-hitting RPD for a model already held is an idempotent upsert
that refreshes `heldAt` / `resetAt`.

New `GoogleRateLimitHoldService`
(`backend/src/modules/strategy/google-rate-limit-hold.service.ts`):

- `hold(strategyName, modelName)` — upsert a row with
  `resetAt = nextPacificMidnight()`.
- `isHeld(strategyName, modelName): Promise<boolean>` — true when a row
  exists with `resetAt > now()`.
- `clearExpired(): Promise<string[]>` — delete rows with
  `resetAt <= now()`, returning the `modelName`s cleared (used by the
  resume sweep for logging).
- `nextPacificMidnight()` — the next `00:00` in `America/Los_Angeles` as
  a UTC `Date`. Computed with `Intl.DateTimeFormat` parts against the
  `America/Los_Angeles` time zone; no date library is added (the backend
  has none today). DST-aware because `Intl` resolves the zone's offset
  for the target date.

### 4. New run status

`backend/src/modules/strategy/entities/strategy-run.entity.ts`:

- `StrategyRunStatus.RATE_LIMITED_DAILY = "rateLimitedDaily"`.
- **Not** added to `TERMINAL_STATUSES`. `StrategyRunStore.loadOrCreateRun`
  treats a non-terminal run as resumable and rebuilds loop state from
  flushed guesses, so a re-dispatched job continues the same run.

### 5. Runner behavior

`backend/src/modules/strategy/llm-strategy-runner.service.ts`:

- Inject `GoogleRateLimitHoldService`.
- **Top gate.** Immediately after `loadOrCreateRun`, before the first
  orchestrator call: if `strategyName === LLM_GOOGLE`, the run is not
  terminal, and `holdService.isHeld(strategyName, model)` is true, set
  `run.status = RATE_LIMITED_DAILY`, `run.finishedAt = new Date()`, save
  via the store, and return `{ status, guessCount }`. This is what makes
  an already-queued job for a held model cost one indexed read instead of
  a Google call. A run with no `model` (should not happen for
  `llm-google`, which always dispatches with one) skips the gate.
- **On the hit.** In the failed-call branch of the loop, when
  `outcome.error.code === "rate_limited_daily"`:
  `await holdService.hold(strategyName, model)`, set
  `run.status = RATE_LIMITED_DAILY` and `run.finishedAt = new Date()`,
  flush, and break. `classifyFailedCall` gains a `rate_limited_daily`
  branch that does nothing — no counter touched, no status set there —
  so the existing "at most one of rateLimitWaitMs / model-error backoff"
  post-flush wait logic is unaffected (neither fires for this code).
  The hold write and status change live in the loop body where `await`
  and the `model` variable are in scope, matching how the per-minute
  path keeps `classifyFailedCall` pure.
- `LlmRunLoopState` needs no new field.

Runs already mid-flight on other models are untouched. A large manual
`llm-google` bulk dispatch issued while a model is held simply produces a
pile of `RATE_LIMITED_DAILY` runs for that model, all of which the sweep
revives together at reset — the intended behavior.

### 6. Resume — dedicated midnight-Pacific sweep

New BullMQ queue `google-rpd-resume`:

- `backend/src/modules/queue/google-rpd-resume.queue.ts` — the `Queue`
  instance, same `defaultJobOptions` shape as the sibling queues.
- `backend/src/modules/queue/queue.module.ts` — `GOOGLE_RPD_RESUME_QUEUE`
  provider/export token, alongside the existing ones.

New `GoogleRpdResumeBootstrap`
(`backend/src/modules/strategy/google-rpd-resume.bootstrap.ts`),
`OnApplicationBootstrap`, modeled on `PuzzleQueueBootstrap`:

- Skips scheduling entirely when `process.env.NODE_ENV === "test"`.
- `queue.upsertJobScheduler("google-rpd-resume",
  { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
  { name: "resume-google-rpd", data: {}, opts: { removeOnComplete: true,
  removeOnFail: 50, attempts: 5, backoff: { type: "exponential",
  delay: 30000 } } })`. `upsertJobScheduler` is idempotent across
  restarts and processes.
- The cron fires at `00:01` Pacific, not `00:00`. That one-minute offset
  is the guard against racing Google's own reset clock: by the time the
  sweep runs, every hold whose `resetAt` was the just-passed midnight is
  a full minute expired, so `clearExpired` clears it and the day's
  quota is definitely live again. `resetAt` itself stays exact midnight
  (see 3). Alternative considered and rejected: fire at `00:00` and add
  60 s to `resetAt` instead — then the sweep would see not-yet-expired
  holds and would need to re-arm a short delayed job to finish the
  resume, which is more moving parts for the same one-minute wait.

Worker handler for `google-rpd-resume` (`backend/src/worker.ts`, in the
`role !== "ollama"` branch alongside the other cloud queues):

1. `const cleared = await holdService.clearExpired()`.
2. Find every `StrategyRun` with `status = RATE_LIMITED_DAILY` and
   `strategyName = 'llm-google'` whose `modelName` is not currently held
   (re-check `isHeld` per distinct model, or filter against the set of
   still-held models in one query). For each: set `status = RUNNING`,
   save, and re-enqueue through `queueForStrategy(...)` with
   `runStrategyJobId(puzzleId, strategyName, trialNumber)` as the job id
   (deterministic id collapses any duplicate).
3. Log `cleared` and the number of runs re-dispatched.

The runner resumes each re-dispatched job from its flushed guesses. If a
model is somehow still rate-limited after reset (misconfigured key, quota
spent elsewhere), the resumed run's first call hits RPD again and re-arms
the hold through the normal path — no special handling.

### 7. Frontend

The new status needs a display label wherever run status is switched on:

- `frontend/src/data/benchmark/runStatus.ts` — status → label / tone
  mapping.
- Any run-history / run-detail / leaderboard component or formatter that
  enumerates `StrategyRunStatus` values.

Label: "Paused — daily quota" (or the codebase's established
short-label style). Treated visually like an in-progress state, not a
failure. No other frontend change — model lists and leaderboard rows are
status-agnostic.

### 8. Config

No new environment variables. The reset time is fixed to
`America/Los_Angeles` (Google AI Studio's documented free-tier reset
zone) rather than made configurable; if that ever needs to move it can
become an env var then.

## Testing

TDD throughout, per the repo's normal workflow.

### Orchestrator

- `solver.test.ts`: a real captured `"PerMinute"` body still classifies
  as `rate_limited` with `retryAfterSeconds`; a `"PerDay"` body
  classifies as `rate_limited_daily` with no `retryAfterSeconds`; a body
  with neither, an unparseable body, and a non-Google provider's 429 all
  still classify as `model_error` without throwing.
- `app.test.ts`: a `rate_limited_daily` `SolveError` round-trips as HTTP
  429 with `code: "rate_limited_daily"` in the body.

### Backend

- `orchestrator.service.spec.ts`: an orchestrator 429 response with
  `code: "rate_limited_daily"` is surfaced as that code (not coerced to
  `model_error`).
- `google-rate-limit-hold.service.spec.ts`: `hold` upserts one row per
  `(strategyName, modelName)` and refreshes `resetAt` on re-hold;
  `isHeld` is true only while `resetAt > now`; `clearExpired` deletes
  only expired rows and returns their model names;
  `nextPacificMidnight()` lands on `00:00` Pacific for a date in PST
  (UTC-8) and for a date in PDT (UTC-7), expressed correctly in UTC,
  including the day either side of a DST transition.
- `llm-strategy-runner.service.spec.ts`:
  - A `rate_limited_daily` failure leaves `consecutiveModelErrors`,
    `duplicateCount`, `malformedCount` at 0, sets
    `run.status = RATE_LIMITED_DAILY`, and writes a hold row for the
    run's model.
  - Repeated `rate_limited_daily` failures never produce
    `StrategyRunStatus.ERROR` regardless of count (spot-check well past
    `LLM_MAX_MODEL_ERRORS`).
  - The top gate: with a live hold for the run's model, `runLlmStrategy`
    returns `RATE_LIMITED_DAILY` having made zero orchestrator calls.
  - With no hold, an `llm-google` run proceeds normally (gate is
    transparent).
- Resume sweep (unit test against the handler function, mocked
  repository + queue): given two `RATE_LIMITED_DAILY` runs for model A
  and one for model B, with A's hold expired and B's still live, only the
  A runs flip to `RUNNING` and get re-enqueued with their deterministic
  job ids; B's run is left alone.
- Queue module: `GOOGLE_RPD_RESUME_QUEUE` resolves to the
  `google-rpd-resume` queue.

### Migration

`1777000000000-add-google-rate-limit-hold.ts` — creates the
`GoogleRateLimitHold` table (with the unique constraint) and adds
`rateLimitedDaily` to `strategy_run_status_enum` (via `ADD VALUE IF NOT
EXISTS`, so a `run → revert → run` round-trip is idempotent even though
`down()` deliberately leaves the enum label in place). The up/down/up
round-trip against a real database is deferred to a serial verification
pass once the branch has the dev DB to itself, per the repo convention
that migrations are not unit-tested.
