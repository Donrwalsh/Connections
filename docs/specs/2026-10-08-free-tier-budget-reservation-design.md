# Free-Tier Budget Reservation — Design

## Problem

On 2026-10-08 the daily automation's OpenAI flagship cycle (started at an 80% threshold = 200,000 of the 250,000-token daily allowance) finished the UTC day at **370,582 tokens** — 170,582 past its threshold and 120,582 past the allowance itself.

This doc captures the decisions reached via a brainstorming session (investigation against prod data, then design) before implementation.

### What happened (from prod `SolvePrompt` data)

| Time (UTC) | Cumulative | Event |
|---|---|---|
| 00:34:56 | 134,649 | gpt-5 run 45911 starts; its first call takes 9 minutes |
| 00:38:31 | 152,537 | o3 run 45922 starts; its first call takes 5 minutes |
| 00:34–00:43 | ~135k–152k | Neither call has landed, so the tick sees plenty of room and keeps dispatching (runs 45940–45942) |
| 00:43:44 / 00:43:56 | 185,711 → **220,145** | The two calls land (33,174 + 34,434). Threshold crossed |
| 00:44–00:45 | 234,521 | Already-queued runs 45940–45942 run (+14,376) |
| 00:46–00:57 | **370,582** | o3 and gpt-5 keep going: 5 more calls of 23k–37k each (+136,061) |

### Root causes

1. **In-flight runs never check the budget (~80% of the overage).** Reaching the threshold only stops the dispatch tick from queuing new trials (`free-tier-dispatch.service.ts` `runTick`). The run loop in `llm-strategy-runner.service.ts` has no budget check, so a started trial runs to completion regardless of spend.
2. **Single reasoning-model calls are large, unbounded and invisible until they finish.** No `maxOutputTokens` is set anywhere in the orchestrator. gpt-5/o3/o4-mini calls reach 33k–40k output tokens and take minutes, and usage is only recorded when `flushBatch` writes the call's `SolvePrompt` row.
3. **The dispatcher reserves a flat 4,000 tokens per in-flight trial** (`DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE`), sized for mini/nano trials. It's roughly right for most models but meaningless for a call with no output limit.

The recent OpenAI retry change (`a07b7c7`) is not involved.

## Goal

A **hard guarantee**: spend initiated by free-tier dispatch never pushes a tier's recorded usage past its cycle threshold.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Hard guarantee vs. best-effort near-zero | Hard guarantee. We accept some budget left unused at the end of the day and trials paused partway through. |
| 2 | What happens to a run stopped mid-trial by the budget | It is paused as `RATE_LIMITED_DAILY` and resumed later from its saved guesses. It is not failed and not left for a manual retry. |
| 3 | Output limit granularity | Per model, as a new `SupportedModel.maxOutputTokens` column that can be edited in Adminer. |
| 4 | Seeding the limits | Taken from historical prod `SolvePrompt.completionTokens` and written into the migration as fixed values. They are not calculated at migration time. |
| 5 | Seed rule | max observed × 1.2, rounded up to the next 1,000, with a minimum of 1,000. No call in history would have been cut off. |
| 6 | Reasoning effort | Leave it as is. Lowering it would change what the benchmark measures, and the generous limit doesn't need the help. |
| 7 | Which spend the guarantee covers | Only runs started by free-tier dispatch. Manual dispatches, retries and judge calls still count toward usage, so the automation stops sooner, but they are never blocked. |
| 8 | Reservation record | A Postgres table with a per-tier row lock. A Redis counter was rejected because it can't see `SolvePrompt` or judge spend, which would mean two counts to keep in sync. |
| 9 | Pause/resume mechanism | It lives inside `free-tier-dispatch`: the dispatch tick resumes paused runs. OpenAI is **not** connected to the provider-pool `freeTier` / `RpdResumeService` machinery (`provider-pool.config.ts` has `openai.freeTier: null`), because that would also bring in rate-limit hold behavior that doesn't apply here. |
| 10 | Who gets the output limit | Every `llm-openai` call, not just budgeted ones. Every limit is above anything that model has produced, so it only guards against runaway calls. |

### Seed values

From prod, all `llm-openai` `SolvePrompt` rows with non-null `completionTokens`, queried 2026-10-08:

| Model | Calls | p99 | Max observed | `maxOutputTokens` |
|---|---|---|---|---|
| o4-mini | 1,086 | 33,505 | 40,311 | 49,000 |
| gpt-5 | 207 | 33,511 | 38,827 | 47,000 |
| o3 | 116 | 35,384 | 38,250 | 46,000 |
| gpt-5-nano | 2,066 | 22,635 | 29,865 | 36,000 |
| o1 | 176 | 20,511 | 27,002 | 33,000 |
| o3-mini | 1,690 | 17,563 | 23,455 | 29,000 |
| gpt-5-mini | 1,102 | 16,005 | 21,685 | 27,000 |
| gpt-4.1-mini | 3,186 | 5,015 | 11,624 | 14,000 |
| gpt-4.1-nano | 3,402 | 1,313 | 3,141 | 4,000 |
| gpt-4.1 | 505 | 607 | 1,646 | 2,000 |
| gpt-4o | 465 | 227 | 231 | 1,000 |
| gpt-4o-mini | 3,356 | 222 | 240 | 1,000 |
| gpt-5.1 | 439 | 223 | 245 | 1,000 |
| gpt-5.2 | 524 | 221 | 243 | 1,000 |
| gpt-5.4 | 411 | 202 | 241 | 1,000 |
| gpt-5.4-mini | 4,052 | 230 | 262 | 1,000 |
| gpt-5.4-nano | 3,538 | 241 | 329 | 1,000 |

Every other model stays `NULL` (no limit). A model without a limit can't be auto-dispatched; a budgeted run on it pauses instead of calling OpenAI.

## Design

### 1. Schema (one migration)

- `SupportedModel.maxOutputTokens int NULL`, seeded with the table above. The migration matches rows on `strategyName = 'llm-openai'` and `modelName`.
- `StrategyRun.budgetTier varchar NULL`, holding `'flagship' | 'mini'`. It is set only when free-tier dispatch creates the run, and it stays set if the run is paused and resumed.
- New table `FreeTierReservation`:
  - `id` serial PK
  - `tier` varchar not null
  - `strategyRunId` int not null, FK → `StrategyRun` on delete cascade
  - `reservedTokens` int not null
  - `status` varchar not null: `pending` or `unrecorded`
  - `createdAt` timestamptz not null default now
  - index on `(tier, createdAt)`

  Only rows with `createdAt >= startOfTodayUtc()` count. There's no cleanup job; yesterday's rows simply stop counting.

Any new entity is registered on the root TypeORM connection as well as in its feature module (see the existing entity-registration convention).

### 2. `FreeTierBudgetService` (`backend/src/modules/free-tier-dispatch/`)

- `committedTokens(tier)`: recorded usage (`FreeTierUsageService.getUsage(tier).usedTokens`, i.e. `SolvePrompt` + judge) plus the sum of today's `FreeTierReservation.reservedTokens` for the tier. It reads without a lock and is used by the dispatch tick.
- `reserve(tier, runId, tokens): Promise<number | null>`. In one transaction it:
  1. Locks the tier's `FreeTierDispatchState` row with `SELECT … FOR UPDATE`. That row already exists one per tier and works as a mutex.
  2. If there's no state row or `active = false`, it returns `null`. With no active cycle there's no threshold to reserve against.
  3. Sets `threshold = floor(dailyLimitTokens × thresholdPercent / 100)`, using the same formula `runTick` uses today.
  4. If `committed + tokens > threshold`, it returns `null`.
  5. Otherwise it inserts a `pending` reservation and returns its id.

  Any thrown error, including a lock timeout, is caught and returns `null` (**fail closed**).
- `settle(reservationId, recorded: boolean, manager: EntityManager)`. It runs inside `StrategyRunStore.flushBatch`'s transaction:
  - `recorded` (the call reported usage) deletes the row, in the same transaction that inserts its `SolvePrompt` row, so the spend is never missing from both places at once;
  - not `recorded` (timeout or call error with no usage) sets `status = 'unrecorded'`. The row keeps counting until UTC midnight, because OpenAI may have billed the call.

  If the flush rolls back, the reservation stays `pending` and keeps counting. Spend can only be over-counted, never under-counted.

### 3. Worst-case call size

`worstCaseCallTokens = maxOutputTokens + inputUpperBound`

`inputUpperBound` is a pure function, unit-tested in isolation. It relies on the fact that tokens never exceed UTF-8 bytes, because every BPE token covers at least one byte:

- **Incremental (the normal case):** the previous call's reported `promptTokens` + its visible output (`completionTokens − (reasoningTokens ?? 0)`) + `Buffer.byteLength` of the new user message + `PER_MESSAGE_OVERHEAD_TOKENS × 2`. The overhead is a small constant (e.g. 8) for role and framing tokens. Reasoning tokens are not resent to the model, so they are excluded.
- **Full fallback** (first call, or the previous call reported no usage): the sum of `Buffer.byteLength` over every message + `PER_MESSAGE_OVERHEAD_TOKENS × messages.length`.

### 4. Run loop (`llm-strategy-runner.service.ts`)

- `budgetTier` travels in the BullMQ job data, alongside `model`, and is written to `StrategyRun.budgetTier` when the run is created. On a resumed run it is read from the existing row.
- If `run.budgetTier` is set, each loop iteration runs these steps before `orchestratorService.requestSolveStep`:
  1. If the model has no `maxOutputTokens`, pause.
  2. Call `reserve(tier, run.id, worstCaseCallTokens)`. If the result is `null`, pause.
  3. Make the call, then pass the reservation id to `flushBatch`, which settles it.
- **Pause** means: set `status = RATE_LIMITED_DAILY` and `finishedAt = now`, save, and return without calling OpenAI. That is the same status-and-return shape the existing daily hold path uses. On resume, state is rebuilt from saved guesses, and the existing `RATE_LIMITED_DAILY → RUNNING` normalization applies.
- Runs without `budgetTier` skip all of this.
- Every `llm-openai` call passes the model's `maxOutputTokens` (when set) through `requestSolveStep`, whether or not the run is budgeted.

### 5. Orchestrator

- `/solve-step` accepts an optional `maxOutputTokens` (positive int) and `runAnswerStep` passes it to `generateText({ maxOutputTokens })`. `/diagnose` (AI Assist) is unchanged.
- A call that hits the limit (`finishReason: "length"`) is not a new error type. Its text goes down the existing malformed/parse path. The backend logs a warning that names the model, so you know when to raise its limit. `finishReason` is already saved in `responseBody`, so no schema change is needed.

### 6. Dispatch tick (`free-tier-dispatch.service.ts` `runTick`)

The tick replaces the flat-estimate math with:

1. Inactive or threshold reached: stop, as today.
2. `room = threshold − committedTokens(tier)`.
3. **Resume first.** Runs with `budgetTier = tier` and `status = RATE_LIMITED_DAILY` are re-queued, oldest `startedAt` first, following the same pattern `RpdResumeService` uses inline: add the job first (`runStrategyJobId(...)-resume-<stamp>`), then flip to `RUNNING`, so a failed add leaves the run paused for the next tick instead of stuck in `RUNNING`. They count toward `MAX_BATCH` and `MAX_IN_FLIGHT`.
4. **New trials.** A model is a candidate only if it has a `maxOutputTokens` value and its first-call worst case fits in `room − Σ(maxOutputTokens of in-flight runs' models)`. This is a soft limit that only reduces mid-trial pauses; the hard guarantee is `reserve()`. `leastAllocatedModel` skips models that don't fit (they are treated as exhausted for this tick). `triggerStrategyRuns` passes `budgetTier = tier`.
5. **Stop** with the log line "budget reached" when there are no runs in flight, nothing left to resume, and no model's worst case fits in `room`. The existing "no unrun puzzles for any model" stop is unchanged.

The tick removes `FREE_TIER_DISPATCH_TOKEN_ESTIMATE` / `DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE` / `freeTierDispatchTokenEstimate()`. `MAX_IN_FLIGHT`, `MAX_BATCH` and `TICK_MS` stay.

`triggerStrategyRuns(puzzleId, strategyName, date, model?, budgetTier?)`: the new optional argument passes through `triggerNextLlmTrial` into the job data.

### 7. How a day works

- At the daily automation cron (`DAILY_AUTOMATION_CRON`, UTC), the cron starts the flagship cycle at 80%. Yesterday's reservations, including any `unrecorded` ones, have stopped counting. The first ticks resume yesterday's paused runs, then pick new puzzles.
- As room shrinks, expensive models stop being candidates first. Cheap models with a 1,000-token limit keep using the remaining room.
- In-flight runs whose next call doesn't fit pause. The cycle stops with "budget reached".
- Raising the threshold or restarting a cycle on the same day resumes paused runs as soon as there's room.

### Unchanged

The daily automation cron and its 80% ceiling, the free-tier usage widget (it keeps showing recorded usage), manual dispatch and retries, the judge, and the provider-pool / `RpdResumeService` machinery.

## Error handling summary

| Situation | Behavior |
|---|---|
| `reserve()` DB error or lock timeout | Returns `null`; the run pauses (fail closed) |
| `flushBatch` rolls back | Reservation stays `pending` and counts until midnight |
| Call times out or fails with no usage | Reservation becomes `unrecorded` and counts until midnight |
| Worker crashes mid-call | `pending` reservation counts until midnight; the stale-run sweep re-queues the run, which makes a fresh reservation |
| Call hits `maxOutputTokens` | Existing malformed path, plus a warning log |
| Model has no `maxOutputTokens` | Not a dispatch candidate; a budgeted run on it pauses |

## Testing

- **`FreeTierBudgetService` (unit):**
  - fits / doesn't fit;
  - `pending` and `unrecorded` rows both count;
  - previous-day rows don't count;
  - inactive or missing state returns `null`;
  - a thrown error returns `null`;
  - `settle` deletes vs. marks `unrecorded`.
- **`inputUpperBound` (unit, pure):** incremental and full-fallback cases. Against recorded fixtures of real conversations, the bound is ≥ the real `promptTokens`.
- **Run loop (unit):**
  - a run without `budgetTier` never calls `reserve`;
  - a `null` reservation pauses without calling the orchestrator;
  - a model with no limit pauses;
  - a reservation id reaches `flushBatch`;
  - `maxOutputTokens` is passed for every `llm-openai` call.
- **Dispatch tick (unit):**
  - paused runs are resumed before new puzzles;
  - models that don't fit are skipped;
  - "budget reached" stop;
  - `budgetTier` is passed to `triggerStrategyRuns`;
  - the existing threshold and no-unrun-puzzle stops still work.
- **Orchestrator (unit, `app.request()`):** `maxOutputTokens` reaches `generateText`; it is omitted when not given.
- **E2E (`backend/test/app.e2e-spec.ts`, real Postgres):** two concurrent `reserve()` calls race for room that only fits one, and exactly one succeeds.
- **Migration:** the seeded values match the table above.
