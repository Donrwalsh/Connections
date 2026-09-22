# Activity Feed Last-Activity Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Activity page's "Puzzle Solves" table sort by last activity (`StrategyRun.updatedAt`) instead of creation time (`StrategyRun.startedAt`), so a manually retried run — which reuses its existing row and never touches `startedAt` — rises to the top of the feed the moment it's retried and stays visible while it progresses.

**Architecture:** `StrategyReadService.getRecentActivity`'s run query currently selects and orders by `run.startedAt`. Swap both to `run.updatedAt`, which TypeORM already bumps on every save to a `StrategyRun` row — including the status flip `StrategyDispatch.retryRun` performs and every subsequent `StrategyRunStoreService.flushBatch` progress save. No schema change. The frontend's `RecentActivityTable` renders whatever `occurredAt` it's given already, so only its column header text changes, from "When" to "Last activity".

**Tech Stack:** NestJS + TypeORM (Postgres) query builder on the backend; React + TypeScript (Vite) on the frontend; Jest (backend) and Vitest (frontend) for tests.

**Spec:** `docs/architecture/specs/activity-feed-last-activity-sort.md`

## Global Constraints

- No new database columns or migrations — this is a query + display change only.
- The "Category Judgments" list (`judgmentQb` in `getRecentActivity`) is unchanged; only the "Puzzle Solves" (`runQb`) query and its rendering are touched.
- No relative-time ("2m ago") formatting — keep the existing absolute date+time formatters as-is.
- No new "retried" badge/marker and no sort-order toggle — the sort is fully replaced, not made switchable.

---

### Task 1: Sort the Activity feed's run query by `updatedAt`

**Files:**
- Modify: `backend/src/modules/strategy/strategy-read.service.ts:1210-1248` (`getRecentActivity`'s `runQb`, and its preceding doc comment)
- Test: `backend/src/modules/strategy/strategy-read.service.spec.ts:1929-1938`

**Interfaces:**
- Consumes: nothing new — `StrategyRun.updatedAt` already exists as a TypeORM `@UpdateDateColumn`.
- Produces: nothing new — `RecentActivityRunEventDto.occurredAt` keeps its existing type (`Date`); only the value it's populated from changes.

- [ ] **Step 1: Update the failing-first test to assert the new sort key**

In `backend/src/modules/strategy/strategy-read.service.spec.ts`, the test `"queries runs newest first with a stable tiebreaker, capped at the activity limit"` (starts line 1929) currently asserts the old field. Change its assertion:

```ts
    it("queries runs newest first with a stable tiebreaker, capped at the activity limit", async () => {
      const { runQb } = mockActivityQueries([rawRun()], []);

      await service.getRecentActivity();

      expect(mockStrategyRunRepo.createQueryBuilder).toHaveBeenCalledWith("run");
      expect(runQb.orderBy).toHaveBeenCalledWith("run.updatedAt", "DESC");
      expect(runQb.addOrderBy).toHaveBeenCalledWith("run.id", "DESC");
      expect(runQb.limit).toHaveBeenCalledWith(100);
    });
```

This is the one existing assertion in the file that pins the run query's sort field, so no other test in the `describe("getRecentActivity", ...)` block needs to change — the rest assert on row mapping and list separation, not the sort column.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest strategy-read.service.spec.ts -t "queries runs newest first"`
Expected: FAIL — the mock's `orderBy` was actually called with `("run.startedAt", "DESC")`, not `("run.updatedAt", "DESC")`.

- [ ] **Step 3: Swap the query's sort key and select from `startedAt` to `updatedAt`**

In `backend/src/modules/strategy/strategy-read.service.ts`, update the doc comment above `getRecentActivity` (currently lines 1210-1226) — change the sentence describing the run event's time source:

```ts
  /**
   * The Activity page's live feed, as two independent newest-first lists —
   * puzzle solves (a StrategyRun's last activity, event time = updatedAt)
   * and category-judge verdicts (a CategoryEvaluation landing, event time =
   * evaluatedAt) — which the page renders as separate sections rather than
   * one interleaved stream. Polled, so it's deliberately cheap: no
   * guessCount/tokenCostUsd correlated subqueries or SupportedModel/
   * ModelPrice joins like getRunHistory has, just the columns a feed row
   * renders. Each list is a rolling RECENT_ACTIVITY_LIMIT window, not a
   * page a caller steps through.
   *
   * The run list sorts by `updatedAt`, not `startedAt`: `updatedAt` is
   * bumped both on ordinary progress (StrategyRunStoreService.flushBatch
   * saves the run on every batch) and — critically — the instant a run is
   * manually retried (StrategyDispatch.retryRun flips it back to RUNNING
   * without changing startedAt), so a retried run rises back to the top of
   * the feed instead of staying wherever its original startedAt placed it.
   *
   * `strategyNames`, when non-empty, narrows both lists to runs dispatched
   * by those strategies (the provider-pool filter — a judgment carries its
   * solving run's strategyName, so the same predicate scopes both). Each
   * list is then the newest N *within* the selected pools, not the newest N
   * overall filtered down.
   */
```

Then in the `runQb` builder (currently lines 1230-1248), change the `occurredAt` select and primary `orderBy`:

```ts
    const runQb = this.strategyRunRepo
      .createQueryBuilder("run")
      .innerJoin(Puzzle, "puzzle", 'puzzle.id = run."puzzleId"')
      .select("run.id", "id")
      .addSelect("run.puzzleId", "puzzleId")
      // Cast to text — see the identical cast in getRunHistory: getRawMany()
      // bypasses Puzzle.date's entity-level string transformer.
      .addSelect("puzzle.date::text", "puzzleDate")
      .addSelect("run.strategyName", "strategyName")
      .addSelect("run.modelName", "modelName")
      .addSelect("run.trialNumber", "trialNumber")
      .addSelect("run.status", "status")
      .addSelect("run.updatedAt", "occurredAt")
      .orderBy("run.updatedAt", "DESC")
      // Stable tiebreaker: without one, ties on the event time (plausible
      // under concurrent dispatch, or two batches flushing in the same
      // millisecond) could reorder rows between polls even though the
      // underlying set hasn't changed.
      .addOrderBy("run.id", "DESC")
      .limit(RECENT_ACTIVITY_LIMIT);
```

(Only the `.addSelect(..., "occurredAt")` line and the `.orderBy(...)` line actually change — every other line is shown for context and stays as-is.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest strategy-read.service.spec.ts`
Expected: PASS — every test in the file, including the updated one. The other `getRecentActivity` tests are unaffected since they don't assert on the sort field.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy-read.service.ts backend/src/modules/strategy/strategy-read.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(strategy): sort the Activity feed's run list by last activity

StrategyRun.updatedAt already gets bumped on every progress save and, since
manual retry flips a run's status without creating a new row or touching
startedAt, on every manual retry too. Sorting by updatedAt instead of
startedAt makes a retried run rise back to the top of the feed instead of
staying buried under its original dispatch time.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rename the feed's timestamp column header

**Files:**
- Modify: `frontend/src/components/benchmark/RecentActivityTable.tsx:26-53`

**Interfaces:**
- Consumes: nothing new — `RecentActivityEvent.occurredAt` (unchanged type/shape from Task 1's backend DTO).
- Produces: nothing new — this is a display-only text change.

No backend interface changed in Task 1 (same field name, same type — only which column populates it), so this task has no new test to write: there is no existing test asserting the literal header text "When" (confirmed by search of `frontend/src/components/benchmark/__tests__/RecentActivityTable.test.tsx`, which only asserts on provider-pool badge text), and adding one to pin a static label string wouldn't exercise any new behavior worth a regression test. This task is a one-line text edit, verified by reading the rendered output in Step 2.

- [ ] **Step 1: Update the column header and its doc comment**

In `frontend/src/components/benchmark/RecentActivityTable.tsx`, update the doc comment above the component (lines 27-35) to describe the new semantics:

```tsx
/** Live feed of the most recent activity across every strategy/model (see
 * ActivityPage, which polls fetchRecentActivity) — one reverse-chronological
 * stream mixing two event kinds: a run's most recent activity (its last
 * progress save, which is also what a manual retry bumps — see
 * StrategyReadService.getRecentActivity), and a category-judge verdict
 * landing. No sorting/filtering; that's what the per-strategy
 * RunHistoryTable is for. Clicking a row goes to that run's puzzle-run page,
 * where the guess chain and (for judgments) the judge diagnostics live —
 * keyed by model for LLM rows (the leaderboard's :strategyId is the model
 * there, not the strategy — see useStrategyMeta), the strategy name
 * otherwise. */
```

Then change the column header text (currently line 53):

```tsx
            <th scope="col">Last activity</th>
```

- [ ] **Step 2: Manually verify the rendered header**

Run: `cd frontend && npm run dev` (with the backend dev server also running, per the project's normal local-dev setup), then open the Activity page in a browser.
Expected: The Puzzle Solves table's third column header reads "Last activity" instead of "When"; the Category Judgments table's matching column (same component, same header) also reads "Last activity" — that's expected, since both tables share this component and the label is now accurate for both (a judgment's `occurredAt` is still when it was evaluated).

- [ ] **Step 3: Run the frontend test suite to confirm nothing else pinned the old text**

Run: `cd frontend && npx vitest run RecentActivityTable.test.tsx`
Expected: PASS — all existing tests, none of which assert on the header text.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/benchmark/RecentActivityTable.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): relabel the Activity feed's timestamp column to Last activity

Matches Task 1's backend change — the column now shows a run's most recent
activity (bumped by manual retry) rather than when it was first dispatched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
