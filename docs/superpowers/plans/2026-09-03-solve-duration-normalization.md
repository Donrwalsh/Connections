# Solve Duration Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report an LLM strategy run's "duration" as the sum of its individual model-call latencies instead of the wall-clock span from start to finish, so rate-limit sleeps and daily parks no longer inflate the number.

**Architecture:** No schema change. `SolvePrompt.latencyMs` (already recorded per model call) is summed per run, live, on every read — the same correlated-subquery / grouped-map pattern the codebase already uses for `guessCount`, `issueCount`, and `tokenCostUsd`. Three backend read paths change (leaderboard average, run-history rows + sort, per-puzzle runs list); the frontend consumes a new `solveDurationMs` field and keeps a wall-clock fallback for deterministic strategies, which are otherwise untouched.

**Tech Stack:** NestJS + TypeORM (Postgres) backend with Jest; React + Vite frontend with Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-solve-duration-normalization-design.md`

## Global Constraints

- Deterministic / shuffle strategies keep wall-clock duration everywhere. Every change to a code path that also serves non-LLM runs must preserve `finishedAt - startedAt` behaviour for them via an explicit fallback.
- `CategoryEvaluation.latencyMs` (category-judge calls) is never included in a solve duration.
- `CALL_ERROR` `SolvePrompt` rows carry no `latencyMs`; no new plumbing is added to record it. A run whose only rows are `CALL_ERROR` therefore sums to SQL `NULL` → `solveDurationMs: null`.
- Field names `avgDurationMs` (leaderboard) and `durationMs` (`RunRecord`) are kept; their meaning changes underneath. New field is `solveDurationMs` on `RunHistoryRowDto` / `RunHistoryRow` and `StrategyRunListItemDto` / `StrategyRunListItem`.
- `startedAt` / `finishedAt` stay on every DTO that already carries them.
- Backend test command: `cd backend && npx jest <path> -t "<test name>"`. Frontend: `cd frontend && npx vitest run <path> -t "<test name>"`.
- Commit after each task with a `feat:` / `test:` scoped message.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `backend/src/modules/strategy/strategy.service.ts` | All three read paths | Modify `getLeaderboard`, `RUN_HISTORY_SORT_EXPR`, `getRunHistory`, `getRunsForPuzzleId` |
| `backend/src/modules/strategy/dto/strategy.dto.ts` | Response shapes | Add `solveDurationMs` to `RunHistoryRowDto` and `StrategyRunListItemDto` |
| `backend/src/modules/strategy/strategy.service.spec.ts` | Backend tests | Update leaderboard duration specs, run-history sort spec, fixtures; add new specs |
| `frontend/src/data/benchmark/types.ts` | Frontend DTO mirrors | Add `solveDurationMs` to `RunHistoryRow` and `StrategyRunListItem` |
| `frontend/src/data/benchmark/api.ts` | `toRunRecord` adapter | Feed `durationMs` from `solveDurationMs`, wall-clock fallback |
| `frontend/src/components/benchmark/RunHistoryTable.tsx` | Run-history table | Render `row.solveDurationMs` instead of computing wall-clock |
| `frontend/src/data/benchmark/__tests__/*` , `frontend/src/components/benchmark/__tests__/*` | Frontend tests | Update `toRunRecord` / `RunHistoryTable` / `RunsTable` specs |

---

## Task 1: Leaderboard `avgDurationMs` from summed call latency

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts` — `getLeaderboard` (approx. lines 498–560 for the query, 562–575 for map building, 638–668 for accumulation)
- Test: `backend/src/modules/strategy/strategy.service.spec.ts` — `describe("getLeaderboard")` (approx. line 1334)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no new exported symbol. `LeaderboardRowDto.avgDurationMs` keeps its type (`number | null`); only its computation changes.

**Background:** `getLeaderboard` runs a `Promise.all` whose third element (`tokenRows`) is a grouped `SolvePrompt` query already selecting `SUM(prompt.promptTokens)`, `SUM(prompt.completionTokens)`, and a filtered issue count. Its rows are consumed into `tokensByRun` / `issueCountByRun` maps. Duration is currently pushed as `run.finishedAt.getTime() - run.startedAt.getTime()` in two places: the `COMPLETED` branch (~line 642) and the LLM cap-`FAILED` branch (~line 667).

- [ ] **Step 1: Write the failing test**

Add to `describe("getLeaderboard")` in `strategy.service.spec.ts`:

```ts
it("averages solve duration from summed SolvePrompt latency, not the wall-clock span", async () => {
  mockStrategyRunRepo.find.mockResolvedValueOnce([
    {
      id: 1,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      status: StrategyRunStatus.COMPLETED,
      puzzleId: 1,
      // 3-hour wall-clock span — dominated by a rate-limit park, not real work.
      startedAt: new Date("2024-01-01T00:00:00Z"),
      finishedAt: new Date("2024-01-01T03:00:00Z"),
    },
    {
      id: 2,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      status: StrategyRunStatus.COMPLETED,
      puzzleId: 2,
      startedAt: new Date("2024-01-02T00:00:00Z"),
      finishedAt: new Date("2024-01-02T00:00:30Z"),
    },
  ]);
  mockGuessCounts([
    { strategyRunId: 1, count: "4" },
    { strategyRunId: 2, count: "4" },
  ]);
  mockPuzzleRepo.count.mockResolvedValueOnce(10);
  mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([
      { strategyRunId: 1, promptTokens: "0", completionTokens: "0", latencyMs: "2000" },
      { strategyRunId: 2, promptTokens: "0", completionTokens: "0", latencyMs: "4000" },
    ]),
  });

  const result = await service.getLeaderboard();

  const row = result.llm.find((r) => r.id === "gpt-4.1-nano")!;
  // (2000 + 4000) / 2 = 3000 — NOT the wall-clock average of ~5.4M ms.
  expect(row.avgDurationMs).toBe(3000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "averages solve duration from summed SolvePrompt latency"`
Expected: FAIL — `avgDurationMs` comes back as the wall-clock average (~5,406,000), not `3000`.

- [ ] **Step 3: Add `latencyMs` to the grouped SolvePrompt query**

In `getLeaderboard`'s `Promise.all`, the `this.solvePromptRepo.createQueryBuilder("prompt")` block (approx. line 528). Add one `addSelect` after the `completionTokens` one:

```ts
.addSelect("SUM(prompt.completionTokens)", "completionTokens")
.addSelect("SUM(prompt.latencyMs)", "latencyMs")
```

And widen that query's `getRawMany` generic to include `latencyMs: string | null`.

- [ ] **Step 4: Build a `latencyMsByRun` map**

In the loop over `tokenRows` (approx. line 569), alongside `tokensByRun` / `issueCountByRun`:

```ts
const latencyMsByRun = new Map<number, number>();
for (const row of tokenRows) {
  tokensByRun.set(Number(row.strategyRunId), {
    promptTokens: Number(row.promptTokens ?? 0),
    completionTokens: Number(row.completionTokens ?? 0),
  });
  issueCountByRun.set(Number(row.strategyRunId), Number(row.issueCount ?? 0));
  if (row.latencyMs !== null && row.latencyMs !== undefined) {
    latencyMsByRun.set(Number(row.strategyRunId), Number(row.latencyMs));
  }
}
```

- [ ] **Step 5: Push summed latency instead of the wall-clock span**

Replace both duration pushes. `COMPLETED` branch (~line 641):

```ts
if (run.status === StrategyRunStatus.COMPLETED) {
  acc.completed++;
  acc.guessCounts.push(guessCountByRun.get(run.id) ?? 0);
  const solveMs = latencyMsByRun.get(run.id);
  if (solveMs !== undefined) {
    acc.durationsMs.push(solveMs);
  }
}
```

LLM cap-`FAILED` branch (~line 665):

```ts
if (isLlmStrategy(run.strategyName)) {
  acc.guessCounts.push(guessCountByRun.get(run.id) ?? 0);
  const solveMs = latencyMsByRun.get(run.id);
  if (solveMs !== undefined) {
    acc.durationsMs.push(solveMs);
  }
}
```

The `run.finishedAt` null-guards those two pushes previously sat behind are now replaced by the `solveMs !== undefined` guard. Leave the surrounding status gating exactly as it is.

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "averages solve duration from summed SolvePrompt latency"`
Expected: PASS

- [ ] **Step 7: Fix the pre-existing leaderboard duration specs**

Several existing `getLeaderboard` tests assert `avgDurationMs` from wall-clock spans while relying on the *default* empty `mockSolvePromptRepo.createQueryBuilder` (which now yields `avgDurationMs: null`). Find every `getLeaderboard` test that asserts `avgDurationMs` (at minimum the one near line 1344, "should treat a lost LLM run … for progress/averages", which expects `45_000`). For each:

- Add a `mockSolvePromptRepo.createQueryBuilder.mockReturnValue({...})` stub (copy the shape from Step 1) whose `getRawMany` returns one row per run that should count, each with a `latencyMs` string.
- Recompute the expected `avgDurationMs` from those `latencyMs` values. For the line-1344 test, keep the intent ("the FAILED cap run counts, the DUPLICATE run does not"): give runs 1 and 2 `latencyMs` values whose average is a clean round number, give run 3 (DUPLICATE) a `latencyMs` too, and assert the average excludes run 3.

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "getLeaderboard"`
Expected: PASS (all `getLeaderboard` tests)

- [ ] **Step 8: Run the full strategy.service suite**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts`
Expected: PASS. If a non-`getLeaderboard` test broke, it is almost certainly another spec that hit the default SolvePrompt mock — apply the same stub fix.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat(strategy): leaderboard avg duration from summed call latency"
```

---

## Task 2: Run-history `solveDurationMs` column + duration sort

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts` — `RUN_HISTORY_SORT_EXPR` (approx. line 71), `getRunHistory` (approx. lines 1148–1268)
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts` — `RunHistoryRowDto` (approx. line 223)
- Test: `backend/src/modules/strategy/strategy.service.spec.ts` — `describe("getRunHistory")` (approx. line 1886)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RunHistoryRowDto.solveDurationMs: number | null` — Task 4 mirrors this on the frontend `RunHistoryRow` type; Task 5 renders it.

**Background:** `getRunHistory` builds one `createQueryBuilder("run")`, adds correlated-subquery `addSelect`s (`guessCount`, `issueCount`, `categoryCorrect/Partial/Lucky`, `tokenCostUsd`), orders by `RUN_HISTORY_SORT_EXPR[sortBy]`, paginates, and `getRawMany`s into a typed shape that a `.map` turns into `RunHistoryRowDto`. The existing `tokenCostUsd` select returns SQL `NULL` for unpriceable runs and is mapped `row.tokenCostUsd === null ? null : Number(row.tokenCostUsd)` — `solveDurationMs` follows that exact pattern.

- [ ] **Step 1: Write the failing test**

In `describe("getRunHistory")`, extend the `rawRun` helper (approx. line 1911) with `solveDurationMs: null` in its defaults, then add:

```ts
it("casts the SQL-summed solveDurationMs to a number, leaving NULL as null", async () => {
  mockRunHistoryQuery(2, [
    rawRun({ id: 1, modelName: "gpt-4.1-nano", solveDurationMs: "5500" }),
    rawRun({ id: 2, modelName: null, solveDurationMs: null }),
  ]);

  const result = await service.getRunHistory("llm-openai", {});

  expect(result.rows[0].solveDurationMs).toBe(5500);
  expect(result.rows[1].solveDurationMs).toBeNull();
});

it("sorts by duration on the summed-latency subquery, not the wall-clock span", async () => {
  const qb = mockRunHistoryQuery(0, []);

  await service.getRunHistory("llm-openai", { sortBy: "duration" });

  expect(qb.orderBy).toHaveBeenLastCalledWith(
    expect.stringContaining('SUM(sp."latencyMs")'),
    "DESC",
  );
  expect(qb.orderBy).not.toHaveBeenLastCalledWith(
    '(run."finishedAt" - run."startedAt")',
    "DESC",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "solveDurationMs"`
Expected: FAIL — `result.rows[0].solveDurationMs` is `undefined`; the sort still uses `(run."finishedAt" - run."startedAt")`.

- [ ] **Step 3: Add the field to `RunHistoryRowDto`**

In `dto/strategy.dto.ts`, in `RunHistoryRowDto`, after `finishedAt: Date | null;`:

```ts
finishedAt: Date | null;
// Summed model-call time for this run: SUM(SolvePrompt.latencyMs). This is
// the "duration" the run-history table shows and sorts on — deliberately
// NOT finishedAt - startedAt, which for LLM runs is inflated by rate-limit
// sleeps, daily parks, and backoffs. Null for non-LLM strategies (no
// SolvePrompt rows) and for an LLM run whose only rows are callErrors
// (no latency recorded). startedAt/finishedAt remain above for anyone
// who still wants the wall-clock span.
solveDurationMs: number | null;
guessCount: number;
```

- [ ] **Step 4: Change the duration sort expression**

In `RUN_HISTORY_SORT_EXPR` (approx. line 71):

```ts
duration:
  '(SELECT SUM(sp."latencyMs") FROM "SolvePrompt" sp WHERE sp."strategyRunId" = run.id)',
```

- [ ] **Step 5: Select `solveDurationMs` in the row query**

In `getRunHistory`, next to the `guessCount` / `issueCount` `addSelect`s (approx. line 1163):

```ts
.addSelect(
  `(SELECT SUM(sp."latencyMs") FROM "SolvePrompt" sp
    WHERE sp."strategyRunId" = run.id)::int`,
  "solveDurationMs",
)
```

Add `solveDurationMs: string | number | null;` to the `getRawMany<{...}>()` generic (approx. line 1235).

- [ ] **Step 6: Map it onto the row**

In the `rawRows.map((row) => ({...}))` (approx. line 1252), after `finishedAt`:

```ts
finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
solveDurationMs: row.solveDurationMs === null ? null : Number(row.solveDurationMs),
guessCount: Number(row.guessCount),
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "solveDurationMs"` then `-t "sorts by duration on the summed-latency subquery"`
Expected: PASS

- [ ] **Step 8: Fix the pre-existing duration-sort spec**

The test near line 2047 ("should sort by startedAt, duration, or tokenCost when asked") asserts:

```ts
expect(qb.orderBy).toHaveBeenLastCalledWith('(run."finishedAt" - run."startedAt")', "DESC");
```

Change that expected string to the new subquery:

```ts
expect(qb.orderBy).toHaveBeenLastCalledWith(
  '(SELECT SUM(sp."latencyMs") FROM "SolvePrompt" sp WHERE sp."strategyRunId" = run.id)',
  "DESC",
);
```

- [ ] **Step 9: Run the full `getRunHistory` suite**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "getRunHistory"`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat(strategy): run-history duration column and sort use summed call latency"
```

---

## Task 3: Per-puzzle runs list `solveDurationMs`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts` — `getRunsForPuzzleId` (approx. lines 1040–1081)
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts` — `StrategyRunListItemDto` (approx. line 127)
- Test: `backend/src/modules/strategy/strategy.service.spec.ts` — `describe("getRunsForPuzzleId")` (line 728) and `describe("getRunsForPuzzle")` (line 803)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `StrategyRunListItemDto.solveDurationMs: number | null` — Task 4 mirrors it on `StrategyRunListItem`; Task 4's `toRunRecord` reads it.

**Background:** `getRunsForPuzzleId` loads the runs, then runs one grouped `guessRepo` query over the run ids into a `countByRun` map, then maps each run to a `StrategyRunListItemDto`. Add a parallel grouped `solvePromptRepo` query the same way.

- [ ] **Step 1: Write the failing test**

In `describe("getRunsForPuzzleId")`:

```ts
it("attaches summed SolvePrompt latency per run, null when a run has none", async () => {
  mockStrategyRunRepo.find.mockResolvedValueOnce([
    { id: 8, strategyName: "llm-openai", trialNumber: 0, status: StrategyRunStatus.COMPLETED, modelName: "gpt-4.1-nano", contextWindow: null, startedAt: new Date("2024-01-01T00:00:00Z"), finishedAt: new Date("2024-01-01T02:00:00Z") },
    { id: 9, strategyName: "llm-openai", trialNumber: 1, status: StrategyRunStatus.FAILED, modelName: "gpt-4.1-nano", contextWindow: null, startedAt: new Date("2024-01-01T00:00:00Z"), finishedAt: new Date("2024-01-01T00:00:10Z") },
  ]);
  mockGuessRepo.createQueryBuilder.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([{ strategyRunId: 8, count: "4" }]),
  });
  mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([{ strategyRunId: 8, latencyMs: "6000" }]),
  });

  const result = await service.getRunsForPuzzleId(5, "llm-openai");

  expect(result.find((r) => r.id === 8)!.solveDurationMs).toBe(6000);
  expect(result.find((r) => r.id === 9)!.solveDurationMs).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "attaches summed SolvePrompt latency per run"`
Expected: FAIL — `solveDurationMs` is `undefined`.

- [ ] **Step 3: Add the field to `StrategyRunListItemDto`**

In `dto/strategy.dto.ts`, in `StrategyRunListItemDto`, after `finishedAt: Date | null;`:

```ts
finishedAt: Date | null;
// Summed model-call time for this run (SUM(SolvePrompt.latencyMs)) — see
// RunHistoryRowDto.solveDurationMs. Null for non-LLM runs and for LLM
// runs with no recorded call latency.
solveDurationMs: number | null;
guessCount: number;
```

- [ ] **Step 4: Query and map the sum**

In `getRunsForPuzzleId`, after the `countByRun` map is built (approx. line 1068), add:

```ts
const latencyRows = await this.solvePromptRepo
  .createQueryBuilder("prompt")
  .select("prompt.strategyRunId", "strategyRunId")
  .addSelect("SUM(prompt.latencyMs)", "latencyMs")
  .where("prompt.strategyRunId IN (:...ids)", { ids: runs.map((run) => run.id) })
  .groupBy("prompt.strategyRunId")
  .getRawMany<{ strategyRunId: number; latencyMs: string | null }>();

const solveDurationByRun = new Map<number, number>();
for (const row of latencyRows) {
  if (row.latencyMs !== null) {
    solveDurationByRun.set(Number(row.strategyRunId), Number(row.latencyMs));
  }
}
```

Then in the `runs.map((run) => ({...}))`, after `finishedAt: run.finishedAt,`:

```ts
finishedAt: run.finishedAt,
solveDurationMs: solveDurationByRun.get(run.id) ?? null,
guessCount: countByRun.get(run.id) ?? 0,
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "attaches summed SolvePrompt latency per run"`
Expected: PASS

- [ ] **Step 6: Fix the pre-existing `getRunsForPuzzle` mapping spec**

The test near line 827 ("should map every trial run ordered by trialNumber with a guess count") asserts a full `expect(result).toEqual([...])`. Add `solveDurationMs: null` to each expected object (the test doesn't stub `mockSolvePromptRepo.createQueryBuilder`, so the default empty mock yields `null`).

- [ ] **Step 7: Run both run-list suites**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t "getRunsForPuzzle"`
Expected: PASS (covers both `getRunsForPuzzleId` and `getRunsForPuzzle`)

- [ ] **Step 8: Run the full strategy.service suite + typecheck**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat(strategy): per-puzzle runs list carries summed call latency"
```

---

## Task 4: Frontend types + `toRunRecord` adapter

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts` — `RunHistoryRow` (approx. line 136), `StrategyRunListItem` (approx. line 297)
- Modify: `frontend/src/data/benchmark/api.ts` — `toRunRecord` (approx. line 277)
- Test: `frontend/src/components/benchmark/__tests__/RunsTable.test.tsx` (the `toRunRecord` consumer) or wherever `toRunRecord` is currently unit-tested — search for `toRunRecord` under `frontend/src`

**Interfaces:**
- Consumes: `StrategyRunListItemDto.solveDurationMs` (Task 3), `RunHistoryRowDto.solveDurationMs` (Task 2) — these arrive as raw JSON, so only the type mirrors need updating.
- Produces: `RunRecord.durationMs` now sourced from `solveDurationMs` with a wall-clock fallback.

- [ ] **Step 1: Write the failing test**

Find the existing `toRunRecord` test (search `frontend/src` for `toRunRecord`). Add two cases:

```ts
it("uses solveDurationMs for durationMs when the backend provides it", () => {
  const record = toRunRecord({
    id: 1, strategyName: "llm-openai", trialNumber: 0, status: "completed",
    modelName: "gpt-4.1-nano", contextWindow: null,
    startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T03:00:00Z",
    guessCount: 4, solveDurationMs: 6000,
  });
  expect(record.durationMs).toBe(6000);
});

it("falls back to wall-clock when solveDurationMs is null (deterministic run)", () => {
  const record = toRunRecord({
    id: 2, strategyName: "shuffle-smart", trialNumber: 0, status: "completed",
    modelName: null, contextWindow: null,
    startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T00:00:05Z",
    guessCount: 40, solveDurationMs: null,
  });
  expect(record.durationMs).toBe(5000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run -t "uses solveDurationMs for durationMs"`
Expected: FAIL — TypeScript rejects `solveDurationMs` on the argument, and/or `durationMs` is the wall-clock value in the first case.

- [ ] **Step 3: Add `solveDurationMs` to the frontend types**

In `types.ts`, `RunHistoryRow`, after `finishedAt: string | null;`:

```ts
finishedAt: string | null;
/** Summed model-call time for this run (SUM of SolvePrompt.latencyMs on
 * the backend) — the value the Duration column shows and sorts on.
 * Deliberately not finishedAt - startedAt, which for LLM runs is inflated
 * by rate-limit waits and daily parks. Null for non-LLM strategies and
 * for LLM runs with no recorded call latency. */
solveDurationMs: number | null;
```

In `StrategyRunListItem`, after `finishedAt: string | null;`:

```ts
finishedAt: string | null;
/** Summed model-call time for this run — see RunHistoryRow.solveDurationMs. */
solveDurationMs: number | null;
```

- [ ] **Step 4: Use it in `toRunRecord`**

In `api.ts` (approx. line 277):

```ts
export function toRunRecord(item: StrategyRunListItem): RunRecord {
  const durationMs =
    item.solveDurationMs ?? computeDurationMs(item.startedAt, item.finishedAt);

  return {
    runId: item.id,
    runNumber: item.trialNumber,
    status: item.status,
    totalSteps: item.guessCount,
    durationMs,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    modelName: item.modelName,
  };
}
```

(`computeDurationMs` stays imported — it is the fallback.)

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd frontend && npx vitest run -t "solveDurationMs"`
Expected: PASS

- [ ] **Step 6: Fix any other fixture that constructs a `StrategyRunListItem` / `RunHistoryRow`**

Run: `cd frontend && npx vitest run` and `cd frontend && npx tsc -b --noEmit`. TypeScript will flag every test fixture and mock missing `solveDurationMs`. Add `solveDurationMs: null` (or a representative number) to each. Common spots: `frontend/src/data/benchmark/mockData*`, `frontend/e2e/fixtures.ts` (only if it's a `.ts` fixture typed against these), `__tests__` files for `StrategyPuzzlePage`, `RunsTable`, and any run-history page test.
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src
git commit -m "feat(benchmark): toRunRecord uses backend solveDurationMs with wall-clock fallback"
```

---

## Task 5: Run-history table renders `solveDurationMs`

**Files:**
- Modify: `frontend/src/components/benchmark/RunHistoryTable.tsx` (imports approx. line 2, row body approx. line 102)
- Test: `frontend/src/components/benchmark/__tests__/RunHistoryTable.test.tsx` (search for the actual filename under `__tests__`)

**Interfaces:**
- Consumes: `RunHistoryRow.solveDurationMs` (Task 4).
- Produces: nothing downstream.

**Background:** the component currently computes `const durationMs = computeDurationMs(row.startedAt, row.finishedAt);` per row (approx. line 103) and renders `{durationMs === null ? "—" : formatDuration(durationMs)}` (approx. line 123).

- [ ] **Step 1: Write the failing test**

In the `RunHistoryTable` test file, add (adapting to the file's existing render helper / row fixture):

```ts
it("shows solveDurationMs formatted, and a dash when it is null", () => {
  renderRunHistoryTable({
    rows: [
      makeRow({ id: 1, solveDurationMs: 6000, startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T03:00:00Z" }),
      makeRow({ id: 2, solveDurationMs: null }),
    ],
  });

  // 6000 ms formatted by formatDuration — NOT the 3-hour wall-clock span.
  expect(screen.getByText(formatDuration(6000))).toBeInTheDocument();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});
```

If the test file has no `makeRow` helper, add `solveDurationMs` to whatever inline row objects it builds.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/RunHistoryTable.test.tsx -t "shows solveDurationMs formatted"`
Expected: FAIL — the cell shows the wall-clock span, not `formatDuration(6000)`.

- [ ] **Step 3: Render `row.solveDurationMs` directly**

In `RunHistoryTable.tsx`, remove the per-row `computeDurationMs` call (approx. line 103) and change the duration cell (approx. line 123):

```tsx
<td className="bench-mono">
  {row.solveDurationMs === null ? "—" : formatDuration(row.solveDurationMs)}
</td>
```

Remove `computeDurationMs` from the import block (approx. line 3) — confirm it is not used elsewhere in this file first (`grep computeDurationMs RunHistoryTable.tsx`).

- [ ] **Step 4: Run the new test to verify it passes**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/RunHistoryTable.test.tsx -t "shows solveDurationMs formatted"`
Expected: PASS

- [ ] **Step 5: Run the full `RunHistoryTable` test file**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/RunHistoryTable.test.tsx`
Expected: PASS. Update any existing row fixture in this file that now needs `solveDurationMs`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/benchmark/RunHistoryTable.tsx frontend/src/components/benchmark/__tests__/RunHistoryTable.test.tsx
git commit -m "feat(benchmark): run-history Duration column renders solveDurationMs"
```

---

## Task 6: Full-suite verification + backend/frontend contract check

**Files:** none modified — verification only. Fold any fixups discovered here into the task they belong to if working task-by-task; otherwise commit them here.

- [ ] **Step 1: Backend — full strategy module suite**

Run: `cd backend && npx jest src/modules/strategy`
Expected: PASS.

- [ ] **Step 2: Backend — typecheck + lint**

Run: `cd backend && npx tsc --noEmit -p tsconfig.json && npm run lint`
Expected: PASS.

- [ ] **Step 3: Backend — e2e (contract shape)**

Run: `cd backend && npm run test:e2e`
Expected: PASS. `backend/test/app.e2e-spec.ts` already stubs `latencyMs: 100` (line ~100); if an assertion pins the exact shape of a run-history or runs-list response, add `solveDurationMs` to the expectation.

- [ ] **Step 4: Frontend — full suite**

Run: `cd frontend && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Frontend — typecheck + lint + build**

Run: `cd frontend && npx tsc -b --noEmit && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Grep for stragglers**

Run:
```bash
grep -rn "computeDurationMs" frontend/src
grep -rn 'finishedAt.*getTime().*startedAt.*getTime()' backend/src/modules/strategy
```
Expected: `computeDurationMs` remains only in `metrics.ts` (definition), `api.ts` (`toRunRecord` fallback), and `metrics` tests. The backend grep should return no hits in `strategy.service.ts` for duration purposes (the RPD-resume `finishedAt = null` code is unrelated and stays).

- [ ] **Step 7: Manual smoke (optional but recommended)**

Start the stack (`docker compose -p connections-dev up` per project convention) and confirm: the leaderboard "Avg duration" for an LLM model with known rate-limited runs is now seconds/minutes not hours; the run-history "Duration" column and its sort behave; a deterministic strategy's run-history still shows a wall-clock-derived duration via the fallback.

- [ ] **Step 8: Commit any fixups**

```bash
git add -A
git commit -m "test(strategy): align remaining fixtures with solveDurationMs"
```

---

## Self-review

**Spec coverage:**
- Leaderboard `avgDurationMs` → Task 1. ✓
- Run-history rows + `RUN_HISTORY_SORT_EXPR` duration sort → Task 2. ✓
- Per-puzzle runs list (`getRunsForPuzzleId`) → Task 3. ✓
- `RunHistoryRowDto` / `StrategyRunListItemDto` new field → Tasks 2, 3. ✓
- Frontend `types.ts`, `toRunRecord` fallback, `RunHistoryTable` → Tasks 4, 5. ✓
- `computeDurationMs` / `formatDuration` retained → Tasks 4, 5, verified Task 6 Step 6. ✓
- Deterministic strategies unchanged (wall-clock fallback) → Task 4 Step 1 second case, Task 6 Step 7. ✓
- `CALL_ERROR` / all-null-latency run → `null` → covered by the `NULL`-mapping tests in Tasks 2 and 3. ✓
- `startedAt` / `finishedAt` stay on DTOs → Tasks 2, 3 add the field beside them, never replace. ✓
- Out of scope (no `CALL_ERROR` latency plumbing, no judge latency, no stored column, no migration) → nothing in any task does these. ✓

**Placeholder scan:** No TBD/TODO. Every code step has literal code. Test names and expected values are concrete.

**Type consistency:** `solveDurationMs: number | null` is identical across `RunHistoryRowDto`, `StrategyRunListItemDto`, `RunHistoryRow`, `StrategyRunListItem`. The SQL subquery string `(SELECT SUM(sp."latencyMs") FROM "SolvePrompt" sp WHERE sp."strategyRunId" = run.id)` is byte-identical in `RUN_HISTORY_SORT_EXPR` (Task 2 Step 4), the row `addSelect` (Task 2 Step 5, plus `::int`), and the sort-spec assertion (Task 2 Step 8). `toRunRecord` uses `item.solveDurationMs ?? computeDurationMs(...)` — the `??` (not `||`) so a real `0` sum is kept, not replaced by wall-clock.

---

## Execution options

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.

**2. Inline Execution** — execute tasks in this session via executing-plans, checkpoints for review.
