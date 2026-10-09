# Free-Tier Budget Reservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that OpenAI calls made by free-tier dispatch never push a tier's token usage past its cycle threshold.

**Architecture:**
- Every `llm-openai` call gets a per-model output limit (`SupportedModel.maxOutputTokens`), so each call has a known worst case: input bound + output limit.
- Before each call, a run started by free-tier dispatch reserves that worst case in a Postgres `FreeTierReservation` table. The reservation happens under a per-tier row lock on `FreeTierDispatchState`.
- If the call doesn't fit, the run is paused (`RATE_LIMITED_DAILY`) instead of making it.
- The reservation is settled in the same transaction that writes the call's `SolvePrompt` row.
- The dispatch tick drops its flat 4,000-token estimate. It resumes paused runs first, skips models whose worst case can't fit, and stops with "budget reached".

**Tech Stack:** NestJS + TypeORM (Postgres 15), BullMQ, Jest (backend); Hono + AI SDK `generateText`, Vitest (orchestrator).

**Spec:** `docs/specs/2026-10-08-free-tier-budget-reservation-design.md`

## Global Constraints

- Node 24. Backend tests: `cd backend && npm test` (always via `npm test`, never bare `jest`). Orchestrator tests: `cd orchestrator && npm run test:run`.
- Work on branch `feature/free-tier-budget-reservation`. Never commit to `master`.
- NestJS constructor injection always uses an explicit `@Inject(Token)` (or `@InjectRepository` / `@InjectDataSource`). No bare type-inferred injection.
- Every new entity is added to **both** `backend/src/app.module.ts` `entities: [...]` and `backend/src/data-source.ts` `entities: [...]`, plus the `forFeature` list of the module that injects it.
- Schema changes go only through a TypeORM migration in `backend/src/migrations/` (`synchronize: false`).
- The guarantee covers only runs created by free-tier dispatch (`StrategyRun.budgetTier` set). Manual dispatch, retries and judge calls are never blocked.
- Fail closed: any error while reserving pauses the run. It never lets the call through.
- Reasoning effort is **not** changed anywhere.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Deviations from the spec (decided while planning)

1. `FreeTierBudgetService` lives in `backend/src/modules/strategy/`, not `free-tier-dispatch/`. `FreeTierDispatchModule` already imports `StrategyModule`, and the run loop (in `StrategyModule`) needs the budget service. Putting it in `free-tier-dispatch/` would create a circular module import.
2. Settling happens through an optional `settlement` argument on `StrategyRunStore.flushBatch`, which calls the exported `settleReservationTx(manager, settlement)` helper. The effect is the same as the spec's `settle(...)`: it runs in `flushBatch`'s transaction.
3. The tick stops with "budget reached" when no model fits and nothing is in flight. It does not wait for paused runs to be resumed first, because a paused run that can't fit would just pause again.
4. The input-bound tests check the byte-count math directly. No prod fixtures are needed, because "tokens ≤ UTF-8 bytes" makes the bound hold by construction.

## File Map

| File | Change |
|---|---|
| `orchestrator/src/types.ts` | `maxOutputTokens` on the solve-step request; `finishReason` on the response |
| `orchestrator/src/answer-step.ts` | Pass `maxOutputTokens` to `generateText`; return `finishReason` |
| `orchestrator/src/app.ts` | Pass `maxOutputTokens` through |
| `backend/src/migrations/1804000000000-free-tier-budget-reservation.ts` | **New.** Columns, seed, new table |
| `backend/src/modules/strategy/entities/free-tier-reservation.entity.ts` | **New** entity |
| `backend/src/modules/supported-model/entities/supported-model.entity.ts` | `maxOutputTokens` column |
| `backend/src/modules/strategy/entities/strategy-run.entity.ts` | `budgetTier` column |
| `backend/src/app.module.ts`, `backend/src/data-source.ts` | Register `FreeTierReservation` |
| `backend/src/modules/supported-model/supported-model.service.ts` | `getMaxOutputTokens`, `getMaxOutputTokensByModel` |
| `backend/src/modules/strategy/token-bound.ts` | **New.** Pure input-token upper bound |
| `backend/src/modules/strategy/free-tier-budget.service.ts` | **New.** `reserve`, `committedTokens`, `modelCaps`, `settleReservationTx` |
| `backend/src/modules/strategy/strategy.module.ts` | Register the entities and the service |
| `backend/src/modules/strategy/strategy-run-store.service.ts` | `loadOrCreateRun(…, budgetTier)`; `flushBatch(…, settlement)` |
| `backend/src/modules/strategy/orchestrator.service.ts` | `requestSolveStep(…, maxOutputTokens)`; `finishReason` |
| `backend/src/modules/strategy/llm-job-handler.ts` | `budgetTier` in job data |
| `backend/src/modules/strategy/llm-strategy-runner.service.ts` | Output limit, reserve/pause/settle, truncation warning |
| `backend/src/modules/strategy/strategy-dispatch.service.ts` | `triggerStrategyRuns(…, budgetTier)`; `resumeBudgetParkedRuns` |
| `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts` | Tick rewrite |
| `backend/src/strategies.ts` | Remove the token-estimate knob |
| `backend/test/app.e2e-spec.ts` | Seed check + concurrent-reserve race |

---

### Task 1: Orchestrator — `maxOutputTokens` and `finishReason`

**Files:**
- Modify: `orchestrator/src/types.ts` (`SolveStepRequestSchema` ~line 86, `SolveStepResponseSchema` ~line 115)
- Modify: `orchestrator/src/answer-step.ts`
- Modify: `orchestrator/src/app.ts:120-126`
- Test: `orchestrator/src/answer-step.test.ts`, `orchestrator/src/app.test.ts`

**Interfaces:**
- Produces:
  - `POST /solve-step` body accepts `maxOutputTokens?: number` (positive int).
  - The response includes `finishReason?: string`, the AI SDK's value, e.g. `"stop"` or `"length"`.

- [ ] **Step 1: Write the failing tests**

In `orchestrator/src/answer-step.test.ts`, add these inside `describe("runAnswerStep", …)`:

```ts
  it("passes maxOutputTokens to generateText when given", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      finishReason: "stop",
      response: { modelId: "gpt-5", id: "r", headers: {}, body: {} },
      request: { body: {} },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    await runAnswerStep(MESSAGES, { model: "gpt-5", provider: "openai", maxOutputTokens: 47000 });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 47000 }),
    );
  });

  it("omits maxOutputTokens from generateText when not given", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      finishReason: "stop",
      response: { modelId: "gpt-5", id: "r", headers: {}, body: {} },
      request: { body: {} },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    await runAnswerStep(MESSAGES, { model: "gpt-5", provider: "openai" });

    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty("maxOutputTokens");
  });

  it("reports the call's finishReason", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "",
      finishReason: "length",
      response: { modelId: "o3", id: "r", headers: {}, body: {} },
      request: { body: {} },
      usage: { inputTokens: 10, outputTokens: 46000, totalTokens: 46010 },
    });

    const result = await runAnswerStep(MESSAGES, { model: "o3", provider: "openai", maxOutputTokens: 46000 });

    expect(result.finishReason).toBe("length");
  });
```

In `orchestrator/src/app.test.ts`, add this inside `describe("POST /solve-step", …)`:

```ts
    it("passes maxOutputTokens through to runAnswerStep when given", async () => {
      runAnswerStepMock.mockResolvedValueOnce({ ...BASE_RESULT, model: "gpt-5" });

      const res = await solveStepRequest({ ...SOLVE_STEP_BODY, maxOutputTokens: 47000 });

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({ maxOutputTokens: 47000 }),
      );
    });

    it("rejects a non-positive maxOutputTokens", async () => {
      const res = await solveStepRequest({ ...SOLVE_STEP_BODY, maxOutputTokens: 0 });
      expect(res.status).toBe(400);
    });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd orchestrator && npm run test:run -- answer-step app`
Expected: FAIL. The new tests fail because `maxOutputTokens` is not forwarded and `finishReason` is undefined; the `maxOutputTokens: 0` test gets 200 instead of 400.

- [ ] **Step 3: Implement**

In `orchestrator/src/types.ts`, add this to `SolveStepRequestSchema`'s `.extend({ … })`, after `contextWindow`:

```ts
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Upper bound on this call's output tokens (reasoning included) — the backend's per-model SupportedModel.maxOutputTokens",
    ),
```

Add this to `SolveStepResponseSchema`'s `.extend({ … })`:

```ts
  finishReason: z
    .string()
    .optional()
    .describe("The AI SDK's finish reason — 'length' means maxOutputTokens cut the reply off"),
```

In `orchestrator/src/answer-step.ts`:
- Add `finishReason?: string;` to `AnswerStepResult` (after `latencyMs`).
- Add this to `AnswerStepOpts`:
  ```ts
  // Hard cap on this call's output (reasoning tokens included) — the
  // backend sends SupportedModel.maxOutputTokens so every call has a known
  // worst-case cost it can reserve against a free-tier budget.
  maxOutputTokens?: number;
  ```
- Declare `let finishReason: string | undefined;` next to the other `let`s.
- Add this to the `generateText({ … })` options, after `maxRetries: 0,`:
  ```ts
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  ```
- After `text = result.text;`, add `finishReason = result.finishReason;`.
- Add `finishReason,` to the returned object, after `latencyMs,`.

In `orchestrator/src/app.ts`, add this to the `runAnswerStep(parsed.data.messages, { … })` options:

```ts
        maxOutputTokens: parsed.data.maxOutputTokens,
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd orchestrator && npm run test:run && npm run typecheck`
Expected: all tests pass and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/types.ts orchestrator/src/answer-step.ts orchestrator/src/app.ts orchestrator/src/answer-step.test.ts orchestrator/src/app.test.ts
git commit -m "feat(orchestrator): accept a per-call maxOutputTokens and report finishReason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema — migration, entities, model-limit lookups

**Files:**
- Create: `backend/src/migrations/1804000000000-free-tier-budget-reservation.ts`
- Create: `backend/src/modules/strategy/entities/free-tier-reservation.entity.ts`
- Modify: `backend/src/modules/supported-model/entities/supported-model.entity.ts`
- Modify: `backend/src/modules/strategy/entities/strategy-run.entity.ts`
- Modify: `backend/src/app.module.ts` (entities list ~line 54), `backend/src/data-source.ts` (entities list ~line 30)
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Test: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Produces:
  - Entity `FreeTierReservation { id: number; tier: string; strategyRunId: number; reservedTokens: number; status: "pending" | "unrecorded"; createdAt: Date }`
  - `SupportedModel.maxOutputTokens: number | null`
  - `StrategyRun.budgetTier: string | null`
  - `SupportedModelService.getMaxOutputTokens(strategyName: string, modelName: string): Promise<number | null>`
  - `SupportedModelService.getMaxOutputTokensByModel(strategyName: string, modelNames: readonly string[]): Promise<Map<string, number | null>>`. Every requested name is present in the map; names with no row map to `null`.

- [ ] **Step 1: Write the failing tests**

In `supported-model.service.spec.ts`, add these next to `describe("getContextWindow", …)`:

```ts
  describe("getMaxOutputTokens", () => {
    it("returns the model's maxOutputTokens", async () => {
      mockRepo.findOne.mockResolvedValueOnce({ maxOutputTokens: 47000 });
      await expect(service.getMaxOutputTokens("llm-openai", "gpt-5")).resolves.toBe(47000);
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { strategyName: "llm-openai", modelName: "gpt-5" },
      });
    });

    it("returns null when the model has no row or no limit", async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getMaxOutputTokens("llm-openai", "nope")).resolves.toBeNull();
      mockRepo.findOne.mockResolvedValueOnce({ maxOutputTokens: null });
      await expect(service.getMaxOutputTokens("llm-openai", "gpt-x")).resolves.toBeNull();
    });
  });

  describe("getMaxOutputTokensByModel", () => {
    it("maps every requested model, null for missing rows or limits", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { modelName: "gpt-5", maxOutputTokens: 47000 },
        { modelName: "gpt-4o", maxOutputTokens: null },
      ]);

      const result = await service.getMaxOutputTokensByModel("llm-openai", ["gpt-5", "gpt-4o", "o3"]);

      expect(result).toEqual(
        new Map<string, number | null>([
          ["gpt-5", 47000],
          ["gpt-4o", null],
          ["o3", null],
        ]),
      );
    });

    it("skips the query for an empty model list", async () => {
      const result = await service.getMaxOutputTokensByModel("llm-openai", []);
      expect(result.size).toBe(0);
      expect(mockRepo.find).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && npm test -- supported-model.service`
Expected: FAIL with "service.getMaxOutputTokens is not a function".

- [ ] **Step 3: Implement the entities and the migration**

In `supported-model.entity.ts`, add this after `contextWindow`:

```ts
  // Hard cap on one call's output tokens (reasoning included), sent to the
  // orchestrator as maxOutputTokens on every llm-openai call. Doubles as the
  // output half of a call's worst-case cost for free-tier budget
  // reservations (see FreeTierBudgetService). Seeded from historical max
  // output × 1.2; null = no cap, and the model can't be auto-dispatched
  // on a free-tier budget. Editable via Adminer.
  @Column({ type: "int", nullable: true })
  maxOutputTokens: number | null;
```

In `strategy-run.entity.ts`, add this after `contextWindow`:

```ts
  // Set only when FreeTierDispatchService created this run ('flagship' |
  // 'mini' — see FreeTierId). A run with a budgetTier reserves each call's
  // worst case against that tier's threshold before making it, and pauses
  // (RATE_LIMITED_DAILY) when it doesn't fit. Null for manual dispatches.
  @Column({ type: "varchar", nullable: true })
  budgetTier: string | null;
```

Create `backend/src/modules/strategy/entities/free-tier-reservation.entity.ts`:

```ts
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type FreeTierReservationStatus = "pending" | "unrecorded";

// One row per in-progress (or unaccounted-for) llm-openai call made by a
// free-tier-dispatched run — its worst-case token cost, held against the
// tier's threshold until the call's real usage is recorded. A 'pending'
// row is deleted in the same transaction that writes the call's SolvePrompt
// row; a call that failed without reporting usage flips to 'unrecorded' and
// keeps counting (OpenAI may still have billed it). Only rows created today
// (UTC) count, so nothing ever needs cleaning up. See FreeTierBudgetService.
@Entity("FreeTierReservation")
@Index("IDX_FreeTierReservation_tier_createdAt", ["tier", "createdAt"])
export class FreeTierReservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar" })
  tier: string;

  @Column({ type: "int" })
  strategyRunId: number;

  @Column({ type: "int" })
  reservedTokens: number;

  @Column({ type: "varchar", default: "pending" })
  status: FreeTierReservationStatus;

  @CreateDateColumn({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
```

Add `FreeTierReservation` (imported from `./modules/strategy/entities/free-tier-reservation.entity`) to the end of the `entities: [...]` arrays in **both** `backend/src/app.module.ts` and `backend/src/data-source.ts`.

Create `backend/src/migrations/1804000000000-free-tier-budget-reservation.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

// Seeded from prod SolvePrompt.completionTokens (queried 2026-10-08): max
// observed × 1.2, rounded up to the next 1,000, floor 1,000 — no call ever
// recorded would have been cut off. See
// docs/specs/2026-10-08-free-tier-budget-reservation-design.md.
const OPENAI_MAX_OUTPUT_TOKENS: ReadonlyArray<[string, number]> = [
  ["o4-mini", 49_000],
  ["gpt-5", 47_000],
  ["o3", 46_000],
  ["gpt-5-nano", 36_000],
  ["o1", 33_000],
  ["o3-mini", 29_000],
  ["gpt-5-mini", 27_000],
  ["gpt-4.1-mini", 14_000],
  ["gpt-4.1-nano", 4_000],
  ["gpt-4.1", 2_000],
  ["gpt-4o", 1_000],
  ["gpt-4o-mini", 1_000],
  ["gpt-5.1", 1_000],
  ["gpt-5.2", 1_000],
  ["gpt-5.4", 1_000],
  ["gpt-5.4-mini", 1_000],
  ["gpt-5.4-nano", 1_000],
];

/** Per-model output caps, StrategyRun.budgetTier, and the
 * FreeTierReservation ledger behind free-tier budget reservations. */
export class FreeTierBudgetReservation1804000000000 implements MigrationInterface {
  name = "FreeTierBudgetReservation1804000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ADD COLUMN IF NOT EXISTS "maxOutputTokens" INT`,
    );
    for (const [modelName, maxOutputTokens] of OPENAI_MAX_OUTPUT_TOKENS) {
      await queryRunner.query(
        `UPDATE "SupportedModel" SET "maxOutputTokens" = $1
          WHERE "strategyName" = 'llm-openai' AND "modelName" = $2`,
        [maxOutputTokens, modelName],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ADD COLUMN IF NOT EXISTS "budgetTier" VARCHAR`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "FreeTierReservation" (
        "id" SERIAL PRIMARY KEY,
        "tier" VARCHAR NOT NULL,
        "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "reservedTokens" INT NOT NULL,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FreeTierReservation_tier_createdAt"
        ON "FreeTierReservation" ("tier", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "FreeTierReservation"`);
    await queryRunner.query(`ALTER TABLE "StrategyRun" DROP COLUMN IF EXISTS "budgetTier"`);
    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN IF EXISTS "maxOutputTokens"`);
  }
}
```

- [ ] **Step 4: Implement the service methods**

In `supported-model.service.ts`, add `In` to the `typeorm` import, then add this after `getContextWindow`:

```ts
  /** The model's per-call output cap (SupportedModel.maxOutputTokens), or
   * null when it has no row or no cap set. */
  async getMaxOutputTokens(strategyName: string, modelName: string): Promise<number | null> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row?.maxOutputTokens ?? null;
  }

  /** Batch form of getMaxOutputTokens — every requested name is present in
   * the result, null when it has no row or no cap. Used by the free-tier
   * dispatch tick to size each candidate model's worst-case call. */
  async getMaxOutputTokensByModel(
    strategyName: string,
    modelNames: readonly string[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>(modelNames.map((name) => [name, null]));
    if (modelNames.length === 0) return result;

    const rows = await this.repo.find({
      where: { strategyName, modelName: In([...modelNames]) },
    });
    for (const row of rows) result.set(row.modelName, row.maxOutputTokens ?? null);
    return result;
  }
```

- [ ] **Step 5: Run the tests and build**

Run: `cd backend && npm test -- supported-model.service && npm run build`
Expected: tests pass and the build is clean.

- [ ] **Step 6: Apply the migration to the local dev DB**

Run (the local stack is `connections-dev`):
```bash
docker compose -p connections-dev up -d db
cd backend && npm run migration:run
docker exec postgres_db psql -U postgres -d mydb -c "SELECT \"modelName\", \"maxOutputTokens\" FROM \"SupportedModel\" WHERE \"strategyName\"='llm-openai' ORDER BY 2 DESC NULLS LAST" -c "\d \"FreeTierReservation\""
```
Expected: the migration runs; the openai models show the seeded caps; the table exists with its FK and index. If the dev DB name isn't `mydb`, use the `DB_NAME` from the root `.env`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/1804000000000-free-tier-budget-reservation.ts backend/src/modules/strategy/entities/free-tier-reservation.entity.ts backend/src/modules/supported-model backend/src/modules/strategy/entities/strategy-run.entity.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "feat(backend): add per-model output caps, StrategyRun.budgetTier, and the FreeTierReservation table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Input-token upper bound (pure function)

**Files:**
- Create: `backend/src/modules/strategy/token-bound.ts`
- Test: `backend/src/modules/strategy/token-bound.spec.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `./orchestrator.service` (`{ role: "user" | "assistant"; content: string }`)
- Produces:
  - `PER_MESSAGE_OVERHEAD_TOKENS = 8`, `REQUEST_OVERHEAD_TOKENS = 64`
  - `interface KnownPrefix { messageCount: number; tokens: number }`
  - `inputTokenUpperBound(messages: readonly ChatMessage[], known: KnownPrefix | null): number`
  - `knownPrefixAfterReply(requestMessageCount: number, promptTokens: number, assistantContent: string): KnownPrefix`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/token-bound.spec.ts`:

```ts
import {
  inputTokenUpperBound,
  knownPrefixAfterReply,
  PER_MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from "./token-bound";
import type { ChatMessage } from "./orchestrator.service";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

describe("inputTokenUpperBound", () => {
  it("bounds a conversation with no known usage by its UTF-8 byte count plus overhead", () => {
    const messages = [msg("user", "abcd"), msg("assistant", "ef"), msg("user", "g")];
    expect(inputTokenUpperBound(messages, null)).toBe(
      REQUEST_OVERHEAD_TOKENS + 4 + 2 + 1 + 3 * PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("counts multi-byte characters by bytes, not characters", () => {
    // "é" is 2 bytes, "😀" is 4 bytes in UTF-8.
    expect(inputTokenUpperBound([msg("user", "é😀")], null)).toBe(
      REQUEST_OVERHEAD_TOKENS + 6 + PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("starts from a known prefix and adds only the messages after it", () => {
    const messages = [msg("user", "x".repeat(5000)), msg("assistant", "yy"), msg("user", "zzz")];
    const known = { messageCount: 2, tokens: 1300 };
    expect(inputTokenUpperBound(messages, known)).toBe(1300 + 3 + PER_MESSAGE_OVERHEAD_TOKENS);
  });

  it("falls back to the full count when the known prefix is longer than the conversation", () => {
    const messages = [msg("user", "ab")];
    expect(inputTokenUpperBound(messages, { messageCount: 3, tokens: 10 })).toBe(
      REQUEST_OVERHEAD_TOKENS + 2 + PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });
});

describe("knownPrefixAfterReply", () => {
  it("covers the request plus the assistant reply, bounding the reply by its bytes", () => {
    expect(knownPrefixAfterReply(1, 500, "ANSWER é")).toEqual({
      messageCount: 2,
      tokens: 500 + 9 + PER_MESSAGE_OVERHEAD_TOKENS,
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && npm test -- token-bound`
Expected: FAIL with "Cannot find module './token-bound'".

- [ ] **Step 3: Implement**

Create `backend/src/modules/strategy/token-bound.ts`:

```ts
import type { ChatMessage } from "./orchestrator.service";

/**
 * A strict upper bound on a request's input tokens, computed before the call
 * so a free-tier-dispatched run can reserve the call's worst case (see
 * FreeTierBudgetService). Rests on one fact: a BPE token always covers at
 * least one byte, so a text's token count never exceeds its UTF-8 byte count.
 *
 * When an earlier call in this run reported its real promptTokens, that
 * exact figure stands in for the messages it covered (`known`), and only
 * what was added since is counted by bytes — keeping the bound within a few
 * hundred tokens of reality instead of ~4× over.
 */

// Role/framing tokens a chat API adds per message — generous on purpose.
export const PER_MESSAGE_OVERHEAD_TOKENS = 8;
// Request-level framing (priming tokens etc.) for a conversation counted
// entirely from bytes; a known prefix's real promptTokens already includes it.
export const REQUEST_OVERHEAD_TOKENS = 64;

/** The first `messageCount` messages of a conversation cost at most `tokens`. */
export interface KnownPrefix {
  messageCount: number;
  tokens: number;
}

export function inputTokenUpperBound(
  messages: readonly ChatMessage[],
  known: KnownPrefix | null,
): number {
  const usable = known !== null && known.messageCount <= messages.length ? known : null;
  let total = usable ? usable.tokens : REQUEST_OVERHEAD_TOKENS;
  for (let i = usable ? usable.messageCount : 0; i < messages.length; i++) {
    total += Buffer.byteLength(messages[i].content, "utf8") + PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/** After a call whose request had `requestMessageCount` messages and reported
 * `promptTokens`, the conversation through the appended assistant reply is
 * bounded by that figure plus the reply's own bytes. The reply is bounded by
 * bytes rather than the call's completionTokens because the runner may echo
 * a compacted restatement instead of the raw reply (MULTIPLE_PROPOSALS). */
export function knownPrefixAfterReply(
  requestMessageCount: number,
  promptTokens: number,
  assistantContent: string,
): KnownPrefix {
  return {
    messageCount: requestMessageCount + 1,
    tokens:
      promptTokens + Buffer.byteLength(assistantContent, "utf8") + PER_MESSAGE_OVERHEAD_TOKENS,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && npm test -- token-bound`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/token-bound.ts backend/src/modules/strategy/token-bound.spec.ts
git commit -m "feat(backend): add a strict pre-call input-token upper bound

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `FreeTierBudgetService` and settling in `flushBatch`

**Files:**
- Create: `backend/src/modules/strategy/free-tier-budget.service.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`
- Modify: `backend/src/modules/strategy/strategy-run-store.service.ts` (`loadOrCreateRun` lines 72-123, `flushBatch` lines 155-242)
- Test: `backend/src/modules/strategy/free-tier-budget.service.spec.ts` (new), `backend/src/modules/strategy/strategy-run-store.service.spec.ts`

**Interfaces:**
- Consumes: `FreeTierReservation` (Task 2); `FreeTierUsageService.getUsage(tier)` and `FREE_TIER_LIMITS` from `./free-tier-usage.service`; `SupportedModelService.getMaxOutputTokensByModel` (Task 2); `startOfTodayUtc`, `LLM_OPENAI` from `../../strategies`.
- Produces:
  - `FreeTierBudgetService.reserve(tier: FreeTierId, strategyRunId: number, tokens: number): Promise<number | null>` returns the reservation id, or `null` if the call doesn't fit, no cycle is active, or there was an error.
  - `FreeTierBudgetService.committedTokens(tier: FreeTierId): Promise<number>` returns recorded usage plus today's reservations.
  - `FreeTierBudgetService.modelCaps(models: readonly string[]): Promise<Map<string, number | null>>` for `llm-openai`.
  - `interface ReservationSettlement { reservationId: number; recorded: boolean }`
  - `settleReservationTx(manager: EntityManager, settlement: ReservationSettlement): Promise<void>`
  - `StrategyRunStore.flushBatch(run, pendingGuesses, pendingProposals = [], pendingPrompts = [], settlement?: ReservationSettlement)`
  - `StrategyRunStore.loadOrCreateRun(puzzleId, strategyName, trialNumber = 0, model?, contextWindow?, budgetTier?: string | null)`. A new run gets `budgetTier: budgetTier ?? null`; an existing run is returned unchanged.

- [ ] **Step 1: Write the failing service tests**

Create `backend/src/modules/strategy/free-tier-budget.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierBudgetService, settleReservationTx } from "./free-tier-budget.service";
import { FreeTierReservation } from "./entities/free-tier-reservation.entity";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { SupportedModelService } from "../supported-model/supported-model.service";

describe("FreeTierBudgetService", () => {
  let service: FreeTierBudgetService;
  let reservedSum: number;
  let usedTokens: number;
  let mockManager: {
    query: jest.Mock;
    insert: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockReservationRepo: { manager: typeof mockManager };
  let mockDataSource: { transaction: jest.Mock };
  let mockUsage: { getUsage: jest.Mock };
  let mockSupportedModels: { getMaxOutputTokensByModel: jest.Mock };
  let sumQuery: { getRawOne: jest.Mock };

  beforeEach(async () => {
    reservedSum = 0;
    usedTokens = 0;
    sumQuery = { getRawOne: jest.fn(async () => ({ total: String(reservedSum) })) };
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: sumQuery.getRawOne,
    };
    mockManager = {
      // Default: an active flagship cycle at 80% → threshold 200,000.
      query: jest.fn().mockResolvedValue([{ active: true, thresholdPercent: 80 }]),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 55 }] }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    mockReservationRepo = { manager: mockManager };
    mockDataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(mockManager)),
    };
    mockUsage = { getUsage: jest.fn(async () => ({ usedTokens })) };
    mockSupportedModels = { getMaxOutputTokensByModel: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        FreeTierBudgetService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(FreeTierReservation), useValue: mockReservationRepo },
        { provide: FreeTierUsageService, useValue: mockUsage },
        { provide: SupportedModelService, useValue: mockSupportedModels },
      ],
    }).compile();
    service = module.get(FreeTierBudgetService);
  });

  describe("reserve", () => {
    it("locks the tier's state row before reading anything", async () => {
      await service.reserve("flagship", 7, 1000);
      expect(mockManager.query).toHaveBeenCalledWith(
        expect.stringContaining("FOR UPDATE"),
        ["flagship"],
      );
      expect(mockManager.query.mock.invocationCallOrder[0]).toBeLessThan(
        sumQuery.getRawOne.mock.invocationCallOrder[0],
      );
    });

    it("inserts a pending reservation and returns its id when the call fits", async () => {
      usedTokens = 150_000;
      reservedSum = 40_000;
      // 150,000 + 40,000 + 10,000 = 200,000 = threshold exactly → fits.
      await expect(service.reserve("flagship", 7, 10_000)).resolves.toBe(55);
      expect(mockManager.insert).toHaveBeenCalledWith(FreeTierReservation, {
        tier: "flagship",
        strategyRunId: 7,
        reservedTokens: 10_000,
        status: "pending",
      });
    });

    it("returns null without inserting when the call would cross the threshold", async () => {
      usedTokens = 150_000;
      reservedSum = 40_000;
      await expect(service.reserve("flagship", 7, 10_001)).resolves.toBeNull();
      expect(mockManager.insert).not.toHaveBeenCalled();
    });

    it("reads reservations before recorded usage, so a settle in between can only double-count", async () => {
      await service.reserve("flagship", 7, 1000);
      expect(sumQuery.getRawOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockUsage.getUsage.mock.invocationCallOrder[0],
      );
    });

    it("returns null when the tier has no active cycle", async () => {
      mockManager.query.mockResolvedValueOnce([{ active: false, thresholdPercent: 80 }]);
      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();
      mockManager.query.mockResolvedValueOnce([]);
      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();
      expect(mockManager.insert).not.toHaveBeenCalled();
    });

    it("fails closed: any error returns null", async () => {
      mockDataSource.transaction.mockRejectedValueOnce(new Error("lock timeout"));
      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();
    });
  });

  describe("committedTokens", () => {
    it("is today's reservations plus recorded usage", async () => {
      usedTokens = 120_000;
      reservedSum = 33_000;
      await expect(service.committedTokens("mini")).resolves.toBe(153_000);
      expect(mockUsage.getUsage).toHaveBeenCalledWith("mini");
    });
  });

  describe("modelCaps", () => {
    it("looks the caps up for llm-openai", async () => {
      const caps = new Map([["gpt-5", 47000]]);
      mockSupportedModels.getMaxOutputTokensByModel.mockResolvedValueOnce(caps);
      await expect(service.modelCaps(["gpt-5"])).resolves.toBe(caps);
      expect(mockSupportedModels.getMaxOutputTokensByModel).toHaveBeenCalledWith("llm-openai", ["gpt-5"]);
    });
  });
});

describe("settleReservationTx", () => {
  it("deletes the reservation when the call's usage was recorded", async () => {
    const manager = { delete: jest.fn(), update: jest.fn() };
    await settleReservationTx(manager as never, { reservationId: 55, recorded: true });
    expect(manager.delete).toHaveBeenCalledWith(FreeTierReservation, { id: 55 });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("keeps the reservation as 'unrecorded' when the call reported no usage", async () => {
    const manager = { delete: jest.fn(), update: jest.fn() };
    await settleReservationTx(manager as never, { reservationId: 55, recorded: false });
    expect(manager.update).toHaveBeenCalledWith(FreeTierReservation, { id: 55 }, { status: "unrecorded" });
    expect(manager.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing store tests**

In `strategy-run-store.service.spec.ts`:
- Update the exact `create` assertion near line 165 to include `budgetTier: null,` after `contextWindow: null,`.
- Add these tests next to the other `loadOrCreateRun` tests:

```ts
    it("should set budgetTier on a newly created run when given", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
      mockStrategyRunRepo.create.mockImplementation((x: unknown) => x);
      mockStrategyRunRepo.save.mockImplementation(async (x: unknown) => x);

      await store.loadOrCreateRun(100, "llm-openai", 1, "gpt-5", null, "flagship");

      expect(mockStrategyRunRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ budgetTier: "flagship" }),
      );
    });
```

- Add this test to the `flushBatch` tests:

```ts
    it("settles a reservation inside the flush transaction", async () => {
      // Requires `delete: jest.fn()` on this spec's mockManager (add it, and
      // to its type, if it isn't there).
      await store.flushBatch(makeRun() as never, [], [], [], { reservationId: 55, recorded: true });
      expect(mockManager.delete).toHaveBeenCalledWith(FreeTierReservation, { id: 55 });
    });
```

Fit these to the spec file's existing names (`store`, `puzzle`, `mockPuzzleRepo`, `mockStrategyRunRepo`, `mockManager`, and a run fixture). Open the file and use the names it already declares. If it has no run fixture, pass `{ id: 7 } as never`. Import `FreeTierReservation` from `./entities/free-tier-reservation.entity`.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd backend && npm test -- free-tier-budget strategy-run-store`
Expected: FAIL. The module isn't found, `budgetTier` is missing from `create`, and `delete` is never called.

- [ ] **Step 4: Implement the service**

Create `backend/src/modules/strategy/free-tier-budget.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { FreeTierReservation } from "./entities/free-tier-reservation.entity";
import { FREE_TIER_LIMITS, FreeTierId, FreeTierUsageService } from "./free-tier-usage.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { LLM_OPENAI, startOfTodayUtc } from "../../strategies";

export interface ReservationSettlement {
  reservationId: number;
  // True when the call reported usage (its SolvePrompt row carries the real
  // figure, so the reservation is released); false when it didn't (timeout /
  // call error — OpenAI may still have billed it, so the reservation stays).
  recorded: boolean;
}

/**
 * Hard guarantee that free-tier-dispatched llm-openai calls never push a
 * tier's spend past its cycle threshold. Before each call a run reserves the
 * call's worst case (input upper bound + the model's maxOutputTokens); the
 * reservation succeeds only if recorded usage + today's outstanding
 * reservations + this call still fit. Reservations for one tier are
 * serialized by a row lock on that tier's FreeTierDispatchState row, so two
 * concurrent runs can never both take the last of the room. See
 * docs/specs/2026-10-08-free-tier-budget-reservation-design.md.
 */
@Injectable()
export class FreeTierBudgetService {
  private readonly logger = new Logger(FreeTierBudgetService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FreeTierReservation)
    private readonly reservationRepo: Repository<FreeTierReservation>,
    @Inject(FreeTierUsageService) private readonly freeTierUsage: FreeTierUsageService,
    @Inject(SupportedModelService) private readonly supportedModels: SupportedModelService,
  ) {}

  /** Returns the new reservation's id, or null when the call doesn't fit, the
   * tier has no active cycle, or anything goes wrong (fail closed). */
  async reserve(tier: FreeTierId, strategyRunId: number, tokens: number): Promise<number | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const [state] = (await manager.query(
          `SELECT "active", "thresholdPercent" FROM "FreeTierDispatchState" WHERE "tier" = $1 FOR UPDATE`,
          [tier],
        )) as { active: boolean; thresholdPercent: number }[];
        if (!state?.active) return null;

        const threshold = Math.floor(
          FREE_TIER_LIMITS[tier].dailyLimitTokens * (state.thresholdPercent / 100),
        );
        const committed = await this.committedWith(manager, tier);
        if (committed + tokens > threshold) return null;

        const result = await manager.insert(FreeTierReservation, {
          tier,
          strategyRunId,
          reservedTokens: tokens,
          status: "pending",
        });
        return result.identifiers[0].id as number;
      });
    } catch (err) {
      this.logger.error(
        `reserving ${tokens} '${tier}' tokens for run ${strategyRunId} failed — treating as no room: ` +
          `${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Recorded usage + today's outstanding reservations, unlocked — the
   * dispatch tick's view of how much of the threshold is spoken for. */
  async committedTokens(tier: FreeTierId): Promise<number> {
    return this.committedWith(this.reservationRepo.manager, tier);
  }

  /** Per-call output caps for llm-openai models (null = no cap). */
  async modelCaps(models: readonly string[]): Promise<Map<string, number | null>> {
    return this.supportedModels.getMaxOutputTokensByModel(LLM_OPENAI, models);
  }

  // Reservations are read BEFORE recorded usage, deliberately. A settle
  // deletes a reservation and inserts its SolvePrompt row in one commit; if
  // that commit lands between these two reads, this order sees both (an
  // over-count), never neither (an under-count that could let a call through).
  private async committedWith(manager: EntityManager, tier: FreeTierId): Promise<number> {
    const raw = await manager
      .createQueryBuilder(FreeTierReservation, "reservation")
      .select('COALESCE(SUM(reservation."reservedTokens"), 0)', "total")
      .where("reservation.tier = :tier", { tier })
      .andWhere('reservation."createdAt" >= :since', { since: startOfTodayUtc() })
      .getRawOne<{ total: string }>();
    const { usedTokens } = await this.freeTierUsage.getUsage(tier);
    return Number(raw?.total ?? 0) + usedTokens;
  }
}

/** Runs inside StrategyRunStore.flushBatch's transaction, so a recorded call's
 * reservation disappears in the same commit its SolvePrompt row appears. */
export async function settleReservationTx(
  manager: EntityManager,
  settlement: ReservationSettlement,
): Promise<void> {
  if (settlement.recorded) {
    await manager.delete(FreeTierReservation, { id: settlement.reservationId });
  } else {
    await manager.update(
      FreeTierReservation,
      { id: settlement.reservationId },
      { status: "unrecorded" },
    );
  }
}
```

- [ ] **Step 5: Register it in `StrategyModule`**

In `strategy.module.ts`:
- Import `FreeTierReservation` from `./entities/free-tier-reservation.entity` and `FreeTierBudgetService` from `./free-tier-budget.service`.
- Add `FreeTierReservation` to `TypeOrmModule.forFeature([...])`.
- Add `FreeTierBudgetService` to both `providers` and `exports`.

- [ ] **Step 6: Update the store**

In `strategy-run-store.service.ts`:
- Import `settleReservationTx` and `type ReservationSettlement` from `./free-tier-budget.service`.
- Add a sixth parameter to `loadOrCreateRun`: `budgetTier?: string | null,`. In the `this.strategyRunRepo.create({ … })` payload, add this after `contextWindow: contextWindow ?? null,`:
  ```ts
      // Only FreeTierDispatchService passes this — see StrategyRun.budgetTier.
      budgetTier: budgetTier ?? null,
  ```
- Add a fifth parameter to `flushBatch`: `settlement?: ReservationSettlement,`. Inside the transaction, immediately before `await manager.save(StrategyRun, run);`, add:
  ```ts
      // Release (or keep, as 'unrecorded') this call's budget reservation in
      // the same commit as its SolvePrompt row — see FreeTierBudgetService.
      if (settlement) await settleReservationTx(manager, settlement);
  ```

- [ ] **Step 7: Run the tests and build**

Run: `cd backend && npm test -- free-tier-budget strategy-run-store && npm run build`
Expected: tests pass and the build is clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/strategy/free-tier-budget.service.ts backend/src/modules/strategy/free-tier-budget.service.spec.ts backend/src/modules/strategy/strategy.module.ts backend/src/modules/strategy/strategy-run-store.service.ts backend/src/modules/strategy/strategy-run-store.service.spec.ts
git commit -m "feat(backend): add FreeTierBudgetService with locked per-call reservations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Run loop — output limit, reserve/pause/settle, truncation warning

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts` (`requestSolveStep` ~line 134, `SolveStepSuccess` type)
- Modify: `backend/src/modules/strategy/llm-job-handler.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, `backend/src/modules/strategy/llm-job-handler.spec.ts`

**Interfaces:**
- Consumes:
  - `FreeTierBudgetService.reserve` and `ReservationSettlement` (Task 4)
  - `inputTokenUpperBound`, `knownPrefixAfterReply`, `KnownPrefix` (Task 3)
  - `SupportedModelService.getMaxOutputTokens` (Task 2)
  - `StrategyRunStore.loadOrCreateRun(…, budgetTier)` and `flushBatch(…, settlement)` (Task 4)
- Produces:
  - `OrchestratorService.requestSolveStep(messages, model?, provider?, contextWindow?, boardWords?, maxOutputTokens?: number | null)`
  - `SolveStepSuccess.finishReason?: string`
  - `RunStrategyJobData.budgetTier?: string | null`
  - `LlmStrategyRunner.runLlmStrategy(puzzleId, strategyName, trialNumber = 0, model?, manualRetry = false, budgetTier: FreeTierId | null = null)`

- [ ] **Step 1: Update the test wiring and existing assertions**

In `llm-strategy-runner.service.spec.ts`:
- Import `FreeTierBudgetService` from `./free-tier-budget.service`, `FreeTierReservation` from `./entities/free-tier-reservation.entity`, `buildInitialPrompt` from `./llm-strategy-runner.service`, and `inputTokenUpperBound` from `./token-bound`.
- Declare `let mockFreeTierBudget: { reserve: jest.Mock };`. In `beforeEach`, add:
  ```ts
    mockFreeTierBudget = { reserve: jest.fn().mockResolvedValue(55) };
  ```
- Add `getMaxOutputTokens: jest.fn().mockResolvedValue(null)` to `mockSupportedModelService` (and to its type).
- Add `delete: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined)` to `mockManager` (and to its type).
- Add `{ provide: FreeTierBudgetService, useValue: mockFreeTierBudget },` to the testing module's providers.
- The four `requestSolveStep).toHaveBeenCalledWith(…)` assertions (near lines 833, 856, 882, 909) gain a sixth expected argument, `null`, after `expect.any(Array),`.

In `llm-job-handler.spec.ts`, the two `runLlmStrategy).toHaveBeenCalledWith(…)` assertions (lines 55 and 82) gain a sixth expected argument, `null`.

- [ ] **Step 2: Write the failing runner tests**

Add this block inside `describe("runLlmStrategy", …)`:

```ts
    describe("free-tier budget", () => {
      const openaiRun = (overrides: Partial<StrategyRun> = {}) =>
        makeRun({ strategyName: "llm-openai", modelName: "gpt-5", ...overrides });
      const solved = () =>
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]);

      it("sends the model's maxOutputTokens on every llm-openai call, budgeted or not", async () => {
        mockSupportedModelService.getMaxOutputTokens.mockResolvedValue(47000);
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(openaiRun());
        mockOrchestratorService.requestSolveStep.mockResolvedValueOnce(solved());

        await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5");

        expect(mockOrchestratorService.requestSolveStep).toHaveBeenCalledWith(
          expect.any(Array), "gpt-5", "openai", null, expect.any(Array), 47000,
        );
        expect(mockFreeTierBudget.reserve).not.toHaveBeenCalled();
      });

      it("reserves the call's worst case (cap + input bound) for a budgeted run", async () => {
        mockSupportedModelService.getMaxOutputTokens.mockResolvedValue(47000);
        const run = openaiRun({ budgetTier: "flagship" });
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(run);
        mockOrchestratorService.requestSolveStep.mockResolvedValueOnce(solved());

        await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5", false, "flagship");

        const firstPrompt = buildInitialPrompt(run.availableWords, run.availableWords.length / 4);
        expect(mockFreeTierBudget.reserve).toHaveBeenCalledWith(
          "flagship",
          7,
          47000 + inputTokenUpperBound([{ role: "user", content: firstPrompt }], null),
        );
      });

      it("pauses without calling OpenAI when the reservation is refused", async () => {
        mockSupportedModelService.getMaxOutputTokens.mockResolvedValue(47000);
        mockFreeTierBudget.reserve.mockResolvedValueOnce(null);
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(openaiRun({ budgetTier: "flagship" }));

        const result = await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5", false, "flagship");

        expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
        expect(mockOrchestratorService.requestSolveStep).not.toHaveBeenCalled();
        expect(mockStrategyRunRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: StrategyRunStatus.RATE_LIMITED_DAILY, finishedAt: expect.any(Date) }),
        );
      });

      it("pauses a budgeted run whose model has no output cap, without reserving", async () => {
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(openaiRun({ budgetTier: "flagship" }));

        const result = await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5", false, "flagship");

        expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
        expect(mockFreeTierBudget.reserve).not.toHaveBeenCalled();
        expect(mockOrchestratorService.requestSolveStep).not.toHaveBeenCalled();
      });

      it("releases the reservation in the flush when the call reports usage", async () => {
        mockSupportedModelService.getMaxOutputTokens.mockResolvedValue(47000);
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(openaiRun({ budgetTier: "flagship" }));
        const outcome = solved();
        if (outcome.ok) outcome.data.usage = { promptTokens: 400, completionTokens: 100, totalTokens: 500 };
        mockOrchestratorService.requestSolveStep.mockResolvedValueOnce(outcome);

        await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5", false, "flagship");

        expect(mockManager.delete).toHaveBeenCalledWith(FreeTierReservation, { id: 55 });
      });

      it("keeps the reservation as 'unrecorded' when a failed call reports no usage", async () => {
        mockSupportedModelService.getMaxOutputTokens.mockResolvedValue(47000);
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(openaiRun({ budgetTier: "flagship" }));
        mockOrchestratorService.requestSolveStep.mockResolvedValueOnce({
          ok: false,
          error: { code: "model_error", error: "Request timed out" },
        } as SolveStepOutcome);

        await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-5", false, "flagship");

        expect(mockManager.update).toHaveBeenCalledWith(
          FreeTierReservation, { id: 55 }, { status: "unrecorded" },
        );
      });
    });
```

If `SolveStepOutcome`'s error shape needs more required fields than `code` and `error`, copy the minimal failed-outcome literal that an existing `model_error` test in this file already uses.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd backend && npm test -- llm-strategy-runner llm-job-handler`
Expected: FAIL. The sixth argument is missing, `reserve` is never called, and runs aren't paused.

- [ ] **Step 4: Update the orchestrator client and the job handler**

In `orchestrator.service.ts`:
- Add `finishReason?: string;` to the `SolveStepSuccess` interface.
- Add `maxOutputTokens?: number | null,` as the sixth parameter of `requestSolveStep`.
- The body becomes `{ messages, model, provider, contextWindow: contextWindow ?? undefined, boardWords, maxOutputTokens: maxOutputTokens ?? undefined }`.
- Add `finishReason: raw.finishReason,` to the success mapper.

In `llm-job-handler.ts`, add this to `RunStrategyJobData`:

```ts
  // Set only by FreeTierDispatchService — the free-tier program ('flagship' |
  // 'mini') this run's calls must reserve against. Written onto
  // StrategyRun.budgetTier at creation; a resumed run reads it from the row.
  budgetTier?: string | null;
```

Destructure `budgetTier` alongside `manualRetry`, and add a sixth argument to the `runLlmStrategy` call: `(budgetTier ?? null) as FreeTierId | null`. Use `import type { FreeTierId } from "./free-tier-usage.service";`.

- [ ] **Step 5: Implement the run-loop changes**

In `llm-strategy-runner.service.ts`:

1. Imports: add `Logger` to the `@nestjs/common` import. Add:
   ```ts
   import { FreeTierBudgetService, type ReservationSettlement } from "./free-tier-budget.service";
   import type { FreeTierId } from "./free-tier-usage.service";
   import { inputTokenUpperBound, knownPrefixAfterReply, type KnownPrefix } from "./token-bound";
   ```
2. Class: add `private readonly logger = new Logger(LlmStrategyRunner.name);`. Add a constructor parameter:
   `@Inject(FreeTierBudgetService) private readonly freeTierBudget: FreeTierBudgetService,`
3. Signature: add `budgetTier: FreeTierId | null = null,` after `manualRetry = false,`.
4. After the `contextWindow` lookup, add:
   ```ts
    // Every llm-openai call carries its model's output cap — a runaway guard
    // sized above anything the model has produced, and the output half of a
    // budgeted call's worst-case reservation below.
    const maxOutputTokens =
      model && provider === "openai"
        ? await this.supportedModelService.getMaxOutputTokens(strategyName, model)
        : null;
   ```
5. Pass `budgetTier` as the sixth argument to `this.store.loadOrCreateRun(…)`.
6. Just before `while (true) {`, add:
   ```ts
    // Taken from the row so a resumed run stays budgeted even though its
    // resume job carries no budgetTier of its own.
    const runBudgetTier = (run.budgetTier as FreeTierId | null) ?? null;
    // Exact token cost of a conversation prefix, from the last call that
    // reported usage — null on a fresh or resumed run, which falls back to
    // counting the whole conversation by bytes (see token-bound.ts).
    let knownPrefix: KnownPrefix | null = null;
   ```
7. Replace `messages.push({ role: "user", content: prompt });` with:
   ```ts
      // A free-tier-dispatched run reserves this call's worst case before
      // making it; no room (or no cap to size it by) pauses the run instead.
      // RATE_LIMITED_DAILY is resumable: FreeTierDispatchService re-queues
      // it once there's room again, and state is rebuilt from saved guesses.
      let reservationId: number | null = null;
      if (runBudgetTier) {
        const worstCase =
          maxOutputTokens === null
            ? null
            : maxOutputTokens +
              inputTokenUpperBound([...messages, { role: "user", content: prompt }], knownPrefix);
        reservationId =
          worstCase === null
            ? null
            : await this.freeTierBudget.reserve(runBudgetTier, run.id, worstCase);
        if (reservationId === null) {
          run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
          run.finishedAt = new Date();
          await this.store.saveRun(run);
          this.logger.log(
            `run ${run.id} (${model}) paused: no room in the '${runBudgetTier}' budget for its next call` +
              (maxOutputTokens === null ? " (model has no maxOutputTokens)" : ""),
          );
          break;
        }
      }

      // Append the user message to conversation history.
      messages.push({ role: "user", content: prompt });
   ```
8. Add `maxOutputTokens,` as the sixth argument to `this.orchestratorService.requestSolveStep(…)`.
9. In the `if (outcome.ok)` branch, right after `const data = outcome.data;`, add:
   ```ts
        if (data.finishReason === "length") {
          this.logger.warn(
            `run ${run.id}: ${model} hit its maxOutputTokens (${maxOutputTokens}) — consider raising` +
              " SupportedModel.maxOutputTokens if this recurs",
          );
        }
   ```
10. Replace `messages.push({ role: "assistant", content: assistantContent });` with:
    ```ts
        messages.push({ role: "assistant", content: assistantContent });
        // The request was every message before this reply; with its real
        // promptTokens in hand, later bounds count only what's added after.
        if (data.usage?.promptTokens != null) {
          knownPrefix = knownPrefixAfterReply(
            messages.length - 1,
            data.usage.promptTokens,
            assistantContent,
          );
        }
    ```
11. Replace `await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts);` with:
    ```ts
      const reportedTotal = outcome.ok
        ? outcome.data.usage?.totalTokens
        : outcome.error.usage?.totalTokens;
      const settlement: ReservationSettlement | undefined =
        reservationId === null ? undefined : { reservationId, recorded: reportedTotal != null };

      // Flush every iteration.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts, settlement);
    ```

- [ ] **Step 6: Run the tests and build**

Run: `cd backend && npm test -- llm-strategy-runner llm-job-handler orchestrator.service && npm run build`
Expected: tests pass and the build is clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/llm-job-handler.ts backend/src/modules/strategy/llm-job-handler.spec.ts backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat(backend): reserve each budgeted call's worst case and pause runs that don't fit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `StrategyDispatch` — tag new runs and resume paused ones

**Files:**
- Modify: `backend/src/modules/strategy/strategy-dispatch.service.ts` (`triggerStrategyRuns` line 132, `triggerNextLlmTrial` line 522)
- Test: `backend/src/modules/strategy/strategy-dispatch.service.spec.ts`

**Interfaces:**
- Produces:
  - `triggerStrategyRuns(puzzleId: number, strategyName: string, date: string, model?: string, budgetTier?: string)`. When `budgetTier` is set, the job data includes `budgetTier`; otherwise the data is unchanged.
  - `resumeBudgetParkedRuns(strategyName: string, budgetTier: string, models: readonly string[], limit: number): Promise<string[]>` returns the model name of each resumed run, oldest `startedAt` first.

- [ ] **Step 1: Write the failing tests**

Add these to `strategy-dispatch.service.spec.ts`. Reuse the file's existing `makeRun`, `mockStrategyRunRepo`, `mockManager` and `mockOpenAIQueue`. The `beforeEach` defaults already resolve `getJobs`, `assertSupported` and `mockManager.query`.

```ts
  describe("triggerStrategyRuns budgetTier", () => {
    it("puts budgetTier into the job data when given", async () => {
      mockManager.find.mockResolvedValueOnce([]);

      await service.triggerStrategyRuns(100, "llm-openai", "2024-01-01", "gpt-5", "flagship");

      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        expect.objectContaining({ model: "gpt-5", budgetTier: "flagship" }),
        expect.anything(),
      );
    });
  });

  describe("resumeBudgetParkedRuns", () => {
    it("re-queues paused budget runs oldest-first, then flips them to running", async () => {
      const parked = makeRun({
        id: 9,
        puzzleId: 100,
        strategyName: "llm-openai",
        trialNumber: 2,
        modelName: "gpt-5",
        status: StrategyRunStatus.RATE_LIMITED_DAILY,
        finishedAt: new Date("2026-10-07T23:59:00Z"),
        puzzle: { date: "2024-01-01" } as Puzzle,
      });
      mockStrategyRunRepo.find.mockResolvedValueOnce([parked]);

      const resumed = await service.resumeBudgetParkedRuns("llm-openai", "flagship", ["gpt-5", "o3"], 3);

      expect(resumed).toEqual(["gpt-5"]);
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            strategyName: "llm-openai",
            budgetTier: "flagship",
            status: StrategyRunStatus.RATE_LIMITED_DAILY,
          }),
          order: { startedAt: "ASC" },
          take: 3,
        }),
      );
      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        { puzzleId: 100, strategyName: "llm-openai", date: "2024-01-01", trialNumber: 2, model: "gpt-5" },
        expect.objectContaining({ jobId: expect.stringContaining("run-100-llm-openai-gpt-5-2-budget-resume-") }),
      );
      expect(mockOpenAIQueue.add.mock.invocationCallOrder[0]).toBeLessThan(
        mockStrategyRunRepo.save.mock.invocationCallOrder[0],
      );
      expect(mockStrategyRunRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: StrategyRunStatus.RUNNING, finishedAt: null }),
      );
    });

    it("does nothing for a zero limit or no models", async () => {
      await expect(service.resumeBudgetParkedRuns("llm-openai", "flagship", ["gpt-5"], 0)).resolves.toEqual([]);
      await expect(service.resumeBudgetParkedRuns("llm-openai", "flagship", [], 3)).resolves.toEqual([]);
      expect(mockStrategyRunRepo.find).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && npm test -- strategy-dispatch.service`
Expected: FAIL. `budgetTier` is missing from the job data and `resumeBudgetParkedRuns` is not a function.

- [ ] **Step 3: Implement**

In `strategy-dispatch.service.ts`, add `In` to the `typeorm` import.

`triggerStrategyRuns`: add a fifth parameter `budgetTier?: string` and pass it on: `await this.triggerNextLlmTrial(puzzleId, strategyName, date, model as string, budgetTier);`.

`triggerNextLlmTrial`: add a fifth parameter `budgetTier?: string`. Change the job data to:

```ts
        {
          puzzleId,
          strategyName,
          date,
          trialNumber: nextTrialNumber,
          model,
          // Only free-tier dispatch tags its runs — see StrategyRun.budgetTier.
          ...(budgetTier ? { budgetTier } : {}),
        },
```

Add a new public method after `retryRun`:

```ts
  /**
   * Re-queues up to `limit` free-tier runs paused (RATE_LIMITED_DAILY) for
   * lack of budget — oldest first, restricted to `models` (the ones the
   * dispatch tick judged able to fit right now). Same enqueue-then-flip order
   * as RpdResumeService: if the add throws, the run stays paused for the
   * next tick instead of stranded in RUNNING with no job. The runner's own
   * RATE_LIMITED_DAILY normalization and guess-replay resume it mid-puzzle;
   * its budgetTier comes from the row, not the job.
   */
  async resumeBudgetParkedRuns(
    strategyName: string,
    budgetTier: string,
    models: readonly string[],
    limit: number,
  ): Promise<string[]> {
    if (limit <= 0 || models.length === 0) return [];

    const parked = await this.strategyRunRepo.find({
      where: {
        strategyName,
        budgetTier,
        status: StrategyRunStatus.RATE_LIMITED_DAILY,
        modelName: In([...models]),
      },
      relations: { puzzle: true },
      order: { startedAt: "ASC" },
      take: limit,
    });

    const resumed: string[] = [];
    for (const run of parked) {
      await this.queueFor(strategyName).add(
        "run-strategy",
        {
          puzzleId: run.puzzleId,
          strategyName,
          date: run.puzzle.date,
          trialNumber: run.trialNumber,
          model: run.modelName,
        },
        {
          jobId: `${runStrategyJobId(run.puzzleId, strategyName, run.modelName, run.trialNumber)}-budget-resume-${Date.now()}`,
        },
      );
      run.status = StrategyRunStatus.RUNNING;
      run.finishedAt = null;
      await this.strategyRunRepo.save(run);
      resumed.push(run.modelName as string);
    }
    return resumed;
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd backend && npm test -- strategy-dispatch.service`
Expected: PASS, including every existing `triggerStrategyRuns` and `retryRun` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy-dispatch.service.ts backend/src/modules/strategy/strategy-dispatch.service.spec.ts
git commit -m "feat(backend): tag free-tier runs with budgetTier and resume budget-paused runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Dispatch tick rewrite and removal of the token estimate

**Files:**
- Modify: `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts`
- Modify: `backend/src/strategies.ts` (remove lines 249-254 `DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE` and its comment, and lines 299-308 `freeTierDispatchTokenEstimate`)
- Test: `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.spec.ts`

**Interfaces:**
- Consumes:
  - `FreeTierBudgetService.committedTokens` and `.modelCaps` (Task 4)
  - `StrategyDispatch.resumeBudgetParkedRuns` and `triggerStrategyRuns(…, budgetTier)` (Task 6)
- Produces: the new `runTick(tier)` behavior. No new public API.

- [ ] **Step 1: Update the test wiring**

In `free-tier-dispatch.service.spec.ts`:
- Import `FreeTierBudgetService` from `../strategy/free-tier-budget.service`.
- Declare `let mockFreeTierBudget: { committedTokens: jest.Mock; modelCaps: jest.Mock };`. In `beforeEach`, add:
  ```ts
    mockFreeTierBudget = {
      committedTokens: jest.fn().mockResolvedValue(0),
      // Default: every model capped at 1,000 → a 3,000-token soft worst case,
      // so budget is never the limiting factor unless a test says so.
      modelCaps: jest.fn().mockImplementation(async (models: string[]) =>
        new Map(models.map((model) => [model, 1000])),
      ),
    };
  ```
- Add `resumeBudgetParkedRuns: jest.fn().mockResolvedValue([])` to `mockStrategyDispatch` (and to its type).
- Add `{ provide: FreeTierBudgetService, useValue: mockFreeTierBudget },` to the providers.
- In `afterEach`, delete the `FREE_TIER_DISPATCH_TOKEN_ESTIMATE` line.
- Delete every `process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = …` line in the file.
- The test "should hold off on new dispatches, but keep ticking, when the token budget is nearly spoken for": replace its comment with `// 900 in flight × (1,000 cap + 2,000 allowance) = 2.7M soft-reserved > 2.25M room.` Its assertions stay as they are.
- The test "should skip a model with no unrun puzzles left and try the next one": the expected `triggerStrategyRuns` call gains a fifth argument, `"mini"`.

- [ ] **Step 2: Write the failing tests**

Add these inside `describe("runTick", …)`:

```ts
    it("stops with 'budget reached' when no model's worst case fits and nothing is in flight", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      // threshold 2,250,000; room 2,500 < 1,000 cap + 2,000 allowance.
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_247_500);

      await service.runTick("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("keeps ticking (doesn't stop) when nothing fits but trials are still in flight", async () => {
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 1);
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_247_500);

      await service.runTick("mini");

      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockStrategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith("tick", { tier: "mini" }, expect.anything());
    });

    it("only dispatches models whose worst case fits the remaining room", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_240_000); // room 10,000
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "gpt-4.1-nano" ? 4000 : 36000])),
      );

      await service.runTick("mini");

      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledWith(
        1, "llm-openai", "2024-01-01", "gpt-4.1-nano", "mini",
      );
    });

    it("never dispatches a model with no output cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "3";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "o3-mini" ? 29000 : null])),
      );

      await service.runTick("mini");

      const models = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(new Set(models)).toEqual(new Set(["o3-mini"]));
    });

    it("sets aside a worst-case call for each in-flight trial before sizing new ones", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "5";
      const inFlight = zeroCounts();
      inFlight.set("o4-mini", 1); // 4,000 cap + 2,000 allowance = 6,000 set aside
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.countInFlightByModel.mockResolvedValueOnce(inFlight);
      mockFreeTierBudget.committedTokens.mockResolvedValueOnce(2_240_000); // room 10,000 → 4,000 left
      mockFreeTierBudget.modelCaps.mockResolvedValueOnce(
        new Map(MINI_MODELS.map((m) => [m, m === "gpt-5.4-nano" ? 1000 : 4000])),
      );

      await service.runTick("mini");

      // Only one 3,000-token model fits in the 4,000 left; the 6,000 ones never do.
      const models = mockStrategyDispatch.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(models).toEqual(["gpt-5.4-nano"]);
    });

    it("resumes budget-paused runs before dispatching new trials, sharing the batch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyDispatch.resumeBudgetParkedRuns.mockResolvedValueOnce(["o3-mini"]);

      await service.runTick("mini");

      expect(mockStrategyDispatch.resumeBudgetParkedRuns).toHaveBeenCalledWith(
        "llm-openai", "mini", expect.arrayContaining(MINI_MODELS), 2,
      );
      expect(mockStrategyDispatch.resumeBudgetParkedRuns.mock.invocationCallOrder[0]).toBeLessThan(
        mockStrategyDispatch.countTodayDispatchByModel.mock.invocationCallOrder[0],
      );
      expect(mockStrategyDispatch.triggerStrategyRuns).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd backend && npm test -- free-tier-dispatch.service`
Expected: FAIL. `FreeTierBudgetService` isn't injected, and the new tests fail.

- [ ] **Step 4: Implement the tick**

In `free-tier-dispatch.service.ts`:
- Remove `freeTierDispatchTokenEstimate` from the `../../strategies` import.
- Import `FreeTierBudgetService` from `../strategy/free-tier-budget.service`.
- Add a constructor parameter: `@Inject(FreeTierBudgetService) private readonly freeTierBudget: FreeTierBudgetService,`
- Add this constant below `TICK_JOB_NAME`:

```ts
// A generous allowance for a run's input on its first call (the initial
// 16-word prompt is ~1.5 KB) — used only by the tick's *soft* "could this
// model plausibly fit" sizing. The hard guarantee is FreeTierBudgetService.reserve,
// which bounds every real call's input exactly before making it.
const SOFT_INPUT_ALLOWANCE_TOKENS = 2_000;
```

Replace `runTick`'s doc comment and body from `const tokenEstimate = …` through the end of the method with the following. The state check, the usage lookup, the threshold stop and the in-flight-cap early return above it stay as they are, except that the in-flight block no longer refers to the estimate.

```ts
    const caps = await this.freeTierBudget.modelCaps(usage.models);
    // A model's soft worst case for one call; a model with no cap is never a
    // candidate (and a manually-dispatched in-flight run on one only counts
    // its input allowance).
    const worstCase = (model: string) => (caps.get(model) ?? 0) + SOFT_INPUT_ALLOWANCE_TOKENS;
    const fits = (model: string, budget: number) =>
      caps.get(model) != null && worstCase(model) <= budget;

    const room = thresholdTokens - (await this.freeTierBudget.committedTokens(tier));

    if (inFlightTotal === 0 && !usage.models.some((model) => fits(model, room))) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' budget reached — ${room} token(s) left under the ` +
          `${state.thresholdPercent}% threshold, too few for any model's next call — stopping`,
      );
      return;
    }

    // Soft: leave room for each in-flight trial's next call too, so new
    // trials don't start only to pause mid-puzzle. reserve() is the hard limit.
    let budgetForNew = room;
    for (const [model, count] of inFlight) budgetForNew -= count * worstCase(model);

    const slots = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);

    // Paused runs first — they've already spent tokens mid-puzzle.
    const resumed = await this.strategyDispatch.resumeBudgetParkedRuns(
      LLM_OPENAI,
      tier,
      usage.models.filter((model) => fits(model, budgetForNew)),
      slots,
    );
    for (const model of resumed) budgetForNew -= worstCase(model);

    const allocation = await this.strategyDispatch.countTodayDispatchByModel(LLM_OPENAI, usage.models);
    // `exhausted`: no unrun puzzles / dispatch failed. `skipped`: doesn't fit
    // this tick. Only `exhausted` covering every model ends the cycle.
    const exhausted = new Set<string>();
    const skipped = new Set<string>();
    let dispatched = 0;

    while (dispatched < slots - resumed.length) {
      for (const model of usage.models) {
        if (!fits(model, budgetForNew)) skipped.add(model);
      }
      const excluded = new Set([...exhausted, ...skipped]);
      if (excluded.size >= usage.models.length) break;

      const model = FreeTierDispatchService.leastAllocatedModel(allocation, excluded);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyDispatch.findUnrunPuzzleDatesForModel(LLM_OPENAI, model, 1);
      } catch (err) {
        this.logger.warn(
          `free-tier dispatch tick for '${tier}': failed to look up a puzzle for '${model}': ` +
            `${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyDispatch.triggerStrategyRuns(
          target.puzzleId,
          LLM_OPENAI,
          target.date,
          model,
          tier,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        budgetForNew -= worstCase(model);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `free-tier dispatch tick for '${tier}': failed to queue a trial for '${model}': ` +
            `${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(
      `free-tier dispatch tick for '${tier}': resumed ${resumed.length}, queued ${dispatched} new trial(s)`,
    );

    if (exhausted.size === usage.models.length) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' ran out of unrun puzzles for every model — stopping`,
      );
      return;
    }

    await this.scheduleNextTick(tier);
  }
```

Also:
- Change `leastAllocatedModel`'s second parameter name to `excluded` and update its doc comment to "excluding any model in `excluded` (no unrun puzzles, or doesn't fit this tick)".
- Rewrite `runTick`'s doc comment to describe:
  - the stops (inactive, recorded usage at threshold, budget reached, no unrun puzzles);
  - the in-flight cap;
  - resume-first;
  - fit-based model selection.

  Remove all mention of the token estimate.
- Rewrite the in-flight-cap block's comment, which mentions "the token-budget estimate below", to: "A deep backlog keeps reservations and real usage far apart — wait for it to drain."

In `backend/src/strategies.ts`:
- Delete `DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE` with its comment block, and `freeTierDispatchTokenEstimate` with its doc comment.
- In the `DEFAULT_FREE_TIER_DISPATCH_MAX_IN_FLIGHT` comment, replace "its estimated token cost is already reserved against the budget on every tick in the meantime" with "the tick sets aside a worst-case call per in-flight trial in the meantime".

- [ ] **Step 5: Run the tests and build**

Run: `cd backend && npm test -- free-tier-dispatch && npm run build`
Then: `git grep -n "TOKEN_ESTIMATE\|freeTierDispatchTokenEstimate" -- backend/src`
Expected: tests pass, the build is clean, and the grep finds no matches.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.spec.ts backend/src/strategies.ts
git commit -m "feat(free-tier-dispatch): size ticks by per-model worst case, resume paused runs, stop on budget reached

Replaces the flat FREE_TIER_DISPATCH_TOKEN_ESTIMATE with reservation-aware
sizing; the hard guarantee lives in FreeTierBudgetService.reserve.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: E2E — seed check and concurrent-reserve race

**Files:**
- Modify: `backend/test/app.e2e-spec.ts`

**Interfaces:**
- Consumes: `FreeTierBudgetService` (Task 4), the migration (Task 2), and the existing `app`, `dataSource` and `TEST_DATE` in the e2e file.

- [ ] **Step 1: Write the tests**

Add `import { FreeTierBudgetService } from "../src/modules/strategy/free-tier-budget.service";`. Then add this top-level `describe` inside `describe("App (e2e)", …)`, after the `"free-tier dispatch"` block:

```ts
  describe("free-tier budget reservation", () => {
    it("seeds maxOutputTokens for the llm-openai models present", async () => {
      const expected: Record<string, number> = {
        "o4-mini": 49000, "gpt-5": 47000, o3: 46000, "gpt-5-nano": 36000, o1: 33000,
        "o3-mini": 29000, "gpt-5-mini": 27000, "gpt-4.1-mini": 14000, "gpt-4.1-nano": 4000,
        "gpt-4.1": 2000, "gpt-4o": 1000, "gpt-4o-mini": 1000, "gpt-5.1": 1000, "gpt-5.2": 1000,
        "gpt-5.4": 1000, "gpt-5.4-mini": 1000, "gpt-5.4-nano": 1000,
      };
      const rows: { modelName: string; maxOutputTokens: number | null }[] = await dataSource.query(
        `SELECT "modelName", "maxOutputTokens" FROM "SupportedModel" WHERE "strategyName" = 'llm-openai'`,
      );
      const seeded = rows.filter((row) => row.modelName in expected);

      expect(seeded.length).toBeGreaterThan(0);
      for (const row of seeded) expect(row.maxOutputTokens).toBe(expected[row.modelName]);
    });

    it("lets exactly one of two concurrent reservations take the last of the room", async () => {
      const budget = app.get(FreeTierBudgetService);
      await dataSource.query(
        `INSERT INTO "FreeTierDispatchState" ("tier", "active", "thresholdPercent", "startedAt")
         VALUES ('flagship', true, 100, now())
         ON CONFLICT ("tier") DO UPDATE SET "active" = true, "thresholdPercent" = 100`,
      );
      const [{ id: puzzleId }] = await dataSource.query(`SELECT "id" FROM "Puzzle" WHERE "date" = $1`, [TEST_DATE]);
      const [{ id: runId }] = await dataSource.query(
        `INSERT INTO "StrategyRun" ("puzzleId", "strategyName", "trialNumber", "status", "availableWords", "currentCombination", "modelName")
         VALUES ($1, 'llm-openai', 999, 'running', '[]', '[0,1,2,3]', 'gpt-5') RETURNING "id"`,
        [puzzleId],
      );

      try {
        const room = 250_000 - (await budget.committedTokens("flagship"));
        expect(room).toBeGreaterThan(2);
        const each = Math.floor(room / 2) + 1; // two of these can never both fit

        const results = await Promise.all([
          budget.reserve("flagship", runId, each),
          budget.reserve("flagship", runId, each),
        ]);

        expect(results.filter((id) => id !== null)).toHaveLength(1);
      } finally {
        // Cascades to this run's FreeTierReservation rows.
        await dataSource.query(`DELETE FROM "StrategyRun" WHERE "id" = $1`, [runId]);
        await dataSource.query(`UPDATE "FreeTierDispatchState" SET "active" = false WHERE "tier" = 'flagship'`);
      }
    });
  });
```

- [ ] **Step 2: Run the E2E suite**

```bash
docker compose -p connections-dev up -d db redis
docker exec postgres_db psql -U postgres -c "CREATE DATABASE connections_test" || true
cd backend && npm run test:e2e
```
Expected: the whole suite passes, including both new tests. The migration runs automatically against `connections_test`.

- [ ] **Step 3: Check that the race test actually detects missing locking (then revert)**

Temporarily delete ` FOR UPDATE` from the `SELECT` in `FreeTierBudgetService.reserve`, run `npm run test:e2e -- -t "concurrent reservations"` 3 times, and note whether it fails at least once. Restore ` FOR UPDATE` and re-run once to confirm it passes. If it never fails without the lock, say so in the PR description. Don't add sleeps to force it.

- [ ] **Step 4: Commit**

```bash
git add backend/test/app.e2e-spec.ts
git commit -m "test(e2e): cover maxOutputTokens seeding and the concurrent-reserve race

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run every suite and build**

```bash
cd backend && npm test && npm run lint && npm run build
cd ../orchestrator && npm run test:run && npm run typecheck
cd ../frontend && npm run test:run
```
Expected: everything passes. The frontend isn't touched, so it's run only as a regression check.

- [ ] **Step 2: Fix lint/format if needed**

Run: `cd backend && npm run format`. Commit any formatting-only changes with:

```bash
git commit -am "style: format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
