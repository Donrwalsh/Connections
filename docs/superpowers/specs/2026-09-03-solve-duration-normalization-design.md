# Solve Duration Normalization — Design

**Date:** 2026-09-03
**Status:** Approved, ready for implementation planning
**Branch:** `feature/solve-duration-normalization`

## Problem

Every "duration" figure shown for a strategy run is currently wall-clock
time: `finishedAt - startedAt`. For LLM runs this is badly inflated by
time the run spent *not* calling the model:

- Google per-minute rate-limit sleeps (`state.rateLimitWaitMs`).
- RPD daily parks — a run parked waiting for Google's daily quota to
  reset can sit for hours or days before the `google-rpd-resume` sweep
  re-dispatches it.
- Model-error backoffs (`modelErrorBackoff`).
- Queue lag between `startedAt` being set and the first real call.

The result is a handful of runs reporting durations of hours or days,
which then distort the leaderboard's average duration and the
run-history duration sort.

The fix: for LLM runs, define solve duration as the sum of the
individual model-call latencies that are already recorded per call,
instead of the wall-clock span.

## Definition

**Solve duration (LLM runs)** = `SUM(SolvePrompt.latencyMs)` over all of
the run's `SolvePrompt` rows.

- `SolvePrompt.latencyMs` is the real model-response time reported back
  by the orchestrator for each `solveAssist` call
  (`OrchestratorService`), persisted per call by the runner.
- `CALL_ERROR` rows contribute nothing — the runner does not store
  `latencyMs` on them (`buildCallErrorPromptRow`). Failed calls are
  capped low per run (`LLM_MAX_MODEL_ERRORS`), so the omission is
  acceptable and no new plumbing is added for it.
- Category-judge calls (`CategoryEvaluation.latencyMs`) are **not**
  included — judging runs separately from the solve and is post-hoc.

**Deterministic / shuffle strategies are unchanged.** They make no LLM
calls, have no `SolvePrompt` rows, and their wall-clock duration is real
compute time. Everything below that touches deterministic runs keeps the
existing `finishedAt - startedAt` behaviour via an explicit fallback.

## Compatibility

Field names are kept and their meaning changes underneath:

- `LeaderboardRowDto.avgDurationMs` — same name, now an average of
  summed call latencies.
- `RunHistoryRowDto` — gains `solveDurationMs`.
- `StrategyRunListItemDto` — gains `solveDurationMs`.
- Frontend `RunRecord.durationMs` — same name, now fed from
  `solveDurationMs` when present.

`startedAt` / `finishedAt` remain on every DTO that already carries
them, so wall-clock is still derivable client-side by any consumer that
wants it. No dedicated wall-clock field is added.

## Storage & computation

No schema change, no migration, no backfill. The value is computed live
on every read, matching how `guessCount`, `issueCount`, and
`tokenCostUsd` are already derived in run-history.

## Changes by surface

### 1. Leaderboard `avgDurationMs`

File: `backend/src/modules/strategy/strategy.service.ts`
(`getLeaderboard`, approx. lines 505–756).

- In the existing `SolvePrompt` grouped query (approx. line 528, the one
  that already `SUM`s prompt/completion tokens and counts issue-tagged
  rows), add `SUM(prompt."latencyMs")` aliased `latencyMs`.
- Build a `latencyMsByRun: Map<number, number>` alongside `tokensByRun`
  from that query's rows.
- Replace both wall-clock pushes:
  - line ~642 (COMPLETED branch)
  - line ~667 (LLM cap-FAILED branch)

  from `acc.durationsMs.push(run.finishedAt.getTime() - run.startedAt.getTime())`
  to pushing `latencyMsByRun.get(run.id)` when that map has an entry.
  Keep a guard so a missing entry pushes nothing (an LLM COMPLETED or
  cap-FAILED run always has at least one parsed `SolvePrompt`, so in
  practice the entry is always present).
- The `run.finishedAt` null checks around those pushes are replaced by
  the map-has-entry check. `startedAt` / `finishedAt` are no longer read
  here for duration.
- Run-status gating is unchanged: only COMPLETED runs, plus LLM runs
  that hit the mistake cap (`lostRuns`), feed `durationsMs`.

### 2. Run-history rows + sort

File: `backend/src/modules/strategy/strategy.service.ts`
(`getRunHistory`, approx. lines 1111–1271).

- Add a correlated subquery select:

  ```
  (SELECT SUM(sp."latencyMs")
     FROM "SolvePrompt" sp
    WHERE sp."strategyRunId" = run.id)::int
  ```

  aliased `solveDurationMs`, next to the existing `guessCount` /
  `issueCount` / `tokenCostUsd` subqueries. Bare `SUM` (no `COALESCE`)
  so it returns SQL `NULL` for a run with no `SolvePrompt` rows at all —
  the same shape `tokenCostUsd` already returns and sorts on.
- `RUN_HISTORY_SORT_EXPR.duration` (line ~75) changes from
  `(run."finishedAt" - run."startedAt")` to the same
  `SELECT SUM(sp."latencyMs") ...` subquery, so the "duration" sort
  orders by summed call time (`NULL`s sort last under `DESC`, first
  under `ASC` — Postgres default, matching `tokenCost`).
- `RunHistoryRowDto` gains `solveDurationMs: number | null`.
- Row mapping: `solveDurationMs` is `null` when the subquery returned
  `NULL` — a run with no `SolvePrompt` rows (deterministic, or an LLM
  run that never recorded a call), or an LLM run whose only rows are
  `CALL_ERROR` (all `latencyMs` `NULL`, so `SUM` is `NULL`). Otherwise
  it is `Number(row.solveDurationMs)`. Same `x === null ? null : Number(x)`
  pattern the mapper already uses for `tokenCostUsd`.
- `startedAt` / `finishedAt` stay on the row DTO.

### 3. Per-puzzle runs list

File: `backend/src/modules/strategy/strategy.service.ts`
(`getRunsForPuzzleId`, approx. lines 1040–1081).

- Add a grouped query mirroring the `countByRun` block directly above
  it: over the page's run ids, `SELECT prompt.strategyRunId,
  SUM(prompt.latencyMs) FROM "SolvePrompt" prompt WHERE
  prompt.strategyRunId IN (:...ids) GROUP BY prompt.strategyRunId`.
- Build `solveDurationByRun: Map<number, number>`; a run absent from the
  map (no `SolvePrompt` rows) or with a `NULL` sum maps to
  `solveDurationMs: null`, else the summed number.
- `StrategyRunListItemDto` gains `solveDurationMs: number | null`.

### 4. Frontend

- `frontend/src/data/benchmark/types.ts`: add `solveDurationMs: number | null`
  to the run-history row type and the run-list-item type.
- `frontend/src/data/benchmark/api.ts` `toRunRecord` (approx. line 277):
  `durationMs = item.solveDurationMs ?? computeDurationMs(item.startedAt, item.finishedAt)`.
  The fallback keeps deterministic runs on wall-clock.
- `frontend/src/components/benchmark/RunHistoryTable.tsx` (approx. line 103):
  stop calling `computeDurationMs(row.startedAt, row.finishedAt)`; use
  `row.solveDurationMs`. `null` renders as `"—"`, same as today.
- `computeDurationMs` and `formatDuration` stay — still used by the
  deterministic fallback in `toRunRecord` and by per-call latency
  formatting in `GuessChainVisualizer`.
- `StrategyTable`, `StrategyPuzzlePage`, leaderboard pages: no change;
  they consume `avgDurationMs` exactly as before.

## Edge cases

| Case | Behaviour |
|------|-----------|
| LLM run, every call `CALL_ERROR` | All `latencyMs` `NULL` → `SUM` is `NULL` → `solveDurationMs` is `null`, row shows `"—"`. Excluded from leaderboard average anyway (not COMPLETED / cap-FAILED). |
| Orchestrator returned `latencyMs: 0` on a real call | Counted as `0`, same as existing telemetry treats it. |
| Deterministic run (no `SolvePrompt` rows) | `solveDurationMs` is `null`; run-history shows `"—"`; `toRunRecord` falls back to wall-clock. Leaderboard path for deterministic strategies is unchanged. |
| LLM run still RUNNING with ≥1 completed call | `solveDurationMs` is the partial sum; not yet in any leaderboard average (gating excludes non-terminal). |
| SQL sort on "duration" with mixed deterministic + LLM rows | Deterministic rows have a `NULL` sum and sort last (`DESC`) / first (`ASC`), same as `tokenCost` already does. Acceptable — this sort is an LLM-oriented view. |

## Testing

Backend (`strategy.service.spec.ts`):

- The existing leaderboard `avgDurationMs` assertions (e.g. the
  "lost LLM run … for progress/averages" test near line 1344 that
  expects `avgDurationMs` `45_000`) currently derive from
  `finishedAt - startedAt` and lean on the **default** empty
  `mockSolvePromptRepo.createQueryBuilder`. Under the new logic an empty
  SolvePrompt query means no `latencyMsByRun` entry and
  `avgDurationMs: null`, so each such test must now stub
  `mockSolvePromptRepo.createQueryBuilder` with `getRawMany` rows
  carrying a `latencyMs` field per run and assert the average of those.
- Add a leaderboard case where wall-clock and summed latency diverge
  sharply (large `startedAt → finishedAt` gap, small `latencyMs` sums)
  and assert the summed value wins.
- Run-history sort spec (the "sort by startedAt, duration, or tokenCost"
  test near line 2047) — change the `duration` expectation from
  `'(run."finishedAt" - run."startedAt")'` to the new
  `SELECT SUM(sp."latencyMs")` subquery string.
- `rawRun()` fixture helper (near line 1911) gains a `solveDurationMs`
  field; add a run-history row spec asserting `solveDurationMs` is
  `Number`-cast when set and stays `null` when the raw value is `null`
  (mirrors the existing `tokenCostUsd` cast test near line 2100).
- New `getRunsForPuzzleId` spec — `solveDurationMs` populated from the
  grouped latency query, `null` for a run absent from it.

Frontend:

- `RunHistoryTable` test — renders `solveDurationMs`, `"—"` on `null`.
- `RunsTable` / `toRunRecord` tests — `durationMs` comes from
  `solveDurationMs`, falls back to wall-clock when it is `null`.

## Out of scope

- Recording `latencyMs` on `CALL_ERROR` rows.
- Including category-judge latency.
- Any change to deterministic / shuffle duration handling.
- A stored/denormalized `StrategyRun` duration column.
- Backfill of historical rows (nothing to backfill — computation is live).
