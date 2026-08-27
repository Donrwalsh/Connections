# Replacing "Avg cost" with "Avg issues" on the primary leaderboard — design

## Problem

The primary leaderboard table (`StrategyTable.tsx`, rendered by
`LeaderboardPage.tsx` for LLM strategies — the top table on the page, above
the deterministic/shuffle one) shows an "Avg cost" column, computed from
`LeaderboardRowDto.avgCostUsd`
([strategy.service.ts:639](../../../backend/src/modules/strategy/strategy.service.ts#L639)).
Now that
[SolvePrompt.issueTags](../../../backend/src/modules/strategy/entities/solve-prompt.entity.ts)
exists (see
[2026-08-26-llm-failure-taxonomy-design.md](2026-08-26-llm-failure-taxonomy-design.md)),
"how error-prone is this model" is a more actionable at-a-glance signal for
this table than raw dollar cost — cost is still tracked and shown elsewhere
(the free-tier budget widget, the per-model detail page), just not as the
headline number on the model-comparison table.

## Goals

- `StrategyTable.tsx`'s LLM-variant column changes from "Avg cost" to "Avg
  issues": the mean number of issue-tagged `SolvePrompt` rows per run, per
  model.
- The underlying `avgCostUsd`/`totalCostUsd` fields and every other consumer
  of them (`StrategyPuzzlePage.tsx`'s cost summary,
  `FreeTierBudgetWidget.tsx`, `sumSpendUsd` in `metrics.ts`) are unaffected
  — this only changes what one table column shows, not the cost-tracking
  feature itself.

## Non-goals

- No change to the leaderboard's sortable metrics
  (`LEADERBOARD_METRICS`/`LeaderboardMetricKey` in `metrics.ts`) — `avgCostUsd`
  was never one of them (only `avgGuesses`/`successRate`/`speed` are), and
  `avgIssues` doesn't become one either. It's a display-only column, same as
  cost was.
- No `totalIssues` field. `totalCostUsd` exists because the free-tier budget
  widget needs an all-time sum; nothing here needs the equivalent for
  issues, so it isn't added (YAGNI).
- No change to the deterministic/shuffle table — it has never shown cost
  (no LLM cost concept applies), and won't show issues either (no
  `SolvePrompt` rows exist for those strategies, so the concept doesn't
  apply there either).

## Design

### 1. Backend: fold the issue count into the existing per-run token query

[strategy.service.ts:454](../../../backend/src/modules/strategy/strategy.service.ts#L454)'s
`Promise.all` already fetches a per-run token-sum query
([:489-499](../../../backend/src/modules/strategy/strategy.service.ts#L489-L499))
to compute cost, grouped by `strategyRunId`. Rather than adding a *second*
`solvePromptRepo.createQueryBuilder()` call, add the issue count as one
more aggregate column on this same query — it's already grouped by the
right key over the right table:

```typescript
this.solvePromptRepo
  .createQueryBuilder("prompt")
  .select("prompt.strategyRunId", "strategyRunId")
  .addSelect("SUM(prompt.promptTokens)", "promptTokens")
  .addSelect("SUM(prompt.completionTokens)", "completionTokens")
  .addSelect(
    `COUNT(*) FILTER (WHERE array_length(prompt."issueTags", 1) > 0)`,
    "issueCount",
  )
  .groupBy("prompt.strategyRunId")
  .getRawMany<{
    strategyRunId: number;
    promptTokens: string | null;
    completionTokens: string | null;
    issueCount: string | null;
  }>(),
```

**Deliberately a merge, not a new parallel query — this avoids a real mock
collision in the existing test suite.** `strategy.service.spec.ts`'s cost
tests stub this call with `mockSolvePromptRepo.createQueryBuilder.mockReturnValue({...})`
(plain `mockReturnValue`, not `mockReturnValueOnce`) — see e.g.
[strategy.service.spec.ts:1342](../../../backend/src/modules/strategy/strategy.service.spec.ts#L1342).
`mockReturnValue` isn't one-shot: every call to `createQueryBuilder()` for
the rest of that test gets the *same* mocked chain. If the issue count were
a second, separate `createQueryBuilder()` call, it would silently receive
the same token-shaped mock rows (no `issueCount` field), which — if parsed
without a fallback — resolves to `NaN` rather than `0`. Merging into the
one existing query sidesteps this: there's still only one
`createQueryBuilder()` call for `SolvePrompt` in `getLeaderboard`, so no
existing test's mock needs to change shape at all, and the parsing below
uses `?? 0` so a mocked row that simply omits `issueCount` (every existing
cost-focused test) yields `0`, not `NaN`.

`tokensByRun`
([:511-517](../../../backend/src/modules/strategy/strategy.service.ts#L511-L517))
gains a sibling `issueCountByRun: Map<number, number>`, built in the same
loop:

```typescript
const issueCountByRun = new Map<number, number>();
for (const row of tokenRows) {
  tokensByRun.set(Number(row.strategyRunId), {
    promptTokens: Number(row.promptTokens ?? 0),
    completionTokens: Number(row.completionTokens ?? 0),
  });
  issueCountByRun.set(Number(row.strategyRunId), Number(row.issueCount ?? 0));
}
```

### 2. Accumulation: every run with a model, regardless of status

`LeaderboardAccumulator`
([:123-153](../../../backend/src/modules/strategy/strategy.service.ts#L123-L153))
gains `issueCounts: number[]`, initialized alongside `costsUsd: []`
([:550](../../../backend/src/modules/strategy/strategy.service.ts#L550)).

Unlike cost — which only gets a value when both token totals *and* a
resolvable price exist, so `costsUsd` can end up shorter than the run
count — issue count is always knowable for any run that has `SolvePrompt`
rows at all: `0` when clean, a real number otherwise. So the push happens
unconditionally inside the same `if (run.modelName)` block that already
collects cost
([:586-593](../../../backend/src/modules/strategy/strategy.service.ts#L586-L593)),
defaulting to `0`:

```typescript
if (run.modelName) {
  // ...existing cost logic...
  acc.issueCounts.push(issueCountByRun.get(run.id) ?? 0);
}
```

This means `acc.issueCounts.length` always equals the number of runs with a
model — for a deterministic/shuffle row (`run.modelName` is always `null`
there) the array stays empty, so `avgIssues` comes out `null` automatically,
matching how `avgCostUsd` is already `null` for those rows today.

### 3. Output field

In the row-mapping (`rows: LeaderboardRowDto[] = [...]`,
[:596-645](../../../backend/src/modules/strategy/strategy.service.ts#L596-L645)),
add next to `avgCostUsd`:

```typescript
avgIssues:
  acc.issueCounts.length === 0
    ? null
    : acc.issueCounts.reduce((a, b) => a + b, 0) / acc.issueCounts.length,
```

`LeaderboardRowDto`
([strategy.dto.ts](../../../backend/src/modules/strategy/dto/strategy.dto.ts))
gains:

```typescript
// Mean count of issue-tagged SolvePrompt rows per run (see
// SolvePromptDto.issueTags) across every run this model has attempted,
// regardless of outcome — a failed or errored run can still carry
// issue-tagged prompts. null for deterministic/shuffle rows (no
// SolvePrompt rows at all), same as avgCostUsd.
avgIssues: number | null;
```

### 4. Frontend

`frontend/src/data/benchmark/types.ts`'s `LeaderboardRow` gains the mirrored
`avgIssues: number | null` field (same raw-JSON-passthrough contract as
every other `LeaderboardRow` field — no remapping in `api.ts`).

`StrategyTable.tsx`'s LLM-variant branch
([:79](../../../frontend/src/components/benchmark/StrategyTable.tsx#L79)
header,
[:152-155](../../../frontend/src/components/benchmark/StrategyTable.tsx#L152-L155)
cell) changes from:

```tsx
<th scope="col">Avg cost</th>
...
<td className="bench-mono">
  {row.avgCostUsd === null ? "—" : formatCostUsd(row.avgCostUsd)}
</td>
```

to:

```tsx
<th scope="col">Avg issues</th>
...
<td className="bench-mono">
  {row.avgIssues === null ? "—" : row.avgIssues.toFixed(1)}
</td>
```

`.toFixed(1)` inline rather than a new shared formatter in `metrics.ts` —
unlike `formatCostUsd` (reused across `StrategyTable`, `StrategyPuzzlePage`,
and `FreeTierBudgetWidget`), this is the only place `avgIssues` renders, so
a shared formatter would be premature (YAGNI). Matches the existing
`avgGuesses` metric's own inline formatting style
(`metrics.ts:24`: `Number.isInteger(value) ? String(value) : value.toFixed(1)`) —
plain `.toFixed(1)` is simpler and sufficient here since an issue count
average never needs the integer special-case (it's essentially always
fractional across more than one run).

### 5. Testing

- `strategy.service.spec.ts`'s existing `getLeaderboard` cost tests
  (e.g. [:1342](../../../backend/src/modules/strategy/strategy.service.spec.ts#L1342),
  [:1392](../../../backend/src/modules/strategy/strategy.service.spec.ts#L1392),
  [:1440](../../../backend/src/modules/strategy/strategy.service.spec.ts#L1440))
  need no mock changes at all — their mocked rows simply won't have an
  `issueCount` field, which the `?? 0` fallback above turns into `0`
  cleanly. No new assertions are required in these tests either; they stay
  focused on cost.
- New test(s) for `avgIssues` specifically: extend one of the existing
  `mockSolvePromptRepo.createQueryBuilder.mockReturnValue({...})` call
  sites' `getRawMany` rows with an `issueCount` field (e.g.
  `{ strategyRunId: 2, promptTokens: "0", completionTokens: "0", issueCount: "3" }`)
  and assert the resulting row's `avgIssues`. Cover: a model with
  issue-tagged prompts on some runs and clean ones on others averages
  across *all* of that model's runs (including the clean ones as `0`, not
  just the tagged ones); a deterministic row shows `avgIssues: null`
  (no `modelName`, so it never enters the `issueCounts` accumulation at
  all — same reasoning as `avgCostUsd: null` for those rows).
- `StrategyTable`/`LeaderboardPage` frontend tests: update row fixtures to
  include `avgIssues`, and change any assertion querying for the "Avg
  cost" header/cell text to "Avg issues".
