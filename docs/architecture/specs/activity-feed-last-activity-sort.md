# Activity Feed: Sort Puzzle Solves by Last Activity

> Produced by a `/grill-me` (superpowers:grilling) design session, not the
> Superpowers brainstorming/writing-plans workflow — kept out of
> `docs/superpowers/specs/` so its different provenance stays distinct. See
> the paired implementation plan at
> `docs/superpowers/plans/2026-09-22-activity-feed-last-activity-sort.md`.

## Problem

The Activity page's "Puzzle Solves" table (`RecentActivityTable` inside
`ActivityPage`) is a live, polling feed of recent `StrategyRun` activity,
sorted newest-first by `run.startedAt`. The manual-retry feature (see
`docs/superpowers/plans/2026-09-17-manual-run-retry.md`) resumes a run stuck
in the `error` status by flipping its existing row back to `RUNNING` and
re-enqueuing its job — it does **not** create a new run and does **not**
touch `startedAt`. So a manually retried run — which is actively making new
model calls right now — stays wherever its original `startedAt` places it
in the feed, instead of rising to the top where an admin watching the feed
would see it and its progress.

## Decision

Sort the Puzzle Solves list by **last activity** (`StrategyRun.updatedAt`)
instead of **creation time** (`StrategyRun.startedAt`). `updatedAt` is an
existing `@UpdateDateColumn` on `StrategyRun` that already gets bumped:

- The instant `StrategyDispatch.retryRun` flips a run back to `RUNNING`
  (`strategy-dispatch.service.ts`'s `run.status = RUNNING; ...;
  await this.strategyRunRepo.save(run)`).
- On every subsequent progress step, via `StrategyRunStoreService.flushBatch`
  (`await manager.save(StrategyRun, run)`), which the solve loop calls as it
  persists each batch of guesses/prompts.
- On ordinary creation and completion, same as today — a fresh run's
  `updatedAt` starts equal to its `startedAt`.

This means: no new database column, no new persisted "this was a retry"
flag, and no join. A manually retried run rises to the top of the feed the
moment it's retried, and stays elevated while it's actively progressing,
exactly like a brand-new dispatch does today — because the sort key is now
genuinely "most recently touched," not "most recently created."

Bulk retry (`StrategyDispatch.retryErroredRuns`) calls `retryRun` once per
run, so it is covered by the same mechanism with no separate handling.

## Explicitly out of scope

- **No visual "retried" badge or marker.** Considered and declined — the
  reordering itself, plus the existing `StatusPill` (e.g. "running"), is
  judged sufficient context. Revisit only if user feedback says otherwise.
- **No new sort-order toggle.** The feed's sort is fully replaced, not made
  switchable between "started" and "last activity" — one column, one
  meaning, matching how the page already reads today.
- **The "Category Judgments" table is untouched.** It already sorts by
  `eval.evaluatedAt`, a one-shot timestamp with no retry concept (a
  `CategoryEvaluation` row isn't resumed the way a `StrategyRun` is), so it
  has no equivalent problem to solve.
- **No relative ("2m ago") timestamp format.** The existing absolute
  date+time formatters (`formatTimestampDate`/`formatTimestampDateShort`/
  `formatTimestampTime`) are kept as-is, for consistency with every other
  timestamp in the app and to avoid introducing a new formatting pattern
  used nowhere else.
- **No new/second timestamp column.** The existing single "When" column is
  repurposed in place (its value now reflects last-activity instead of
  start-time for run rows); a judgment row's value is unaffected. The
  column header changes from "When" to "Last activity" to keep it accurate,
  since it's the same column for both event kinds.

## Concrete changes

1. **Backend** — `StrategyReadService.getRecentActivity`
   (`backend/src/modules/strategy/strategy-read.service.ts`): the run query
   (`runQb`) changes its `occurredAt` select and its primary `orderBy` from
   `run.startedAt` to `run.updatedAt`. The `run.id DESC` tiebreaker stays.
   The judgment query (`judgmentQb`) is unchanged.
2. **Frontend** — `RecentActivityTable`
   (`frontend/src/components/benchmark/RecentActivityTable.tsx`): the
   `<th>` text "When" becomes "Last activity". No other rendering logic
   changes — it already renders whatever `occurredAt` the backend sends.

## Verification

`fetchRecentActivity`/`getRecentActivity` has exactly one frontend consumer
(`ActivityPage`), confirmed by search — so this change has no ripple effect
elsewhere in the app.
