# Candidate 10 — Model-scoped bulk retry/delete for errored runs: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow.

**Branch:** `feature/bulk-actions-by-model`, off `origin/master` (`aa2e322`), in worktree
`.worktrees/bulk-actions-by-model`.

**Shape of delivery:** 1 PR, 4 commits (backend service/store, backend controller routes,
frontend api/types, frontend UI).

---

## Goal

Each individual run page already has "Delete this run" / "Manually retry" buttons, shown only
when that one run's `status` is `'error'` (`GuessChainVisualizer.tsx`). There is no way to act on
every errored run for one model at once — an operator has to open each run individually. A global
"delete every errored run, any model" bulk action already exists (`MaintenancePanel`, added in
commit `89e9968`), but nothing scoped to a single model, and no bulk *retry* exists anywhere yet
(only per-run).

This adds two buttons to `StrategyPuzzlePage` (the per-model run-history page a Leaderboard row
links to): **"Retry all errored runs"** and **"Delete all errored runs"**, each acting on every
`StrategyRun` where `strategyName` equals the page's own strategy (== the model, for LLM rows) and
`status === 'error'` — exactly the same condition that already gates the single-run buttons, no
broader and no narrower.

---

## Scope

### In scope

- New backend routes, scoped by `strategyName` only (never `modelName` independently — see
  Design/Fact-check below):
  - `GET /dispatch/strategy/:strategyName/runs/errored` — count.
  - `DELETE /dispatch/strategy/:strategyName/runs/errored` — bulk delete.
  - `POST /dispatch/strategy/:strategyName/runs/errored/retry` — bulk retry (new — no per-run
    precedent to extend, unlike delete).
- `StrategyDispatch.deleteErroredRuns`/`countErroredRuns` gain an optional `strategyName` filter
  (backward compatible — the existing global `runs/errored` routes and `MaintenancePanel` keep
  calling them with no argument, unchanged behavior).
- New `StrategyDispatch.retryErroredRuns(strategyName)` — loops the strategy's errored runs
  through the existing `retryRun(runId)` path unchanged, so each retry inherits the same status
  check, job-id collision avoidance, and (for LLM runs) conversation-history reconstruction fix
  (`d712bca`) that a single manual retry already has.
- `StrategyRunStore.deleteErroredRuns` gains the same optional `strategyName` filter.
- Two new buttons on `StrategyPuzzlePage`, admin-gated (`useAdminAuth().isAdmin`, same gate as the
  single-run buttons) and only shown when the strategy's fresh errored count is > 0, each opening
  the existing `BulkActionModal` (from `MaintenancePanel`) with a bulk-scoped `action`.
- Frontend `fetchErroredRunCountForStrategy` / `deleteErroredRunsForStrategy` /
  `retryErroredRunsForStrategy` in `api.ts`, plus a new `BulkRetryErroredRunsResult` type.

### Out of scope

| Item | Why deferred |
|---|---|
| A Leaderboard-page shortcut | Confirmed in grilling: only `StrategyPuzzlePage`. |
| An independent `model` filter separate from `strategyName` | Confirmed in grilling (Q9): a
  strategy page *is* one model in current usage; `RunHistoryTable`'s separate `model` query param
  capability is not needed here — YAGNI until a strategy genuinely spans multiple models. |
| Any new BullMQ throttling/rate-limit cap for bulk retry | Confirmed in grilling (Q8): rely on the
  existing per-provider queue concurrency (default 1) and the per-model rate-limit-hold gate
  (`llm-strategy-runner.service.ts`), both of which already apply identically to a manually-retried
  run. |
| Live progress polling for bulk retry | The single-run `RetryRunModal` already has none (it tells
  the operator to refresh the page); bulk retry follows the same convention — see Design. |
| Cross-model or cross-provider bulk actions | Confirmed in grilling: scope is always one specific
  model (one `strategyName`), never "every model on provider X". |

---

## Fact-check (resolved during the grilling session and this spec's research pass)

- **`StrategyRun.modelName` is a separate denormalized text column from `strategyName`**
  (`entities/strategy-run.entity.ts:91-92`), and `RunHistoryTable`/`fetchRunHistory` do filter by
  both independently. In *current* usage, though, an LLM `StrategyPuzzlePage`'s `:strategyId` route
  param already resolves to one model (`useStrategyMeta`), and the user confirmed in grilling that
  "a particular model" must never expand to "every model under one provider" — i.e. scope is
  strictly the one `strategyName` shown on the page, not broader. Per Q9, the new routes filter by
  `strategyName` only.
- **The Leaderboard/`StrategyPuzzlePage` header's existing "Failed N" badge (`progress.failed`) is
  NOT the same figure as "errored runs".** `strategy-read.service.ts`'s `LeaderboardAccumulator`
  bundles `FAILED` (hit the mistake cap), `DUPLICATE`, `MALFORMED_RESPONSE`, *and* `ERROR` into one
  `failed` counter (with an LLM-specific display adjustment on top). Reusing it for the bulk-action
  confirmation count would be wrong — a fresh, `ERROR`-only count is fetched via the new
  `GET .../runs/errored` route instead (mirrors the existing global `countErroredRuns`, which
  already counts `ERROR` only).
- **Manual retry already just enqueues a BullMQ job and returns** (`retryRun`,
  `strategy-dispatch.service.ts:313-349`) — it does not await the LLM call. Bulk retry therefore
  means looping `retryRun` calls (each a fast DB update + `queue.add`), not a long-running
  synchronous batch — this is what the user meant by "enqueue into the existing BullMQ scheme" in
  grilling Q1, as opposed to sequentially waiting out each run's full retry.
- **Bulk delete is synchronous and transactional** (`StrategyRunStore.deleteErroredRuns` runs the
  whole sweep in one DB transaction, mirroring `deleteRun`). The model-scoped version keeps that
  same one-transaction-per-sweep shape — per-model result sets are a strict subset of the existing
  global sweep's, so the same pattern that already ships in production is safe to reuse unchanged.
- **`BulkActionModal` already has the right UX for both actions, unmodified.** It never
  auto-closes on success — it shows `result.message` and leaves a "Close" button
  (`BulkActionModal.tsx:78-86`). That is exactly the "queued, not completed" framing the user
  wants for bulk retry (Q7), and it is also already how the existing global bulk-delete behaves. No
  component changes needed — only new `action` callbacks are wired in from `StrategyPuzzlePage`.
- **No controller-level tests exist for the dispatch controller today** (`dispatch.controller.ts`
  has no `.spec.ts` — it's a thin pass-through to `StrategyDispatch`, tested at the service layer).
  This spec follows that precedent: no new controller tests, only service-layer tests for the new/
  changed `StrategyDispatch` and `StrategyRunStore` methods.

---

## Design

### Backend: `StrategyRunStore.deleteErroredRuns` — add optional `strategyName` filter

`backend/src/modules/strategy/strategy-run-store.service.ts:282-314`, current signature:

```ts
async deleteErroredRuns(): Promise<{
  deletedRuns: number;
  deletedGuesses: number;
  deletedSolvePrompts: number;
  deletedLlmProposals: number;
  deletedCategoryEvaluations: number;
}> {
  return this.dataSource.transaction(async (manager) => {
    const erroredRuns = await manager.find(StrategyRun, {
      where: { status: StrategyRunStatus.ERROR },
      select: { id: true },
    });
    // ... (unchanged loop over erroredRuns calling deleteRunTx)
  });
}
```

New signature — only the `where` clause changes, everything else (the transaction, the
`deleteRunTx` loop, the totals accumulator) is untouched:

```ts
async deleteErroredRuns(strategyName?: string): Promise<{
  deletedRuns: number;
  deletedGuesses: number;
  deletedSolvePrompts: number;
  deletedLlmProposals: number;
  deletedCategoryEvaluations: number;
}> {
  return this.dataSource.transaction(async (manager) => {
    const erroredRuns = await manager.find(StrategyRun, {
      where: {
        status: StrategyRunStatus.ERROR,
        ...(strategyName ? { strategyName } : {}),
      },
      select: { id: true },
    });
    // ... unchanged
  });
}
```

### Backend: `StrategyDispatch.deleteErroredRuns` / `countErroredRuns` — thread the same filter

`backend/src/modules/strategy/strategy-dispatch.service.ts:283-296`:

```ts
async deleteErroredRuns(strategyName?: string) {
  return this.store.deleteErroredRuns(strategyName);
}

async countErroredRuns(strategyName?: string): Promise<{ erroredRuns: number }> {
  const erroredRuns = await this.strategyRunRepo.count({
    where: {
      status: StrategyRunStatus.ERROR,
      ...(strategyName ? { strategyName } : {}),
    },
  });
  return { erroredRuns };
}
```

### Backend: new `StrategyDispatch.retryErroredRuns(strategyName)`

Add right after `retryRun` (`strategy-dispatch.service.ts:349`):

```ts
/**
 * Bulk version of retryRun, scoped to one strategy (== one model, for LLM
 * strategies) — retries every run currently in the 'error' status for
 * strategyName through the exact same retryRun path, so each inherits its
 * per-run status check, job-id collision avoidance, and (for LLM runs)
 * conversation-history reconstruction. Unlike deleteErroredRuns this is not
 * one transaction: each retryRun call independently flips one row and
 * enqueues one job, so one run's failure can't roll back another's, and a
 * run whose status changed out from under us between listing and retrying
 * (e.g. another operator already retried it, or it self-resumed from
 * RATE_LIMITED_DAILY) is counted as 'skipped', not 'failed' — see Q7 in
 * docs/architecture/specs/10-model-scoped-bulk-run-actions.md.
 */
async retryErroredRuns(strategyName: string): Promise<{
  retried: number;
  skipped: number;
  failed: number;
  failures: { runId: number; reason: string }[];
}> {
  const erroredRuns = await this.strategyRunRepo.find({
    where: { strategyName, status: StrategyRunStatus.ERROR },
    select: { id: true },
  });

  let retried = 0;
  const failures: { runId: number; reason: string }[] = [];
  let skipped = 0;

  for (const { id } of erroredRuns) {
    try {
      await this.retryRun(id);
      retried += 1;
    } catch (err) {
      if (err instanceof ConflictException) {
        skipped += 1;
      } else {
        failures.push({ runId: id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { retried, skipped, failed: failures.length, failures };
}
```

`ConflictException` is already imported in this file (used by `retryRun` itself, line 324).

### Backend: new controller routes

`backend/src/modules/dispatch/dispatch.controller.ts`, added directly after the existing
`runs/errored` GET/DELETE pair (after line 355) and after the existing `run/:runId/retry` route
(after line 402) respectively — same `@ApiParam`/`@ApiBody` conventions as the single-run routes:

```ts
// Same as GET runs/errored, scoped to one strategy — the fresh count
// StrategyPuzzlePage's bulk-action modals fetch right before their confirm
// dialog. Read-only, un-gated, matching the global version.
@Get("strategy/:strategyName/runs/errored")
async countErroredRunsForStrategy(@Param("strategyName") strategyName: string) {
  return this.strategyDispatch.countErroredRuns(strategyName);
}

// Bulk version of DELETE run/:runId, scoped to one strategy — same teardown
// as the global DELETE runs/errored, filtered to strategyName.
@Delete("strategy/:strategyName/runs/errored")
@UseGuards(DispatchAuthGuard)
@ApiParam({
  name: "strategyName",
  type: String,
  description: "The strategy name (== model name, for LLM strategies)",
  example: "llm-openai",
})
@ApiBody({ type: DispatchAuthDto })
async deleteErroredRunsForStrategy(@Param("strategyName") strategyName: string) {
  const result = await this.strategyDispatch.deleteErroredRuns(strategyName);
  return {
    message: `Deleted ${result.deletedRuns} errored strategy run(s) for '${strategyName}' and all related data`,
    strategyName,
    ...result,
  };
}

// Bulk version of POST run/:runId/retry, scoped to one strategy.
@Post("strategy/:strategyName/runs/errored/retry")
@UseGuards(DispatchAuthGuard)
@ApiParam({
  name: "strategyName",
  type: String,
  description: "The strategy name (== model name, for LLM strategies)",
  example: "llm-openai",
})
@ApiBody({ type: DispatchAuthDto })
async retryErroredRunsForStrategy(@Param("strategyName") strategyName: string) {
  const result = await this.strategyDispatch.retryErroredRuns(strategyName);
  const suffix =
    (result.skipped > 0 ? `, ${result.skipped} already handled` : "") +
    (result.failed > 0 ? `, ${result.failed} failed to enqueue` : "");
  return {
    message: `Queued ${result.retried} errored strategy run(s) for '${strategyName}' for manual retry${suffix}`,
    strategyName,
    ...result,
  };
}
```

### Frontend: new types (`frontend/src/data/benchmark/types.ts`)

Added directly after `DeleteErroredRunsResult` (line 541):

```ts
/** Response from DELETE /dispatch/strategy/:strategyName/runs/errored — the
 * same per-table counts as DeleteErroredRunsResult, scoped to one strategy. */
export interface DeleteErroredRunsForStrategyResult extends DeleteErroredRunsResult {
  strategyName: string;
}

/** Response from POST /dispatch/strategy/:strategyName/runs/errored/retry —
 * per-run *enqueue* outcome, not the eventual retry result: a queued job's
 * real outcome isn't known until it completes on the worker (see
 * RetryRunModal, which has the same "refresh to see progress" framing for a
 * single run). 'skipped' is a run whose status changed out from under the
 * sweep (e.g. already retried by someone else) — not a real failure. */
export interface BulkRetryErroredRunsResult {
  message: string;
  strategyName: string;
  retried: number;
  skipped: number;
  failed: number;
  failures: { runId: number; reason: string }[];
}
```

### Frontend: new `api.ts` functions

Added directly after `retryRun` (line 352):

```ts
/** How many strategy runs are in the 'error' status right now, for one
 * strategy — the figure StrategyPuzzlePage's bulk-action buttons/modals act
 * on. Read-only, un-gated, same shape as fetchErroredRunCount. */
export function fetchErroredRunCountForStrategy(
  strategyName: string,
  signal?: AbortSignal,
): Promise<ErroredRunCount> {
  return fetchJson(`/dispatch/strategy/${strategyName}/runs/errored`, signal);
}

/** Permanently deletes every strategy run in the 'error' status for one
 * strategy, plus all rows tied to each. Rejects (thrown Error, message from
 * the backend) if the admin session has expired. */
export function deleteErroredRunsForStrategy(
  strategyName: string,
  signal?: AbortSignal,
): Promise<DeleteErroredRunsForStrategyResult> {
  return fetchJsonAdmin(`/dispatch/strategy/${strategyName}/runs/errored`, signal, {
    method: "DELETE",
  });
}

/** Queues every strategy run in the 'error' status for one strategy for
 * manual retry. Rejects (thrown Error, message from the backend) if the
 * admin session has expired. Each run resumes asynchronously on the job
 * queue, same as retryRun — this resolving only means the batch was
 * accepted, not that any run has finished (see BulkActionModal usage in
 * StrategyPuzzlePage). */
export function retryErroredRunsForStrategy(
  strategyName: string,
  signal?: AbortSignal,
): Promise<BulkRetryErroredRunsResult> {
  return fetchJsonAdmin(`/dispatch/strategy/${strategyName}/runs/errored/retry`, signal, {
    method: "POST",
  });
}
```

### Frontend: `StrategyPuzzlePage` — buttons + modals

`frontend/src/pages/benchmark/StrategyPuzzlePage.tsx` changes:

1. New imports: `useAdminAuth` from `"../../auth/useAdminAuth"`; `BulkActionModal` from
   `"../../components/benchmark/BulkActionModal"`; the three new `api.ts` functions above.
2. New state: `const [openBulkModal, setOpenBulkModal] = useState<null | "delete" | "retry">(null);`
3. New resource, alongside the existing `leaderboardData`/`history` ones:

```ts
const {
  data: erroredCount,
  refetch: refetchErroredCount,
} = useResource(
  ["erroredRunCount", resolvedStrategyName],
  (signal) =>
    resolvedStrategyName
      ? fetchErroredRunCountForStrategy(resolvedStrategyName, signal)
      : Promise.reject(new Error("Strategy not resolved")),
  { enabled: !!resolvedStrategyName },
);
```

4. `const { isAdmin } = useAdminAuth();` near the top of the component.
5. In the header, directly after the existing `<div className="bench-badges">...</div>` block
   (after line 224), add the bulk-action buttons — reusing the `bench-visualizer__actions` flex-row
   class already defined for the single-run buttons (`benchmark.css:827-830`):

```tsx
{isAdmin && resolvedStrategyName && (erroredCount?.erroredRuns ?? 0) > 0 ? (
  <div className="bench-visualizer__actions">
    <button
      type="button"
      className="bench-sort-btn"
      onClick={() => {
        void refetchErroredCount();
        setOpenBulkModal("retry");
      }}
    >
      Retry all errored runs
    </button>
    <button
      type="button"
      className="bench-sort-btn bench-sort-btn--danger"
      onClick={() => {
        void refetchErroredCount();
        setOpenBulkModal("delete");
      }}
    >
      Delete all errored runs
    </button>
  </div>
) : null}
```

6. Modals, rendered once near the bottom of the component's returned JSX (sibling to the closing
   `</div>` of `bench-page`, so they aren't clipped by any inner scroll container):

```tsx
{openBulkModal === "delete" && resolvedStrategyName ? (
  <BulkActionModal
    title={`Delete all errored runs for ${meta.name}`}
    warning={
      `This permanently deletes ${erroredCount?.erroredRuns ?? "all"} errored run(s) for ` +
      `${meta.name} and every row tied to them. This cannot be undone.`
    }
    confirmLabel="Delete all errored runs"
    action={() => deleteErroredRunsForStrategy(resolvedStrategyName)}
    onClose={() => setOpenBulkModal(null)}
    onDone={() => {
      void refetchErroredCount();
      void refetchHistory();
    }}
  />
) : null}

{openBulkModal === "retry" && resolvedStrategyName ? (
  <BulkActionModal
    title={`Retry all errored runs for ${meta.name}`}
    warning={
      `This queues ${erroredCount?.erroredRuns ?? "all"} errored run(s) for ${meta.name} for ` +
      "manual retry. Retries run asynchronously — refresh this page to see progress."
    }
    confirmLabel="Retry all errored runs"
    action={() => retryErroredRunsForStrategy(resolvedStrategyName)}
    onClose={() => setOpenBulkModal(null)}
    onDone={() => void refetchErroredCount()}
  />
) : null}
```

`refetchHistory` is the existing `history` resource's `refetch`, destructured alongside `data:
history`/`loading: isLoading`/`error` at line 57-79 (add `refetch: refetchHistory` to that existing
destructure — it's already returned by `useResource`, just not currently pulled out).

Bulk delete refetches both the count and the run-history table (so deleted rows disappear
immediately, matching the fact that delete is synchronous and already complete by the time
`onDone` fires). Bulk retry only refetches the count — the runs themselves haven't finished
retrying yet (they're freshly enqueued), so refreshing the history table would just show them
still sitting in whatever transient state the retry flip left them in, no more informative than
before; the modal's own message plus a manual page refresh (same convention as the single-run
`RetryRunModal`) is what actually shows progress.

---

## Steps

All on `feature/bulk-actions-by-model`, one PR, four commits:

**Commit 1 — Backend: scope `deleteErroredRuns`/`countErroredRuns`, add `retryErroredRuns`.**

- `backend/src/modules/strategy/strategy-run-store.service.spec.ts`: add a test to the existing
  `describe("deleteErroredRuns")` block asserting `manager.find` is called with
  `where: { status: StrategyRunStatus.ERROR, strategyName: "llm-openai" }` when a `strategyName`
  arg is passed, and keep the existing no-arg test passing unchanged (it should still call `find`
  with `where: { status: StrategyRunStatus.ERROR }`, no `strategyName` key at all — assert
  `expect(mockManager.find).toHaveBeenCalledWith(StrategyRun, { where: { status:
  StrategyRunStatus.ERROR }, select: { id: true } })` still passes with no changes).
- Run: `cd backend && npx jest strategy-run-store.service.spec.ts` (the backend's `test` script is
  `jest --forceExit --detectOpenHandles`). Expect the new assertion to FAIL (current code ignores
  any argument).
- Implement the `strategyName?: string` change in `StrategyRunStore.deleteErroredRuns` (Design,
  above). Re-run — expect PASS, and the old no-arg test still PASS.
- `backend/src/modules/strategy/strategy-dispatch.service.spec.ts`: add a `strategyName` case to
  `describe("deleteErroredRuns")` and `describe("countErroredRuns")` mirroring the store-level
  test (mock the repo/store call and assert the `strategyName` is threaded through unchanged).
  Add a new `describe("retryErroredRuns")` block with three cases:
  1. Two errored runs, both retry successfully → `{ retried: 2, skipped: 0, failed: 0, failures: []
     }`, and `mockStrategyRunRepo.find` called with `{ where: { strategyName: "llm-openai", status:
     StrategyRunStatus.ERROR }, select: { id: true } }`.
  2. One run whose `retryRun` throws `ConflictException` (status changed) → `{ retried: 0, skipped:
     1, failed: 0, failures: [] }`.
  3. One run whose `retryRun` throws a plain `Error("boom")` → `{ retried: 0, skipped: 0, failed: 1,
     failures: [{ runId: <id>, reason: "boom" }] }`.
  For cases 2-3, spy on `service.retryRun` directly (`vi.spyOn(service, "retryRun")`) rather than
  re-mocking the full repo/queue chain — `retryErroredRuns` only needs to prove it calls
  `retryRun` per id and classifies the outcome correctly, not re-prove `retryRun`'s own internals
  (already covered by the existing `describe("retryRun")` block).
- Run the service spec file, confirm the new tests FAIL, implement `retryErroredRuns` and the
  `deleteErroredRuns`/`countErroredRuns` signature changes (Design, above), re-run, confirm PASS.
- Commit: `git add backend/src/modules/strategy/strategy-run-store.service.ts
  backend/src/modules/strategy/strategy-run-store.service.spec.ts
  backend/src/modules/strategy/strategy-dispatch.service.ts
  backend/src/modules/strategy/strategy-dispatch.service.spec.ts && git commit -m "feat(strategy): scope bulk-delete by strategy, add bulk manual retry"`

**Commit 2 — Backend: controller routes.**

- No new test file (matches the existing no-controller-spec precedent — see Fact-check). Add the
  three routes from Design to `dispatch.controller.ts`.
- Verify manually: `cd backend && npm run build` (or the repo's typecheck script) to confirm the
  controller compiles against the new service signatures.
- Commit: `git add backend/src/modules/dispatch/dispatch.controller.ts && git commit -m "feat(dispatch): add strategy-scoped bulk errored-run routes"`

**Commit 3 — Frontend: api.ts + types.ts.**

- `frontend/src/data/benchmark/api.test.ts`: add three `describe` blocks mirroring the existing
  `fetchErroredRunCount`/`deleteErroredRuns`/`retryRun` ones (lines 113-172), asserting the new
  functions hit `/dispatch/strategy/llm-openai/runs/errored`
  (`fetchErroredRunCountForStrategy`/`deleteErroredRunsForStrategy`, GET/DELETE respectively) and
  `/dispatch/strategy/llm-openai/runs/errored/retry` (`retryErroredRunsForStrategy`, POST), with
  the delete/retry cases also asserting `credentials: "include"` and the `X-Admin-Request` header
  (same assertions as the existing `deleteErroredRuns`/`retryRun` tests).
- Run: `cd frontend && npx vitest run api.test.ts`. Expect FAIL (functions don't exist yet).
- Add the three functions to `api.ts` and the two new types to `types.ts` (Design, above). Re-run,
  confirm PASS.
- Commit: `git add frontend/src/data/benchmark/api.ts frontend/src/data/benchmark/types.ts
  frontend/src/data/benchmark/api.test.ts && git commit -m "feat(api): add strategy-scoped bulk errored-run client functions"`

**Commit 4 — Frontend: `StrategyPuzzlePage` UI.**

- `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`: extend `stubFetch` to
  accept an optional `erroredCount` param (default `0`) and respond to
  `href.includes("/runs/errored")` with `{ erroredRuns: erroredCount }` for GET, and to add a
  `deleteErroredRunsOk`/`retryErroredRunsOk` style hook if needed for the DELETE/POST cases — follow
  whatever shape keeps the existing branches (`leaderboard`, `models`, `runs`) working unchanged,
  since `/runs/errored` also contains `/runs` as a substring and must be checked *before* the
  existing `href.includes("/runs")` branch or it will be misrouted to the run-history stub.
  Add new tests, wrapping renders needing `isAdmin: true` in
  `<AdminAuthContext.Provider value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout:
  vi.fn() }}>` (same pattern as `GuessChainVisualizer.test.tsx`):
  1. "does not show bulk-action buttons when not an admin" — default (no provider) render with
     `erroredCount: 5`; assert `screen.queryByRole("button", { name: "Retry all errored runs" })`
     is null.
  2. "does not show bulk-action buttons when the admin's errored count is zero" — admin provider,
     `erroredCount: 0`; assert both buttons absent.
  3. "shows both bulk-action buttons for an admin when there are errored runs" — admin provider,
     `erroredCount: 3`; assert both buttons present.
  4. "opens the delete-all modal, confirms, and refetches the count and history" — admin provider,
     `erroredCount: 2`; click "Delete all errored runs", assert the modal's warning text mentions
     "2", click the modal's own "Delete all errored runs" submit button, assert a DELETE request
     hit `/dispatch/strategy/.../runs/errored`, and assert the result message appears.
  5. "opens the retry-all modal, confirms, and shows the queued/skipped/failed summary" — admin
     provider, `erroredCount: 2`; click "Retry all errored runs", confirm, assert a POST request
     hit `/dispatch/strategy/.../runs/errored/retry`, and assert the returned `message` (e.g.
     "Queued 2 errored strategy run(s) for 'llm-openai' for manual retry") renders.
- Run: `cd frontend && npx vitest run StrategyPuzzlePage.test.tsx`. Expect the five new tests FAIL.
- Implement the `StrategyPuzzlePage.tsx` changes from Design (imports, `isAdmin`, the
  `erroredCount` resource, the two buttons, the two `BulkActionModal` instances, `refetchHistory`
  destructured from the existing `history` resource). Re-run, confirm all PASS and no existing test
  regressed.
- Commit: `git add frontend/src/pages/benchmark/StrategyPuzzlePage.tsx
  frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx && git commit -m "feat(strategy-puzzle): add per-model bulk retry/delete for errored runs"`

**Final check** — run both full suites once more (`cd backend && npm test`, `cd frontend && npm
test`) to confirm nothing else regressed, then hand off for review (see
`superpowers:requesting-code-review`).

---

## Tests

Covered inline per-commit above; summarized:

- `strategy-run-store.service.spec.ts` / `strategy-dispatch.service.spec.ts`: `strategyName`
  filter threading (delete + count), and the three `retryErroredRuns` outcome classes (all
  succeed / one skipped via `ConflictException` / one genuinely failed).
- `api.test.ts`: the three new client functions hit the right method/URL/auth headers.
- `StrategyPuzzlePage.test.tsx`: admin-gating, zero-count-hides-buttons, and one happy-path test
  per bulk action (delete refetches count+history, retry refetches count only and shows the
  enqueue summary message).

No new controller-level or E2E tests, matching the existing precedent that `dispatch.controller.ts`
has no `.spec.ts` of its own.

---

## Risks

- **`href.includes("/runs")` ordering in `StrategyPuzzlePage.test.tsx`'s `stubFetch`**: the new
  `/dispatch/strategy/:strategyName/runs/errored[/retry]` URLs contain `/runs` as a substring, so
  the existing run-history branch (`if (href.includes("/runs"))`) would wrongly intercept them
  unless the new `/runs/errored` check is placed *before* it in the mock's `if`/`else if` chain.
  Get this ordering wrong and the new tests will fail with a confusing "wrong shape" error rather
  than a clear one — worth double-checking first if Commit 4's tests don't behave as expected.
- **`deleteErroredRuns`/`countErroredRuns`'s optional-param backward compatibility** rests on the
  conditional-spread pattern (`...(strategyName ? { strategyName } : {})`) rather than
  `{ status, strategyName }` directly — the latter would pass `strategyName: undefined` into
  TypeORM's `where`, which is not guaranteed to behave identically to the key being absent
  entirely. The existing no-arg tests (`deleteErroredRuns()`/`countErroredRuns()` with no
  `strategyName`) must keep passing unchanged as the regression check for this.
- **`retryErroredRuns` has no cross-run transaction** (by design — see Fact-check): a bulk retry
  that's interrupted mid-loop (e.g. a server restart) leaves whichever runs were already flipped to
  `RUNNING`/enqueued in that state, and the rest still `ERROR` — no different from what would happen
  if an operator was manually clicking retry one-by-one and got interrupted partway. Not a
  regression this feature introduces, just worth knowing it's not atomic the way bulk delete is.
- **This spec's grilling session surfaced but explicitly deferred** a scenario where a single
  `strategyName` could someday span multiple `modelName` values (Q9) — if that ever becomes real
  (e.g. a "router" strategy that fans out across models), these bulk routes would need the
  additional `model` filter `RunHistoryTable` already supports, and `retryErroredRuns`'s `find`
  call would need the same `modelName` addition. Not needed today; flagged here so a future reader
  knows exactly where to extend it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
