# Leaderboard "Avg Issues" and Success-Rate Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the primary leaderboard's "Avg cost" column with "Avg issues" (mean issue-tagged `SolvePrompt` rows per run), and fix `successRate` display across the app to show up to 3 significant figures instead of a rounded whole percent.

**Architecture:** Backend: fold a new issue-count aggregate into `StrategyService.getLeaderboard`'s existing per-run token-sum query (not a second query — avoids a mock collision in the existing test suite), accumulate it the same way cost already is, and expose it as a new `avgIssues` field. Frontend: swap `StrategyTable.tsx`'s LLM column from cost to issues, and add a shared `formatSuccessRate` formatter used by both `StrategyTable.tsx` and `StrategyPuzzlePage.tsx`.

**Tech Stack:** NestJS + TypeORM (backend), React + Vite (frontend), Jest (backend tests), Vitest (frontend tests).

**Spec:** [docs/superpowers/specs/2026-08-27-leaderboard-avg-issues-design.md](../specs/2026-08-27-leaderboard-avg-issues-design.md)

## Global Constraints

- `avgIssues` is folded into the *existing* per-run `SolvePrompt` token-sum query in `getLeaderboard` — never a second `solvePromptRepo.createQueryBuilder()` call. A second call would collide with existing cost tests' `mockReturnValue` (not `mockReturnValueOnce`) stubbing, silently feeding token-shaped mock rows into the issue-count parse.
- `issueCounts` accumulates for every run with a `modelName`, regardless of status or whether cost was priceable — issue count is always knowable (`0` when clean), unlike cost which needs a resolvable rate.
- No `totalIssues` field, and `avgIssues` never becomes a sortable `LeaderboardMetricKey` — it's a display-only column, same as `avgCostUsd` was.
- `avgCostUsd`/`totalCostUsd` and every other consumer of them (`StrategyPuzzlePage.tsx`'s cost summary, `FreeTierBudgetWidget.tsx`, `sumSpendUsd`) are untouched.
- `formatSuccessRate(value)` = `` `${Number(value.toPrecision(3))}%` `` — round-tripping through `Number` drops the trailing zeros `toPrecision` always includes, so round numbers stay clean (`"100%"`, `"5%"`) instead of padding to `"100.00%"`/`"5.00%"`.
- `MetricDefinition.format` in `metrics.ts` (the `successRate` entry in `LEADERBOARD_METRICS`) is confirmed dead code — nothing calls it. Leave it untouched.

---

### Task 1: Backend — `avgIssues` on `getLeaderboard`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts:123-153` (interface), `:489-499` (query), `:511-517` (map-building), `:550` (accumulator init), `:586-593` (push), `:639-640` (output)
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts:152-153`
- Test: `backend/src/modules/strategy/strategy.service.spec.ts:1298-1376`

**Interfaces:**
- Consumes: nothing new.
- Produces: `LeaderboardRowDto.avgIssues: number | null`. Task 2 (frontend) consumes this exact field name and type.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/strategy/strategy.service.spec.ts`, find the test `"should compute avg/total cost per model from token usage and rates, leaving deterministic rows and unpriceable models null"` (starts at line 1298). Replace its `mockSolvePromptRepo.createQueryBuilder.mockReturnValue({...})` block:

```typescript
      mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 2, promptTokens: "1000000", completionTokens: "500000" },
          { strategyRunId: 3, promptTokens: "1000000", completionTokens: "500000" },
          { strategyRunId: 4, promptTokens: "1000000", completionTokens: "0" },
        ]),
      });
```

with (adding `issueCount` to two of the three rows, deliberately leaving row 3 without one to exercise the `?? 0` fallback):

```typescript
      mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 2, promptTokens: "1000000", completionTokens: "500000", issueCount: "3" },
          { strategyRunId: 3, promptTokens: "1000000", completionTokens: "500000" },
          { strategyRunId: 4, promptTokens: "1000000", completionTokens: "0", issueCount: "2" },
        ]),
      });
```

Then replace the test's assertions block:

```typescript
      const result = await service.getLeaderboard();

      const alphabetical = result.deterministic.find((row) => row.id === "alphabetical")!;
      expect(alphabetical.avgCostUsd).toBeNull();
      expect(alphabetical.totalCostUsd).toBeNull();

      // 2 runs at $0.30 each ((1 * 0.1) + (0.5 * 0.4)) = $0.60 total, $0.30 avg.
      const gptNano = result.llm.find((row) => row.id === "gpt-4.1-nano")!;
      expect(gptNano.totalCostUsd).toBeCloseTo(0.6);
      expect(gptNano.avgCostUsd).toBeCloseTo(0.3);

      const gptMini = result.llm.find((row) => row.id === "gpt-4o-mini")!;
      expect(gptMini.avgCostUsd).toBeNull();
      expect(gptMini.totalCostUsd).toBeNull();
    });
```

with:

```typescript
      const result = await service.getLeaderboard();

      const alphabetical = result.deterministic.find((row) => row.id === "alphabetical")!;
      expect(alphabetical.avgCostUsd).toBeNull();
      expect(alphabetical.totalCostUsd).toBeNull();
      expect(alphabetical.avgIssues).toBeNull();

      // 2 runs at $0.30 each ((1 * 0.1) + (0.5 * 0.4)) = $0.60 total, $0.30 avg.
      const gptNano = result.llm.find((row) => row.id === "gpt-4.1-nano")!;
      expect(gptNano.totalCostUsd).toBeCloseTo(0.6);
      expect(gptNano.avgCostUsd).toBeCloseTo(0.3);
      // issueCount 3 on run 2, no issueCount field (defaults to 0 via the
      // ?? fallback) on run 3 -> (3 + 0) / 2 = 1.5.
      expect(gptNano.avgIssues).toBeCloseTo(1.5);

      const gptMini = result.llm.find((row) => row.id === "gpt-4o-mini")!;
      expect(gptMini.avgCostUsd).toBeNull();
      expect(gptMini.totalCostUsd).toBeNull();
      // gpt-4o-mini has no priceable rate (avgCostUsd/totalCostUsd stay
      // null above), but its run's issueCount of 2 still counts -> issue
      // counting is never gated on cost being resolvable.
      expect(gptMini.avgIssues).toBe(2);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest strategy.service.spec.ts -t "should compute avg/total cost"`
Expected: FAIL — `avgIssues` is `undefined` on every row (the field doesn't exist on `LeaderboardRowDto` or `getLeaderboard`'s output yet).

- [ ] **Step 3: Update `backend/src/modules/strategy/dto/strategy.dto.ts`**

In `LeaderboardRowDto`, insert right after `totalCostUsd: number | null;` (currently line 153):

```typescript
  // Mean count of issue-tagged SolvePrompt rows per run (see
  // SolvePromptDto.issueTags) across every run this model has attempted,
  // regardless of outcome — a failed or errored run can still carry
  // issue-tagged prompts. null for deterministic/shuffle rows (no
  // SolvePrompt rows at all), same as avgCostUsd.
  avgIssues: number | null;
```

- [ ] **Step 4: Update `backend/src/modules/strategy/strategy.service.ts`**

Replace the `LeaderboardAccumulator` interface's final field (currently ending at line 153):

```typescript
  // USD cost of every run with resolvable token usage and a resolvable
  // model rate — unlike guesses/duration this covers every run regardless
  // of outcome, since a failed or errored LLM run still spent tokens.
  costsUsd: number[];
}
```

with:

```typescript
  // USD cost of every run with resolvable token usage and a resolvable
  // model rate — unlike guesses/duration this covers every run regardless
  // of outcome, since a failed or errored LLM run still spent tokens.
  costsUsd: number[];
  // Issue-tagged SolvePrompt count for every run with a model, regardless
  // of status or whether cost was priceable — unlike costsUsd, issue
  // count is always knowable (0 when clean), so this array's length always
  // equals the number of runs with a model, not a subset of them.
  issueCounts: number[];
}
```

Replace the per-run token-sum query (currently):

```typescript
      this.solvePromptRepo
        .createQueryBuilder("prompt")
        .select("prompt.strategyRunId", "strategyRunId")
        .addSelect("SUM(prompt.promptTokens)", "promptTokens")
        .addSelect("SUM(prompt.completionTokens)", "completionTokens")
        .groupBy("prompt.strategyRunId")
        .getRawMany<{
          strategyRunId: number;
          promptTokens: string | null;
          completionTokens: string | null;
        }>(),
```

with:

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

Replace the map-building loop right after it (currently):

```typescript
    const tokensByRun = new Map<number, { promptTokens: number; completionTokens: number }>();
    for (const row of tokenRows) {
      tokensByRun.set(Number(row.strategyRunId), {
        promptTokens: Number(row.promptTokens ?? 0),
        completionTokens: Number(row.completionTokens ?? 0),
      });
    }
```

with:

```typescript
    const tokensByRun = new Map<number, { promptTokens: number; completionTokens: number }>();
    const issueCountByRun = new Map<number, number>();
    for (const row of tokenRows) {
      tokensByRun.set(Number(row.strategyRunId), {
        promptTokens: Number(row.promptTokens ?? 0),
        completionTokens: Number(row.completionTokens ?? 0),
      });
      issueCountByRun.set(Number(row.strategyRunId), Number(row.issueCount ?? 0));
    }
```

Replace the accumulator's initial-value object (currently):

```typescript
        acc = {
          strategyName: run.strategyName,
          modelName: run.modelName,
          puzzleIds: new Set(),
          completed: 0,
          active: 0,
          failed: 0,
          lostRuns: 0,
          guessCounts: [],
          durationsMs: [],
          costsUsd: [],
        };
```

with:

```typescript
        acc = {
          strategyName: run.strategyName,
          modelName: run.modelName,
          puzzleIds: new Set(),
          completed: 0,
          active: 0,
          failed: 0,
          lostRuns: 0,
          guessCounts: [],
          durationsMs: [],
          costsUsd: [],
          issueCounts: [],
        };
```

Replace the cost-push block (currently):

```typescript
      // Cost counts for every run regardless of outcome — a failed or
      // errored LLM run still spent tokens — so this sits outside the
      // status branches above.
      if (run.modelName) {
        const tokens = tokensByRun.get(run.id);
        const history = priceHistoryByModel.get(leaderboardKey(run.strategyName, run.modelName));
        const rate = priceAsOf(history, run.startedAt);
        if (tokens && rate) {
          acc.costsUsd.push(computeTokenCostUsd(tokens.promptTokens, tokens.completionTokens, rate));
        }
      }
    }
```

with:

```typescript
      // Cost counts for every run regardless of outcome — a failed or
      // errored LLM run still spent tokens — so this sits outside the
      // status branches above. Issue count is pushed the same way, but
      // unconditionally (not gated on a resolvable rate) since it's always
      // knowable, not just when cost happens to be.
      if (run.modelName) {
        const tokens = tokensByRun.get(run.id);
        const history = priceHistoryByModel.get(leaderboardKey(run.strategyName, run.modelName));
        const rate = priceAsOf(history, run.startedAt);
        if (tokens && rate) {
          acc.costsUsd.push(computeTokenCostUsd(tokens.promptTokens, tokens.completionTokens, rate));
        }
        acc.issueCounts.push(issueCountByRun.get(run.id) ?? 0);
      }
    }
```

Finally, in the row-mapping (`rows: LeaderboardRowDto[] = [...]`), replace:

```typescript
        avgCostUsd: totalCostUsd === null ? null : totalCostUsd / acc.costsUsd.length,
        totalCostUsd,
```

with:

```typescript
        avgCostUsd: totalCostUsd === null ? null : totalCostUsd / acc.costsUsd.length,
        totalCostUsd,
        avgIssues:
          acc.issueCounts.length === 0
            ? null
            : acc.issueCounts.reduce((a, b) => a + b, 0) / acc.issueCounts.length,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest strategy.service.spec.ts -t "should compute avg/total cost"`
Expected: PASS

- [ ] **Step 6: Run the full backend test suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS (in particular every other `getLeaderboard` test, whose mocked `SolvePrompt` rows simply lack an `issueCount` field — the `?? 0` fallback means they're unaffected)

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat: add avgIssues to the leaderboard, folded into the existing token-sum query"
```

---

### Task 2: Frontend — swap "Avg cost" for "Avg issues" on the primary leaderboard

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts:99-100`
- Modify: `frontend/src/components/benchmark/StrategyTable.tsx:1-10,79,152-155`
- Modify: `frontend/src/pages/benchmark/__tests__/LeaderboardPage.test.tsx:37-58,82-84,162-201`
- Modify: `frontend/src/data/benchmark/mockData.test.ts:5-26,81-100`
- Modify: `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx:41-59`
- Modify: `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx:27-45`

**Interfaces:**
- Consumes: `LeaderboardRowDto.avgIssues: number | null` from Task 1, fetched as raw JSON (no remapping — same contract as every other `LeaderboardRow` field).
- Produces: `LeaderboardRow.avgIssues: number | null`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/pages/benchmark/__tests__/LeaderboardPage.test.tsx`:

Add `avgIssues: null,` to the `makeRow` factory's base object, right after `totalCostUsd: null,` (currently line 52):

```typescript
    avgCostUsd: null,
    totalCostUsd: null,
    avgIssues: null,
    contextWindow: null,
```

Add `avgIssues: 1.5,` to the `llm` row's overrides in the `leaderboard` fixture (currently lines 72-84):

```typescript
  llm: [
    makeRow({
      id: "gpt-4.1-nano-2025-04-14",
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano-2025-04-14",
      kind: "llm",
      successRate: 80,
      avgGuessesToSolve: 4.2,
      minGuesses: 2,
      maxGuesses: 8,
      progress: { completed: 4, active: 1, failed: 1, queued: 3 },
      avgCostUsd: 0.1234,
      totalCostUsd: 0.4936,
      avgIssues: 1.5,
    }),
  ],
```

Replace the test `"shows the right column set per table: LLM gets success rate/avg duration/avg cost, deterministic gets avg speed/guesses/range"` (starting at line 162) with:

```typescript
  it("shows the right column set per table: LLM gets success rate/avg duration/avg issues, deterministic gets avg speed/guesses/range", async () => {
    stubFetch(leaderboard);
    renderLeaderboard();

    const tables = await screen.findAllByRole("table");

    // LLM table (first): Success rate, Avg duration, Avg issues — no Avg
    // guesses, Range, or Avg speed (that's the deterministic table's
    // solves/hr framing; LLM shows raw wall-clock duration instead).
    expect(within(tables[0]!).getByRole("columnheader", { name: "Success rate" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg duration" })).toBeInTheDocument();
    expect(within(tables[0]!).getByRole("columnheader", { name: "Avg issues" })).toBeInTheDocument();
    expect(
      within(tables[0]!).queryByRole("columnheader", { name: "Avg guesses" }),
    ).not.toBeInTheDocument();
    expect(within(tables[0]!).queryByRole("columnheader", { name: "Range" })).not.toBeInTheDocument();
    expect(within(tables[0]!).queryByRole("columnheader", { name: "Avg speed" })).not.toBeInTheDocument();
    expect(within(tables[0]!).getByText("80%")).toBeInTheDocument();
    expect(within(tables[0]!).getByText("1.5")).toBeInTheDocument();
    // gpt row: avgDurationMs 12 -> raw duration, not a derived solves/hr rate.
    expect(firstRowIn(tables[0]!).textContent).toContain("12ms");

    // Deterministic table (second): Avg speed, Avg guesses, Range — no
    // Success rate, Avg issues, or Avg duration (deterministic strategies
    // have no LLM issue-tag concept, and their near-instant runs read
    // better as a derived solves/hr rate than a raw millisecond duration).
    expect(within(tables[1]!).getByRole("columnheader", { name: "Avg speed" })).toBeInTheDocument();
    expect(within(tables[1]!).getByRole("columnheader", { name: "Avg guesses" })).toBeInTheDocument();
    expect(within(tables[1]!).getByRole("columnheader", { name: "Range" })).toBeInTheDocument();
    expect(
      within(tables[1]!).queryByRole("columnheader", { name: "Success rate" }),
    ).not.toBeInTheDocument();
    expect(within(tables[1]!).queryByRole("columnheader", { name: "Avg issues" })).not.toBeInTheDocument();
    expect(
      within(tables[1]!).queryByRole("columnheader", { name: "Avg duration" }),
    ).not.toBeInTheDocument();
    // alphabetical row: avgDurationMs 12 -> 3,600,000 / 12 = 300,000 solves/hr,
    // shown as a value line plus a "solves/hr" unit caption underneath.
    expect(firstRowIn(tables[1]!).textContent).toContain("300,000solves/hr");
  });
```

This replaces the entire original test (which ran from `it("shows the right column set per table: LLM gets success rate/avg duration/avg cost, ...")` at line 162 through its closing `});` at line 201) verbatim except for the three differences: the test title, "Avg cost" → "Avg issues" in the two `columnheader` assertions and one comment, and `getByText("$0.12")` → `getByText("1.5")`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run LeaderboardPage.test.tsx -t "shows the right column set"`
Expected: FAIL — `StrategyTable.tsx` still renders "Avg cost", not "Avg issues", and `row.avgIssues` doesn't exist on the type yet (TypeScript error on the fixture).

- [ ] **Step 3: Update `frontend/src/data/benchmark/types.ts`**

Replace:

```typescript
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  /** Current model metadata (not run-time-historical, unlike cost) — see
```

with:

```typescript
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  /** Mean count of issue-tagged solve steps per run (see
   * SolvePromptRecord.issueTags) across every run this model has
   * attempted, regardless of outcome. null for deterministic/shuffle rows
   * (no SolvePrompt rows at all), same as avgCostUsd. */
  avgIssues: number | null;
  /** Current model metadata (not run-time-historical, unlike cost) — see
```

- [ ] **Step 4: Update `frontend/src/components/benchmark/StrategyTable.tsx`**

Replace the import block:

```typescript
import {
  formatCostUsd,
  formatDuration,
  formatGuessCount,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
```

with:

```typescript
import {
  formatDuration,
  formatGuessCount,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
```

Replace the header cell:

```tsx
            <th scope="col">Avg cost</th>
```

with:

```tsx
            <th scope="col">Avg issues</th>
```

Replace the data cell:

```tsx
                <td className="bench-mono">
                  {row.avgCostUsd === null ? "—" : formatCostUsd(row.avgCostUsd)}
                </td>
```

with:

```tsx
                <td className="bench-mono">
                  {row.avgIssues === null ? "—" : row.avgIssues.toFixed(1)}
                </td>
```

- [ ] **Step 5: Fix the other 3 fixture files so the project still compiles**

`LeaderboardRow` is now missing `avgIssues` in three more test fixtures. None of these tests exercise `avgIssues` behavior — they just need the field present for `LeaderboardRow` to type-check.

In `frontend/src/data/benchmark/mockData.test.ts`, add `avgIssues: null,` right after `totalCostUsd: 0.1,` in `makeLlmRow` (currently line 20):

```typescript
    avgCostUsd: 0.1,
    totalCostUsd: 0.1,
    avgIssues: null,
    contextWindow: null,
```

and add `avgIssues: null,` right after `totalCostUsd: null,` in the inline `LeaderboardRow` literal inside `"leaves deterministic rows unaffected"` (currently line 96):

```typescript
      avgCostUsd: null,
      totalCostUsd: null,
      avgIssues: null,
      contextWindow: null,
```

In `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`, add `avgIssues: null,` right after `totalCostUsd: null,` in the `makeRow` factory (currently line 57):

```typescript
    avgCostUsd: null,
    totalCostUsd: null,
    avgIssues: null,
    contextWindow: null,
```

In `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`, add `avgIssues: null,` right after `totalCostUsd: null,` in the `makeLeaderboardRow` factory (currently line 41):

```typescript
    avgCostUsd: null,
    totalCostUsd: null,
    avgIssues: null,
    contextWindow: null,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run LeaderboardPage.test.tsx mockData.test.ts ActivityPage.test.tsx StrategyPuzzlePage.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend test suite and typecheck to check for regressions**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/components/benchmark/StrategyTable.tsx frontend/src/pages/benchmark/__tests__/LeaderboardPage.test.tsx frontend/src/data/benchmark/mockData.test.ts frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx
git commit -m "feat: swap the leaderboard's Avg cost column for Avg issues"
```

---

### Task 3: Frontend — shared `formatSuccessRate`, used everywhere success rate renders

**Files:**
- Create: `frontend/src/data/benchmark/metrics.test.ts`
- Modify: `frontend/src/data/benchmark/metrics.ts`
- Modify: `frontend/src/components/benchmark/StrategyTable.tsx`
- Modify: `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`

**Interfaces:**
- Consumes: nothing new (Task 2 must land first — this task's edit to `StrategyTable.tsx`'s import block starts from Task 2's already-modified version).
- Produces: `formatSuccessRate(value: number): string`, exported from `metrics.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/data/benchmark/metrics.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatSuccessRate } from "./metrics";

describe("formatSuccessRate", () => {
  it("shows 3 significant figures for a low rate instead of rounding to 0%", () => {
    expect(formatSuccessRate(0.333)).toBe("0.333%");
  });

  it("doesn't pad a round number with trailing zeros", () => {
    expect(formatSuccessRate(100)).toBe("100%");
    expect(formatSuccessRate(5)).toBe("5%");
  });

  it("rounds rather than truncates", () => {
    expect(formatSuccessRate(45.678)).toBe("45.7%");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run metrics.test.ts`
Expected: FAIL — `formatSuccessRate` is not exported from `metrics.ts`.

- [ ] **Step 3: Add `formatSuccessRate` to `frontend/src/data/benchmark/metrics.ts`**

Add this function after `formatCostUsd` (which ends at line 129):

```typescript
/** Success rate to 3 significant figures rather than a rounded whole
 * percent — an occasionally-successful model (e.g. 1 win in 300 attempts,
 * 0.33%) would otherwise round to "0%", indistinguishable from a model
 * that has never solved anything. Number(...toPrecision(3)) rather than a
 * fixed decimal count so round numbers stay clean ("100%", "5%") instead
 * of padding to "100.00%"/"5.00%". */
export function formatSuccessRate(value: number): string {
  return `${Number(value.toPrecision(3))}%`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Use it in `frontend/src/components/benchmark/StrategyTable.tsx`**

Replace the import block (as left by Task 2):

```typescript
import {
  formatDuration,
  formatGuessCount,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
```

with:

```typescript
import {
  formatDuration,
  formatGuessCount,
  formatSuccessRate,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
```

Replace:

```typescript
          const successRateDisplay = row.successRate === null ? "—" : `${Math.round(row.successRate)}%`;
```

with:

```typescript
          const successRateDisplay = row.successRate === null ? "—" : formatSuccessRate(row.successRate);
```

- [ ] **Step 6: Use it in `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`**

Replace the import:

```typescript
import { formatCostUsd, formatDuration } from "../../data/benchmark/metrics";
```

with:

```typescript
import { formatCostUsd, formatDuration, formatSuccessRate } from "../../data/benchmark/metrics";
```

Replace:

```tsx
                <span className="bench-mono">
                  {leaderboardRow.successRate === null
                    ? "—"
                    : `${Math.round(leaderboardRow.successRate)}%`}
                </span>
```

with:

```tsx
                <span className="bench-mono">
                  {leaderboardRow.successRate === null ? "—" : formatSuccessRate(leaderboardRow.successRate)}
                </span>
```

- [ ] **Step 7: Run the full frontend test suite and typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS. Every existing test asserting a rendered success-rate string uses a round-number fixture (`100`, `60`, `80`) — `formatSuccessRate` renders those identically to the old `Math.round(...)%`, so no other test needs a fixture or assertion change.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/data/benchmark/metrics.ts frontend/src/data/benchmark/metrics.test.ts frontend/src/components/benchmark/StrategyTable.tsx frontend/src/pages/benchmark/StrategyPuzzlePage.tsx
git commit -m "feat: show success rate to 3 significant figures instead of a rounded whole percent"
```

## Final Verification

- [ ] Run the full backend suite: `cd backend && npm test`
- [ ] Run the full frontend suite and typecheck: `cd frontend && npx vitest run && npx tsc --noEmit`
- [ ] Manually load the Leaderboard page against a local backend with at least one LLM run that has issue-tagged prompts, and confirm the LLM table's "Avg issues" column renders a sensible decimal (not "—" for a model with runs) while the deterministic table has no such column at all.
