# Daily free-tier automation

## Problem

Two free-usage programs already exist in this codebase but both require a
human to trigger them by hand every day:

- **OpenAI mini/nano free tier** (`FreeTierDispatchService`, `FreeTierId =
  "mini"`) — a self-rescheduling tick chain that burns free tokens by
  dispatching `llm-openai` trials until today's usage reaches a caller-chosen
  percent of the tier's daily budget. Someone has to open the UI and click
  "start" each day.
- **Category judging** (`CategoryEvaluatorService`) — enqueues judge jobs for
  successful proposals that haven't been evaluated yet. Its calls run on
  `JUDGE_MODEL` (a mini/nano model), so its token spend already lands in the
  same `mini` tier budget that `FreeTierDispatchService` tracks
  (`FreeTierUsageService.getUsage` sums both `SolvePrompt` and
  `CategoryEvaluation` tokens). Also triggered by hand.
- **Google's free daily RPD (requests-per-day) quota** has no dispatch side
  at all today — only a reactive one. `GoogleRateLimitHoldService` parks a
  run when Google returns an RPD rate limit, and `GoogleRpdResumeBootstrap`
  runs a daily sweep (00:01 America/Los_Angeles, plus a startup catch-up) to
  un-park anything whose hold has expired. Nothing proactively dispatches
  `llm-google` trials to actually use the free quota before it resets.

There is also no single place to see whether "today's automatic runs"
happened, or when the next one is expected — each of these lives in its own
widget with its own polling loop and no shared "last run" concept.

## Goals

1. Once a day, automatically:
   - enqueue the category-judge backlog,
   - burn the OpenAI mini/nano free tier up to a ceiling that leaves headroom
     for judge spend landing later in the day,
   - burn Google's free daily RPD quota until it's exhausted or every
     unrun-puzzle backlog for Google's models is empty.
2. Make it easy to see, from the UI, whether today's automatic run happened
   and what it did, and when the next one is expected to fire.
3. Leave the OpenAI **flagship** tier untouched — it stays manual-only, as
   today. Nothing here changes `FreeTierDispatchService`'s existing
   `start`/`stop`/manual-threshold behavior; the daily automation is a new
   caller of it, not a replacement.

## Non-goals

- Changing how `FreeTierUsageService` computes usage, or how judge tokens are
  attributed to the mini tier — both already work correctly today.
- Any change to the existing manual dispatch endpoints/UI
  (`FreeTierDispatchModal`, the manual `POST /category-evaluation/dispatch`,
  the manual free-tier start/stop routes). The daily automation is additive.
- A generic "cron job admin" UI. This spec covers exactly the three legs
  below, surfaced through the existing benchmark widgets plus one new small
  widget — not a general job-scheduling dashboard.

## Design

### Architecture

One new daily cron, alongside the existing `OnApplicationBootstrap` +
`queue.upsertJobScheduler(pattern, tz)` schedulers already in this codebase
(`ModelMetadataRefreshBootstrap`, `GoogleRpdResumeBootstrap`).

`DailyAutomationBootstrap` schedules `"15 0 * * *"` UTC (00:15 UTC — after
the mini/nano tier's UTC-midnight usage window has reset, matching the
"one-minute-plus offset after a reset" pattern `GoogleRpdResumeBootstrap`
already uses for Pacific midnight) plus a startup catch-up job with a
per-UTC-day jobId, same shape as `GoogleRpdResumeBootstrap`'s.

That job calls `DailyAutomationService.run()`, which fires three legs in
**kickoff** order — not wait-for-completion order. None of the three blocks
on another leg finishing, because the ordering constraint between judging and
the mini/nano burn is enforced by a *reserved budget slice*, not by
sequencing:

1. **Judge leg** — `categoryEvaluatorService.enqueuePending({ limit: <cap>
   })`. Fire-and-forget: the jobs it enqueues are drained by the existing
   judge workers on their own schedule, exactly as a manual dispatch would.
2. **Mini/nano burn leg** — `freeTierDispatchService.start("mini", 80)`. 80%
   is the daily automation's ceiling: the mini tier's overall safety cap is
   95%, and 15% is reserved so that judge spend landing over the rest of the
   day (from jobs the judge leg just enqueued, or from proposals produced by
   models solving throughout the day) has room to land without either
   silently exceeding the tier's real daily limit or racing the burn cycle
   for the last few tokens. If a cycle is already running (a human started
   one earlier at some other threshold), `start()`'s existing "already
   running" guard applies unchanged — the automation does not stop or
   override a human-started cycle.
3. **Google burn leg** — `googleFreeDispatchService.start()` (new service,
   see below). No token-threshold concept applies to Google — there is no
   per-token free budget, only a daily request cap enforced by Google itself
   — so this leg's stop condition is "every Google model is currently
   RPD-held" rather than a percentage of a budget.

Each leg's outcome (started / already active / already exhausted / error) is
written into one `AutomationRunLog` row per UTC calendar day immediately
after that leg resolves — not batched until the whole chain finishes, so a
crash partway through the chain still leaves the earlier legs' outcomes
visible. That row is the one thing the UI needs to answer "did today's
automatic run happen, and what did it do."

### Components

**New backend:**

- `AutomationRunLog` entity — `date` (UTC day, `YYYY-MM-DD`, primary key),
  `triggeredAt`, `judgeEnqueued` (int, nullable), `judgeError` (nullable),
  `miniBurnOutcome` (`started` | `alreadyActive` | `error`),
  `miniBurnMessage` (nullable — the started threshold, or the error text),
  `googleBurnOutcome` (`started` | `alreadyActive` | `alreadyExhausted` |
  `error`), `googleBurnMessage` (nullable), `updatedAt`. One row per day,
  upserted as each leg reports in.
- `DailyAutomationService` — `run()` (the three-leg kickoff described
  above) and `getTodayStatus()` (reads today's `AutomationRunLog` row, or a
  default "hasn't run yet today" shape if the cron hasn't fired yet).
- `DailyAutomationBootstrap` — schedules the cron as described above.
- `GoogleFreeDispatchService` — a new sibling to `FreeTierDispatchService`,
  same overall shape (`start` / `stop` / `getStatus` / `runTick` as a
  self-rescheduling tick chain on its own queue), but:
  - no `thresholdPercent` — there is nothing to compare a percentage
    against;
  - its stop condition is `googleRateLimitHoldService.heldModels("llm-google")`
    covering every model returned by the new
    `supportedModelService.findModelNamesByStrategy("llm-google")` (see
    below) — once every Google model is held, the cycle stops the same way
    `FreeTierDispatchService` stops on reaching its threshold;
  - `start()` checks this same condition up front and returns an
    `alreadyExhausted`-flavored no-op instead of queuing a tick that would
    immediately find nothing to do — this matters specifically for the daily
    automation case where yesterday's burn may have exhausted every Google
    model and Google's own Pacific-midnight reset (~08:00 UTC) hasn't
    happened yet by the time this leg's 00:15 UTC cron fires.
  - otherwise reuses the same pacing knobs
    (`freeTierDispatchTickMs`/`MaxBatch`/`MaxInFlight`/`TokenEstimate` — or a
    parallel `GOOGLE_FREE_DISPATCH_*` set if Google's actual rate limits turn
    out to need different pacing; default to the same values initially) and
    the same `findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` /
    `countInFlightByModel` calls `StrategyService` already exposes generically
    over `strategyName`.
- `GoogleDispatchState` entity — mirrors `FreeTierDispatchState` minus
  `thresholdPercent` (`tier` becomes unnecessary too — there's only one
  Google program, so this can be a single-row table, or keyed by a fixed
  constant id for symmetry with the existing table's shape).
- New BullMQ queue `google-free-dispatch` (mirrors `free-tier-dispatch`),
  wired into `worker.ts` the same way the existing free-tier-dispatch worker
  is.
- `SupportedModelService.findModelNamesByStrategy(strategyName)` — new
  method, same shape as the existing `findModelNamesByFreeTier` (filtered to
  `supported: true`, ordered by id).
- `AutomationController` — `GET /automation/status`, assembling: today's
  `AutomationRunLog` row, the mini tier's live `FreeTierDispatchStatusDto`,
  the Google leg's live status, the judge backlog's live
  `CategoryEvaluationCoverage`, and the next scheduled fire time (computed
  from the known `"15 0 * * *"` UTC pattern — no need to store this
  anywhere).

**New frontend:**

- `fetchAutomationStatus()` in `data/benchmark/api.ts`, and its response
  shape in `data/benchmark/types.ts`.
- `FreeTierBudgetWidget` (mini tier only) and `CategoryJudgingWidget` each
  grow a small "last auto-run: `<time>` · next: `<time>`" line, both fed by
  the one `/automation/status` call (lifted to the parent page and passed
  down, matching how `spentUsd`/`refreshSignal` are already threaded
  through `FreeTierBudgetWidget` today).
- New `GoogleDispatchWidget`, visually matching the `bench-free-tier` family
  (`FreeTierBudgetWidget`/`CategoryJudgingWidget`'s shared styling), showing
  the Google leg's active/last-run/next-run state. Placed alongside
  `CategoryJudgingWidget` on the Activity page.

### Data flow & error handling

The cron fires `DailyAutomationService.run()`. Each leg is wrapped in its own
try/catch — one leg failing does not block the others, the same independent-
outcome pattern `DispatchController.startBothFreeTiers` already uses for
"both" tiers. Each leg's outcome is written to today's `AutomationRunLog` row
as soon as that leg resolves.

- **Judge leg failing** (e.g. a DB error from `enqueuePending`) — logged,
  `judgeEnqueued: null` and the error message recorded; the other two legs
  still run.
- **Mini burn already running** — not an error. A human may have started a
  cycle earlier at a different threshold; recorded as `alreadyActive`, and
  the existing cycle is left alone (no override, no stop-and-restart at
  80%).
- **Google burn already exhausted** — checked up front (see
  `GoogleFreeDispatchService.start()` above) and recorded as
  `alreadyExhausted` rather than spinning a tick that immediately finds
  every model held.
- **Startup catch-up** — mirrors `GoogleRpdResumeBootstrap`: a fixed
  per-UTC-day jobId means a backend and worker booting together (or a worker
  restart mid-day) collapse to a single run instead of double-firing.

Frontend polls `GET /automation/status` on the same ~30s cadence
`FreeTierBudgetWidget` already uses for dispatch-status polling.

### Testing

- Unit: `DailyAutomationService.run()` — each leg mocked; assert independent
  try/catch behavior (one leg throwing doesn't stop the other two), assert
  the `AutomationRunLog` upsert shape for each outcome variant.
- Unit: `GoogleFreeDispatchService` — same test shape as
  `free-tier-dispatch.service.spec.ts`, swapping the threshold-reached stop
  condition for the held-models stop condition; covers the
  already-exhausted no-op path and the runs-until-held path.
- Unit: `SupportedModelService.findModelNamesByStrategy` — same shape as the
  existing `findModelNamesByFreeTier` tests.
- Unit: `AutomationController` — status-assembly shape, with the four
  underlying services mocked.
- Frontend: widget tests for the new "last/next auto-run" lines on
  `FreeTierBudgetWidget`/`CategoryJudgingWidget` (mock
  `fetchAutomationStatus`), and a new `GoogleDispatchWidget.test.tsx`
  mirroring `FreeTierBudgetWidget.test.tsx`'s shape.
- No new end-to-end/integration coverage beyond what the existing
  free-tier-dispatch and google-rpd-resume suites already exercise for their
  respective patterns — this reuses those patterns rather than inventing new
  integration surface.

## Open questions for implementation planning

- Exact daily cap passed to `enqueuePending({ limit })` for the judge leg —
  large enough to actually drain a typical day's backlog in one dispatch,
  bounded by the same `MAX_LIMIT` (500) the manual endpoint already enforces.
- Whether Google's tick-chain pacing knobs should be a distinct
  `GOOGLE_FREE_DISPATCH_*` env family from day one, or start by reusing the
  existing `FREE_TIER_DISPATCH_*` values and split only if Google's real
  rate limits demand different pacing.
