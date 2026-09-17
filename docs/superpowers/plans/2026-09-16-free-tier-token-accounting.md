# Free-Tier Token Accounting Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #42 — calls that bill OpenAI tokens (often 10k-16k reasoning tokens for `gpt-5-nano`/`gpt-5.4-nano`) but end up as a `callError` row currently persist with `promptTokens`/`completionTokens`/`totalTokens` all `NULL`, so `FreeTierUsageService`'s `SUM()` silently counts them as zero, the daily free-tier cap gauge undercounts real spend, and `FreeTierDispatchService` overshoots the real 2.5M/day mini-tier cap onto OpenAI's paid tier. This plan makes every billed call — success or failure — record its tokens, adds a `reasoningTokens` breakdown column so reasoning spend is visible on its own instead of silently folded into `completionTokens`, backfills historical rows from data already stored, and surfaces the new figures in the two UI views that already show token/cost detail.

**Architecture:** The failure happens at three points in a chain that already threads a narrowed `{promptTokens, completionTokens, totalTokens}` usage shape from the AI SDK's `generateText`/`generateObject` result, through the orchestrator's HTTP response, into the backend's `SolvePrompt`/`CategoryEvaluation` rows: (1) when a call succeeds but downstream validation rejects the output (`answer-step.ts`'s empty-groups check, and `generateObject`'s own `NoObjectGeneratedError` in the judge path), the orchestrator throws a `SolveError` whose `details` bag never carried the already-computed `usage` object; (2) the backend's `buildCallErrorPromptRow`/judge-path error-save never read a `usage` field because none existed to read; (3) nothing separates reasoning tokens from ordinary completion tokens anywhere in the shape, so there's no way to see reasoning spend independent of total spend. The fix widens the usage shape end-to-end to include `reasoningTokens`, attaches it to the thrown `SolveError` at both failure points, reads it on the backend's error-row builders, adds a nullable `reasoningTokens` column to both entities, backfills historical rows from the raw `responseBody` JSON already stored, and renders it in the two UI surfaces that already show per-call token detail.

**Tech Stack:** NestJS + TypeORM + Postgres (backend), Vercel AI SDK v5 (`ai`, `@ai-sdk/openai`) + Hono (orchestrator, tested with **Vitest**, not Jest), React + Vite (frontend). Backend and orchestrator are separate npm packages with separate test runners — backend specs are Jest (`*.spec.ts`), orchestrator specs are Vitest (`*.test.ts`).

**Spec:** https://github.com/Donrwalsh/Connections/issues/42 — the full agreed scope below was worked out in a requirements session on top of that issue (no separate written spec doc; the issue plus this plan's Global Constraints are the complete spec).

## Global Constraints

- Reasoning tokens are already a priced *subset* of `completionTokens` (OpenAI bills them as ordinary output tokens, and the AI SDK's `outputTokens` already includes them) — `reasoningTokens` is purely informational. Never add it into `totalTokens`, never let it affect `FreeTierUsageService`'s cap math, never let it affect `computeTokenCostUsd`.
- Do not add a query-time JSON-parsing fallback (e.g. `coalesce(totalTokens, responseBody->'usage'->>'total_tokens')`) to `FreeTierUsageService.getUsage`. Between the forward-fix (Tasks 1-3, 6-7) and the backfill script (Task 10) writing real values into the actual columns, every row will have real columns populated — a live JSON-parsing fallback would be dead defensive code for a scenario that can no longer happen.
- Out of scope, do not implement or suggest folding in: reasoning-effort capping (`providerOptions.openai.reasoningEffort`) or dropping `gpt-5-nano` from rotation; fixing `DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE` in `backend/src/strategies.ts` (handled separately by the user); dispatcher headroom/safety margin; reconciliation against OpenAI's own usage/costs API; any change to `StrategyTable.tsx` (leaderboard) or `RunHistoryTable.tsx` (they show no raw token counts today and should stay that way); the `/diagnose` AI Assist path (`captureTelemetry: false` — deliberately never persists telemetry, do not touch); cached-input-token pricing (`model-price.entity.ts` deliberately doesn't price it — unrelated gap).
- Every new/changed nullable column follows this codebase's existing pattern: `@Column({ type: "int", nullable: true })` with the TS type `number | null`.
- Migrations are auto-discovered via `migrations: [__dirname + "/migrations/*{.ts,.js}"]` in `data-source.ts` — a new migration file needs no separate registration. Only new *entities* need registration in `data-source.ts`/`app.module.ts`; this plan adds columns to existing entities only, so no entity registration is needed anywhere.
- NestJS constructor injection in this backend requires explicit `@Inject(Token)` — bare typed constructor parameters silently resolve to `undefined` under this project's tsx/esbuild runtime. Follow the existing `@Inject(...)` pattern in any class this plan touches.

---

## File Structure

**Orchestrator (`orchestrator/src/`):**
- `types.ts` — modify: widen the two `usage` zod sub-schemas with `reasoningTokens`.
- `answer-step.ts` — modify: narrow `reasoningTokens` into `AnswerStepResult["usage"]`; attach `usage` to the `invalid_group` `SolveError`.
- `judge-category.ts` — modify: narrow `reasoningTokens` into `JudgeCategoryResult["usage"]`.
- `solver.ts` — modify: `SolveErrorDetails` gains `usage`; `classifyModelCallError` extracts `usage` from a `NoObjectGeneratedError`.

**Backend (`backend/src/modules/strategy/`):**
- `orchestrator.service.ts` — modify: `SolveUsage` gains `reasoningTokens`; `SolveStepFailure` gains `usage`; `extractCallDetail` reads it.
- `entities/solve-prompt.entity.ts`, `entities/category-evaluation.entity.ts` — modify: add `reasoningTokens` column.
- `backend/src/migrations/` — create: one migration adding the column to both tables.
- `llm-strategy-runner.service.ts` — modify: success path sets `reasoningTokens`; `buildCallErrorPromptRow` reads `usage` for all four token fields.
- `category-evaluator.service.ts` — modify: success path sets `reasoningTokens`; error path reads `usage` for all four token fields (today hardcoded `null`).
- `dto/strategy.dto.ts` — modify: `SolvePromptDto`/`CategoryEvaluationDto` gain `reasoningTokens`.
- `strategy-read.service.ts` — modify: two DTO-mapping sites pass `reasoningTokens` through.
- `free-tier-usage.service.ts` — modify: `FreeTierUsageDto` gains `reasoningTokensUsedToday`; `getUsage` sums it.
- `backend/src/scripts/backfill-token-usage.ts` — create: one-off backfill script (dry-run + write modes) for historical rows in both tables.
- `backend/package.json` — modify: add `backfill:token-usage` script.

**Frontend (`frontend/src/`):**
- `data/benchmark/types.ts` — modify: `SolvePromptRecord`, `CategoryEvaluationRecord`, `FreeTierUsage` each gain their new field.
- `components/benchmark/GuessChainVisualizer.tsx` — modify: show reasoning tokens in the "Raw response" detail and the judge sub-panel.
- `components/benchmark/FreeTierBudgetWidget.tsx` — modify: show today's reasoning-token figure next to the cap bar.

---

### Task 1: Orchestrator — widen the usage shape with `reasoningTokens`

**Files:**
- Modify: `orchestrator/src/types.ts:126-132` (`SolveStepResponseSchema.usage`), `orchestrator/src/types.ts:166-172` (`JudgeCategoryResponseSchema.usage`)
- Modify: `orchestrator/src/answer-step.ts:25-29` (`AnswerStepResult["usage"]` type), `orchestrator/src/answer-step.ts:110-117` (narrowing)
- Modify: `orchestrator/src/judge-category.ts:23` (`JudgeCategoryResult["usage"]` type), `orchestrator/src/judge-category.ts:91-98` (narrowing)
- Test: `orchestrator/src/answer-step.test.ts`, `orchestrator/src/judge-category.test.ts`

**Interfaces:**
- Produces: `AnswerStepResult["usage"]` and `JudgeCategoryResult["usage"]` now include `reasoningTokens?: number`, consumed by Task 2 (answer-step.ts's throw) and by the backend in Task 6/7 via `data.usage?.reasoningTokens`.

- [ ] **Step 1: Write the failing test — answer-step.ts captures reasoningTokens on success**

Add to `orchestrator/src/answer-step.test.ts`, inside the existing `describe("runAnswerStep", ...)` block, right after the `"captures the raw request/response detail on a successful call by default"` test (after line 76):

```ts
  it("captures reasoningTokens alongside the rest of usage on a successful call", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: { modelId: "gpt-5-nano", id: "resp_456" },
      request: { body: {} },
      usage: {
        inputTokens: 200,
        outputTokens: 500,
        totalTokens: 700,
        outputTokenDetails: { textTokens: 100, reasoningTokens: 400 },
      },
    });

    const result = await runAnswerStep(MESSAGES);

    expect(result.usage).toEqual({
      promptTokens: 200,
      completionTokens: 500,
      totalTokens: 700,
      reasoningTokens: 400,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npx vitest run answer-step.test.ts`
Expected: FAIL — `result.usage` is missing `reasoningTokens` (actual result has only `promptTokens`/`completionTokens`/`totalTokens`).

- [ ] **Step 3: Widen `AnswerStepResult["usage"]` and the narrowing**

In `orchestrator/src/answer-step.ts`, change the `usage` field of `AnswerStepResult` (lines 25-29):

```ts
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
```

Change the narrowing block (lines 110-117):

```ts
      if (result.usage) {
        const u: LanguageModelUsage = result.usage;
        usage = {
          promptTokens: u.inputTokens,
          completionTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          reasoningTokens: u.outputTokenDetails.reasoningTokens,
        };
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run answer-step.test.ts`
Expected: PASS (all tests in the file, including the new one and the pre-existing `"skips requesting request/response body detail..."` one, which asserts `result.usage` is `undefined` and is unaffected).

- [ ] **Step 5: Write the failing test — judge-category.ts captures reasoningTokens on success**

Add to `orchestrator/src/judge-category.test.ts`, right after the existing `"returns the verdict, rationale, model, and captured call detail"` test:

```ts
  it("captures reasoningTokens alongside the rest of usage", async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: "correct", rationale: "Same connection, different wording." },
      response: { id: "resp_789", headers: {}, body: {} },
      request: { body: {} },
      usage: {
        inputTokens: 80,
        outputTokens: 300,
        totalTokens: 380,
        outputTokenDetails: { textTokens: 30, reasoningTokens: 270 },
      },
    });

    const result = await judgeCategory("wordplay", "wordplay");

    expect(result.usage).toEqual({
      promptTokens: 80,
      completionTokens: 300,
      totalTokens: 380,
      reasoningTokens: 270,
    });
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run (from `orchestrator/`): `npx vitest run judge-category.test.ts`
Expected: FAIL — `reasoningTokens` missing from `result.usage`.

- [ ] **Step 7: Widen `JudgeCategoryResult["usage"]` and the narrowing**

In `orchestrator/src/judge-category.ts`, change line 23:

```ts
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
```

Change the narrowing block (lines 91-98):

```ts
    let usage: JudgeCategoryResult["usage"];
    if (result.usage) {
      const u: LanguageModelUsage = result.usage;
      usage = {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        reasoningTokens: u.outputTokenDetails.reasoningTokens,
      };
    }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run judge-category.test.ts`
Expected: PASS.

- [ ] **Step 9: Widen the zod schemas so the HTTP response shape allows the new field**

In `orchestrator/src/types.ts`, change the `usage` object inside `SolveStepResponseSchema` (lines 126-132):

```ts
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
    })
    .optional(),
```

And inside `JudgeCategoryResponseSchema` (lines 166-172), the same change:

```ts
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      reasoningTokens: z.number().optional(),
    })
    .optional(),
```

Note: `app.ts`'s route handlers assign `result` directly to a `SolveStepResponse`/`JudgeCategoryResponse`-typed const and return it via `c.json(...)` — they don't call `.parse()`/`.safeParse()` on the outgoing response, so this is a type-level widening only; no runtime validation to adjust.

- [ ] **Step 10: Run the full orchestrator test suite**

Run (from `orchestrator/`): `npx vitest run`
Expected: PASS — no other test depended on the old narrower `usage` shape.

- [ ] **Step 11: Commit**

```bash
git add orchestrator/src/types.ts orchestrator/src/answer-step.ts orchestrator/src/answer-step.test.ts orchestrator/src/judge-category.ts orchestrator/src/judge-category.test.ts
git commit -m "feat(orchestrator): widen usage shape with reasoningTokens"
```

---

### Task 2: Orchestrator — attach usage to the `invalid_group` SolveError (answer-step.ts's own validation throw)

This is the first of the two failure points from the issue: `generateText` succeeds (tokens billed) but `parseAnswer` finds no groups, so `answer-step.ts` throws `SolveError("invalid_group", ...)` directly — today without the `usage` it already computed moments earlier in the same function.

**Files:**
- Modify: `orchestrator/src/answer-step.ts:130-136`
- Test: `orchestrator/src/answer-step.test.ts`

**Interfaces:**
- Consumes: `usage: AnswerStepResult["usage"]` (Task 1), already in scope in `runAnswerStep` at the point of the throw.
- Produces: the thrown `SolveError`'s `details.usage` — consumed by Task 6's `buildCallErrorPromptRow` after crossing the HTTP boundary (Task 4).

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/src/answer-step.test.ts`, right after the existing `"rejects a response with no parseable ANSWER or GROUPS section as invalid_group"` test:

```ts
  it("attaches the already-billed usage to the invalid_group SolveError instead of dropping it", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "I don't know the answer",
      response: { modelId: "gpt-5-nano", id: "resp_999" },
      request: { body: {} },
      usage: {
        inputTokens: 2100,
        outputTokens: 16000,
        totalTokens: 18100,
        outputTokenDetails: { textTokens: 100, reasoningTokens: 15900 },
      },
    });

    await expect(runAnswerStep(MESSAGES)).rejects.toMatchObject({
      code: "invalid_group",
      details: {
        usage: {
          promptTokens: 2100,
          completionTokens: 16000,
          totalTokens: 18100,
          reasoningTokens: 15900,
        },
      },
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npx vitest run answer-step.test.ts`
Expected: FAIL — thrown `SolveError.details` has no `usage` key at all.

- [ ] **Step 3: Attach usage to the throw**

In `orchestrator/src/answer-step.ts`, change lines 130-136:

```ts
  if (parsed.groups.length === 0) {
    throw new SolveError(
      "invalid_group",
      'Model response contained no parseable group proposals or "ANSWER:" section',
      { model: modelId, latencyMs, requestBody, responseId, responseHeaders, responseBody, usage },
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run answer-step.test.ts`
Expected: PASS (full file).

- [ ] **Step 5: Widen `SolveErrorDetails` so this compiles**

In `orchestrator/src/solver.ts`, add a `usage` field to `SolveErrorDetails` (after `dailyResetSeconds` at line 34, before the closing `}` at line 35):

```ts
  // Tokens the AI SDK reported for this call, when a `SolveError` is thrown
  // *after* a call that still billed tokens (e.g. the call succeeded but its
  // output failed downstream validation) — see answer-step.ts's invalid_group
  // throw and classifyModelCallError's NoObjectGeneratedError branch. Absent
  // when the call itself failed outright (no tokens were ever billed).
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
```

- [ ] **Step 6: Run the full orchestrator test suite**

Run (from `orchestrator/`): `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/answer-step.ts orchestrator/src/answer-step.test.ts orchestrator/src/solver.ts
git commit -m "fix(orchestrator): attach billed usage to the invalid_group SolveError"
```

---

### Task 3: Orchestrator — extract usage from `NoObjectGeneratedError` in `classifyModelCallError` (judge path)

This is the second failure point: `judge-category.ts` calls `generateObject` with a zod schema; when the model's output fails schema validation, the AI SDK itself throws `NoObjectGeneratedError` *before* `judgeCategory`'s own code ever sees a result — so there is no `result.usage` to narrow in `judge-category.ts` itself. But `NoObjectGeneratedError` carries its own `.usage: LanguageModelUsage | undefined` property (confirmed in `orchestrator/node_modules/ai/dist/index.d.ts`), which `classifyModelCallError` (the function `judge-category.ts`'s catch block routes every thrown error through) currently ignores entirely.

**Files:**
- Modify: `orchestrator/src/solver.ts:498-508`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `NoObjectGeneratedError.usage` (from the `ai` package, already imported in `solver.ts`).
- Produces: `SolveError.details.usage`, same shape as Task 2 — consumed identically by Task 7's judge-path error row.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/src/solver.test.ts`, inside the `describe("classifyModelCallError", ...)` block (after any of the existing tests, e.g. right after line 102's block):

```ts
  it("attaches usage from a NoObjectGeneratedError so a billed-but-malformed judge call still records its tokens", () => {
    const err = new NoObjectGeneratedError({
      message: "No object generated: response did not match schema.",
      text: "not json",
      response: { id: "resp_555", timestamp: new Date(), modelId: "gpt-5-nano" },
      usage: {
        inputTokens: 90,
        outputTokens: 12000,
        totalTokens: 12090,
        inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 40, reasoningTokens: 11960 },
      },
      finishReason: "stop",
    });

    const result = classifyModelCallError(err, "openai", { model: "gpt-5-nano" });

    expect(result.code).toBe("invalid_group");
    expect(result.details.usage).toEqual({
      promptTokens: 90,
      completionTokens: 12000,
      totalTokens: 12090,
      reasoningTokens: 11960,
    });
  });
```

Add `NoObjectGeneratedError` to the existing `import { APICallError, RetryError } from "ai";` at the top of the file (line 2):

```ts
import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npx vitest run solver.test.ts`
Expected: FAIL — `result.details.usage` is `undefined`.

- [ ] **Step 3: Extract usage in the NoObjectGeneratedError branch**

In `orchestrator/src/solver.ts`, change lines 498-508:

```ts
  if (
    err instanceof NoObjectGeneratedError ||
    err instanceof TypeValidationError ||
    err instanceof JSONParseError
  ) {
    const usage =
      err instanceof NoObjectGeneratedError && err.usage
        ? {
            promptTokens: err.usage.inputTokens,
            completionTokens: err.usage.outputTokens,
            totalTokens: err.usage.totalTokens,
            reasoningTokens: err.usage.outputTokenDetails.reasoningTokens,
          }
        : undefined;
    return new SolveError(
      "invalid_group",
      `Model produced a malformed response: ${message}`,
      { ...details, usage },
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run solver.test.ts`
Expected: PASS (full file — this branch is shared by every provider's `describe` block, so confirm none of those broke).

- [ ] **Step 5: Run the full orchestrator test suite**

Run (from `orchestrator/`): `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts
git commit -m "fix(orchestrator): extract usage from NoObjectGeneratedError for the judge path"
```

---

### Task 4: Backend — thread `usage`/`reasoningTokens` through `OrchestratorService`

The orchestrator's error response body is `{ error, code, details }`, where `details` is the `SolveErrorDetails` object from Task 2/3 — already including `usage` once those land, since `app.ts`'s catch handlers spread `err.details` wholesale into the JSON response with no schema stripping it. This task makes the backend's HTTP client (`OrchestratorService`) actually read that field out.

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts:7-11` (`SolveUsage`), `:42-58` (`SolveStepFailure`), `:241-267` (`extractCallDetail`)
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `SolveStepFailure.usage?: SolveUsage` (with `SolveUsage` now including `reasoningTokens?: number`) — consumed by Task 6 (`llm-strategy-runner.service.ts`'s `outcome.error.usage`) and Task 7 (`category-evaluator.service.ts`'s `outcome.error.usage`).

- [ ] **Step 1: Write the failing test**

Check `backend/src/modules/strategy/orchestrator.service.spec.ts` for how a failure response is mocked (likely a `fetch` mock returning `ok: false` with a JSON body). Add a test there, in the `describe` block covering failure/`extractCallDetail` behavior:

```ts
  it("extracts usage (including reasoningTokens) from the orchestrator's error details", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Model produced a malformed response",
        code: "invalid_group",
        details: {
          usage: { promptTokens: 2100, completionTokens: 16000, totalTokens: 18100, reasoningTokens: 15900 },
        },
      }),
    });

    const outcome = await service.requestSolveStep([{ role: "user", content: "hi" }]);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.usage).toEqual({
        promptTokens: 2100,
        completionTokens: 16000,
        totalTokens: 18100,
        reasoningTokens: 15900,
      });
    }
  });
```

(If the existing spec mocks `global.fetch` differently — e.g. via `jest.spyOn(global, "fetch")` rather than a `mockFetch` variable — match whatever pattern the file's other failure-path tests already use instead of introducing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx jest orchestrator.service.spec.ts`
Expected: FAIL — `outcome.error.usage` is `undefined` (TypeScript may also flag the property as not existing on `SolveStepFailure` yet, depending on how the test is typed).

- [ ] **Step 3: Widen `SolveUsage` and `SolveStepFailure`, update `extractCallDetail`**

In `backend/src/modules/strategy/orchestrator.service.ts`, change `SolveUsage` (lines 7-11):

```ts
export interface SolveUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}
```

Add `usage` to `SolveStepFailure` (after `dailyResetSeconds` at line 57, before the closing `}`):

```ts
  // Tokens the model call billed before its output failed downstream
  // validation — absent when the call itself failed outright (no tokens
  // billed). See SolveErrorDetails.usage on the orchestrator side.
  usage?: SolveUsage;
```

Change `extractCallDetail`'s return type and body (lines 241-267):

```ts
  /** Pulls the known raw-detail keys off a SolveError `details` bag (see solver.ts on the orchestrator side), ignoring anything else it might carry. */
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    SolveStepFailure,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
    | "retryAfterSeconds"
    | "dailyResetSeconds"
    | "usage"
  > {
    if (!details) return {};
    return {
      requestBody: details.requestBody,
      responseId: details.responseId as string | undefined,
      responseHeaders: details.responseHeaders as Record<string, string> | undefined,
      responseBody: details.responseBody,
      statusCode: details.statusCode as number | undefined,
      errorName: details.errorName as string | undefined,
      isRetryable: details.isRetryable as boolean | undefined,
      retryAfterSeconds: details.retryAfterSeconds as number | undefined,
      dailyResetSeconds: details.dailyResetSeconds as number | undefined,
      usage: details.usage as SolveUsage | undefined,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest orchestrator.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend test suite for this file's package**

Run (from `backend/`): `npx jest orchestrator.service`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat(backend): thread usage through OrchestratorService's error path"
```

---

### Task 5: Backend — add `reasoningTokens` column to `SolvePrompt` and `CategoryEvaluation`

**Files:**
- Modify: `backend/src/modules/strategy/entities/solve-prompt.entity.ts:152-153`, `backend/src/modules/strategy/entities/category-evaluation.entity.ts:140-141`
- Create: `backend/src/migrations/1802000000000-add-reasoning-tokens.ts`

**Interfaces:**
- Produces: `SolvePrompt.reasoningTokens: number | null` and `CategoryEvaluation.reasoningTokens: number | null` — consumed by Task 6, 7 (writes), Task 8 (DTO mapping), Task 10 (backfill script).

- [ ] **Step 1: Add the column to both entities**

In `backend/src/modules/strategy/entities/solve-prompt.entity.ts`, after the `totalTokens` column (line 153), before `latencyMs`:

```ts
  // Subset of completionTokens spent on the model's internal reasoning
  // (OpenAI's completion_tokens_details.reasoning_tokens / the Responses
  // API's output_tokens_details.reasoning_tokens) — additive information
  // only, never added into totalTokens or used in cap/cost math, since
  // OpenAI already bills it as ordinary output tokens and completionTokens
  // already includes it. Lets a reasoning-heavy failed call (billed tokens,
  // no usable output) be seen on its own instead of only inferred after the
  // fact — see docs/superpowers/plans/2026-09-16-free-tier-token-accounting.md.
  @Column({ type: "int", nullable: true })
  reasoningTokens: number | null;
```

In `backend/src/modules/strategy/entities/category-evaluation.entity.ts`, after the `totalTokens` column (line 141), before `latencyMs`, add the same column (same comment):

```ts
  // Subset of completionTokens spent on the model's internal reasoning —
  // see SolvePrompt.reasoningTokens for the full explanation. Additive
  // information only, never added into totalTokens or used in cap/cost math.
  @Column({ type: "int", nullable: true })
  reasoningTokens: number | null;
```

- [ ] **Step 2: Write the migration**

Create `backend/src/migrations/1802000000000-add-reasoning-tokens.ts` (timestamp follows the last existing migration, `1801000000000-add-solve-prompt-text.ts`):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds a nullable reasoningTokens column to SolvePrompt and
 * CategoryEvaluation — the subset of completionTokens spent on the model's
 * internal reasoning (OpenAI's completion_tokens_details.reasoning_tokens /
 * the Responses API's output_tokens_details.reasoning_tokens). Additive
 * information only: never folded into totalTokens, never used in cap or
 * cost math (OpenAI already bills it as ordinary output tokens). Purely
 * additive here too — no backfill in this migration; a separate one-off
 * script (backfill-token-usage.ts) recovers it for historical rows from
 * their stored responseBody. See
 * docs/superpowers/plans/2026-09-16-free-tier-token-accounting.md.
 */
export class AddReasoningTokens1802000000000 implements MigrationInterface {
  name = "AddReasoningTokens1802000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "reasoningTokens" INT
    `);
    await queryRunner.query(`
      ALTER TABLE "CategoryEvaluation" ADD COLUMN "reasoningTokens" INT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "reasoningTokens"
    `);
    await queryRunner.query(`
      ALTER TABLE "CategoryEvaluation" DROP COLUMN "reasoningTokens"
    `);
  }
}
```

- [ ] **Step 3: Run the migration against the local dev database**

Run (from `backend/`): `npm run migration:run`
Expected: Output confirms `AddReasoningTokens1802000000000` ran successfully.

- [ ] **Step 4: Verify the columns exist**

Run: `npx tsx -e "import { AppDataSource } from './src/data-source'; AppDataSource.initialize().then(async (ds) => { const r = await ds.query(\"SELECT column_name FROM information_schema.columns WHERE table_name IN ('SolvePrompt','CategoryEvaluation') AND column_name = 'reasoningTokens'\"); console.log(r); await ds.destroy(); });"`
Expected: two rows, one per table, both showing `reasoningTokens`.

- [ ] **Step 5: Run the full backend test suite to confirm nothing broke**

Run (from `backend/`): `npx jest`
Expected: PASS (entity changes are additive; no existing test asserts an exhaustive column list).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/entities/solve-prompt.entity.ts backend/src/modules/strategy/entities/category-evaluation.entity.ts backend/src/migrations/1802000000000-add-reasoning-tokens.ts
git commit -m "feat(backend): add reasoningTokens column to SolvePrompt and CategoryEvaluation"
```

---

### Task 6: Backend — solve path: populate `reasoningTokens` on success, capture full usage on `callError`

This is the core fix for the solve-step half of the bug: `buildCallErrorPromptRow` currently sets `requestBody`/`responseId`/`responseHeaders`/`responseBody`/`statusCode`/`errorName`/`errorMessage`/`isRetryable` but never `promptTokens`/`completionTokens`/`totalTokens` — even though, after Tasks 1-4, `outcome.error.usage` now carries them for exactly the calls that were billed before failing.

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts:27` (import), `:366-386` (success path), `:456-469` (error call site), `:544-577` (`buildCallErrorPromptRow`)
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `SolveUsage` type (Task 4), `SolvePrompt.reasoningTokens` column (Task 5).
- Produces: every `SolvePrompt` row (success or `callError`) now has real `promptTokens`/`completionTokens`/`totalTokens`/`reasoningTokens` whenever the underlying call billed tokens.

- [ ] **Step 1: Write the failing test — reasoningTokens on a successful row**

Add to `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, inside `describe("runLlmStrategy", ...)`, near the other token-related assertions (find the existing success-path test that checks `promptTokens`/`completionTokens`/`totalTokens` on an inserted row — likely the main "should solve a puzzle through iterative orchestrator calls" test or a dedicated one; add a new test rather than editing an existing one):

```ts
    it("should persist reasoningTokens on a successful row", async () => {
      mockOrchestratorService.requestSolveStep.mockResolvedValueOnce({
        ok: true,
        data: {
          response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
          groups: ["AAAA, BBBB, CCCC, DDDD"],
          proposalWords: [["AAAA", "BBBB", "CCCC", "DDDD"]],
          categoryByGroup: { "1": "Test category" },
          textIssues: [],
          model: "gpt-5-nano",
          latencyMs: 500,
          usage: { promptTokens: 200, completionTokens: 500, totalTokens: 700, reasoningTokens: 400 },
        },
      });

      await runner.runLlmStrategy("llm-openai", 1);

      const promptRows = mockManager.insert.mock.calls
        .filter(([entity]) => entity === "SolvePrompt")
        .map(([, row]) => row);
      expect(promptRows[0].reasoningTokens).toBe(400);
    });
```

(Match the exact mocking/assertion pattern used by the closest existing success-path test in this file — e.g. how `mockStrategyRunRepo`/`mockManager` are wired in `beforeEach`, and whether inserted rows are read via `mockManager.insert.mock.calls` or a different accessor. Adjust the snippet above to that established pattern before running.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — `reasoningTokens` is `undefined` on the inserted row (the field isn't set at all yet).

- [ ] **Step 3: Set reasoningTokens on the success path**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, change the `currentPrompt` object (lines 366-386), adding one line after `totalTokens`:

```ts
        const currentPrompt: Partial<SolvePrompt> = {
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          attemptNumber,
          promptType,
          status: SolvePromptStatus.PARSED,
          rawResponseText: data.response,
          promptText: transcriptText,
          issueTags: [],
          temperature,
          promptTokens: data.usage?.promptTokens ?? null,
          completionTokens: data.usage?.completionTokens ?? null,
          totalTokens: data.usage?.totalTokens ?? null,
          reasoningTokens: data.usage?.reasoningTokens ?? null,
          latencyMs: data.latencyMs,
          requestBody: data.requestBody ?? null,
          responseId: data.responseId ?? null,
          responseHeaders: data.responseHeaders ?? null,
          responseBody: this.toJsonbResponseBody(data.responseBody),
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS for the new test; re-run the full file to confirm no regressions.

- [ ] **Step 5: Write the failing test — usage captured on a callError row**

Add another test to the same `describe` block, near the existing `"should terminate with 'duplicate' once the duplicate limit is hit"` test (which already exercises the `callError` insert path):

```ts
    it("should capture usage on a callError row instead of leaving tokens null", async () => {
      mockOrchestratorService.requestSolveStep.mockResolvedValueOnce({
        ok: false,
        error: {
          error: "Model produced a malformed response: ...",
          code: "invalid_group",
          usage: { promptTokens: 2100, completionTokens: 16000, totalTokens: 18100, reasoningTokens: 15900 },
        },
      });

      await runner.runLlmStrategy("llm-openai", 1);

      const promptRows = mockManager.insert.mock.calls
        .filter(([entity]) => entity === "SolvePrompt")
        .map(([, row]) => row);
      const errorRow = promptRows.find((row) => row.status === "callError");
      expect(errorRow.promptTokens).toBe(2100);
      expect(errorRow.completionTokens).toBe(16000);
      expect(errorRow.totalTokens).toBe(18100);
      expect(errorRow.reasoningTokens).toBe(15900);
    });
```

(Again, match whatever mock-return-value shape the existing `"should terminate with 'duplicate'..."` test uses for a repeated failing `requestSolveStep` call — it may need `mockResolvedValue` for a repeated failure rather than `mockResolvedValueOnce`, depending on the run's retry loop; check that test's setup before finalizing this one.)

- [ ] **Step 6: Run test to verify it fails**

Run (from `backend/`): `npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — `errorRow.promptTokens` etc. are all `undefined`/`null` because `buildCallErrorPromptRow` doesn't read `usage` yet.

- [ ] **Step 7: Read usage in `buildCallErrorPromptRow` and its call site**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, add `type SolveUsage` to the existing import (line 27):

```ts
import { OrchestratorService, type ChatMessage, type SolveErrorCode, type SolveUsage } from "./orchestrator.service";
```

Change the call site (lines 456-469), adding one line:

```ts
        pendingPrompts.push(
          this.buildCallErrorPromptRow(run.id, globalPromptNumber, promptType, {
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
            usage: outcome.error.usage,
          }),
        );
```

Change `buildCallErrorPromptRow`'s signature and body (lines 544-577):

```ts
  private buildCallErrorPromptRow(
    strategyRunId: number,
    promptNumber: number,
    promptType: SolvePromptType,
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
      usage?: SolveUsage;
    },
  ): Partial<SolvePrompt> {
    return {
      strategyRunId,
      promptNumber,
      attemptNumber: attempt.attemptNumber,
      promptType,
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
      promptTokens: attempt.usage?.promptTokens ?? null,
      completionTokens: attempt.usage?.completionTokens ?? null,
      totalTokens: attempt.usage?.totalTokens ?? null,
      reasoningTokens: attempt.usage?.reasoningTokens ?? null,
    };
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS (full file).

- [ ] **Step 9: Run the full backend test suite**

Run (from `backend/`): `npx jest`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "fix(backend): capture full usage (incl. reasoningTokens) on solve-step callError rows"
```

---

### Task 7: Backend — judge path: same fix in `category-evaluator.service.ts`

The judge path has an even more direct version of the bug: its error-row save today hardcodes `promptTokens: null, completionTokens: null, totalTokens: null` unconditionally (lines 336-338), never even attempting to read usage — because until Task 3/4, there was nothing to read.

**Files:**
- Modify: `backend/src/modules/strategy/category-evaluator.service.ts:15` (import), `:290-317` (success save), `:320-342` (error save)
- Test: `backend/src/modules/strategy/category-evaluator.service.spec.ts`

**Interfaces:**
- Consumes: `SolveUsage` type (Task 4), `CategoryEvaluation.reasoningTokens` column (Task 5).

- [ ] **Step 1: Write the failing test — reasoningTokens on a judged row**

Add to `backend/src/modules/strategy/category-evaluator.service.spec.ts`, near the existing test(s) covering a successful `judgeCategory` outcome and the saved row's token fields:

```ts
    it("should persist reasoningTokens on a judged row", async () => {
      mockOrchestrator.judgeCategory.mockResolvedValueOnce({
        ok: true,
        data: {
          verdict: "correct",
          rationale: "Same connection.",
          model: "gpt-5-nano",
          latencyMs: 300,
          usage: { promptTokens: 80, completionTokens: 300, totalTokens: 380, reasoningTokens: 270 },
        },
      });

      await service.evaluateProposal(/* whatever args the existing success test uses */);

      expect(mockCategoryEvalRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningTokens: 270 }),
      );
    });
```

(Replace the placeholder call/mocks above with the exact setup the nearest existing success-path test in this spec file uses — method name, argument shape, and repo/mock variable names — since `evaluateProposal`'s real signature and the file's mock wiring weren't re-verified for this snippet.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx jest category-evaluator.service.spec.ts`
Expected: FAIL — `reasoningTokens` isn't in the saved object at all.

- [ ] **Step 3: Set reasoningTokens on the success save**

In `backend/src/modules/strategy/category-evaluator.service.ts`, change the success-path `save` call (lines 290-317), adding one line after `totalTokens`:

```ts
        promptTokens: d.usage?.promptTokens ?? null,
        completionTokens: d.usage?.completionTokens ?? null,
        totalTokens: d.usage?.totalTokens ?? null,
        reasoningTokens: d.usage?.reasoningTokens ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest category-evaluator.service.spec.ts`
Expected: PASS for the new test.

- [ ] **Step 5: Write the failing test — usage captured on a judge callError row**

Add another test near the existing `callError`-path test in the same file:

```ts
    it("should capture usage on a judge callError row instead of leaving tokens null", async () => {
      mockOrchestrator.judgeCategory.mockResolvedValueOnce({
        ok: false,
        error: {
          error: "Model produced a malformed response: ...",
          code: "invalid_group",
          usage: { promptTokens: 90, completionTokens: 12000, totalTokens: 12090, reasoningTokens: 11960 },
        },
      });

      await service.evaluateProposal(/* same args as the existing callError test */);

      expect(mockCategoryEvalRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          promptTokens: 90,
          completionTokens: 12000,
          totalTokens: 12090,
          reasoningTokens: 11960,
        }),
      );
    });
```

(Match the existing `callError`-path test's exact mock/argument setup, same caveat as Step 1.)

- [ ] **Step 6: Run test to verify it fails**

Run (from `backend/`): `npx jest category-evaluator.service.spec.ts`
Expected: FAIL — the current code path saves all four token fields as `null` unconditionally.

- [ ] **Step 7: Read usage on the error save**

Add `type SolveUsage` to the existing `OrchestratorService` import (line 15 area — currently `import { OrchestratorService } from "./orchestrator.service";`):

```ts
import { OrchestratorService, type SolveUsage } from "./orchestrator.service";
```

Change the error-path `save` call (lines 320-342):

```ts
    const e = outcome.error;
    await this.categoryEvalRepo.save({
      ...(existing ? { id: existing.id } : {}),
      ...base,
      status: CategoryEvalStatus.CALL_ERROR,
      verdict: null,
      rationale: null,
      requestBody: e.requestBody ?? null,
      responseId: e.responseId ?? null,
      responseHeaders: e.responseHeaders ?? null,
      responseBody: e.responseBody ?? null,
      rawResponseText: null,
      statusCode: e.statusCode ?? null,
      errorName: e.errorName ?? null,
      errorMessage: e.error ?? null,
      isRetryable: e.isRetryable ?? null,
      promptTokens: e.usage?.promptTokens ?? null,
      completionTokens: e.usage?.completionTokens ?? null,
      totalTokens: e.usage?.totalTokens ?? null,
      reasoningTokens: e.usage?.reasoningTokens ?? null,
      latencyMs: null,
      temperature: null,
    });
    return { outcome: "callError" };
```

(`SolveUsage` isn't referenced by name in this file's own code — the import is `type`-only, needed because `e.usage` is typed as `SolveUsage | undefined` via `SolveStepFailure` from Task 4. If TypeScript reports the import unused, this confirms the type is inferred structurally and the import can be dropped; check the actual compiler output rather than assuming either way.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest category-evaluator.service.spec.ts`
Expected: PASS (full file).

- [ ] **Step 9: Run the full backend test suite**

Run (from `backend/`): `npx jest`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/strategy/category-evaluator.service.ts backend/src/modules/strategy/category-evaluator.service.spec.ts
git commit -m "fix(backend): capture full usage (incl. reasoningTokens) on judge callError rows"
```

---

### Task 8: Backend — expose `reasoningTokens` through the DTOs

**Files:**
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts:38-40` (`CategoryEvaluationDto`), `:75-77` (`SolvePromptDto`)
- Modify: `backend/src/modules/strategy/strategy-read.service.ts:836-838`, `:865-867`
- Test: `backend/src/modules/strategy/strategy-read.service.spec.ts`

**Interfaces:**
- Produces: `SolvePromptDto.reasoningTokens: number | null`, `CategoryEvaluationDto.reasoningTokens: number | null` — consumed by Task 11 (frontend types).

- [ ] **Step 1: Write the failing test**

Check `backend/src/modules/strategy/strategy-read.service.spec.ts` for the existing test asserting a `SolvePromptDto`'s shape (search for `promptTokens` in that file). Add `reasoningTokens: <value>` to the fixture `SolvePrompt` row it builds, and add `reasoningTokens: <value>` to that test's expected-output assertion. Do the same for the nearest `CategoryEvaluationDto`-shape test.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx jest strategy-read.service.spec.ts`
Expected: FAIL — the produced DTO has no `reasoningTokens` key (or it's `undefined` where the test expects a number/null).

- [ ] **Step 3: Add the field to both DTOs**

In `backend/src/modules/strategy/dto/strategy.dto.ts`, add to `CategoryEvaluationDto` (after `totalTokens` at line 40):

```ts
  reasoningTokens: number | null;
```

Add to `SolvePromptDto` (after `totalTokens` at line 77):

```ts
  reasoningTokens: number | null;
```

- [ ] **Step 4: Map the field through in strategy-read.service.ts**

Change the `SolvePromptDto` mapping (lines 836-838):

```ts
        promptTokens: prompt.promptTokens,
        completionTokens: prompt.completionTokens,
        totalTokens: prompt.totalTokens,
        reasoningTokens: prompt.reasoningTokens,
```

Change the `CategoryEvaluationDto` mapping in `toCategoryEvaluationDto` (lines 865-867):

```ts
      promptTokens: e.promptTokens ?? null,
      completionTokens: e.completionTokens ?? null,
      totalTokens: e.totalTokens ?? null,
      reasoningTokens: e.reasoningTokens ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest strategy-read.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the full backend test suite**

Run (from `backend/`): `npx jest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy-read.service.ts backend/src/modules/strategy/strategy-read.service.spec.ts
git commit -m "feat(backend): expose reasoningTokens on SolvePromptDto and CategoryEvaluationDto"
```

---

### Task 9: Backend — today's reasoning-token figure on `FreeTierUsageService`

Adds a same-window (today, UTC) aggregate of `reasoningTokens` alongside the existing `totalTokens` cap-math sum — informational only, paired with the widget's existing daily cap bar (not with the separate all-time `spentUsd` figure the frontend computes elsewhere).

**Files:**
- Modify: `backend/src/modules/strategy/free-tier-usage.service.ts:22-30` (`FreeTierUsageDto`), `:79-87` (empty-tier early return), `:89-115` (`getUsage` query + return)
- Test: `backend/src/modules/strategy/free-tier-usage.service.spec.ts`

**Interfaces:**
- Produces: `FreeTierUsageDto.reasoningTokensUsedToday: number` — consumed by Task 13 (frontend widget).

- [ ] **Step 1: Update the shared test helper to support a second aggregate column**

In `backend/src/modules/strategy/free-tier-usage.service.spec.ts`, change `makeQb` and `mockUsageQuery` (lines 27-46):

```ts
  function makeQb(totalTokens: string | null, reasoningTokens: string | null = "0") {
    return {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue(totalTokens === null ? undefined : { totalTokens, reasoningTokens }),
    };
  }

  // Stubs both token sums getUsage runs: SolvePrompt (solve-step tokens) and
  // CategoryEvaluation (category-judge call tokens). judgeTokens defaults to
  // "0" so the pre-existing SolvePrompt-only assertions are unaffected.
  function mockUsageQuery(
    promptTokens: string | null,
    judgeTokens: string | null = "0",
    promptReasoningTokens: string | null = "0",
    judgeReasoningTokens: string | null = "0",
  ) {
    const prompt = makeQb(promptTokens, promptReasoningTokens);
    const judge = makeQb(judgeTokens, judgeReasoningTokens);
    mockSolvePromptRepo.createQueryBuilder.mockReturnValue(prompt);
    mockCategoryEvaluationRepo.createQueryBuilder.mockReturnValue(judge);
    return { prompt, judge };
  }
```

This is additive-compatible with every existing call site in the file (`mockUsageQuery("1000")`, `mockUsageQuery("500000", "40000")`, etc.) since the two new parameters default to `"0"`.

- [ ] **Step 2: Write the failing test**

Add to the same spec file, in the `describe("getFlagshipUsage", ...)` block or a new top-level `describe`:

```ts
  it("sums reasoningTokens across both sources for the same today window as usedTokens", async () => {
    mockUsageQuery("62340", "10000", "40000", "6000");

    const result = await service.getFlagshipUsage();

    expect(result.reasoningTokensUsedToday).toBe(46_000);
  });

  it("returns zero reasoningTokensUsedToday when no rows match", async () => {
    mockUsageQuery(null, null);

    const result = await service.getFlagshipUsage();

    expect(result.reasoningTokensUsedToday).toBe(0);
  });

  it("returns zero reasoningTokensUsedToday when the tier has no models configured", async () => {
    mockSupportedModelService.findModelNamesByFreeTier.mockResolvedValueOnce([]);

    const result = await service.getFlagshipUsage();

    expect(result.reasoningTokensUsedToday).toBe(0);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `backend/`): `npx jest free-tier-usage.service.spec.ts`
Expected: FAIL — `result.reasoningTokensUsedToday` is `undefined`.

- [ ] **Step 4: Add the aggregate to the DTO and the query**

In `backend/src/modules/strategy/free-tier-usage.service.ts`, add to `FreeTierUsageDto` (after `remainingTokens` at line 27):

```ts
  // Today's (UTC) reasoning-token share of usedTokens above — same window,
  // same two sources, purely informational (see SolvePrompt.reasoningTokens).
  // Not subtracted from remainingTokens: it's already included in
  // usedTokens, since OpenAI bills reasoning tokens as ordinary output.
  reasoningTokensUsedToday: number;
```

Add to the empty-models early return (lines 79-87):

```ts
    if (models.length === 0) {
      return {
        tier,
        label,
        usedTokens: 0,
        dailyLimitTokens,
        remainingTokens: dailyLimitTokens,
        reasoningTokensUsedToday: 0,
        models,
      };
    }
```

Change the query + return (lines 89-115):

```ts
    const [promptRaw, judgeRaw] = await Promise.all([
      this.solvePromptRepo
        .createQueryBuilder("prompt")
        .innerJoin("prompt.strategyRun", "run")
        .where("run.modelName IN (:...models)", { models })
        .andWhere("prompt.createdAt >= :startOfTodayUtc", { startOfTodayUtc: since })
        .select("COALESCE(SUM(prompt.totalTokens), 0)", "totalTokens")
        .addSelect("COALESCE(SUM(prompt.reasoningTokens), 0)", "reasoningTokens")
        .getRawOne<{ totalTokens: string; reasoningTokens: string }>(),
      this.categoryEvaluationRepo
        .createQueryBuilder("evaluation")
        .where("evaluation.judgeModel IN (:...models)", { models })
        .andWhere("evaluation.evaluatedAt >= :startOfTodayUtc", { startOfTodayUtc: since })
        .select("COALESCE(SUM(evaluation.totalTokens), 0)", "totalTokens")
        .addSelect("COALESCE(SUM(evaluation.reasoningTokens), 0)", "reasoningTokens")
        .getRawOne<{ totalTokens: string; reasoningTokens: string }>(),
    ]);

    const usedTokens = Number(promptRaw?.totalTokens ?? 0) + Number(judgeRaw?.totalTokens ?? 0);
    const reasoningTokensUsedToday =
      Number(promptRaw?.reasoningTokens ?? 0) + Number(judgeRaw?.reasoningTokens ?? 0);

    return {
      tier,
      label,
      usedTokens,
      dailyLimitTokens,
      remainingTokens: Math.max(0, dailyLimitTokens - usedTokens),
      reasoningTokensUsedToday,
      models,
    };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest free-tier-usage.service.spec.ts`
Expected: PASS (full file — including the pre-existing tests using the updated helper).

- [ ] **Step 6: Run the full backend test suite**

Run (from `backend/`): `npx jest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/free-tier-usage.service.ts backend/src/modules/strategy/free-tier-usage.service.spec.ts
git commit -m "feat(backend): surface today's reasoningTokensUsedToday on FreeTierUsageDto"
```

---

### Task 10: Backend — historical backfill script

Recovers `promptTokens`/`completionTokens`/`totalTokens`/`reasoningTokens` from each row's already-stored `responseBody.usage` JSON, for every row (both tables, any status) where at least one of those four columns is currently `null` and the data is recoverable. Handles both raw shapes real historical rows may contain: OpenAI's Responses API (`input_tokens`/`output_tokens`/`total_tokens`/`output_tokens_details.reasoning_tokens`) and Chat Completions (`prompt_tokens`/`completion_tokens`/`total_tokens`/`completion_tokens_details.reasoning_tokens`). Supports `--dry-run` (count only, no writes) per the user's explicit request to review before committing to the write.

**Files:**
- Create: `backend/src/scripts/backfill-token-usage.ts`
- Modify: `backend/package.json` (add script entry)
- Test: `backend/src/scripts/backfill-token-usage.spec.ts`

**Interfaces:**
- Consumes: `SolvePrompt.responseBody`, `CategoryEvaluation.responseBody` (existing `jsonb` columns), the `reasoningTokens` column (Task 5).

- [ ] **Step 1: Write the failing test — Responses API shape**

Create `backend/src/scripts/backfill-token-usage.spec.ts`:

```ts
import { parseUsageFromResponseBody } from "./backfill-token-usage";

describe("parseUsageFromResponseBody", () => {
  it("parses the Responses API shape (input_tokens/output_tokens/output_tokens_details)", () => {
    const responseBody = {
      usage: {
        input_tokens: 2134,
        output_tokens: 16162,
        total_tokens: 18296,
        output_tokens_details: { reasoning_tokens: 16000 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 2134,
      completionTokens: 16162,
      totalTokens: 18296,
      reasoningTokens: 16000,
    });
  });

  it("parses the Chat Completions shape (prompt_tokens/completion_tokens/completion_tokens_details)", () => {
    const responseBody = {
      usage: {
        prompt_tokens: 500,
        completion_tokens: 1200,
        total_tokens: 1700,
        completion_tokens_details: { reasoning_tokens: 900 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    });
  });

  it("returns null reasoningTokens when the shape has no reasoning breakdown at all", () => {
    const responseBody = {
      usage: { prompt_tokens: 500, completion_tokens: 1200, total_tokens: 1700 },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: null,
    });
  });

  it("returns null when responseBody has no usage object at all", () => {
    expect(parseUsageFromResponseBody({ error: "some gateway error page" })).toBeNull();
    expect(parseUsageFromResponseBody(null)).toBeNull();
    expect(parseUsageFromResponseBody("a raw string body")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npx jest backfill-token-usage.spec.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Write the script with the exported parse function and the main backfill loop**

Create `backend/src/scripts/backfill-token-usage.ts`:

```ts
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, IsNull, Or } from "typeorm";
import { AppModule } from "../app.module";
import { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { CategoryEvaluation } from "../modules/strategy/entities/category-evaluation.entity";

/**
 * One-off backfill for SolvePrompt and CategoryEvaluation rows whose
 * promptTokens/completionTokens/totalTokens/reasoningTokens are null but
 * whose responseBody (raw jsonb, always captured regardless of outcome —
 * see toJsonbResponseBody on both writers) still has the usage data OpenAI
 * actually returned. Recovers both known raw shapes:
 *
 *  - OpenAI Responses API: input_tokens / output_tokens / total_tokens /
 *    output_tokens_details.reasoning_tokens
 *  - OpenAI Chat Completions: prompt_tokens / completion_tokens /
 *    total_tokens / completion_tokens_details.reasoning_tokens
 *
 * Covers every row with recoverable data, not just callError rows — a
 * successful row written before the reasoningTokens column existed has the
 * same gap for that one field, and this backfill is what makes historical
 * runs display correctly in the new per-step reasoning-token UI.
 *
 * Idempotent: only ever writes a row whose own fields are actually null
 * where the parsed data has a value, so re-running is always safe.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/backfill-token-usage.ts --dry-run
 *   npx tsx src/scripts/backfill-token-usage.ts
 *
 * Production/container:
 *   docker exec <container> node dist/scripts/backfill-token-usage.js --dry-run
 *   docker exec <container> node dist/scripts/backfill-token-usage.js
 */

const logger = new Logger("BackfillTokenUsage");

export interface ParsedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Extracts token counts from a stored responseBody, trying both known raw
 * OpenAI shapes. Returns null when responseBody isn't a usage-bearing
 * object at all (a gateway HTML error page, a plain string, absent usage).
 * reasoningTokens is null (not 0) when the shape has no reasoning
 * breakdown, distinguishing "not a reasoning-capable call" from "zero
 * reasoning tokens spent".
 */
export function parseUsageFromResponseBody(responseBody: unknown): ParsedUsage | null {
  if (typeof responseBody !== "object" || responseBody === null) return null;
  const usage = (responseBody as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

  // Responses API shape.
  if ("input_tokens" in u || "output_tokens" in u) {
    const details = u.output_tokens_details as Record<string, unknown> | undefined;
    return {
      promptTokens: asNumber(u.input_tokens),
      completionTokens: asNumber(u.output_tokens),
      totalTokens: asNumber(u.total_tokens),
      reasoningTokens: details ? asNumber(details.reasoning_tokens) : null,
    };
  }

  // Chat Completions shape.
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    const details = u.completion_tokens_details as Record<string, unknown> | undefined;
    return {
      promptTokens: asNumber(u.prompt_tokens),
      completionTokens: asNumber(u.completion_tokens),
      totalTokens: asNumber(u.total_tokens),
      reasoningTokens: details ? asNumber(details.reasoning_tokens) : null,
    };
  }

  return null;
}

async function backfillTable<T extends { id: number; responseBody: unknown }>(
  dataSource: DataSource,
  entity: new () => T,
  label: string,
  dryRun: boolean,
): Promise<void> {
  const repo = dataSource.getRepository(entity);
  const rows = await repo.find({
    where: [
      { promptTokens: IsNull() } as never,
      { completionTokens: IsNull() } as never,
      { totalTokens: IsNull() } as never,
      { reasoningTokens: IsNull() } as never,
    ],
    select: { id: true, responseBody: true } as never,
  });
  logger.log(`[${label}] Found ${rows.length} row(s) with at least one null token column.`);

  let updatedCount = 0;
  for (const row of rows) {
    const parsed = parseUsageFromResponseBody(row.responseBody);
    if (!parsed) continue;

    if (dryRun) {
      updatedCount++;
      continue;
    }

    await repo.update(row.id, {
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      totalTokens: parsed.totalTokens,
      reasoningTokens: parsed.reasoningTokens,
    } as never);
    updatedCount++;
  }

  logger.log(
    `[${label}] ${dryRun ? "Would update" : "Updated"} ${updatedCount} of ${rows.length} row(s).`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    logger.log("Running in --dry-run mode: no writes will be made.");
  }

  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    await backfillTable(dataSource, SolvePrompt, "SolvePrompt", dryRun);
    await backfillTable(dataSource, CategoryEvaluation, "CategoryEvaluation", dryRun);
  } finally {
    await appContext.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });
```

Note on the `where: [{ promptTokens: IsNull() }, ...]` array: TypeORM's `find({ where: [...] })` ORs the conditions, matching "at least one of these four columns is null" — exactly the target set. The `as never` casts sidestep TypeORM's generic `FindOptionsWhere<T>` typing friction with a generic `T` parameter; this mirrors the pragmatic style already used elsewhere in this codebase's scripts rather than introducing new generic-repository infrastructure for a one-off script.

- [ ] **Step 4: Run test to verify it passes**

Run (from `backend/`): `npx jest backfill-token-usage.spec.ts`
Expected: PASS.

- [ ] **Step 5: Manually verify the dry-run mode against local dev data**

Run (from `backend/`): `npx tsx src/scripts/backfill-token-usage.ts --dry-run`
Expected: Logs a found/would-update count for both tables, no errors, no rows actually changed (verify with `SELECT count(*) FROM "SolvePrompt" WHERE "totalTokens" IS NULL` before and after — the count should be unchanged after a dry run).

- [ ] **Step 6: Manually verify the real run against local dev data**

Run (from `backend/`): `npx tsx src/scripts/backfill-token-usage.ts`
Expected: Logs an updated count; re-running the same `SELECT count(*) ... IS NULL` query shows fewer null rows for whichever ones had recoverable `responseBody.usage` data.

- [ ] **Step 7: Verify idempotency**

Run (from `backend/`): `npx tsx src/scripts/backfill-token-usage.ts --dry-run`
Expected: The "would update" count is now much lower (only rows still genuinely unrecoverable, if any) — running it again finds nothing left to change among the rows it already fixed.

- [ ] **Step 8: Wire the npm script**

In `backend/package.json`, add to `"scripts"` (after `"backfill:prompt-text"` at line 23):

```json
    "backfill:token-usage": "node dist/scripts/backfill-token-usage.js",
```

Note: this matches the existing scripts' convention of running the *compiled* `dist/` output in production (`npm run build` first), while local dev uses `npx tsx src/scripts/backfill-token-usage.ts` directly per the doc comment above — same as every other `backfill:*` script in this file. The `--dry-run` flag works identically either way (`node dist/scripts/backfill-token-usage.js --dry-run`).

- [ ] **Step 9: Run the full backend test suite**

Run (from `backend/`): `npx jest`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/scripts/backfill-token-usage.ts backend/src/scripts/backfill-token-usage.spec.ts backend/package.json
git commit -m "feat(backend): add backfill-token-usage script for historical null token columns"
```

---

### Task 11: Frontend — widen the type definitions

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts:253-260` (`FreeTierUsage`), `:420-440` (`CategoryEvaluationRecord`), `:465-492` (`SolvePromptRecord`)

**Interfaces:**
- Produces: `SolvePromptRecord.reasoningTokens: number | null`, `CategoryEvaluationRecord.reasoningTokens: number | null`, `FreeTierUsage.reasoningTokensUsedToday: number` — consumed by Tasks 12 and 13.

- [ ] **Step 1: Add the fields**

In `frontend/src/data/benchmark/types.ts`, change `FreeTierUsage` (lines 253-260):

```ts
export interface FreeTierUsage {
  tier: FreeTierId;
  label: string;
  usedTokens: number;
  dailyLimitTokens: number;
  remainingTokens: number;
  reasoningTokensUsedToday: number;
  models: string[];
}
```

Add to `CategoryEvaluationRecord` (after `totalTokens` at line 430):

```ts
  reasoningTokens: number | null;
```

Add to `SolvePromptRecord` (after `totalTokens` at line 473):

```ts
  reasoningTokens: number | null;
```

- [ ] **Step 2: Type-check the frontend**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: PASS (no errors) — these are additive optional-in-practice fields on interfaces consumed by components not yet touched, so nothing should break yet. If any existing file constructs a literal of one of these types without the new field, TypeScript will flag it here — investigate and fix before proceeding (likely only test fixtures, if any exist for these types).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/data/benchmark/types.ts
git commit -m "feat(frontend): widen FreeTierUsage/SolvePromptRecord/CategoryEvaluationRecord with reasoningTokens"
```

---

### Task 12: Frontend — show reasoning tokens in `GuessChainVisualizer`

Extends the existing "Raw response" `<details>` summary (which already shows `completionTokens`) with the reasoning-token count, and adds an equivalent line to the judge sub-panel — both gated on `reasoningTokens` being present and greater than zero, so a non-reasoning-model call renders no extra text.

**Files:**
- Modify: `frontend/src/components/benchmark/GuessChainVisualizer.tsx:138-148` (solve-step "Raw response" detail), `:237-249` (judge sub-panel telemetry line)

**Interfaces:**
- Consumes: `SolvePromptRecord.reasoningTokens`, `CategoryEvaluationRecord.reasoningTokens` (Task 11).

- [ ] **Step 1: Extend the "Raw response" summary**

In `frontend/src/components/benchmark/GuessChainVisualizer.tsx`, change lines 138-148:

```tsx
      {prompt.rawResponseText ? (
        <details className="bench-step__detail">
          <summary>
            Raw response
            {prompt.completionTokens !== null
              ? ` (${prompt.completionTokens.toLocaleString()} tokens${
                  prompt.reasoningTokens !== null && prompt.reasoningTokens > 0
                    ? `, ${prompt.reasoningTokens.toLocaleString()} reasoning`
                    : ""
                })`
              : ""}
          </summary>
          <pre className="bench-step__pre">{prompt.rawResponseText}</pre>
        </details>
      ) : null}
```

- [ ] **Step 2: Add the same figure to the judge sub-panel's telemetry line**

Change lines 237-249 (the judge sub-panel's `<p className="bench-mono bench-muted">` block):

```tsx
              <p className="bench-mono bench-muted">
                {[
                  `${proposal.categoryEvaluation.judgeProvider}/${proposal.categoryEvaluation.judgeModel}`,
                  proposal.categoryEvaluation.totalTokens !== null
                    ? `${proposal.categoryEvaluation.totalTokens} tok`
                    : null,
                  proposal.categoryEvaluation.reasoningTokens !== null &&
                  proposal.categoryEvaluation.reasoningTokens > 0
                    ? `${proposal.categoryEvaluation.reasoningTokens} reasoning`
                    : null,
                  proposal.categoryEvaluation.latencyMs !== null
                    ? formatDuration(proposal.categoryEvaluation.latencyMs)
                    : null,
                  proposal.categoryEvaluation.statusCode !== null
                    ? `HTTP ${proposal.categoryEvaluation.statusCode}`
                    : null,
                ].filter(Boolean).join(" · ")}
              </p>
```

- [ ] **Step 3: Manually verify in the browser**

Run the app locally (backend + frontend dev servers). Open the benchmark leaderboard, pick a run whose model is `gpt-5-nano`/`gpt-5.4-nano` with at least one `callError` step (after the backend fixes and backfill have landed and produced non-null `reasoningTokens` on at least one local row — if no such row exists locally, temporarily set one via `UPDATE "SolvePrompt" SET "reasoningTokens" = 5000 WHERE id = <some id>` to verify rendering, then revert). Confirm:
- The "Raw response" summary shows `(N tokens, M reasoning)` for that row and plain `(N tokens)` for a row with `reasoningTokens` null or 0.
- A judged proposal's judge sub-panel shows `N reasoning` in its telemetry line only when nonzero.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/benchmark/GuessChainVisualizer.tsx
git commit -m "feat(frontend): show reasoning-token count in the guess chain visualizer"
```

---

### Task 13: Frontend — today's reasoning-token figure on `FreeTierBudgetWidget`

Adds a line next to the existing daily cap bar (`usedTokens`/`dailyLimitTokens`/`remainingTokens` — all today-scoped), matching that window rather than the separate all-time `spentUsd` figure.

**Files:**
- Modify: `frontend/src/components/benchmark/FreeTierBudgetWidget.tsx:176-178`

**Interfaces:**
- Consumes: `FreeTierUsage.reasoningTokensUsedToday` (Task 11).

- [ ] **Step 1: Add the figure next to the remaining-tokens line**

In `frontend/src/components/benchmark/FreeTierBudgetWidget.tsx`, change lines 176-178:

```tsx
      <span className="bench-muted bench-free-tier__remaining">
        {usage.remainingTokens.toLocaleString()} tokens remaining today
      </span>
      {usage.reasoningTokensUsedToday > 0 ? (
        <span
          className="bench-muted bench-free-tier__reasoning"
          title="Tokens spent on model reasoning today, already included in the used-tokens figure above — shown separately since it's the spend most likely to come from a failed reasoning-heavy call."
        >
          {usage.reasoningTokensUsedToday.toLocaleString()} of which reasoning
        </span>
      ) : null}
```

- [ ] **Step 2: Manually verify in the browser**

Run the app locally. Load the leaderboard/activity page showing `FreeTierBudgetWidget` for the `mini` tier. If today's local data has no reasoning tokens yet, temporarily set one via SQL as in Task 12 Step 3 on a row dated today, then reload — confirm the new line appears only when `reasoningTokensUsedToday > 0`, positioned right after "N tokens remaining today". Revert the temporary SQL change afterward.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/benchmark/FreeTierBudgetWidget.tsx
git commit -m "feat(frontend): show today's reasoning-token spend on the free-tier budget widget"
```

---

## Self-Review

**Spec coverage:**
- Capture usage on the callError path (solve + judge) — Tasks 2, 3, 6, 7. ✓
- `reasoningTokens` column, informational-only, not in cap/cost math — Task 5, reinforced in Global Constraints. ✓
- Historical backfill via npm script with dry-run — Task 10. ✓
- UI: GuessChainVisualizer (solve + judge parity) — Task 12. ✓
- UI: FreeTierBudgetWidget, today-scoped — Task 13. ✓
- DTO/API plumbing end-to-end — Tasks 1, 4, 8, 11. ✓
- No coalesce-fallback query hack in `getUsage` — explicitly called out in Global Constraints, not implemented anywhere. ✓
- Explicitly out-of-scope items — none touched in any task. ✓

**Placeholder scan:** No TBD/TODO markers; every step has concrete code or a concrete shell command. The two judge-service test steps (Task 7, Steps 1 and 5) note that the exact mock/argument shape should be matched against the nearest existing test in that file rather than assumed — this is a pointer to verify against a live file the plan's author did not have byte-exact visibility into at write time, not a placeholder for missing logic; the assertions and mock *data* themselves are fully concrete.

**Type consistency:** `SolveUsage` (backend, Task 4) is the single shape threaded through `SolveStepFailure.usage`, `buildCallErrorPromptRow`'s `attempt.usage` (Task 6), and `category-evaluator.service.ts`'s `e.usage` (Task 7) — all reference the same interface rather than redeclaring it. `AnswerStepResult["usage"]` / `JudgeCategoryResult["usage"]` (orchestrator, Task 1) and `SolveErrorDetails.usage` (Task 2) use matching field names (`promptTokens`/`completionTokens`/`totalTokens`/`reasoningTokens`) even though they're separate type declarations on the orchestrator side (no shared interface there today — consistent with the existing codebase style, which doesn't share this shape as a named type across `answer-step.ts`/`judge-category.ts`/`solver.ts` either). `reasoningTokens` is spelled identically everywhere: entity columns (Task 5), DTOs (Task 8), frontend records (Task 11), and the widget's `reasoningTokensUsedToday` (Task 9/11/13) — no naming drift.
