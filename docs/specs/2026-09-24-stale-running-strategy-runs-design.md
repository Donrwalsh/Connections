# Stale `RUNNING` StrategyRuns — Design

## Problem

After a production restart, some `StrategyRun` rows are left with `status = 'running'` while no corresponding BullMQ job is actually processing them (confirmed via Bull Board) — they are permanently stuck, since nothing will ever pick them back up. At the time of writing, prod has 15 such rows.

This doc captures the decisions reached via an interview process (`/grill-me`) before implementation, so the plan executes against a settled design.

### Root causes (found via code investigation)

1. **No liveness link between a `StrategyRun` row and its BullMQ job.** The entity has no `bullJobId` column; correlation would require recomputing the deterministic job id (`runStrategyJobId`, `backend/src/modules/queue/strategy.queue.ts:148-156`) from `(puzzleId, strategyName, model, trialNumber)`. That id is *not* stable across the run's life: a resume/retry re-enqueues under a suffixed id (`-manual-retry-<ts>` in `strategy-dispatch.service.ts:359`, `-resume-<stamp>` in `rpd-resume.service.ts:139,229`), so a row's *current* job id can drift from what a reconciler would recompute.
2. **BullMQ's own failure/stall handling never syncs back to the DB.** Every `worker.on("failed", ...)` handler in `backend/src/worker.ts` only logs (lines 98-100, 135-137, 187-189, 208-210, 235-237, 260-265, 294-296, 315-317). A job whose handler throws and exhausts `attempts: 3` (`strategy.queue.ts` `defaultJobOptions`) moves to BullMQ's own `failed` state, but nothing writes a terminal status onto the row — it stays `running` forever.
3. **A worker-process death mid-job (the restart case) doesn't even reach `worker.on("failed")`.** BullMQ's stalled-job recovery (`moveStalledJobsToWait`, library defaults `stalledInterval: 30000ms`, `maxStalledCount: 1`) resolves entirely inside a Redis Lua script; it does not emit the JS-level `'failed'` event that `worker.on("failed")` listens for (verified in `bullmq/dist/cjs/classes/worker.js:664-689` — that handler only fires from *this* worker instance's own try/catch around a job it actively ran). So a job orphaned by a dead worker process silently disappears from Bull's active/visible state with **no** application-level signal at all — this is the actual mechanism behind the reported bug, and it's a separate gap from #2, not the same one.
4. `StrategyRun.updatedAt` (`@UpdateDateColumn`) reliably reflects liveness: `StrategyRunStore.flushBatch` (`strategy-run-store.service.ts:153-240`) is called on every loop iteration of an active run (`llm-strategy-runner.service.ts:556`), not just at creation.
5. There is no existing reconciliation for this: the only sweep-and-resume pattern in the codebase, `RpdResumeBootstrap`/`RpdResumeService` (`backend/src/modules/provider-pool/`), is scoped exclusively to `RATE_LIMITED_DAILY`. No admin tooling can even list a stuck `RUNNING` row — `StrategyRunStore.deleteRun` explicitly refuses to touch one (`strategy-run-store.service.ts:267-271`), and the existing "retry errored runs" endpoints only accept `status === ERROR` (`strategy-dispatch.service.ts:338-342`).

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Scope | A systemic fix, not a one-off. It must also resolve the current 15 stuck rows on prod — via the same mechanism (next worker restart), not a separate script. |
| 2 | What happens to a detected stuck row | Auto-resume it from where it left off. No new status needed: `loadOrCreateRun` (`strategy-run-store.service.ts:84-101`) already finds and continues an existing row by `(puzzleId, strategyName, trialNumber)` — re-enqueuing is sufficient, exactly the mechanism `RpdResumeService` already uses for `RATE_LIMITED_DAILY`. |
| 3 | Urgency | Not urgent — the stuck rows are inert, not actively harmful. Full design over a rushed patch. |
| 4 | Detection mechanism | Pure time-based staleness (`updatedAt` older than a threshold), not BullMQ job-id cross-referencing — the job-id drift in root cause #1 makes that unreliable. |
| 5 | Where reconciliation runs | Startup sweep only. No recurring cron, no proactive shutdown-hook marking. |
| 6 | Also fix the "BullMQ formally failed, never synced" gap (#2 above)? | Yes. |
| 7 | New `bullJobId` column? | No — unnecessary for a time-based check. |
| 8 | Sweep scope across worker roles (`cloud` vs `ollama`, `backend/src/strategies.ts:81-96`) | Scope each sweep run to only the queues that process's `WorkerRole` owns, mirroring `worker.ts`'s own `role !== "ollama"` / `role !== "cloud"` gating — avoids racing a still-alive worker of the other role. |
| 9 | Staleness threshold | 1 hour of no `updatedAt` movement. This is the *only* safety margin against double-processing (no lock/heartbeat exists), so it errs conservative rather than fast. |
| 10 | Behavior on a formal BullMQ failure (#6) | Mark `StrategyRunStatus.FAILED` and stop — no auto re-enqueue. Confirmed distinct from `ERROR`: `FAILED` means the puzzle-solving itself failed on the merits (`llm-strategy-runner.service.ts:786`, too many wrong guesses), `ERROR` means repeated infra/model errors (`llm-strategy-runner.service.ts:848`) and is the status the existing manual retry tooling recognizes. Neither is reused for this; a genuine, repeated thrown-exception failure (as opposed to an infra-interruption) is deliberately left for manual review, consistent with how this codebase already treats `ERROR`. |

## Design note: why the sweep doesn't need `OnApplicationBootstrap` to be worker-only

Both `backend/src/main.ts` (API server) and `backend/src/worker.ts` boot the same `AppModule`, so any `OnApplicationBootstrap` hook fires in *both* processes independently — this is the existing, deliberate pattern `RpdResumeBootstrap` and `DailyAutomationBootstrap` already use, relying on a deterministic per-day job id so redundant enqueues from both processes collapse into one BullMQ job.

The sweep follows the same pattern rather than special-casing `worker.ts`:
- Role scoping (decision #8) uses `workerRole()` (`backend/src/strategies.ts:93-96`), which reads `WORKER_ROLE` and returns `"all"` when unset — exactly what the API server sees, since it never sets that env var. An `"all"` sweep run (API server, or a local single-process dev setup) owns every queue, matching `worker.ts`'s own `role !== "ollama"` / `role !== "cloud"` gates read the same way.
- Each candidate row's resume job uses a jobId suffixed with a UTC date stamp (`-sweep-<YYYY-MM-DD>`, mirroring `rpd-resume.service.ts`'s `-resume-<stamp>`), so if both the API server and the worker happen to boot the same day, their sweeps collapse to one `queue.add()` per row via BullMQ's existing jobId idempotency — no new locking needed.

This also means the current 15 stuck rows get swept on the *next* boot of either process, not only a full worker redeploy.

## Design note: why the `on("failed")` fix doesn't fire for orphaned/stalled jobs

Verified directly in `bullmq`'s source (`node_modules/bullmq/dist/cjs/classes/worker.js:664-689`): the JS-level `'failed'` event only fires from a worker instance's own try/catch around a job *it* actively ran and whose handler threw. BullMQ's stalled-job recovery (`moveStalledJobsToWait`) resolves entirely inside a Redis Lua script and does not go through that path or emit `'failed'` — confirming root cause #3 above, and confirming decisions #6/#10 and the sweep are solving two genuinely non-overlapping problems, not duplicating each other:
- **Sweep**: catches jobs whose worker process died (no thrown exception, no BullMQ-level failure at all — this is the reported bug).
- **`on("failed")` fix**: catches jobs whose handler ran and threw repeatedly until BullMQ's own `attempts: 3` was exhausted (a real, repeated application/infra error, distinct from a restart).

## Implementation

### 1. New: `backend/src/modules/strategy/stale-run-sweep.service.ts`

`StaleRunSweepService implements OnApplicationBootstrap`:
- Skips under `NODE_ENV === "test"` (matches `RpdResumeBootstrap`/`DailyAutomationBootstrap`).
- `sweep(role: WorkerRole)`: queries `StrategyRun` where `status = RUNNING` and `updatedAt < now - 1h` (exported `STALE_RUN_THRESHOLD_MS` constant), with `relations: { puzzle: true }`. For each row, resolves its queue via the existing `queueForStrategy(runsQueueByPool, defaultQueue, strategyName)` helper (`strategy.queue.ts:100-108`) and skips it unless that queue belongs to the current process's role (mirrors `worker.ts`'s `role !== "ollama"` / `role !== "cloud"` checks exactly, via the `ollama` pool's queue name). Owned rows are re-enqueued with `runStrategyJobId(...) + "-sweep-" + <UTC date stamp>` as the jobId, carrying `{ puzzleId, strategyName, date: run.puzzle.date, trialNumber, model: run.modelName }` — no DB write needed on the row itself (it's already `RUNNING`; `loadOrCreateRun` resumes from its stored progress).
- Injected: `@InjectRepository(StrategyRun)`, `@Inject(RUNS_QUEUE_BY_POOL)`, `@Inject(STRATEGY_QUEUE)` (covers both LLM provider-pool strategies and the shared deterministic/shuffle queue).
- Registered as a provider in `strategy.module.ts` (which already imports `QueueModule` for these tokens).

### 2. Edit: `backend/src/modules/strategy/strategy-run-store.service.ts`

New method `markFailedIfStillRunning(puzzleId, strategyName, trialNumber, reason)`: loads the row; no-ops if missing or no longer `RUNNING` (already resolved by the run itself); otherwise sets `status = FAILED`, `finishedAt = new Date()`, saves, and logs a warning with `reason`.

### 3. Edit: `backend/src/worker.ts`

Inject `StrategyRunStore`. In `strategyRunsWorker.on("failed", ...)` (line 98) and inside `createLlmWorker`'s `llmWorker.on("failed", ...)` (line 135), additionally check `job?.name === "run-strategy"` (excludes `evaluate-category` judge jobs riding the same LLM queues — see `llm-job-handler.ts:36-50`) and call `strategyRunStore.markFailedIfStillRunning(puzzleId, strategyName, trialNumber, err?.message ?? String(err))`, fire-and-forget with its own `.catch(...)` logging so a failure to write doesn't affect BullMQ's own event handling.

### 4. Tests

- `stale-run-sweep.service.spec.ts` (new): staleness filtering (respects the 1h cutoff), role scoping (cloud/ollama/all against provider-pool and shared-queue rows), jobId/payload shape, no DB write on the swept row.
- `strategy-run-store.service.spec.ts`: new `describe("markFailedIfStillRunning")` block — no-ops on missing row and on non-`RUNNING` row; sets `FAILED` + `finishedAt` otherwise.
- `worker.ts` itself has no existing test coverage (none of its other `on("failed")` wiring is tested either) — the new call is thin wiring over the now-tested store method, verified by manual/integration check instead.

## Non-goals

- No `bullJobId` schema column (decision #7).
- No recurring cron or shutdown-hook marking (decision #5) — startup sweep only.
- No auto re-enqueue on a formal BullMQ failure (decision #10) — `FAILED` is terminal, matching how `ERROR` already requires manual review in this codebase.
- No change to the existing `ERROR`-only retry tooling (`strategy-dispatch.service.ts` `retryRun`/`retryErroredRuns`) — `FAILED` rows from the new `on("failed")` fix are intentionally outside that tooling's scope, per decision #10.
