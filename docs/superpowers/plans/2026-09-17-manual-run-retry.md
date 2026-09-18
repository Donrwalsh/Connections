# Manual Run Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin manually resume a strategy run stuck in the `error` status from the leaderboard UI, re-enqueuing the same job so the solve loop continues from the last successful guess instead of requiring the run to be deleted and started over.

**Architecture:** Resuming already works for one specific case today — `RATE_LIMITED_DAILY` runs are automatically flipped back to `RUNNING` and re-dispatched by a cron sweep (`RpdResumeService`), and `LlmStrategyRunner.runLlmStrategy` already rebuilds its in-memory conversation state from persisted `Guess` rows on every call, so it resumes correctly regardless of *why* the run stopped. This feature generalizes that same flip-status-and-re-enqueue mechanism to the `error` status, triggers it manually via an admin-gated endpoint instead of a cron, and adds a `manualRetry` flag threaded from the HTTP request through the BullMQ job into every `SolvePrompt` row created during that resumed execution, so the UI can badge those steps distinctly from the run's original attempt.

**Tech Stack:** NestJS + TypeORM (Postgres) + BullMQ on the backend; React + TypeScript (Vite) on the frontend.

**Spec:** This plan was produced directly from a grilling-skill design session in this conversation (no separate spec document exists). Key decisions baked into the tasks below:
- Retry is admin-only, gated the same way as the existing "Delete this run" button (`DispatchAuthGuard` / `useAdminAuth`).
- Only runs in the `error` status are eligible — matches the existing delete button's own gating exactly, so both actions appear/disappear together.
- No retry cap; it's a manual, human-triggered action.
- Confirmation modal before firing, matching `DeleteRunModal`'s UX.
- No live polling after retry — v1 shows a queued confirmation and the admin refreshes manually.
- Every `SolvePrompt` row from a manually-retried execution gets a `manualRetry: true` flag, shown as an additional "Manually retried" badge next to the existing "Initial solve"/"Retry" pill (which is an orthogonal, unrelated game-logic distinction — see Task 1).

## Global Constraints

- Retry only ever applies to `StrategyRunStatus.ERROR` — no other terminal status (`failed`, `malformedResponse`, `duplicate`, `completed`) is eligible in this version.
- Every admin-mutating route must use `@UseGuards(DispatchAuthGuard)` and accept `DispatchAuthDto` in its body, matching every other dispatch route.
- Every admin-mutating frontend call must use `fetchJsonAdmin` (not `fetchJson`), matching `deleteRun`/`deleteErroredRuns`/`deleteFailedJudgeCalls`.
- New DB columns are additive only (nullable or defaulted) — no destructive migrations.
- Follow existing test conventions exactly: NestJS services get Jest unit-test coverage with hand-rolled repo/queue mocks (see `strategy-dispatch.service.spec.ts`, `llm-strategy-runner.service.spec.ts`); thin controller routes and presentational React components in this codebase currently have no dedicated test file of their own (`DeleteRunModal.tsx` has none) — don't invent a new testing pattern for this feature that the rest of the codebase doesn't use.

---

### Task 1: `SolvePrompt.manualRetry` column and runner threading

**Files:**
- Modify: `backend/src/modules/strategy/entities/solve-prompt.entity.ts:111-116`
- Create: `backend/src/migrations/1802000000000-add-solve-prompt-manual-retry.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts:180`, `:367-385`, `:456-469`, `:544-577`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Produces: `SolvePrompt.manualRetry: boolean` (DB column, default `false`).
- Produces: `LlmStrategyRunner.runLlmStrategy(puzzleId: number, strategyName: string, trialNumber = 0, model?: string, manualRetry = false)` — new 5th parameter, defaults to `false` so every existing caller is unaffected.
- Consumes: nothing new (pure addition to an existing method/entity).

`promptType` (`initialSolve`/`retry`) already exists on `SolvePrompt` and tracks a completely different, orthogonal fact: whether *this specific call* is re-prompting because the model's previous guess was wrong (game logic — see `llm-strategy-runner.service.ts:337-339`). `manualRetry` tracks whether the call happened during an admin-triggered resume of an errored run. A manually-resumed call can be either an `initialSolve` or a `retry` in the existing sense, so this must be a second, independent column — not a new value squeezed into `promptType`.

- [ ] **Step 1: Write failing tests for `manualRetry` on both the success and CALL_ERROR SolvePrompt row paths**

Add to `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, immediately after the existing test `"should persist promptText on success rows as the transcript through the user turn, for both INITIAL and RETRY prompts"` (ends around line 711):

```ts
    it("stamps manualRetry true on a success row when the run is a manual retry", async () => {
      mockOrchestratorService.requestSolveStep.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      await runner.runLlmStrategy(100, "llm-openai", 0, undefined, true);

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ manualRetry: true }));
    });

    it("leaves manualRetry false on a success row for an ordinary (non-retried) run", async () => {
      mockOrchestratorService.requestSolveStep.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ manualRetry: false }));
    });
```

Add a second pair right after the existing test `"should write a CALL_ERROR row for a terminal failure, carrying whatever raw detail the orchestrator returned"` (ends around line 1110):

```ts
    it("stamps manualRetry true on a CALL_ERROR row when the run is a manual retry", async () => {
      process.env.LLM_MAX_MODEL_ERRORS = "1";
      try {
        mockOrchestratorService.requestSolveStep.mockResolvedValue({
          ok: false,
          error: { error: "model down", code: "model_error", statusCode: 502 },
        });

        await runner.runLlmStrategy(100, "llm-openai", 0, undefined, true);

        const promptRows = mockManager.insert.mock.calls
          .filter((call) => call[0] === "SolvePrompt")
          .flatMap((call) => call[1] as Array<Record<string, unknown>>);
        expect(promptRows[0]).toEqual(
          expect.objectContaining({ status: "callError", manualRetry: true }),
        );
      } finally {
        delete process.env.LLM_MAX_MODEL_ERRORS;
      }
    });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts -t "manualRetry"`
Expected: FAIL — `manualRetry` is `undefined` on every row (the field doesn't exist yet), and `runLlmStrategy` doesn't accept a 5th argument yet (TypeScript will also fail to compile the test file).

- [ ] **Step 3: Add the `manualRetry` column to the `SolvePrompt` entity**

In `backend/src/modules/strategy/entities/solve-prompt.entity.ts`, insert immediately after the `attemptNumber` column (currently lines 111-115):

```ts
  // 1-based within promptNumber's step — distinguishes an OpenAI call the
  // backend had to retry (orchestrator.service.ts) from the step's other
  // attempts, all of which share the same promptNumber.
  @Column({ type: "int", default: 1 })
  attemptNumber: number;

  // True for every row created while this step's run was resuming after an
  // admin manually retried it from the 'error' status (see
  // llm-strategy-runner.service.ts's runLlmStrategy `manualRetry` parameter
  // and StrategyDispatch.retryRun). Orthogonal to promptType above, which
  // tracks whether *this specific call* is re-prompting after a wrong guess
  // (game logic) — a manually-retried run can produce either kind, so this
  // needs its own column rather than a third promptType value.
  @Column({ type: "boolean", default: false })
  manualRetry: boolean;
```

- [ ] **Step 4: Create the migration**

Create `backend/src/migrations/1802000000000-add-solve-prompt-manual-retry.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds SolvePrompt.manualRetry — see solve-prompt.entity.ts for what it
 * means and why it's a separate column from promptType.
 */
export class AddSolvePromptManualRetry1802000000000 implements MigrationInterface {
  name = "AddSolvePromptManualRetry1802000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD COLUMN "manualRetry" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP COLUMN "manualRetry"
    `);
  }
}
```

Run: `cd backend && npm run migration:run`
Expected: The migration applies cleanly against the local dev database (no errors).

- [ ] **Step 5: Thread `manualRetry` through `runLlmStrategy`**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, change the method signature (line 180):

```ts
  async runLlmStrategy(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
    model?: string,
    manualRetry = false,
  ) {
```

In the success-path `currentPrompt` object (lines 367-385), add `manualRetry,` right after `promptType,`:

```ts
        const currentPrompt: Partial<SolvePrompt> = {
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          attemptNumber,
          promptType,
          manualRetry,
          status: SolvePromptStatus.PARSED,
```

At the CALL_ERROR call site (lines 456-469), pass `manualRetry` through:

```ts
        pendingPrompts.push(
          this.buildCallErrorPromptRow(run.id, globalPromptNumber, promptType, manualRetry, {
            attemptNumber,
            promptText: transcriptText,
            requestBody: outcome.error.requestBody,
            responseId: outcome.error.responseId,
            responseHeaders: outcome.error.responseHeaders,
            responseBody: outcome.error.responseBody,
            statusCode: outcome.error.statusCode,
            errorName: outcome.error.errorName,
            errorMessage: outcome.error.error,
            isRetryable: outcome.error.isRetryable,
          }),
        );
```

Update `buildCallErrorPromptRow`'s signature and body (lines 544-577):

```ts
  private buildCallErrorPromptRow(
    strategyRunId: number,
    promptNumber: number,
    promptType: SolvePromptType,
    manualRetry: boolean,
    attempt: {
      attemptNumber: number;
      promptText: string;
      requestBody?: unknown;
      responseId?: string;
      responseHeaders?: Record<string, string>;
      responseBody?: unknown;
      statusCode?: number;
      errorName?: string;
      errorMessage?: string;
      isRetryable?: boolean;
    },
  ): Partial<SolvePrompt> {
    return {
      strategyRunId,
      promptNumber,
      attemptNumber: attempt.attemptNumber,
      promptType,
      manualRetry,
      status: SolvePromptStatus.CALL_ERROR,
      promptText: attempt.promptText,
      requestBody: attempt.requestBody ?? null,
      responseId: attempt.responseId ?? null,
      responseHeaders: attempt.responseHeaders ?? null,
      responseBody: this.toJsonbResponseBody(attempt.responseBody),
      statusCode: attempt.statusCode ?? null,
      errorName: attempt.errorName ?? null,
      errorMessage: attempt.errorMessage ?? null,
      isRetryable: attempt.isRetryable ?? null,
    };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS — every test in the file, including the 3 new ones (the whole file, not just the filtered subset, since the signature/entity change touches shared code paths).

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/entities/solve-prompt.entity.ts backend/src/migrations/1802000000000-add-solve-prompt-manual-retry.ts backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(strategy): add SolvePrompt.manualRetry and thread it through the run loop

Lays the groundwork for admin-triggered run retry: every SolvePrompt row
created during a manually-resumed run execution is now flagged, separately
from the existing promptType initial/retry distinction (which tracks
something unrelated — game-logic re-prompting after a wrong guess).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Thread `manualRetry` through the BullMQ job payload

**Files:**
- Modify: `backend/src/modules/strategy/llm-job-handler.ts`
- Test: `backend/src/modules/strategy/llm-job-handler.spec.ts`

**Interfaces:**
- Consumes: `LlmStrategyRunner.runLlmStrategy(puzzleId, strategyName, trialNumber, model?, manualRetry?)` from Task 1.
- Produces: `RunStrategyJobData.manualRetry?: boolean` — the job-data field `StrategyDispatch.retryRun` (Task 3) will set to `true` when re-enqueuing.

- [ ] **Step 1: Write a failing test for `manualRetry` passthrough, and fix the now-stale existing assertion**

In `backend/src/modules/strategy/llm-job-handler.spec.ts`, the existing test `"routes a run-strategy job to the strategy runner"` (lines 39-57) currently asserts a 4-argument call. Once Step 3 below adds a 5th argument to every call, that assertion breaks — update it in the same edit:

```ts
  it("routes a run-strategy job to the strategy runner", async () => {
    const runner = { runLlmStrategy: jest.fn().mockResolvedValue({ status: "completed" }) };
    const evaluator = { evaluateProposal: jest.fn() };
    const job = {
      id: "j2",
      name: "run-strategy",
      data: { puzzleId: 1, strategyName: "llm-openai", date: "2024-01-01", trialNumber: 1, model: "gpt-4.1-nano" },
    };

    await handleLlmJob(job as never, {
      llmStrategyRunner: runner as never,
      categoryEvaluatorService: evaluator as never,
      expectedStrategy: "llm-openai",
      logger,
    });

    expect(runner.runLlmStrategy).toHaveBeenCalledWith(1, "llm-openai", 1, "gpt-4.1-nano", false);
    expect(evaluator.evaluateProposal).not.toHaveBeenCalled();
  });
```

Then add a new test right after it:

```ts
  it("passes manualRetry through to the strategy runner when the job data sets it", async () => {
    const runner = { runLlmStrategy: jest.fn().mockResolvedValue({ status: "running" }) };
    const evaluator = { evaluateProposal: jest.fn() };
    const job = {
      id: "j4",
      name: "run-strategy",
      data: {
        puzzleId: 1,
        strategyName: "llm-openai",
        date: "2024-01-01",
        trialNumber: 1,
        model: "gpt-4.1-nano",
        manualRetry: true,
      },
    };

    await handleLlmJob(job as never, {
      llmStrategyRunner: runner as never,
      categoryEvaluatorService: evaluator as never,
      expectedStrategy: "llm-openai",
      logger,
    });

    expect(runner.runLlmStrategy).toHaveBeenCalledWith(1, "llm-openai", 1, "gpt-4.1-nano", true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest llm-job-handler.spec.ts`
Expected: FAIL — both the updated assertion (currently called with 4 args, not 5) and the new test fail.

- [ ] **Step 3: Add `manualRetry` to `RunStrategyJobData` and thread it through `handleLlmJob`**

In `backend/src/modules/strategy/llm-job-handler.ts`, update the interface (lines 6-15):

```ts
export interface RunStrategyJobData {
  puzzleId: number;
  strategyName: string;
  date: string;
  trialNumber: number;
  // The dispatcher already validated this against the SupportedModel table
  // before enqueueing (StrategyDispatch/PuzzleIngestionService) — null/absent
  // for non-LLM strategies, which don't have a model at all.
  model?: string | null;
  // Set only when this job was enqueued by StrategyDispatch.retryRun to
  // resume a run stuck in 'error' — threaded through to
  // LlmStrategyRunner.runLlmStrategy so every SolvePrompt row this
  // execution creates gets manualRetry stamped (see solve-prompt.entity.ts).
  // Absent/false for an ordinary dispatch.
  manualRetry?: boolean;
}
```

Update the `run-strategy` branch (lines 46-60):

```ts
  const { puzzleId, strategyName, date, trialNumber, model, manualRetry } =
    job.data as RunStrategyJobData;
  if (strategyName !== deps.expectedStrategy) {
    throw new Error(
      `Strategy '${strategyName}' dispatched to the '${deps.expectedStrategy}' queue for puzzle ${puzzleId}; expected '${deps.expectedStrategy}'`,
    );
  }
  deps.logger.log(
    `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber}`,
  );
  const result = await deps.llmStrategyRunner.runLlmStrategy(
    puzzleId,
    strategyName,
    trialNumber,
    model ?? undefined,
    manualRetry ?? false,
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest llm-job-handler.spec.ts`
Expected: PASS — all 5 tests in the file.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-job-handler.ts backend/src/modules/strategy/llm-job-handler.spec.ts
git commit -m "$(cat <<'EOF'
feat(strategy): thread manualRetry through the run-strategy job payload

Lets StrategyDispatch.retryRun (next) mark a re-enqueued job as a manual
retry, so the runner stamps every SolvePrompt row it creates accordingly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `StrategyDispatch.retryRun` and the `POST /dispatch/run/:runId/retry` route

**Files:**
- Modify: `backend/src/modules/strategy/strategy-dispatch.service.ts:1`, and a new method added after `countErroredRuns` (currently ends line 295)
- Test: `backend/src/modules/strategy/strategy-dispatch.service.spec.ts`
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts` — new route added after `deleteRun` (currently ends line 379)

**Interfaces:**
- Consumes: `RunStrategyJobData.manualRetry` (Task 2); `runStrategyJobId(puzzleId, strategyName, trialNumber)` (already exported from `strategy.queue.ts`); `this.queueFor(strategyName)` (existing private method on `StrategyDispatch`).
- Produces: `StrategyDispatch.retryRun(runId: number): Promise<{ status: StrategyRunStatus }>`; `POST /dispatch/run/:runId/retry` → `{ message: string; runId: number; status: StrategyRunStatus }`.

No dedicated controller-level test is added — this codebase has no test file for `dispatch.controller.ts` at all (`deleteRun`'s own route is untested at that layer too; only `StrategyDispatch.deleteRun` is unit-tested). The route below is a thin pass-through with no branching logic of its own, so `StrategyDispatch.retryRun`'s unit tests are the real coverage, matching how `deleteRun` is already tested.

- [ ] **Step 1: Write failing tests for `StrategyDispatch.retryRun`**

In `backend/src/modules/strategy/strategy-dispatch.service.spec.ts`, add a new `describe` block right after the existing `describe("deleteRun", ...)` block (ends around line 892):

```ts
  describe("retryRun", () => {
    it("flips an errored run back to running, clears finishedAt, and re-enqueues its job with manualRetry set", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({
          id: 7,
          puzzleId: 100,
          strategyName: "llm-openai",
          trialNumber: 2,
          modelName: "gpt-4.1",
          status: StrategyRunStatus.ERROR,
          finishedAt: new Date("2024-01-01T00:00:00Z"),
          puzzle: { date: "2024-01-01" },
        }),
      );

      const result = await service.retryRun(7);

      expect(result).toEqual({ status: StrategyRunStatus.RUNNING });
      expect(mockStrategyRunRepo.findOne).toHaveBeenCalledWith({
        where: { id: 7 },
        relations: { puzzle: true },
      });
      expect(mockStrategyRunRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: StrategyRunStatus.RUNNING, finishedAt: null }),
      );
      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-01",
          trialNumber: 2,
          model: "gpt-4.1",
          manualRetry: true,
        },
        expect.objectContaining({
          jobId: expect.stringContaining("run-100-llm-openai-2-manual-retry-"),
        }),
      );
    });

    it("rejects a run that isn't in the error status", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ id: 7, status: StrategyRunStatus.RUNNING, puzzle: { date: "2024-01-01" } }),
      );

      await expect(service.retryRun(7)).rejects.toThrow(/not 'error'/);
      expect(mockStrategyRunRepo.save).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });

    it("rejects a nonexistent run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.retryRun(999)).rejects.toThrow(/No strategy run/);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest strategy-dispatch.service.spec.ts -t "retryRun"`
Expected: FAIL — `service.retryRun is not a function`.

- [ ] **Step 3: Implement `StrategyDispatch.retryRun`**

In `backend/src/modules/strategy/strategy-dispatch.service.ts`, update the import on line 1:

```ts
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
```

Add the method right after `countErroredRuns` (currently lines 286-295):

```ts
  /**
   * Resumes a run stuck in the 'error' status — the same flip-status-and-
   * re-enqueue mechanism RpdResumeService uses for a parked
   * RATE_LIMITED_DAILY run, triggered manually instead of by a cron sweep.
   * The status flip is required: runLlmStrategy's TERMINAL_STATUSES gate
   * (see llm-strategy-runner.service.ts) returns immediately without doing
   * anything for a run still in 'error', so simply re-enqueueing the job
   * alone would be a no-op. loadOrCreateRun then finds the existing row by
   * (puzzleId, strategyName, trialNumber) and the solve loop resumes from
   * the last successful guess, since its conversation state is rebuilt from
   * persisted Guess rows on every call regardless of why the run stopped.
   * The jobId gets a fresh timestamp suffix — the original job's id is
   * still occupied by its failed BullMQ job record (removeOnFail keeps up
   * to 5000), so reusing it would collide.
   */
  async retryRun(runId: number): Promise<{ status: StrategyRunStatus }> {
    const run = await this.strategyRunRepo.findOne({
      where: { id: runId },
      relations: { puzzle: true },
    });

    if (!run) {
      throw new NotFoundException(`No strategy run with id: ${runId}`);
    }

    if (run.status !== StrategyRunStatus.ERROR) {
      throw new ConflictException(
        `Strategy run ${runId} is in status '${run.status}', not 'error' — only an errored run can be manually retried.`,
      );
    }

    run.status = StrategyRunStatus.RUNNING;
    run.finishedAt = null;
    await this.strategyRunRepo.save(run);

    await this.queueFor(run.strategyName).add(
      "run-strategy",
      {
        puzzleId: run.puzzleId,
        strategyName: run.strategyName,
        date: run.puzzle.date,
        trialNumber: run.trialNumber,
        model: run.modelName,
        manualRetry: true,
      },
      {
        jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber)}-manual-retry-${Date.now()}`,
      },
    );

    return { status: run.status };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest strategy-dispatch.service.spec.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Add the controller route**

In `backend/src/modules/dispatch/dispatch.controller.ts`, add a new method right after `deleteRun` (currently ends line 379, before the `refreshModelMetadata` method):

```ts
  // Resumes a strategy run stuck in the 'error' status — flips it back to
  // RUNNING and re-enqueues the same (puzzle, strategy, trial, model) job,
  // so the solve loop picks up from the last successful guess instead of
  // starting over. Unlike DELETE run/:runId, nothing is destroyed. Only an
  // 'error'-status run qualifies — see StrategyDispatch.retryRun.
  @Post("run/:runId/retry")
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "runId",
    type: Number,
    description: "The strategy run's numeric id",
    example: 12292,
  })
  @ApiBody({ type: DispatchAuthDto })
  async retryRun(@Param("runId", ParseIntPipe) runId: number) {
    const result = await this.strategyDispatch.retryRun(runId);
    return {
      message: `Strategy run ${runId} requeued for manual retry`,
      runId,
      ...result,
    };
  }
```

- [ ] **Step 6: Build to verify the controller compiles**

Run: `cd backend && npx tsc -p tsconfig.json --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/strategy-dispatch.service.ts backend/src/modules/strategy/strategy-dispatch.service.spec.ts backend/src/modules/dispatch/dispatch.controller.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): add manual retry for errored strategy runs

POST /dispatch/run/:runId/retry flips an 'error'-status run back to running
and re-enqueues its job (manualRetry: true), so an admin can recover from a
transient failure (e.g. a rate limit that exhausted the run's own backoff)
without deleting the run and losing its already-successful calls.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Expose `manualRetry` through the read DTO to the frontend

**Files:**
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts:69-106`
- Modify: `backend/src/modules/strategy/strategy-read.service.ts:830-851`
- Modify: `frontend/src/data/benchmark/types.ts:465-492`
- Test: `backend/src/modules/strategy/strategy-read.service.spec.ts`

**Interfaces:**
- Consumes: `SolvePrompt.manualRetry` (Task 1).
- Produces: `SolvePromptDto.manualRetry: boolean`; `SolvePromptRecord.manualRetry: boolean` (frontend).

- [ ] **Step 1: Write a failing test for `manualRetry` surfacing through `getRunDetailByRunId`**

In `backend/src/modules/strategy/strategy-read.service.spec.ts`, add a new test right after `"should assemble the reconstructed guess chain for an LLM run"` (ends around line 477):

```ts
    it("should surface manualRetry on a solve-prompt row produced by a manual retry", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ id: 7, strategyName: "llm-openai", availableWords: [] }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(0);
      mockGuessRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockSolvePromptRepo.find.mockResolvedValueOnce([
        {
          id: 502,
          strategyRunId: 7,
          promptNumber: 1,
          promptType: "initialSolve",
          status: "parsed",
          manualRetry: true,
          rawResponseText: "raw",
          promptText: "[User]\nprompt\n\n[Assistant]\nraw",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 500,
          temperature: 0.2,
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
      ]);
      mockLlmProposalRepo.find.mockResolvedValueOnce([]);

      const result = await service.getRunDetailByRunId(7);

      expect(result.solvePrompts[0]!.manualRetry).toBe(true);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest strategy-read.service.spec.ts -t "manualRetry"`
Expected: FAIL — `result.solvePrompts[0]!.manualRetry` is `undefined`.

- [ ] **Step 3: Add the field to `SolvePromptDto`**

In `backend/src/modules/strategy/dto/strategy.dto.ts`, add `manualRetry: boolean;` right after `promptType: SolvePromptType;` (line 72):

```ts
export interface SolvePromptDto {
  id: number;
  promptNumber: number;
  promptType: SolvePromptType;
  manualRetry: boolean;
  status: SolvePromptStatus;
```

- [ ] **Step 4: Map it in `strategy-read.service.ts`**

In `backend/src/modules/strategy/strategy-read.service.ts`, add `manualRetry: prompt.manualRetry,` right after `promptType: prompt.promptType,` in the returned object (around line 833):

```ts
      return {
        id: prompt.id,
        promptNumber: prompt.promptNumber,
        promptType: prompt.promptType,
        manualRetry: prompt.manualRetry,
        status: prompt.status,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest strategy-read.service.spec.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 6: Add the field to the frontend type**

In `frontend/src/data/benchmark/types.ts`, add `manualRetry: boolean;` right after `promptType: SolvePromptTypeValue;` (line 468):

```ts
export interface SolvePromptRecord {
  id: number;
  promptNumber: number;
  promptType: SolvePromptTypeValue;
  manualRetry: boolean;
  status: SolvePromptStatusValue;
```

- [ ] **Step 7: Run the frontend build to verify no type errors**

Run: `cd frontend && npx tsc -b`
Expected: No errors. (This will surface any other place `SolvePromptRecord` is constructed by hand and now needs `manualRetry` too — fix any such spot the same way, adding `manualRetry: false` for mock/fixture data that predates this feature, e.g. `frontend/src/data/benchmark/mockData.ts` if it hand-builds `SolvePromptRecord` objects.)

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy-read.service.ts backend/src/modules/strategy/strategy-read.service.spec.ts frontend/src/data/benchmark/types.ts
git commit -m "$(cat <<'EOF'
feat(strategy): surface SolvePrompt.manualRetry through the run-detail API

Threads the manual-retry flag from Task 1 out through SolvePromptDto and
into the frontend's SolvePromptRecord type, so the guess-chain UI (next)
can badge the affected steps.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Frontend — retry button, confirmation modal, and "Manually retried" badge

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts` (add `RetryRunResult`, near `DeleteRunResult` at line 504)
- Modify: `frontend/src/data/benchmark/api.ts` (add `retryRun`, near `deleteRun` at line 339)
- Test: `frontend/src/data/benchmark/api.test.ts`
- Create: `frontend/src/components/benchmark/RetryRunModal.tsx`
- Modify: `frontend/src/components/benchmark/GuessChainVisualizer.tsx`
- Modify: `frontend/src/benchmark.css:837-842` (new `.bench-visualizer__actions` rule)

**Interfaces:**
- Consumes: `POST /dispatch/run/:runId/retry` (Task 3); `SolvePromptRecord.manualRetry` (Task 4).
- Produces: `retryRun(runId: number, signal?: AbortSignal): Promise<RetryRunResult>`; `<RetryRunModal runId={number} onClose={() => void} />`.

No dedicated test file is added for `RetryRunModal.tsx` or the `GuessChainVisualizer.tsx` changes — this codebase has no component test for any file in `frontend/src/components/benchmark/` (including `DeleteRunModal.tsx`, which this closely mirrors). Coverage here comes from the `api.ts` unit test (Step 1-4) plus manual verification in the browser (Step 8).

- [ ] **Step 1: Write failing tests for the `retryRun` API function**

In `frontend/src/data/benchmark/types.ts`, add right after `DeleteRunResult` (ends around line 511):

```ts
/** Response from POST /dispatch/run/:runId/retry — the run's new status
 * (always "running" on success; the request rejects otherwise). */
export interface RetryRunResult {
  message: string;
  runId: number;
  status: string;
}
```

In `frontend/src/data/benchmark/api.test.ts`, add `retryRun` to the import list at the top:

```ts
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  deleteErroredRuns,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchFailedJudgeCallCount,
  fetchRecentActivity,
  retryRun,
  toRunRecord,
} from "./api";
```

Then add a new `describe` block right after `describe("deleteErroredRuns", ...)` (ends around line 154):

```ts
  describe("retryRun", () => {
    it("POSTs /dispatch/run/:runId/retry with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Strategy run 42 requeued for manual retry",
        runId: 42,
        status: "running",
      });

      const result = await retryRun(42);

      expect(result.status).toBe("running");
      expect(calls[0].url).toContain("/dispatch/run/42/retry");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(retryRun(42)).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run api.test.ts`
Expected: FAIL — `retryRun` doesn't exist yet (import error).

- [ ] **Step 3: Implement `retryRun` in `api.ts`**

In `frontend/src/data/benchmark/api.ts`, add right after `deleteRun` (ends line 341):

```ts
/** Resumes a run stuck in the 'error' status — flips it back to running and
 * re-enqueues its job, preserving every previously successful call. Rejects
 * (thrown Error, message from the backend) if the run isn't in the 'error'
 * status, doesn't exist, or the admin session has expired. The run resumes
 * asynchronously on the job queue, so this resolving only means the retry
 * was accepted — not that the run has finished (see RetryRunModal). */
export function retryRun(runId: number, signal?: AbortSignal): Promise<RetryRunResult> {
  return fetchJsonAdmin(`/dispatch/run/${runId}/retry`, signal, { method: "POST" });
}
```

Add `RetryRunResult` to the existing `import type { ... } from "./types"` block at the top of the file (find `DeleteRunResult` in that import and add `RetryRunResult` alongside it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run api.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Create `RetryRunModal.tsx`**

Create `frontend/src/components/benchmark/RetryRunModal.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { retryRun } from "../../data/benchmark/api";

export interface RetryRunModalProps {
  runId: number;
  onClose: () => void;
}

/** Confirmation modal for manually resuming a run stuck in the 'error'
 * status — same overlay pattern as DeleteRunModal, but non-destructive: on
 * success it stays open with a confirmation instead of closing, since
 * (unlike a delete) the run doesn't disappear from view, and v1 has no live
 * progress polling — the admin refreshes the page manually to see the new
 * steps once the job has run. */
export function RetryRunModal({ runId, onClose }: RetryRunModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await retryRun(runId);
      setSucceeded(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to retry run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="bench-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="retry-run-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bench-modal">
        <h2 id="retry-run-title" className="bench-modal__title">
          Manually retry run #{runId}
        </h2>

        {succeeded ? (
          <>
            <p>
              Run #{runId} has been requeued and is resuming from its last successful call. Refresh
              the page to see progress.
            </p>
            <div className="bench-modal__actions">
              <button type="button" className="bench-sort-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p>
              This resumes run #{runId} from its last successful call and makes new, real model API
              calls. Previously successful calls are kept.
            </p>
            {error ? <p className="bench-error">{error}</p> : null}

            <div className="bench-modal__actions">
              <button type="button" className="bench-sort-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="bench-sort-btn" disabled={isSubmitting}>
                {isSubmitting ? "Retrying…" : "Retry"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire the button, modal, and badge into `GuessChainVisualizer.tsx`**

`bench-visualizer__head` (`frontend/src/benchmark.css:837-842`) is a `display: flex; justify-content: space-between` row currently holding exactly two children: the title block, and (conditionally) the single "Delete this run" button. Wiring in a second button means that second flex child needs to become a small row of two buttons — add a matching utility class for it. In `frontend/src/benchmark.css`, insert right after the `.bench-visualizer__head` rule (lines 837-842):

```css
.bench-visualizer__actions {
  display: flex;
  gap: 0.5rem;
}
```

Add the import right after `DeleteRunModal`'s import (line 18):

```ts
import { DeleteRunModal } from "./DeleteRunModal";
import { RetryRunModal } from "./RetryRunModal";
```

Add a `showRetryModal` state right after `showDeleteModal` (line 43):

```ts
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRetryModal, setShowRetryModal] = useState(false);
```

Add a "Manually retry" button next to "Delete this run" (lines 52-60) — same `isAdmin && detail?.status === "error"` gate, so both actions appear and disappear together:

```tsx
        {isAdmin && detail?.status === "error" ? (
          <div className="bench-visualizer__actions">
            <button
              type="button"
              className="bench-sort-btn"
              onClick={() => setShowRetryModal(true)}
            >
              Manually retry
            </button>
            <button
              type="button"
              className="bench-sort-btn bench-sort-btn--danger"
              onClick={() => setShowDeleteModal(true)}
            >
              Delete this run
            </button>
          </div>
        ) : null}
```

Render the modal alongside the existing `DeleteRunModal` render (after line 80):

```tsx
      {showDeleteModal ? (
        <DeleteRunModal
          runId={runId}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={(result) => onDeleted?.(result)}
        />
      ) : null}

      {showRetryModal ? (
        <RetryRunModal runId={runId} onClose={() => setShowRetryModal(false)} />
      ) : null}
```

Add the "Manually retried" badge in `PromptStep`, right after the existing type span (lines 108-111):

```tsx
        <span className="bench-mono bench-step__number">#{prompt.promptNumber}</span>
        <span className="bench-step__type">
          {prompt.promptType === "retry" ? "Retry" : "Initial solve"}
        </span>
        {prompt.manualRetry ? <StatusPill label="Manually retried" tone="neutral" /> : null}
```

- [ ] **Step 7: Run the frontend build and test suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: No type errors; all tests pass.

- [ ] **Step 8: Manually verify in the browser**

Run: `cd frontend && npm run dev` (and the backend dev server, per the project's normal local-dev setup).
1. Log in as admin (`/admin-login`).
2. Navigate to a run detail page for a run currently in the `error` status (or manufacture one — e.g. temporarily force `LLM_MAX_MODEL_ERRORS=1` and dispatch a run against a mocked-down orchestrator).
3. Confirm "Manually retry" appears next to "Delete this run", and disappears once the run's status is no longer `error`.
4. Click it, confirm in the modal, confirm the success message appears with no auto-close.
5. Refresh the page; confirm new steps appear in the guess chain with a "Manually retried" badge, and that the run's earlier (pre-retry) steps are unchanged and un-badged.

Expected: Matches all of the above. If step 2 is impractical to manufacture locally, at minimum verify the button is correctly hidden for a `completed` run and behaves correctly against the backend's actual `ConflictException` response for a non-`error` run (e.g. by calling the endpoint directly with curl/Swagger against a non-errored run id and confirming the modal surfaces that rejection message).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/data/benchmark/api.test.ts frontend/src/components/benchmark/RetryRunModal.tsx frontend/src/components/benchmark/GuessChainVisualizer.tsx frontend/src/benchmark.css
git commit -m "$(cat <<'EOF'
feat(benchmark): add a manual-retry action for errored runs to the UI

Adds a "Manually retry" button next to "Delete this run" (admin-only, same
gating), a confirmation modal, and a "Manually retried" badge on the steps
a retry produces — closing the loop on the backend work from the prior
commits in this series.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
