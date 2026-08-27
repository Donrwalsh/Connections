# LLM Category-Accuracy Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judge whether a correct LLM guess also identified the right connection, store the verdict with full judge-call diagnostics, and surface category accuracy across the leaderboard.

**Architecture:** A new `CategoryEvaluation` table holds one row per judged proposal. A new orchestrator `POST /judge-category` endpoint runs an LLM-as-judge (3-way verdict). Evaluation runs as one BullMQ job per proposal on the judge provider's existing LLM queue, kicked off by a password-protected backend endpoint that enqueues the latest un-evaluated successful proposals. The leaderboard aggregates verdict counts per model; four frontend surfaces display them.

**Tech Stack:** NestJS + TypeORM + Postgres (backend), BullMQ + Redis (queues), Hono + Vercel AI SDK (orchestrator), React + Vite + TanStack Query (frontend), Jest (backend tests), Vitest (orchestrator tests), Vitest + Testing Library (frontend tests).

**Spec:** `docs/superpowers/specs/2026-08-27-llm-category-accuracy-evaluation-design.md`

## Global Constraints

- **Explicit DI:** every class-to-class constructor injection in the backend uses an explicit `@Inject(Token)` — bare typed parameters silently resolve to `undefined` under the worker's tsx/esbuild runtime. Repos use `@InjectRepository(Entity)`.
- **No `synchronize`:** schema changes ship as a TypeORM migration in `backend/src/migrations/`, raw `queryRunner.query()` calls, explicit `up` and `down`. New entities are registered in **both** `backend/src/app.module.ts` and `backend/src/data-source.ts` entity arrays.
- **Judge defaults:** `JUDGE_MODEL=gpt-4.1-nano`, `JUDGE_PROVIDER=openai`. Neither is required to boot.
- **Evaluator version constant:** `EVALUATOR_VERSION = 1` (module-level in `category-evaluator.service.ts`), written on every row.
- **Verdict values:** `"correct" | "partial" | "lucky"`. A `callError` row has `verdict = null`.
- **Diagnostics parity:** the `CategoryEvaluation` diagnostic columns mirror `SolvePrompt`'s raw call-detail block (`solve-prompt.entity.ts:106-148`).
- **TDD:** write the failing test, watch it fail, minimal implementation, watch it pass, commit. Backend test command: `cd backend && npm test -- <path>`. Orchestrator: `cd orchestrator && npm test -- <path>`. Frontend: `cd frontend && npm test -- <path>`.
- **Commit style:** Conventional Commits (`feat:`, `test:`, `chore:`, `docs:`). Commit at each step-5.

---

## File Structure

**Backend — created**
- `backend/src/modules/strategy/entities/category-evaluation.entity.ts` — the entity + its two enums.
- `backend/src/migrations/1776000000000-add-category-evaluation.ts` — table + enum types.
- `backend/src/modules/strategy/category-evaluator.service.ts` — `evaluateProposal`, `enqueuePending`, `EVALUATOR_VERSION`.
- `backend/src/modules/strategy/category-evaluator.service.spec.ts` — its tests.
- `backend/src/scripts/evaluate-categories.ts` — CLI enqueue entrypoint.

**Backend — modified**
- `backend/src/data-source.ts` / `backend/src/app.module.ts` — register the entity.
- `backend/src/modules/strategy/strategy.module.ts` — `forFeature` + provider + export.
- `backend/src/modules/queue/strategy.queue.ts` — `llmGoogleQueue`, `queueForStrategy` google branch, `queueForJudgeProvider`, `categoryEvalJobId`.
- `backend/src/modules/queue/queue.module.ts` — `LLM_GOOGLE_QUEUE` token/provider/export.
- `backend/src/app.setup.ts` — Bull-Board adapter for the google queue.
- `backend/src/config/env.ts` — `JUDGE_MODEL`, `JUDGE_PROVIDER` in `AppEnv`.
- `backend/src/modules/strategy/orchestrator.service.ts` — `judgeCategory(...)`.
- `backend/src/worker.ts` — `job.name === "evaluate-category"` branch; resolve `CategoryEvaluatorService`.
- `backend/src/modules/dispatch/dispatch.controller.ts` — `POST /dispatch/evaluate-categories`.
- `backend/src/modules/strategy/strategy.service.ts` — leaderboard aggregation query + accumulator + row fields.
- `backend/src/modules/strategy/strategy.service.spec.ts` — `categoryEvaluationRepo` mock + `getLeaderboard` tests.
- `backend/src/modules/strategy/dto/strategy.dto.ts` — `LeaderboardRowDto` fields, `CategoryEvaluationDto`, `LlmProposalDto.categoryEvaluation`.
- `backend/src/modules/strategy/strategy.service.ts` (`buildSolvePromptDtos`) — attach evaluations to proposal DTOs.
- `backend/package.json` — `eval:categories` script.
- `.env.sample` — the two judge vars.

**Orchestrator — created**
- `orchestrator/src/judge-category.ts` — `judgeCategory(...)`, prompt builder, parse.
- `orchestrator/src/judge-category.test.ts` — its tests.

**Orchestrator — modified**
- `orchestrator/src/types.ts` — `JudgeCategoryRequestSchema` / `JudgeCategoryResponseSchema`.
- `orchestrator/src/app.ts` — `POST /judge-category` route.
- `orchestrator/src/provider.ts` — `DEFAULT_JUDGE_MODEL` / `DEFAULT_JUDGE_PROVIDER` consts.

**Frontend — modified**
- `frontend/src/data/benchmark/types.ts` — `LeaderboardRow` fields, `CategoryEvaluationRecord`, `LlmProposalRecord.categoryEvaluation`.
- `frontend/src/data/benchmark/metrics.ts` — `categoryAccuracy` metric + `MetricSource`.
- `frontend/src/data/benchmark/metrics.test.ts` — metric sort/format tests.
- `frontend/src/components/benchmark/StrategyTable.tsx` — "Category IQ" column.
- `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx` — breakdown block.
- `frontend/src/components/benchmark/GuessChainVisualizer.tsx` — verdict pill + "Category judge" details.
- The `*.test.tsx` files for the three components above + `frontend/src/data/benchmark/mockData.ts`.

---

## Task 1: `CategoryEvaluation` entity and migration

**Files:**
- Create: `backend/src/modules/strategy/entities/category-evaluation.entity.ts`
- Create: `backend/src/migrations/1776000000000-add-category-evaluation.ts`
- Modify: `backend/src/data-source.ts` (entities array)
- Modify: `backend/src/app.module.ts` (entities array, ~line 47-59)
- Modify: `backend/src/modules/strategy/strategy.module.ts` (`TypeOrmModule.forFeature`, line 20)
- Test: `backend/src/modules/strategy/entities/category-evaluation.entity.spec.ts`

**Interfaces:**
- Produces: `CategoryEvaluation` entity class; `CategoryEvalVerdict` (`"correct" | "partial" | "lucky"`) and `CategoryEvalStatus` (`"judged" | "callError"`) string-enum objects exported from the entity file. Column names used by later tasks: `llmProposalId`, `strategyRunId`, `answerGroupId`, `verdict`, `rationale`, `proposedCategory`, `actualCategory`, `status`, `evaluatorVersion`, `judgeModel`, `judgeProvider`, `requestBody`, `responseId`, `responseHeaders`, `responseBody`, `rawResponseText`, `statusCode`, `errorName`, `errorMessage`, `isRetryable`, `promptTokens`, `completionTokens`, `totalTokens`, `latencyMs`, `temperature`, `evaluatedAt`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/entities/category-evaluation.entity.spec.ts`:

```typescript
import { DataSource } from "typeorm";
import { CategoryEvaluation } from "./category-evaluation.entity";

describe("CategoryEvaluation entity metadata", () => {
  it("maps to the CategoryEvaluation table with the expected columns", () => {
    const ds = new DataSource({
      type: "postgres",
      entities: [CategoryEvaluation],
    });
    const meta = ds.getMetadata(CategoryEvaluation);
    expect(meta.tableName).toBe("CategoryEvaluation");
    const cols = meta.columns.map((c) => c.databaseName);
    for (const expected of [
      "id",
      "llmProposalId",
      "strategyRunId",
      "answerGroupId",
      "verdict",
      "rationale",
      "proposedCategory",
      "actualCategory",
      "status",
      "evaluatorVersion",
      "judgeModel",
      "judgeProvider",
      "requestBody",
      "responseHeaders",
      "responseBody",
      "rawResponseText",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "latencyMs",
      "evaluatedAt",
    ]) {
      expect(cols).toContain(expected);
    }
    const unique = meta.indices.find((i) => i.isUnique);
    expect(unique?.columns.map((c) => c.databaseName)).toEqual(["llmProposalId"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- category-evaluation.entity.spec`
Expected: FAIL — `Cannot find module './category-evaluation.entity'`.

- [ ] **Step 3: Write the entity**

Create `backend/src/modules/strategy/entities/category-evaluation.entity.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  JoinColumn,
} from "typeorm";
import { StrategyRun } from "./strategy-run.entity";
import { LlmProposal } from "./llm-proposal.entity";
import { AnswerGroup } from "../../game/entities/answer-group.entity";

// String enums, not DB enums for the value set beyond the two Postgres
// enum types below — kept as `as const` objects for the same reason
// SolvePromptIssueTag is (see solve-prompt.entity.ts): cheap to extend.
export enum CategoryEvalVerdict {
  CORRECT = "correct",
  PARTIAL = "partial",
  LUCKY = "lucky",
}

export enum CategoryEvalStatus {
  // The judge call produced a usable verdict.
  JUDGED = "judged",
  // The judge call itself failed — verdict stays null; the error/request/
  // response columns carry whatever detail was captured. Mirrors
  // SolvePromptStatus.CALL_ERROR.
  CALL_ERROR = "callError",
}

/**
 * One LLM-judge verdict on whether a *successful* used LlmProposal named the
 * real connection (see AnswerGroup.group_name) or just landed the right four
 * words. Written entirely by the batch/queue evaluation path — see
 * category-evaluator.service.ts and
 * docs/superpowers/specs/2026-08-27-llm-category-accuracy-evaluation-design.md.
 *
 * The diagnostic columns below (judgeModel .. temperature) mirror
 * SolvePrompt's raw call-detail block so a specific verdict can be audited.
 */
@Entity("CategoryEvaluation")
@Index("IDX_CategoryEvaluation_strategyRunId", ["strategyRunId"])
@Index("UQ_CategoryEvaluation_llmProposalId", ["llmProposalId"], { unique: true })
export class CategoryEvaluation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  llmProposalId: number;

  @ManyToOne(() => LlmProposal, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "llmProposalId" })
  llmProposal: LlmProposal;

  // Denormalized so getLeaderboard can group verdict counts by run without
  // a three-table join — the same reason LlmProposal carries strategyRunId.
  @Column({ type: "int" })
  strategyRunId: number;

  @ManyToOne(() => StrategyRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "strategyRunId" })
  strategyRun: StrategyRun;

  @Column({ type: "int" })
  answerGroupId: number;

  @ManyToOne(() => AnswerGroup, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "answerGroupId" })
  answerGroup: AnswerGroup;

  @Column({
    type: "enum",
    enum: CategoryEvalVerdict,
    enumName: "category_eval_verdict_enum",
    nullable: true,
  })
  verdict: CategoryEvalVerdict | null;

  @Column({ type: "text", nullable: true })
  rationale: string | null;

  @Column({ type: "text" })
  proposedCategory: string;

  @Column({ type: "text" })
  actualCategory: string;

  @Column({
    type: "enum",
    enum: CategoryEvalStatus,
    enumName: "category_eval_status_enum",
    default: CategoryEvalStatus.JUDGED,
  })
  status: CategoryEvalStatus;

  @Column({ type: "int" })
  evaluatorVersion: number;

  // ── Judge-call diagnostics (mirrors SolvePrompt) ────────────────────

  @Column({ type: "text" })
  judgeModel: string;

  @Column({ type: "text" })
  judgeProvider: string;

  @Column({ type: "jsonb", nullable: true })
  requestBody: unknown | null;

  @Column({ type: "text", nullable: true })
  responseId: string | null;

  @Column({ type: "jsonb", nullable: true })
  responseHeaders: Record<string, string> | null;

  @Column({ type: "jsonb", nullable: true })
  responseBody: unknown | null;

  @Column({ type: "text", nullable: true })
  rawResponseText: string | null;

  @Column({ type: "int", nullable: true })
  statusCode: number | null;

  @Column({ type: "text", nullable: true })
  errorName: string | null;

  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  @Column({ type: "boolean", nullable: true })
  isRetryable: boolean | null;

  @Column({ type: "int", nullable: true })
  promptTokens: number | null;

  @Column({ type: "int", nullable: true })
  completionTokens: number | null;

  @Column({ type: "int", nullable: true })
  totalTokens: number | null;

  @Column({ type: "int", nullable: true })
  latencyMs: number | null;

  @Column({ type: "double precision", nullable: true })
  temperature: number | null;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  evaluatedAt: Date;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- category-evaluation.entity.spec`
Expected: PASS.

- [ ] **Step 5: Write the migration**

Create `backend/src/migrations/1776000000000-add-category-evaluation.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the CategoryEvaluation table — one LLM-judge verdict per successful
 * used LlmProposal on whether its proposed category named the real
 * connection. See
 * docs/superpowers/specs/2026-08-27-llm-category-accuracy-evaluation-design.md.
 * No data backfill: rows are produced by the evaluation jobs.
 */
export class AddCategoryEvaluation1776000000000 implements MigrationInterface {
  name = "AddCategoryEvaluation1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "category_eval_verdict_enum" AS ENUM ('correct', 'partial', 'lucky')`,
    );
    await queryRunner.query(
      `CREATE TYPE "category_eval_status_enum" AS ENUM ('judged', 'callError')`,
    );
    await queryRunner.query(`
      CREATE TABLE "CategoryEvaluation" (
        "id" SERIAL NOT NULL,
        "llmProposalId" integer NOT NULL,
        "strategyRunId" integer NOT NULL,
        "answerGroupId" integer NOT NULL,
        "verdict" "category_eval_verdict_enum",
        "rationale" text,
        "proposedCategory" text NOT NULL,
        "actualCategory" text NOT NULL,
        "status" "category_eval_status_enum" NOT NULL DEFAULT 'judged',
        "evaluatorVersion" integer NOT NULL,
        "judgeModel" text NOT NULL,
        "judgeProvider" text NOT NULL,
        "requestBody" jsonb,
        "responseId" text,
        "responseHeaders" jsonb,
        "responseBody" jsonb,
        "rawResponseText" text,
        "statusCode" integer,
        "errorName" text,
        "errorMessage" text,
        "isRetryable" boolean,
        "promptTokens" integer,
        "completionTokens" integer,
        "totalTokens" integer,
        "latencyMs" integer,
        "temperature" double precision,
        "evaluatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_CategoryEvaluation_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_CategoryEvaluation_llmProposalId" UNIQUE ("llmProposalId"),
        CONSTRAINT "FK_CategoryEvaluation_llmProposalId" FOREIGN KEY ("llmProposalId")
          REFERENCES "LlmProposal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_CategoryEvaluation_strategyRunId" FOREIGN KEY ("strategyRunId")
          REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_CategoryEvaluation_answerGroupId" FOREIGN KEY ("answerGroupId")
          REFERENCES "AnswerGroup"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_CategoryEvaluation_strategyRunId" ON "CategoryEvaluation" ("strategyRunId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "CategoryEvaluation"`);
    await queryRunner.query(`DROP TYPE "category_eval_status_enum"`);
    await queryRunner.query(`DROP TYPE "category_eval_verdict_enum"`);
  }
}
```

- [ ] **Step 6: Register the entity**

In `backend/src/data-source.ts`, import `CategoryEvaluation` and add it to the `entities: [...]` array after `SolvePrompt`.

In `backend/src/app.module.ts`, import `CategoryEvaluation` (next to the other strategy-entity imports around line 17-20) and add it to the `entities: [...]` array in the `TypeOrmModule.forRootAsync` config (after `SolvePrompt`, ~line 53).

In `backend/src/modules/strategy/strategy.module.ts`, import `CategoryEvaluation` and add it to `TypeOrmModule.forFeature([...])` on line 20.

- [ ] **Step 7: Run the migration against the local DB**

Run: `cd backend && npm run migration:run`
Expected: `AddCategoryEvaluation1776000000000` runs with no error. Verify with `npm run migration:show` (it appears with `[X]`). Then confirm revert works: `npm run migration:revert` then `npm run migration:run` again.

- [ ] **Step 8: Run the full backend entity/migration-adjacent suite**

Run: `cd backend && npm test -- entities`
Expected: PASS (all entity metadata specs, including the new one).

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/strategy/entities/category-evaluation.entity.ts \
  backend/src/modules/strategy/entities/category-evaluation.entity.spec.ts \
  backend/src/migrations/1776000000000-add-category-evaluation.ts \
  backend/src/data-source.ts backend/src/app.module.ts \
  backend/src/modules/strategy/strategy.module.ts
git commit -m "feat: add CategoryEvaluation entity and migration"
```

---

## Task 2: Orchestrator `POST /judge-category` endpoint

**Files:**
- Modify: `orchestrator/src/provider.ts` (add two consts near the other `DEFAULT_*_MODEL`)
- Modify: `orchestrator/src/types.ts` (add two schemas after `SolveAssistResponseSchema`)
- Create: `orchestrator/src/judge-category.ts`
- Modify: `orchestrator/src/app.ts` (add route after `/solve-assist`)
- Test: `orchestrator/src/judge-category.test.ts`

**Interfaces:**
- Consumes: `getModel`, `getModelName`, `defaultProvider`, `ModelProvider` from `provider.ts`; `SolveError`, `classifyModelCallError` from `solver.ts`.
- Produces:
  - `DEFAULT_JUDGE_MODEL = "gpt-4.1-nano"`, `DEFAULT_JUDGE_PROVIDER: ModelProvider = "openai"` in `provider.ts`.
  - `JudgeCategoryRequestSchema`, `JudgeCategoryResponse` (type) in `types.ts`.
  - `judgeCategory(proposedCategory: string, actualCategory: string, model?: string, provider?: ModelProvider, abortSignal?: AbortSignal): Promise<JudgeCategoryResult>` in `judge-category.ts`, where `JudgeCategoryResult` is `{ verdict: "correct"|"partial"|"lucky"; rationale: string; model: string; latencyMs: number; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }; requestBody?: unknown; responseId?: string; responseHeaders?: Record<string,string>; responseBody?: unknown; rawResponseText?: string }`.
  - `buildJudgePrompt(proposedCategory: string, actualCategory: string): string` (exported for the test).
  - `POST /judge-category` route.

- [ ] **Step 1: Write the failing test**

Create `orchestrator/src/judge-category.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildJudgePrompt, judgeCategory } from "./judge-category.js";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});
vi.mock("./provider.js", () => ({
  DEFAULT_JUDGE_MODEL: "gpt-4.1-nano",
  DEFAULT_JUDGE_PROVIDER: "openai",
  defaultProvider: () => "openai",
  getModel: () => ({ mock: "model" }),
  getModelName: () => "gpt-4.1-nano",
}));

describe("buildJudgePrompt", () => {
  it("includes both categories and the three verdict definitions, not the words", () => {
    const prompt = buildJudgePrompt("Fruits", "___ COBBLER");
    expect(prompt).toContain('"Fruits"');
    expect(prompt).toContain('"___ COBBLER"');
    expect(prompt).toContain("correct:");
    expect(prompt).toContain("partial:");
    expect(prompt).toContain("lucky:");
  });
});

describe("judgeCategory", () => {
  beforeEach(() => generateObjectMock.mockReset());

  it("returns the verdict, rationale, model, and captured call detail", async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: "partial", rationale: "Saw fruit, missed the wordplay." },
      usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
      request: { body: { foo: 1 } },
      response: { id: "resp_1", headers: { h: "v" }, body: { ok: true } },
    });

    const result = await judgeCategory("Fruits", "___ COBBLER", "gpt-4.1-nano", "openai");

    expect(result.verdict).toBe("partial");
    expect(result.rationale).toBe("Saw fruit, missed the wordplay.");
    expect(result.model).toBe("gpt-4.1-nano");
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 15, totalTokens: 135 });
    expect(result.requestBody).toEqual({ foo: 1 });
    expect(result.responseId).toBe("resp_1");
    expect(result.responseHeaders).toEqual({ h: "v" });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("classifies a model-call failure into a SolveError", async () => {
    generateObjectMock.mockRejectedValue(new Error("boom"));
    await expect(judgeCategory("A", "B", "gpt-4.1-nano", "openai")).rejects.toMatchObject({
      name: "SolveError",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd orchestrator && npm test -- judge-category`
Expected: FAIL — `Cannot find module './judge-category.js'`.

- [ ] **Step 3: Add the provider defaults**

In `orchestrator/src/provider.ts`, after `DEFAULT_GOOGLE_MODEL` (line 8):

```typescript
export const DEFAULT_JUDGE_MODEL = "gpt-4.1-nano";
export const DEFAULT_JUDGE_PROVIDER: ModelProvider = "openai";
```

- [ ] **Step 4: Add the schemas**

In `orchestrator/src/types.ts`, after `SolveAssistResponseSchema`:

```typescript
/**
 * Request body for POST /judge-category. Categories only — the four words
 * are deliberately not sent; the judge is comparing whether one label
 * names the same connection as another, and both already describe the same
 * items by construction. `model`/`provider` override JUDGE_MODEL/
 * JUDGE_PROVIDER, same override semantics as /solve-assist.
 */
export const JudgeCategoryRequestSchema = z.object({
  proposedCategory: z.string().min(1),
  actualCategory: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: z.enum(["openai", "ollama", "google"]).optional(),
});
export type JudgeCategoryRequest = z.infer<typeof JudgeCategoryRequestSchema>;

/**
 * Response body for POST /judge-category. The 3-way verdict plus a
 * one-sentence rationale, plus the same per-call telemetry / raw call
 * detail /solve-assist returns, which the backend persists onto its
 * CategoryEvaluation row.
 */
export const JudgeCategoryResponseSchema = z.object({
  verdict: z.enum(["correct", "partial", "lucky"]),
  rationale: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  requestBody: z.unknown().optional(),
  responseId: z.string().optional(),
  responseHeaders: z.record(z.string()).optional(),
  responseBody: z.unknown().optional(),
});
export type JudgeCategoryResponse = z.infer<typeof JudgeCategoryResponseSchema>;
```

- [ ] **Step 5: Write `judge-category.ts`**

Create `orchestrator/src/judge-category.ts`:

```typescript
import { generateObject, type LanguageModelUsage } from "ai";
import { z } from "zod";
import {
  DEFAULT_JUDGE_PROVIDER,
  getModel,
  getModelName,
  type ModelProvider,
} from "./provider.js";
import { classifyModelCallError } from "./solver.js";

const JUDGE_TEMPERATURE = 0;

const VerdictSchema = z.object({
  verdict: z.enum(["correct", "partial", "lucky"]),
  rationale: z.string(),
});

export interface JudgeCategoryResult {
  verdict: "correct" | "partial" | "lucky";
  rationale: string;
  model: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  rawResponseText?: string;
}

export function buildJudgePrompt(proposedCategory: string, actualCategory: string): string {
  return [
    "You are grading whether a puzzle solver correctly identified the theme",
    "connecting a group of four items.",
    "",
    "The solver labeled the group:",
    `  "${proposedCategory}"`,
    "",
    "The puzzle's real label for that group is:",
    `  "${actualCategory}"`,
    "",
    "Both labels describe the same four items. Decide whether the solver",
    "understood the actual connection:",
    "",
    "- correct: the solver's label expresses the same connection as the real",
    "  label, even if worded differently.",
    "- partial: the solver's label is related or thematically close, but",
    "  misses, over-generalizes, or garbles the specific connection.",
    "- lucky: the solver's label does not reflect the real connection - a",
    "  right group of items for the wrong reason, or for no clear reason.",
    "",
    'Respond with JSON: {"verdict": "correct"|"partial"|"lucky",',
    '"rationale": "<one sentence>"}',
  ].join("\n");
}

/**
 * Runs one LLM-judge call: does `proposedCategory` name the same connection
 * as `actualCategory`? Structured output via generateObject so the verdict
 * can't drift; temperature 0 for reproducibility. Captures the same raw
 * request/response detail solve-assist.ts does. A model-call failure is
 * rethrown as a typed SolveError (classifyModelCallError) carrying whatever
 * detail was captured.
 */
export async function judgeCategory(
  proposedCategory: string,
  actualCategory: string,
  model?: string,
  provider?: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<JudgeCategoryResult> {
  const resolvedProvider = provider ?? DEFAULT_JUDGE_PROVIDER;
  const prompt = buildJudgePrompt(proposedCategory, actualCategory);
  const startTime = Date.now();

  try {
    const result = await generateObject({
      model: getModel(resolvedProvider, model),
      schema: VerdictSchema,
      prompt,
      temperature: JUDGE_TEMPERATURE,
      abortSignal,
    });
    const latencyMs = Date.now() - startTime;

    let usage: JudgeCategoryResult["usage"];
    if (result.usage) {
      const u: LanguageModelUsage = result.usage;
      usage = {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
      };
    }

    return {
      verdict: result.object.verdict,
      rationale: result.object.rationale,
      model: getModelName(resolvedProvider, model),
      latencyMs,
      usage,
      requestBody: result.request?.body,
      responseId: result.response?.id,
      responseHeaders: result.response?.headers,
      responseBody: result.response?.body,
      rawResponseText: JSON.stringify(result.object),
    };
  } catch (err) {
    throw classifyModelCallError(err, {
      model: getModelName(resolvedProvider, model),
      latencyMs: Date.now() - startTime,
    });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd orchestrator && npm test -- judge-category`
Expected: PASS.

- [ ] **Step 7: Wire the route**

In `orchestrator/src/app.ts`: import `JudgeCategoryRequestSchema` and `type JudgeCategoryResponse` from `./types.js`, and `judgeCategory` from `./judge-category.js`. After the `/solve-assist` route block:

```typescript
app.post(
  "/judge-category",
  bodyLimit({
    maxSize: SOLVE_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = JudgeCategoryRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const result = await judgeCategory(
        parsed.data.proposedCategory,
        parsed.data.actualCategory,
        parsed.data.model,
        parsed.data.provider,
        c.req.raw.signal,
      );
      const response: JudgeCategoryResponse = result;
      return c.json(response, 200);
    } catch (err) {
      console.error("Judge-category failed:", err);
      if (err instanceof SolveError) {
        return c.json(
          { error: err.message, code: err.code, details: err.details },
          ERROR_STATUS[err.code],
        );
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Judge-category failed", details: message }, 502);
    }
  },
);
```

- [ ] **Step 8: Add an app-level route test**

In `orchestrator/src/app.test.ts` (follow the existing `/solve-assist` test pattern in that file — mock `judgeCategory`, POST to `/judge-category` with the `x-internal-api-key` header), add:
- a 200 case asserting the JSON body carries `verdict` and `rationale`;
- a 401 case with no key header;
- a 400 case with an empty body.

```typescript
// sketch — match the file's existing mocking style for solve-assist
it("POST /judge-category returns the verdict", async () => {
  vi.mocked(judgeCategory).mockResolvedValue({
    verdict: "correct",
    rationale: "Same connection.",
    model: "gpt-4.1-nano",
    latencyMs: 5,
  });
  const res = await app.request("/judge-category", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-api-key": "test-key" },
    body: JSON.stringify({ proposedCategory: "A", actualCategory: "B" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ verdict: "correct", rationale: "Same connection." });
});
```

- [ ] **Step 9: Run the orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add orchestrator/src/judge-category.ts orchestrator/src/judge-category.test.ts \
  orchestrator/src/types.ts orchestrator/src/app.ts orchestrator/src/app.test.ts \
  orchestrator/src/provider.ts
git commit -m "feat: add /judge-category endpoint to the orchestrator"
```

---

## Task 3: Backend `OrchestratorService.judgeCategory` + judge env vars

**Files:**
- Modify: `backend/src/config/env.ts` (`AppEnv` + `loadEnv` return)
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Modify: `.env.sample`
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Consumes: `loadEnv().JUDGE_MODEL`, `loadEnv().JUDGE_PROVIDER`.
- Produces:
  - `AppEnv.JUDGE_MODEL: string`, `AppEnv.JUDGE_PROVIDER: string` (default `"gpt-4.1-nano"` / `"openai"`).
  - `OrchestratorService.judgeCategory(proposedCategory: string, actualCategory: string, model?: string, provider?: "openai" | "ollama" | "google"): Promise<JudgeCategoryOutcome>` where
    `JudgeCategoryOutcome = { ok: true; data: JudgeCategorySuccess } | { ok: false; error: SolveAssistFailure }` and
    `JudgeCategorySuccess = { verdict: "correct" | "partial" | "lucky"; rationale: string; model: string; latencyMs: number; usage?: SolveUsage; requestBody?: unknown; responseId?: string; responseHeaders?: Record<string,string>; responseBody?: unknown; rawResponseText?: string }`.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/strategy/orchestrator.service.spec.ts` (matches its existing `fetch`-mock style for `solveAssist`), add:

```typescript
describe("judgeCategory", () => {
  it("POSTs categories to /judge-category and maps the success body", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          verdict: "lucky",
          rationale: "Right words, wrong reason.",
          model: "gpt-4.1-nano",
          latencyMs: 42,
          usage: { promptTokens: 100, completionTokens: 12, totalTokens: 112 },
          requestBody: { a: 1 },
          responseId: "r1",
          responseHeaders: { h: "v" },
          responseBody: { ok: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const outcome = await service.judgeCategory("Fruits", "___ COBBLER", "gpt-4.1-nano", "openai");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/judge-category"),
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      proposedCategory: "Fruits",
      actualCategory: "___ COBBLER",
      model: "gpt-4.1-nano",
      provider: "openai",
    });
    expect(outcome).toEqual({
      ok: true,
      data: expect.objectContaining({ verdict: "lucky", rationale: "Right words, wrong reason." }),
    });
  });

  it("returns { ok: false } with the failure detail on a non-2xx response", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "boom", code: "model_error" }), { status: 502 }),
    );
    const outcome = await service.judgeCategory("A", "B", "gpt-4.1-nano", "openai");
    expect(outcome.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- orchestrator.service.spec`
Expected: FAIL — `service.judgeCategory is not a function`.

- [ ] **Step 3: Add the env vars**

In `backend/src/config/env.ts`: add `JUDGE_MODEL: string;` and `JUDGE_PROVIDER: string;` to `AppEnv`, and in the `loadEnv` return object:

```typescript
JUDGE_MODEL: env.JUDGE_MODEL ?? "gpt-4.1-nano",
JUDGE_PROVIDER: env.JUDGE_PROVIDER ?? "openai",
```

In `.env.sample`, add:

```
# Model that grades whether a correct LLM guess also named the real
# connection (POST /judge-category). Defaults shown.
JUDGE_MODEL=gpt-4.1-nano
JUDGE_PROVIDER=openai
```

- [ ] **Step 4: Add `judgeCategory` to `OrchestratorService`**

In `backend/src/modules/strategy/orchestrator.service.ts`, add the success type and method:

```typescript
export interface JudgeCategorySuccess {
  verdict: "correct" | "partial" | "lucky";
  rationale: string;
  model: string;
  latencyMs: number;
  usage?: SolveUsage;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  rawResponseText?: string;
}

export type JudgeCategoryOutcome =
  | { ok: true; data: JudgeCategorySuccess }
  | { ok: false; error: SolveAssistFailure };
```

```typescript
  /**
   * Calls the orchestrator's POST /judge-category — an LLM-as-judge verdict
   * on whether `proposedCategory` names the same connection as
   * `actualCategory`. `model`/`provider` default to JUDGE_MODEL/
   * JUDGE_PROVIDER on the orchestrator side when omitted; the backend always
   * passes both (from loadEnv()). Same failure shape as solveAssist.
   */
  async judgeCategory(
    proposedCategory: string,
    actualCategory: string,
    model?: string,
    provider?: "openai" | "ollama" | "google",
  ): Promise<JudgeCategoryOutcome> {
    return this.executeCall<JudgeCategorySuccess>(
      "/judge-category",
      { proposedCategory, actualCategory, model, provider },
      (raw) => ({
        verdict: raw.verdict,
        rationale: raw.rationale,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
        requestBody: raw.requestBody,
        responseId: raw.responseId,
        responseHeaders: raw.responseHeaders,
        responseBody: raw.responseBody,
        rawResponseText: raw.rawResponseText,
      }),
    );
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npm test -- orchestrator.service.spec`
Expected: PASS.

- [ ] **Step 6: Run the config env test**

Run: `cd backend && npm test -- config/env`
Expected: PASS (existing env tests still green; add an assertion that `loadEnv({}).JUDGE_MODEL === "gpt-4.1-nano"` if the file has a matching test block).

- [ ] **Step 7: Commit**

```bash
git add backend/src/config/env.ts backend/src/modules/strategy/orchestrator.service.ts \
  backend/src/modules/strategy/orchestrator.service.spec.ts .env.sample
git commit -m "feat: add OrchestratorService.judgeCategory and judge env vars"
```

---

## Task 4: `llm-google` queue wiring + judge-provider routing

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/app.setup.ts` (Bull-Board adapter list, ~line 193-195)
- Test: `backend/src/modules/queue/strategy.queue.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `LLM_OPENAI`, `LLM_OLLAMA`, `LLM_GOOGLE` from `../../strategies`.
- Produces:
  - `llmGoogleQueue: Queue` (`"llm-google-runs"`) exported from `strategy.queue.ts`.
  - `LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE"` token exported from `queue.module.ts`, provided + exported by `QueueModule`.
  - `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, strategyName)` — **signature gains `googleQueue` as the 4th arg**, before `strategyName`.
  - `queueForJudgeProvider(provider: "openai" | "ollama" | "google", openAIQueue: Queue, ollamaQueue: Queue, googleQueue: Queue): Queue`.
  - `categoryEvalJobId(llmProposalId: number): string` → `` `cat-eval-${llmProposalId}` ``.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/queue/strategy.queue.spec.ts`:

```typescript
import { LLM_GOOGLE, LLM_OLLAMA, LLM_OPENAI } from "../../strategies";
import {
  categoryEvalJobId,
  queueForJudgeProvider,
  queueForStrategy,
} from "./strategy.queue";

const openai = { name: "openai" } as never;
const ollama = { name: "ollama" } as never;
const google = { name: "google" } as never;
const shared = { name: "shared" } as never;

describe("queueForStrategy", () => {
  it("routes each LLM strategy to its own queue and everything else to the shared queue", () => {
    expect(queueForStrategy(shared, openai, ollama, google, LLM_OPENAI)).toBe(openai);
    expect(queueForStrategy(shared, openai, ollama, google, LLM_OLLAMA)).toBe(ollama);
    expect(queueForStrategy(shared, openai, ollama, google, LLM_GOOGLE)).toBe(google);
    expect(queueForStrategy(shared, openai, ollama, google, "alphabetical")).toBe(shared);
  });
});

describe("queueForJudgeProvider", () => {
  it("maps a judge provider to that provider's LLM queue", () => {
    expect(queueForJudgeProvider("openai", openai, ollama, google)).toBe(openai);
    expect(queueForJudgeProvider("ollama", openai, ollama, google)).toBe(ollama);
    expect(queueForJudgeProvider("google", openai, ollama, google)).toBe(google);
  });
});

describe("categoryEvalJobId", () => {
  it("is deterministic per proposal", () => {
    expect(categoryEvalJobId(42)).toBe("cat-eval-42");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- strategy.queue.spec`
Expected: FAIL — `queueForJudgeProvider`/`categoryEvalJobId` not exported, and `queueForStrategy` arity wrong.

- [ ] **Step 3: Update `strategy.queue.ts`**

Add the queue:

```typescript
export const llmGoogleQueue = new Queue("llm-google-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

Change `queueForStrategy` to take `googleQueue` and route `LLM_GOOGLE`:

```typescript
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  return defaultQueue;
}
```

Add:

```typescript
/**
 * The LLM queue a judge job rides — the judge provider's own queue, so
 * category-evaluation jobs share that provider's worker concurrency and
 * rate budget with its solve runs (see the design doc).
 */
export function queueForJudgeProvider(
  provider: "openai" | "ollama" | "google",
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
): Queue {
  if (provider === "ollama") return ollamaQueue;
  if (provider === "google") return googleQueue;
  return openAIQueue;
}

/** Deterministic job id so a re-enqueue of a still-pending evaluation collapses. */
export function categoryEvalJobId(llmProposalId: number): string {
  return `cat-eval-${llmProposalId}`;
}
```

Import `LLM_GOOGLE` in the file's imports.

- [ ] **Step 4: Update `queue.module.ts`**

Import `llmGoogleQueue`; add `export const LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE";`; add `{ provide: LLM_GOOGLE_QUEUE, useValue: llmGoogleQueue }` to `providers`; add `LLM_GOOGLE_QUEUE` to `exports`.

- [ ] **Step 5: Update the one existing `queueForStrategy` call site**

In `backend/src/modules/strategy/strategy.service.ts`: `queueFor` (line ~191-193) must pass the google queue. Inject it:

```typescript
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
```

```typescript
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      strategyName,
    );
  }
```

Import `LLM_GOOGLE_QUEUE`. Also add `this.llmGoogleQueue` to the `queues` array in `queuedCountsByKey` (line ~693) so queued google jobs are tallied.

In `backend/src/modules/strategy/strategy.service.spec.ts`: add `mockGoogleQueue` (same shape as `mockOllamaQueue`) and `{ provide: LLM_GOOGLE_QUEUE, useValue: mockGoogleQueue }` to the test module providers, and import `LLM_GOOGLE_QUEUE`.

- [ ] **Step 6: Update `app.setup.ts` Bull-Board**

Import `llmGoogleQueue` and add `new BullMQAdapter(llmGoogleQueue),` to the adapter array next to the openai/ollama ones.

- [ ] **Step 7: Run tests**

Run: `cd backend && npm test -- strategy.queue.spec strategy.service.spec`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/strategy.queue.spec.ts \
  backend/src/modules/queue/queue.module.ts backend/src/app.setup.ts \
  backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat: wire the llm-google queue and add judge-provider queue routing"
```

---

## Task 5: `CategoryEvaluatorService.evaluateProposal`

**Files:**
- Create: `backend/src/modules/strategy/category-evaluator.service.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts` (`providers`, `exports`)
- Test: `backend/src/modules/strategy/category-evaluator.service.spec.ts`

**Interfaces:**
- Consumes: `OrchestratorService.judgeCategory` (Task 3); `CategoryEvaluation` entity + enums (Task 1); `loadEnv().JUDGE_MODEL`, `loadEnv().JUDGE_PROVIDER`.
- Produces:
  - `EVALUATOR_VERSION = 1` (exported const).
  - `CategoryEvaluatorService.evaluateProposal(llmProposalId: number, opts?: { force?: boolean }): Promise<{ outcome: "judged" | "callError" | "skipped"; reason?: string }>`.
  - `matchAnswerGroup(guessWords: string[], puzzle: Puzzle): AnswerGroup | null` (exported helper for the test).

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/category-evaluator.service.spec.ts`:

```typescript
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { CategoryEvaluatorService, matchAnswerGroup } from "./category-evaluator.service";
import { CategoryEvaluation, CategoryEvalStatus, CategoryEvalVerdict } from "./entities/category-evaluation.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { Guess, GuessResult } from "./entities/guess.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { OrchestratorService } from "./orchestrator.service";
import { LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";

const puzzle = {
  id: 7,
  answerGroups: [
    { id: 100, group_name: "___ COBBLER", members: [{ word: "APPLE" }, { word: "PEACH" }, { word: "SHOE" }, { word: "COBBLE" }] },
    { id: 101, group_name: "Citrus", members: [{ word: "LIME" }, { word: "LEMON" }, { word: "ORANGE" }, { word: "CITRON" }] },
  ],
} as unknown as Puzzle;

describe("matchAnswerGroup", () => {
  it("matches by word set regardless of order", () => {
    const group = matchAnswerGroup(["SHOE", "APPLE", "COBBLE", "PEACH"], puzzle);
    expect(group?.id).toBe(100);
  });
  it("returns null when no group's members equal the guess word set", () => {
    expect(matchAnswerGroup(["APPLE", "PEACH", "SHOE", "LIME"], puzzle)).toBeNull();
  });
});

describe("CategoryEvaluatorService.evaluateProposal", () => {
  let service: CategoryEvaluatorService;
  let catEvalRepo: { findOne: jest.Mock; save: jest.Mock };
  let llmProposalRepo: { findOne: jest.Mock };
  let puzzleRepo: { findOne: jest.Mock };
  let orchestrator: { judgeCategory: jest.Mock };

  const usedProposal = {
    id: 55,
    strategyRunId: 9,
    category: "Fruits",
    status: LlmProposalStatus.USED,
    guess: { id: 3, puzzleId: 7, words: ["APPLE", "PEACH", "SHOE", "COBBLE"], result: GuessResult.SUCCESS } as Guess,
  } as unknown as LlmProposal;

  beforeEach(async () => {
    catEvalRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn().mockImplementation((r) => r) };
    llmProposalRepo = { findOne: jest.fn().mockResolvedValue(usedProposal) };
    puzzleRepo = { findOne: jest.fn().mockResolvedValue(puzzle) };
    orchestrator = {
      judgeCategory: jest.fn().mockResolvedValue({
        ok: true,
        data: {
          verdict: "partial",
          rationale: "Saw fruit, missed the wordplay.",
          model: "gpt-4.1-nano",
          latencyMs: 20,
          usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 },
          requestBody: { a: 1 },
          responseHeaders: { h: "v" },
          responseBody: { ok: true },
          rawResponseText: '{"verdict":"partial"}',
        },
      }),
    };

    const noopQueue = { add: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        { provide: getRepositoryToken(CategoryEvaluation), useValue: catEvalRepo },
        { provide: getRepositoryToken(LlmProposal), useValue: llmProposalRepo },
        { provide: getRepositoryToken(Puzzle), useValue: puzzleRepo },
        { provide: OrchestratorService, useValue: orchestrator },
        { provide: LLM_OPENAI_QUEUE, useValue: noopQueue },
        { provide: LLM_OLLAMA_QUEUE, useValue: noopQueue },
        { provide: LLM_GOOGLE_QUEUE, useValue: noopQueue },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  it("writes one judged row with the verdict and diagnostics", async () => {
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("judged");
    expect(catEvalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProposalId: 55,
        strategyRunId: 9,
        answerGroupId: 100,
        verdict: CategoryEvalVerdict.PARTIAL,
        rationale: "Saw fruit, missed the wordplay.",
        proposedCategory: "Fruits",
        actualCategory: "___ COBBLER",
        status: CategoryEvalStatus.JUDGED,
        judgeModel: "gpt-4.1-nano",
        promptTokens: 90,
        completionTokens: 10,
        requestBody: { a: 1 },
      }),
    );
  });

  it("writes a callError row (verdict null) without throwing when the judge fails", async () => {
    orchestrator.judgeCategory.mockResolvedValue({
      ok: false,
      error: { error: "boom", code: "model_error", errorName: "APICallError", statusCode: 502, isRetryable: true },
    });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("callError");
    expect(catEvalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CategoryEvalStatus.CALL_ERROR,
        verdict: null,
        errorName: "APICallError",
        statusCode: 502,
        answerGroupId: 100,
      }),
    );
  });

  it("skips (no judge call, no row) when a row already exists and force is not set", async () => {
    catEvalRepo.findOne.mockResolvedValue({ id: 1 });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(orchestrator.judgeCategory).not.toHaveBeenCalled();
    expect(catEvalRepo.save).not.toHaveBeenCalled();
  });

  it("skips when the proposal is not a successful used guess", async () => {
    llmProposalRepo.findOne.mockResolvedValue({ ...usedProposal, guess: { ...usedProposal.guess, result: GuessResult.FAILURE } });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(orchestrator.judgeCategory).not.toHaveBeenCalled();
  });

  it("skips (no row written) when the winning word set matches no answer group", async () => {
    llmProposalRepo.findOne.mockResolvedValue({
      ...usedProposal,
      guess: { ...usedProposal.guess, words: ["APPLE", "PEACH", "SHOE", "LIME"] },
    });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(catEvalRepo.save).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- category-evaluator.service.spec`
Expected: FAIL — `Cannot find module './category-evaluator.service'`.

- [ ] **Step 3: Write the service (`evaluateProposal` + helper only)**

Create `backend/src/modules/strategy/category-evaluator.service.ts`:

```typescript
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { loadEnv } from "../../config/env";
import { Puzzle } from "../game/entities/puzzle.entity";
import { AnswerGroup } from "../game/entities/answer-group.entity";
import {
  CategoryEvaluation,
  CategoryEvalStatus,
  CategoryEvalVerdict,
} from "./entities/category-evaluation.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { GuessResult } from "./entities/guess.entity";
import { OrchestratorService } from "./orchestrator.service";

// Bump only when buildJudgePrompt (orchestrator) changes materially, so a
// later re-judge pass can find rows produced by an older prompt. Nothing
// reads it yet.
export const EVALUATOR_VERSION = 1;

const VERDICT_BY_STRING: Record<string, CategoryEvalVerdict> = {
  correct: CategoryEvalVerdict.CORRECT,
  partial: CategoryEvalVerdict.PARTIAL,
  lucky: CategoryEvalVerdict.LUCKY,
};

function wordSetKey(words: string[]): string {
  return [...words].map((w) => w.trim().toUpperCase()).sort().join("|");
}

/** The puzzle answer group whose member words equal `guessWords` as a set. */
export function matchAnswerGroup(guessWords: string[], puzzle: Puzzle): AnswerGroup | null {
  const target = wordSetKey(guessWords);
  for (const group of puzzle.answerGroups ?? []) {
    if (wordSetKey(group.members.map((m) => m.word)) === target) {
      return group;
    }
  }
  return null;
}

export interface EvaluateProposalResult {
  outcome: "judged" | "callError" | "skipped";
  reason?: string;
}

@Injectable()
export class CategoryEvaluatorService {
  private readonly logger = new Logger(CategoryEvaluatorService.name);
  private readonly judgeModel = loadEnv().JUDGE_MODEL;
  private readonly judgeProvider = loadEnv().JUDGE_PROVIDER as "openai" | "ollama" | "google";

  constructor(
    @InjectRepository(CategoryEvaluation)
    private readonly categoryEvalRepo: Repository<CategoryEvaluation>,
    @InjectRepository(LlmProposal)
    private readonly llmProposalRepo: Repository<LlmProposal>,
    @InjectRepository(Puzzle)
    private readonly puzzleRepo: Repository<Puzzle>,
    @Inject(OrchestratorService)
    private readonly orchestrator: OrchestratorService,
  ) {}

  /**
   * Judge one proposal's category. Idempotent: a no-op if a row already
   * exists (unless `force`). Writes exactly one CategoryEvaluation row on a
   * judged or callError outcome; writes nothing (and returns "skipped") when
   * the proposal isn't a successful used guess or its winning word set
   * matches no answer group.
   */
  async evaluateProposal(
    llmProposalId: number,
    opts: { force?: boolean } = {},
  ): Promise<EvaluateProposalResult> {
    const existing = await this.categoryEvalRepo.findOne({ where: { llmProposalId } });
    if (existing && !opts.force) {
      return { outcome: "skipped", reason: "already evaluated" };
    }

    const proposal = await this.llmProposalRepo.findOne({
      where: { id: llmProposalId },
      relations: { guess: true },
    });
    if (
      !proposal ||
      proposal.status !== LlmProposalStatus.USED ||
      !proposal.guess ||
      proposal.guess.result !== GuessResult.SUCCESS
    ) {
      this.logger.warn(`Proposal ${llmProposalId} is not a successful used guess — skipping.`);
      return { outcome: "skipped", reason: "not a successful used guess" };
    }

    const puzzle = await this.puzzleRepo.findOne({
      where: { id: proposal.guess.puzzleId },
      relations: { answerGroups: { members: true } },
    });
    const group = puzzle ? matchAnswerGroup(proposal.guess.words, puzzle) : null;
    if (!group) {
      this.logger.warn(
        `Proposal ${llmProposalId}: winning word set matched no answer group on puzzle ${proposal.guess.puzzleId} — skipping.`,
      );
      return { outcome: "skipped", reason: "no matching answer group" };
    }

    const proposedCategory = proposal.category;
    const actualCategory = group.group_name;

    const outcome = await this.orchestrator.judgeCategory(
      proposedCategory,
      actualCategory,
      this.judgeModel,
      this.judgeProvider,
    );

    const base = {
      llmProposalId,
      strategyRunId: proposal.strategyRunId,
      answerGroupId: group.id,
      proposedCategory,
      actualCategory,
      evaluatorVersion: EVALUATOR_VERSION,
      judgeModel: this.judgeModel,
      judgeProvider: this.judgeProvider,
    };

    if (outcome.ok) {
      const d = outcome.data;
      await this.categoryEvalRepo.save({
        ...(existing ? { id: existing.id } : {}),
        ...base,
        status: CategoryEvalStatus.JUDGED,
        verdict: VERDICT_BY_STRING[d.verdict],
        rationale: d.rationale,
        judgeModel: d.model || this.judgeModel,
        requestBody: d.requestBody ?? null,
        responseId: d.responseId ?? null,
        responseHeaders: d.responseHeaders ?? null,
        responseBody: d.responseBody ?? null,
        rawResponseText: d.rawResponseText ?? null,
        promptTokens: d.usage?.promptTokens ?? null,
        completionTokens: d.usage?.completionTokens ?? null,
        totalTokens: d.usage?.totalTokens ?? null,
        latencyMs: d.latencyMs ?? null,
        statusCode: null,
        errorName: null,
        errorMessage: null,
        isRetryable: null,
        temperature: 0,
      });
      return { outcome: "judged" };
    }

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
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      latencyMs: null,
      temperature: null,
    });
    return { outcome: "callError" };
  }
}
```

- [ ] **Step 4: Register the provider**

In `backend/src/modules/strategy/strategy.module.ts`: import `CategoryEvaluatorService`, add it to `providers`, and add it to `exports` (the worker resolves it from the app context).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npm test -- category-evaluator.service.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/category-evaluator.service.ts \
  backend/src/modules/strategy/category-evaluator.service.spec.ts \
  backend/src/modules/strategy/strategy.module.ts
git commit -m "feat: add CategoryEvaluatorService.evaluateProposal"
```

---

## Task 6: `enqueuePending` + `POST /dispatch/evaluate-categories`

**Files:**
- Modify: `backend/src/modules/strategy/category-evaluator.service.ts` (add `enqueuePending`; inject the three LLM queues)
- Modify: `backend/src/modules/strategy/category-evaluator.service.spec.ts` (add `enqueuePending` tests)
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts` (new route)
- Test: `backend/src/modules/dispatch/dispatch.controller.spec.ts` (add a case; follow existing structure)

**Interfaces:**
- Consumes: `queueForJudgeProvider`, `categoryEvalJobId` (Task 4); `LLM_OPENAI_QUEUE`, `LLM_OLLAMA_QUEUE`, `LLM_GOOGLE_QUEUE` tokens.
- Produces:
  - `CategoryEvaluatorService.enqueuePending(opts?: { limit?: number }): Promise<{ enqueued: number; llmProposalIds: number[] }>` — default limit 50, clamped 1..500.
  - `DispatchController.evaluateCategories(limitRaw?: string): Promise<{ message: string; enqueued: number; llmProposalIds: number[] }>` on `POST /dispatch/evaluate-categories`, `@UseGuards(DispatchAuthGuard)`.

- [ ] **Step 1: Write the failing test**

Add to `category-evaluator.service.spec.ts` a new `describe("enqueuePending")`. Extend the test module: the `LlmProposal` repo mock gains `createQueryBuilder`, and capture the OpenAI queue mock's `add`.

```typescript
describe("CategoryEvaluatorService.enqueuePending", () => {
  let service: CategoryEvaluatorService;
  let openaiAdd: jest.Mock;
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    openaiAdd = jest.fn().mockResolvedValue(undefined);
    qb = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: 90 }, { id: 88 }, { id: 80 }]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        { provide: getRepositoryToken(CategoryEvaluation), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(LlmProposal), useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) } },
        { provide: getRepositoryToken(Puzzle), useValue: { findOne: jest.fn() } },
        { provide: OrchestratorService, useValue: { judgeCategory: jest.fn() } },
        { provide: LLM_OPENAI_QUEUE, useValue: { add: openaiAdd } },
        { provide: LLM_OLLAMA_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_GOOGLE_QUEUE, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  it("adds one evaluate-category job per un-evaluated proposal to the judge provider's queue", async () => {
    const res = await service.enqueuePending({ limit: 10 });
    expect(res).toEqual({ enqueued: 3, llmProposalIds: [90, 88, 80] });
    expect(openaiAdd).toHaveBeenCalledTimes(3);
    expect(openaiAdd).toHaveBeenCalledWith(
      "evaluate-category",
      { llmProposalId: 90 },
      { jobId: "cat-eval-90" },
    );
    expect(qb.limit).toHaveBeenCalledWith(10);
  });

  it("clamps limit to 1..500", async () => {
    await service.enqueuePending({ limit: 99999 });
    expect(qb.limit).toHaveBeenCalledWith(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- category-evaluator.service.spec`
Expected: FAIL — `service.enqueuePending is not a function`.

- [ ] **Step 3: Implement `enqueuePending`**

In `category-evaluator.service.ts`, add the queue imports and constructor params:

```typescript
import { Queue } from "bullmq";
import { LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { queueForJudgeProvider, categoryEvalJobId } from "../queue/strategy.queue";
```

```typescript
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
```

```typescript
  private readonly DEFAULT_LIMIT = 50;
  private readonly MAX_LIMIT = 500;

  /**
   * Enqueue one `evaluate-category` job per not-yet-evaluated successful
   * used proposal, newest LlmProposal.id first, up to `limit`. Jobs land on
   * the judge provider's LLM queue (deterministic jobId so a re-enqueue of a
   * still-pending job collapses). Returns what was queued.
   */
  async enqueuePending(opts: { limit?: number } = {}): Promise<{
    enqueued: number;
    llmProposalIds: number[];
  }> {
    const limit = Math.min(this.MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? this.DEFAULT_LIMIT)));

    const rows = await this.llmProposalRepo
      .createQueryBuilder("proposal")
      .innerJoin("proposal.guess", "guess", "guess.result = :success", { success: GuessResult.SUCCESS })
      .leftJoin(CategoryEvaluation, "ce", 'ce."llmProposalId" = proposal.id')
      .where("proposal.status = :used", { used: LlmProposalStatus.USED })
      .andWhere("ce.id IS NULL")
      .orderBy("proposal.id", "DESC")
      .limit(limit)
      .select("proposal.id", "id")
      .getRawMany<{ id: number }>();

    const queue = queueForJudgeProvider(
      this.judgeProvider,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
    );

    const llmProposalIds = rows.map((r) => Number(r.id));
    for (const id of llmProposalIds) {
      await queue.add("evaluate-category", { llmProposalId: id }, { jobId: categoryEvalJobId(id) });
    }

    return { enqueued: llmProposalIds.length, llmProposalIds };
  }
```

Note: the existing `evaluateProposal` test module (Task 5) already provides the three queue tokens, so it keeps compiling.

- [ ] **Step 4: Run the service test**

Run: `cd backend && npm test -- category-evaluator.service.spec`
Expected: PASS.

- [ ] **Step 5: Add the endpoint**

In `backend/src/modules/dispatch/dispatch.controller.ts`: inject `CategoryEvaluatorService` (`@Inject(CategoryEvaluatorService)`), import it and `Query` (already imported). Add:

```typescript
  // Enqueues LLM-judge evaluation jobs for the most recent successful LLM
  // guesses that don't have a CategoryEvaluation yet — one job per
  // proposal, onto the judge provider's LLM queue (see
  // CategoryEvaluatorService). Password-gated like the other paid-call
  // dispatch routes.
  @Post("evaluate-categories")
  @UseGuards(DispatchAuthGuard)
  @ApiQuery({
    name: "limit",
    type: Number,
    required: false,
    description: "How many un-evaluated proposals to enqueue (default 50, max 500).",
    example: 50,
  })
  @ApiBody({ type: DispatchAuthDto })
  async evaluateCategories(@Query("limit") limitRaw?: string) {
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    const result = await this.categoryEvaluatorService.enqueuePending({ limit });
    return {
      message: `Enqueued ${result.enqueued} category-evaluation job(s)`,
      ...result,
    };
  }
```

`DispatchModule` already imports `StrategyModule`, which now exports `CategoryEvaluatorService`, so no module wiring change is needed.

- [ ] **Step 6: Add a controller test**

In `dispatch.controller.spec.ts`, register a `mockCategoryEvaluatorService = { enqueuePending: jest.fn().mockResolvedValue({ enqueued: 2, llmProposalIds: [9, 8] }) }` provider and assert `POST /dispatch/evaluate-categories?limit=2` returns `{ message: expect.stringContaining("2"), enqueued: 2, llmProposalIds: [9, 8] }` and that `enqueuePending` was called with `{ limit: 2 }`.

- [ ] **Step 7: Run tests**

Run: `cd backend && npm test -- category-evaluator.service.spec dispatch.controller.spec`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/strategy/category-evaluator.service.ts \
  backend/src/modules/strategy/category-evaluator.service.spec.ts \
  backend/src/modules/dispatch/dispatch.controller.ts \
  backend/src/modules/dispatch/dispatch.controller.spec.ts
git commit -m "feat: add evaluate-categories enqueue endpoint and service method"
```

---

## Task 7: Worker branch for `evaluate-category` jobs

**Files:**
- Modify: `backend/src/worker.ts`
- Test: `backend/src/worker.spec.ts` (create if absent — test only the extracted handler)

**Interfaces:**
- Consumes: `CategoryEvaluatorService.evaluateProposal` (Task 5).
- Produces: `handleLlmJob(job, deps)` — an exported pure handler so the branch is testable without booting BullMQ. `deps = { llmStrategyRunner, categoryEvaluatorService, expectedStrategy, logger }`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/worker.spec.ts`:

```typescript
import { handleLlmJob } from "./worker";

const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as never;

describe("handleLlmJob", () => {
  it("routes an evaluate-category job to the evaluator, not the strategy runner", async () => {
    const runner = { runLlmStrategy: jest.fn() };
    const evaluator = { evaluateProposal: jest.fn().mockResolvedValue({ outcome: "judged" }) };
    const job = { id: "j1", name: "evaluate-category", data: { llmProposalId: 77 } };

    const result = await handleLlmJob(job as never, {
      llmStrategyRunner: runner as never,
      categoryEvaluatorService: evaluator as never,
      expectedStrategy: "llm-openai",
      logger,
    });

    expect(evaluator.evaluateProposal).toHaveBeenCalledWith(77);
    expect(runner.runLlmStrategy).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "judged" });
  });

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

    expect(runner.runLlmStrategy).toHaveBeenCalledWith(1, "llm-openai", 1, "gpt-4.1-nano");
    expect(evaluator.evaluateProposal).not.toHaveBeenCalled();
  });

  it("throws when a run-strategy job's strategy doesn't match the queue", async () => {
    const job = { id: "j3", name: "run-strategy", data: { puzzleId: 1, strategyName: "llm-google", trialNumber: 1 } };
    await expect(
      handleLlmJob(job as never, {
        llmStrategyRunner: { runLlmStrategy: jest.fn() } as never,
        categoryEvaluatorService: { evaluateProposal: jest.fn() } as never,
        expectedStrategy: "llm-openai",
        logger,
      }),
    ).rejects.toThrow(/expected 'llm-openai'/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- worker.spec`
Expected: FAIL — `handleLlmJob` is not exported from `./worker`.

- [ ] **Step 3: Extract and branch the handler**

In `backend/src/worker.ts`:

- Import `CategoryEvaluatorService` and `LlmStrategyRunner` types; resolve `const categoryEvaluatorService = appContext.get(CategoryEvaluatorService);` in `bootstrap()`.
- Add an exported handler:

```typescript
export interface LlmJobDeps {
  llmStrategyRunner: LlmStrategyRunner;
  categoryEvaluatorService: CategoryEvaluatorService;
  expectedStrategy: string;
  logger: Logger;
}

/**
 * Body of the per-provider LLM worker. Two job kinds share the queue:
 * `evaluate-category` (LLM-judge a proposal's category — see
 * CategoryEvaluatorService) and everything else (`run-strategy`, an actual
 * solve run). Exported so the routing is unit-testable without BullMQ.
 */
export async function handleLlmJob(
  job: Job<RunStrategyJobData | { llmProposalId: number }>,
  deps: LlmJobDeps,
): Promise<unknown> {
  if (job.name === "evaluate-category") {
    const { llmProposalId } = job.data as { llmProposalId: number };
    deps.logger.log(`starting job ${job.id}: evaluate-category proposal=${llmProposalId}`);
    const result = await deps.categoryEvaluatorService.evaluateProposal(llmProposalId);
    deps.logger.log(`finished job ${job.id}: evaluate-category proposal=${llmProposalId} outcome=${result.outcome}`);
    return result;
  }

  const { puzzleId, strategyName, date, trialNumber, model } = job.data as RunStrategyJobData;
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
  );
  deps.logger.log(
    `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber} status=${result.status}`,
  );
  return result;
}
```

- Change `createLlmWorker`'s processor to delegate:

```typescript
    const llmWorker = new Worker(
      queueName,
      (job: Job<RunStrategyJobData | { llmProposalId: number }>) =>
        handleLlmJob(job, {
          llmStrategyRunner,
          categoryEvaluatorService,
          expectedStrategy,
          logger,
        }),
      { connection: redisConnection, concurrency },
    );
```

- The `strategy-runs` worker's defensive LLM branch (line ~72-82) is unchanged — it never receives `evaluate-category` jobs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- worker.spec`
Expected: PASS.

- [ ] **Step 5: Type-check the worker**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/worker.ts backend/src/worker.spec.ts
git commit -m "feat: route evaluate-category jobs to the category evaluator in the LLM worker"
```

---

## Task 8: CLI script `evaluate-categories.ts`

**Files:**
- Create: `backend/src/scripts/evaluate-categories.ts`
- Modify: `backend/package.json` (`scripts`)

**Interfaces:**
- Consumes: `CategoryEvaluatorService.enqueuePending` (Task 6).
- Produces: `npm run eval:categories -- [--limit N] [--force]` — enqueues jobs (the worker does the judging). `--force` re-enqueues already-evaluated proposals.

Note: this task has no unit test — it mirrors `backfill-issue-tags.ts`, which this repo also leaves untested (a thin `NestFactory.createApplicationContext` wrapper). Verification is a manual run.

- [ ] **Step 1: Write the script**

Create `backend/src/scripts/evaluate-categories.ts`:

```typescript
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module";
import { CategoryEvaluatorService } from "../modules/strategy/category-evaluator.service";

/**
 * Enqueues LLM-judge category-evaluation jobs for the most recent
 * successful LLM guesses that have no CategoryEvaluation row yet. The
 * worker (llm-<provider>-runs queue) does the actual judging — this only
 * queues the work, the same as POST /dispatch/evaluate-categories.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/evaluate-categories.ts --limit 100
 *
 * --force re-enqueues even already-evaluated proposals (the job passes
 * force through to evaluateProposal, which then overwrites the row).
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/evaluate-categories.ts --limit 200
 */

const logger = new Logger("EvaluateCategories");

function parseArgs(argv: string[]): { limit?: number; force: boolean } {
  const force = argv.includes("--force");
  const i = argv.indexOf("--limit");
  const limit = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : undefined;
  return { limit, force };
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  const appContext = await NestFactory.createApplicationContext(AppModule);
  try {
    const service = appContext.get(CategoryEvaluatorService);
    const result = await service.enqueuePending({ limit });
    logger.log(`Enqueued ${result.enqueued} job(s): ${result.llmProposalIds.join(", ") || "(none)"}`);
  } finally {
    await appContext.close();
  }
}

// See backfill-issue-tags.ts — appContext.close() doesn't close the BullMQ
// queues' ioredis connections, so exit explicitly.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });
```

Note: `--force` currently only affects re-selection semantics via a future flag on the job payload; for this task the script's `--force` is accepted and logged but `enqueuePending` filters out already-evaluated rows. To honour `--force`, extend `enqueuePending` to accept `{ force }` and, when set, skip the `ce.id IS NULL` filter and pass `force: true` in the job data; `handleLlmJob` then calls `evaluateProposal(id, { force: true })`. Implement that extension here:

- `enqueuePending({ limit, force }): drop the `andWhere("ce.id IS NULL")` when `force`; `queue.add("evaluate-category", { llmProposalId: id, force }, ...)`.
- `handleLlmJob`: `evaluateProposal(llmProposalId, { force: Boolean((job.data as { force?: boolean }).force) })`.
- Add one service test: `enqueuePending({ force: true })` does not add the `ce.id IS NULL` clause (assert `qb.andWhere` not called with that string) and passes `force: true` in the job data.

- [ ] **Step 2: Add the npm script**

In `backend/package.json` `scripts`, add (next to `backfill:issue-tags`):

```json
"eval:categories": "tsx src/scripts/evaluate-categories.ts"
```

- [ ] **Step 3: Manual verification**

With Redis + Postgres up and at least one successful LLM run in the DB:

Run: `cd backend && npm run eval:categories -- --limit 5`
Expected: logs `Enqueued N job(s): ...`. Check Bull-Board (`/admin/queues`) — `llm-openai-runs` shows N `evaluate-category` jobs. With a worker running, they process and `SELECT count(*) FROM "CategoryEvaluation"` increases.

- [ ] **Step 4: Run the service test for the `force` extension**

Run: `cd backend && npm test -- category-evaluator.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scripts/evaluate-categories.ts backend/package.json \
  backend/src/modules/strategy/category-evaluator.service.ts \
  backend/src/modules/strategy/category-evaluator.service.spec.ts \
  backend/src/worker.ts
git commit -m "feat: add eval:categories CLI script and --force enqueue path"
```

---

## Task 9: Leaderboard aggregation

**Files:**
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts` (`LeaderboardRowDto`)
- Modify: `backend/src/modules/strategy/strategy.service.ts` (`getLeaderboard`, `LeaderboardAccumulator`)
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts` (mock + tests)

**Interfaces:**
- Consumes: `CategoryEvaluation` entity (Task 1).
- Produces: `LeaderboardRowDto` gains `categoryCorrect: number`, `categoryPartial: number`, `categoryLucky: number`, `categoryEvaluated: number`, `categoryAccuracy: number | null`.

- [ ] **Step 1: Write the failing test**

In `strategy.service.spec.ts`, add a `categoryEvaluationRepo` mock (default `createQueryBuilder` returning `getRawMany: []`, same shape as `mockSolvePromptRepo`'s), register `{ provide: getRepositoryToken(CategoryEvaluation), useValue: mockCategoryEvaluationRepo }`, import the entity. Then a `getLeaderboard` test:

```typescript
it("reports per-model category accuracy from CategoryEvaluation verdict counts", async () => {
  mockStrategyRunRepo.find.mockResolvedValue([
    { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", status: "completed", puzzleId: 1, startedAt: new Date(), finishedAt: new Date() },
    { id: 2, strategyName: "llm-openai", modelName: "gpt-4.1-nano", status: "failed", puzzleId: 2, startedAt: new Date(), finishedAt: new Date() },
  ]);
  mockCategoryEvaluationRepo.createQueryBuilder.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([
      { strategyRunId: 1, correct: "3", partial: "1", lucky: "0" },
      { strategyRunId: 2, correct: "1", partial: "0", lucky: "2" },
    ]),
  });

  const board = await service.getLeaderboard();
  const row = board.llm.find((r) => r.modelName === "gpt-4.1-nano")!;
  expect(row.categoryCorrect).toBe(4);
  expect(row.categoryPartial).toBe(1);
  expect(row.categoryLucky).toBe(2);
  expect(row.categoryEvaluated).toBe(7);
  expect(row.categoryAccuracy).toBeCloseTo((4 / 7) * 100);
});

it("gives categoryAccuracy null for a model with no evaluations and for deterministic rows", async () => {
  mockStrategyRunRepo.find.mockResolvedValue([
    { id: 1, strategyName: "alphabetical", modelName: null, status: "completed", puzzleId: 1, startedAt: new Date(), finishedAt: new Date() },
  ]);
  const board = await service.getLeaderboard();
  expect(board.deterministic[0].categoryAccuracy).toBeNull();
  expect(board.deterministic[0].categoryEvaluated).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- strategy.service.spec -t "category accuracy"`
Expected: FAIL — `row.categoryCorrect` is `undefined` / provider for `CategoryEvaluation` repo missing.

- [ ] **Step 3: Add the DTO fields**

In `strategy.dto.ts` `LeaderboardRowDto`, after `avgIssues`:

```typescript
  // Category-reasoning quality for this model's successful guesses, from the
  // LLM judge (see 2026-08-27-llm-category-accuracy-evaluation-design.md).
  // correct/partial/lucky are raw verdict counts across every evaluated
  // successful used proposal of this model; categoryEvaluated is their sum
  // (callError rows have verdict null and count toward none of them).
  // categoryAccuracy is correct / categoryEvaluated * 100, or null when
  // categoryEvaluated is 0 — which is also the case for deterministic/
  // shuffle rows, so those show "—" like avgCostUsd/avgIssues.
  categoryCorrect: number;
  categoryPartial: number;
  categoryLucky: number;
  categoryEvaluated: number;
  categoryAccuracy: number | null;
```

- [ ] **Step 4: Implement the aggregation**

In `strategy.service.ts`:

- Inject the repo: `@InjectRepository(CategoryEvaluation) private readonly categoryEvaluationRepo: Repository<CategoryEvaluation>,` and import the entity.
- `LeaderboardAccumulator` gains `catCorrect: number; catPartial: number; catLucky: number;`.
- In `getLeaderboard`'s `Promise.all`, add a query and destructure it as `categoryRows`:

```typescript
      this.categoryEvaluationRepo
        .createQueryBuilder("ce")
        .select("ce.strategyRunId", "strategyRunId")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'correct')", "correct")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'partial')", "partial")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'lucky')", "lucky")
        .groupBy("ce.strategyRunId")
        .getRawMany<{ strategyRunId: number; correct: string; partial: string; lucky: string }>(),
```

- Build a map:

```typescript
    const categoryByRun = new Map<number, { correct: number; partial: number; lucky: number }>();
    for (const row of categoryRows) {
      categoryByRun.set(Number(row.strategyRunId), {
        correct: Number(row.correct ?? 0),
        partial: Number(row.partial ?? 0),
        lucky: Number(row.lucky ?? 0),
      });
    }
```

- In the accumulator init object, add `catCorrect: 0, catPartial: 0, catLucky: 0,`.
- In the `for (const run of runs)` loop, unconditionally (an evaluation belongs to its run regardless of run status):

```typescript
      const cat = categoryByRun.get(run.id);
      if (cat) {
        acc.catCorrect += cat.correct;
        acc.catPartial += cat.partial;
        acc.catLucky += cat.lucky;
      }
```

- In the row map, next to `avgIssues`:

```typescript
      const categoryEvaluated = acc.catCorrect + acc.catPartial + acc.catLucky;
```

```typescript
        categoryCorrect: acc.catCorrect,
        categoryPartial: acc.catPartial,
        categoryLucky: acc.catLucky,
        categoryEvaluated,
        categoryAccuracy:
          categoryEvaluated === 0 ? null : (acc.catCorrect / categoryEvaluated) * 100,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npm test -- strategy.service.spec`
Expected: PASS (existing tests untouched — the default `categoryEvaluationRepo` mock returns `[]`, so every existing row gets zeroed counts and `categoryAccuracy: null`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/dto/strategy.dto.ts \
  backend/src/modules/strategy/strategy.service.ts \
  backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat: aggregate category-accuracy verdict counts onto leaderboard rows"
```

---

## Task 10: Attach evaluations to proposal DTOs in the guess chain

**Files:**
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts` (`CategoryEvaluationDto`, `LlmProposalDto`)
- Modify: `backend/src/modules/strategy/strategy.service.ts` (`buildSolvePromptDtos`)
- Modify: `backend/src/modules/strategy/prompt-reconstruction.ts` (pass evaluations through to proposal DTOs) — check this file; `reconstructSolvePrompts` builds the `LlmProposalDto[]`.
- Test: `backend/src/modules/strategy/strategy.service.spec.ts` or `prompt-reconstruction.spec.ts` (whichever builds proposal DTOs)

**Interfaces:**
- Consumes: `CategoryEvaluation` rows for a run.
- Produces:
  - `CategoryEvaluationDto` (see spec §6e — exact field list below).
  - `LlmProposalDto.categoryEvaluation: CategoryEvaluationDto | null`.

- [ ] **Step 1: Read `prompt-reconstruction.ts`**

Confirm where `LlmProposalDto` objects are constructed (`reconstructSolvePrompts` maps `LlmProposal` → `LlmProposalDto`). The new field is populated there from a `Map<number, CategoryEvaluation>` passed in, or attached afterwards in `buildSolvePromptDtos` by walking `dto.solvePrompts[].proposals[]`. Prefer attaching afterwards in `buildSolvePromptDtos` to keep `reconstructSolvePrompts`'s signature stable — decide based on what the file shows.

- [ ] **Step 2: Write the failing test**

In the spec that covers `getRunDetailByRunId` / `buildSolvePromptDtos` (search `strategy.service.spec.ts` for `solvePrompts`), add: given a run whose `llmProposalRepo.find` returns a `used` proposal with `id: 55`, and `categoryEvaluationRepo.find` returns `[{ llmProposalId: 55, verdict: "correct", status: "judged", proposedCategory: "X", actualCategory: "Y", rationale: "r", judgeModel: "gpt-4.1-nano", judgeProvider: "openai", promptTokens: 10, completionTokens: 2, totalTokens: 12, latencyMs: 5, statusCode: null, errorName: null, errorMessage: null, requestBody: null, responseHeaders: null, responseBody: null, rawResponseText: "{}", evaluatedAt: new Date() }]`, the returned `solvePrompts[0].proposals[0].categoryEvaluation` deep-equals a `CategoryEvaluationDto` with `verdict: "correct"`, and a proposal with no evaluation has `categoryEvaluation: null`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npm test -- strategy.service.spec -t "categoryEvaluation"`
Expected: FAIL — property is `undefined`.

- [ ] **Step 4: Add the DTO**

In `strategy.dto.ts`:

```typescript
// One LLM-judge verdict on a used proposal's category (see
// 2026-08-27-llm-category-accuracy-evaluation-design.md). Present only on a
// proposal that was submitted, whose guess succeeded, and that has been
// evaluated — null everywhere else. `verdict` is null on a `callError`
// row; the error/raw fields carry the judge-call diagnostics for auditing.
export interface CategoryEvaluationDto {
  verdict: "correct" | "partial" | "lucky" | null;
  status: "judged" | "callError";
  proposedCategory: string;
  actualCategory: string;
  rationale: string | null;
  judgeModel: string;
  judgeProvider: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  statusCode: number | null;
  errorName: string | null;
  errorMessage: string | null;
  requestBody: unknown | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown | null;
  rawResponseText: string | null;
  evaluatedAt: Date;
}
```

Add to `LlmProposalDto` (after `guess`):

```typescript
  categoryEvaluation: CategoryEvaluationDto | null;
```

- [ ] **Step 5: Populate it**

In `buildSolvePromptDtos` (`strategy.service.ts`), add `this.categoryEvaluationRepo.find({ where: { strategyRunId: run.id } })` to the `Promise.all`, build `const evalByProposalId = new Map(catEvals.map((e) => [e.llmProposalId, e]))`, and after `reconstructSolvePrompts(...)` returns `dtos`, walk them:

```typescript
    for (const prompt of dtos) {
      for (const proposal of prompt.proposals) {
        const e = evalByProposalId.get(proposal.id);
        proposal.categoryEvaluation = e ? toCategoryEvaluationDto(e) : null;
      }
    }
    return dtos;
```

Add a private mapper `toCategoryEvaluationDto(e: CategoryEvaluation): CategoryEvaluationDto` that copies the fields 1:1 (`verdict: e.verdict ?? null`, etc.).

If `reconstructSolvePrompts` (in `prompt-reconstruction.ts`) constructs proposal DTOs without the new key, add `categoryEvaluation: null` to its object literal so the shape is always present before the walk overwrites it.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npm test -- strategy.service.spec prompt-reconstruction.spec`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/dto/strategy.dto.ts \
  backend/src/modules/strategy/strategy.service.ts \
  backend/src/modules/strategy/prompt-reconstruction.ts \
  backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat: expose category evaluations on guess-chain proposal DTOs"
```

---

## Task 11: Frontend — row type, "Category IQ" column, sortable metric

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/metrics.ts`
- Modify: `frontend/src/data/benchmark/metrics.test.ts`
- Modify: `frontend/src/components/benchmark/StrategyTable.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/` StrategyTable/Leaderboard tests + `frontend/src/data/benchmark/mockData.ts`

**Interfaces:**
- Consumes: `LeaderboardRowDto` fields from Task 9 (raw JSON passthrough).
- Produces:
  - `LeaderboardRow` gains `categoryCorrect: number; categoryPartial: number; categoryLucky: number; categoryEvaluated: number; categoryAccuracy: number | null;`.
  - `metrics.ts`: `LeaderboardMetricKey` adds `"categoryAccuracy"`; `MetricSource` adds `categoryAccuracy: number | null`; `LEADERBOARD_METRICS` gains the entry; `metricValue` handles it.

- [ ] **Step 1: Write the failing metrics test**

In `frontend/src/data/benchmark/metrics.test.ts`:

```typescript
import { sortStrategiesByMetric, metricValue, getMetricDefinition } from "./metrics";

const row = (id: string, categoryAccuracy: number | null) =>
  ({ id, avgGuessesToSolve: null, successRate: null, avgDurationMs: null, categoryAccuracy }) as never;

describe("categoryAccuracy metric", () => {
  it("sorts highest accuracy first, nulls last", () => {
    const sorted = sortStrategiesByMetric(
      [row("a", 40), row("b", null), row("c", 90)],
      "categoryAccuracy",
    );
    expect(sorted.map((r) => (r as { id: string }).id)).toEqual(["c", "a", "b"]);
  });

  it("reads the value and formats as a percent to 3 sig figs", () => {
    expect(metricValue(row("a", 33.333), "categoryAccuracy")).toBeCloseTo(33.333);
    expect(getMetricDefinition("categoryAccuracy").format(33.333)).toBe("33.3%");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- metrics.test`
Expected: FAIL — `"categoryAccuracy"` not assignable to `LeaderboardMetricKey`.

- [ ] **Step 3: Update `types.ts`**

In `LeaderboardRow`, after `avgIssues`:

```typescript
  /** Category-reasoning quality for this model's successful guesses, from
   * the LLM judge. correct/partial/lucky are raw verdict counts;
   * categoryEvaluated is their sum. categoryAccuracy is
   * correct / categoryEvaluated * 100, or null when nothing has been
   * evaluated (also the case for every deterministic/shuffle row). */
  categoryCorrect: number;
  categoryPartial: number;
  categoryLucky: number;
  categoryEvaluated: number;
  categoryAccuracy: number | null;
```

- [ ] **Step 4: Update `metrics.ts`**

- `LeaderboardMetricKey`: `"avgGuesses" | "successRate" | "speed" | "categoryAccuracy"`.
- `LEADERBOARD_METRICS` — new entry:

```typescript
  {
    key: "categoryAccuracy",
    label: "Category IQ",
    description: "Share of evaluated successful guesses where the model named the real connection",
    higherIsBetter: true,
    format: (value) => formatSuccessRate(value),
  },
```

- `MetricSource`: add `categoryAccuracy: number | null;`.
- `metricValue`: add `case "categoryAccuracy": return strategy.categoryAccuracy;`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- metrics.test`
Expected: PASS.

- [ ] **Step 6: Write the failing StrategyTable test**

In the StrategyTable test file, extend the LLM-row fixture with the five fields (e.g. `categoryCorrect: 6, categoryPartial: 2, categoryLucky: 2, categoryEvaluated: 10, categoryAccuracy: 60`) and assert:
- the LLM table renders a `Category IQ` column header and a cell showing `60%`;
- a row with `categoryEvaluated: 0, categoryAccuracy: null` renders `—`;
- the deterministic table does **not** render a `Category IQ` header.

- [ ] **Step 7: Run test to verify it fails**

Run: `cd frontend && npm test -- StrategyTable`
Expected: FAIL — no `Category IQ` header.

- [ ] **Step 8: Update `StrategyTable.tsx`**

In the `<thead>`, after the `Avg issues` header (inside the `variant === "llm"` branch — currently the `<th scope="col">Avg issues</th>` in the `else` of `isDeterministic`):

```tsx
            <th scope="col">Category IQ</th>
```

In the body, right after the `Avg issues` cell (`<td className="bench-mono">{row.avgIssues === null ? "—" : row.avgIssues.toFixed(1)}</td>`), still inside the non-deterministic branch:

```tsx
                <td
                  className="bench-mono"
                  title={
                    row.categoryEvaluated === 0
                      ? "No successful guesses evaluated yet"
                      : `${row.categoryCorrect} of ${row.categoryEvaluated} correct · ${row.categoryPartial} partial · ${row.categoryLucky} lucky`
                  }
                >
                  {row.categoryAccuracy === null
                    ? "—"
                    : formatSuccessRate(row.categoryAccuracy)}
                </td>
```

`formatSuccessRate` is already imported in this file.

- [ ] **Step 9: Fix other fixtures**

Search `frontend/src` for `LeaderboardRow` fixtures missing the new fields: `mockData.ts` (`describeLeaderboardRow` sample rows), `LeaderboardPage.test.tsx`, any `api` test. Add the five fields to each (use `categoryAccuracy: null` where the test doesn't care).

- [ ] **Step 10: Run tests**

Run: `cd frontend && npm test -- StrategyTable metrics LeaderboardPage`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/metrics.ts \
  frontend/src/data/benchmark/metrics.test.ts frontend/src/data/benchmark/mockData.ts \
  frontend/src/components/benchmark/StrategyTable.tsx frontend/src/components/benchmark/__tests__ \
  frontend/src/pages/benchmark/__tests__/LeaderboardPage.test.tsx
git commit -m "feat: add Category IQ leaderboard column and sortable metric"
```

---

## Task 12: Frontend — detail-page breakdown + guess-chain verdict

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts` (`CategoryEvaluationRecord`, `LlmProposalRecord.categoryEvaluation`)
- Modify: `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`
- Modify: `frontend/src/components/benchmark/GuessChainVisualizer.tsx`
- Modify: their test files + `frontend/src/data/benchmark/mockData.ts`

**Interfaces:**
- Consumes: `CategoryEvaluationDto` (Task 10) via raw JSON; `LeaderboardRow.category*` (Task 11).
- Produces:
  - `CategoryEvaluationRecord` (mirror of `CategoryEvaluationDto`, dates as `string`).
  - `LlmProposalRecord.categoryEvaluation: CategoryEvaluationRecord | null`.

- [ ] **Step 1: Write the failing GuessChainVisualizer test**

In the GuessChainVisualizer test file, build a `SolvePromptRecord` fixture whose `proposals[0]` is `status: "used"` with:

```typescript
categoryEvaluation: {
  verdict: "lucky",
  status: "judged",
  proposedCategory: "Fruits",
  actualCategory: "___ COBBLER",
  rationale: "Right words, wrong reason.",
  judgeModel: "gpt-4.1-nano",
  judgeProvider: "openai",
  promptTokens: 90, completionTokens: 8, totalTokens: 98,
  latencyMs: 30, statusCode: null, errorName: null, errorMessage: null,
  requestBody: null, responseHeaders: null, responseBody: null,
  rawResponseText: '{"verdict":"lucky"}', evaluatedAt: "2026-08-27T00:00:00.000Z",
}
```

Assert: a pill with text matching `/lucky/i` renders in that proposal row; a `Category judge` `<summary>` is present; expanding it shows `Fruits`, `___ COBBLER`, and `Right words, wrong reason.`. Add a second fixture proposal with `categoryEvaluation: null` and assert no judge pill/section for it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- GuessChainVisualizer`
Expected: FAIL — no `lucky` pill / no `Category judge` text.

- [ ] **Step 3: Update `types.ts`**

```typescript
export type CategoryVerdictValue = "correct" | "partial" | "lucky";

/** One LLM-judge verdict on a used proposal's category — see
 * CategoryEvaluationDto on the backend. Present only on a submitted
 * proposal whose guess succeeded and that has been evaluated. `verdict` is
 * null on a `callError` row. */
export interface CategoryEvaluationRecord {
  verdict: CategoryVerdictValue | null;
  status: "judged" | "callError";
  proposedCategory: string;
  actualCategory: string;
  rationale: string | null;
  judgeModel: string;
  judgeProvider: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  statusCode: number | null;
  errorName: string | null;
  errorMessage: string | null;
  requestBody: unknown | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown | null;
  rawResponseText: string | null;
  evaluatedAt: string;
}
```

Add to `LlmProposalRecord`:

```typescript
  categoryEvaluation: CategoryEvaluationRecord | null;
```

- [ ] **Step 4: Update `GuessChainVisualizer.tsx`**

Add helpers next to `issueTagLabel`:

```typescript
function categoryVerdictLabel(verdict: string | null): string {
  switch (verdict) {
    case "correct": return "Category: correct";
    case "partial": return "Category: partial";
    case "lucky": return "Category: lucky";
    default: return "Category: judge failed";
  }
}

function categoryVerdictTone(verdict: string | null): "success" | "neutral" | "failed" {
  if (verdict === "correct") return "success";
  if (verdict === "partial") return "neutral";
  return "failed";
}
```

In `ProposalRow`, after the existing `proposal.guess` pill block, when `proposal.categoryEvaluation` is set:

```tsx
      {proposal.categoryEvaluation ? (
        <>
          <StatusPill
            label={categoryVerdictLabel(proposal.categoryEvaluation.verdict)}
            tone={categoryVerdictTone(proposal.categoryEvaluation.verdict)}
          />
          <details className="bench-step__detail">
            <summary>Category judge</summary>
            <div className="bench-proposal__judge">
              <p><strong>Proposed:</strong> {proposal.categoryEvaluation.proposedCategory}</p>
              <p><strong>Actual:</strong> {proposal.categoryEvaluation.actualCategory}</p>
              {proposal.categoryEvaluation.rationale ? (
                <p>{proposal.categoryEvaluation.rationale}</p>
              ) : null}
              <p className="bench-mono bench-muted">
                {[
                  `${proposal.categoryEvaluation.judgeProvider}/${proposal.categoryEvaluation.judgeModel}`,
                  proposal.categoryEvaluation.totalTokens !== null
                    ? `${proposal.categoryEvaluation.totalTokens} tok`
                    : null,
                  proposal.categoryEvaluation.latencyMs !== null
                    ? formatDuration(proposal.categoryEvaluation.latencyMs)
                    : null,
                  proposal.categoryEvaluation.statusCode !== null
                    ? `HTTP ${proposal.categoryEvaluation.statusCode}`
                    : null,
                ].filter(Boolean).join(" · ")}
              </p>
              {proposal.categoryEvaluation.errorMessage ? (
                <p className="bench-error">
                  {proposal.categoryEvaluation.errorName}: {proposal.categoryEvaluation.errorMessage}
                </p>
              ) : null}
              {proposal.categoryEvaluation.requestBody !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge request</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.requestBody, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.responseHeaders !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge response headers</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.responseHeaders, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.responseBody !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge response body</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.responseBody, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.rawResponseText ? (
                <details className="bench-step__detail">
                  <summary>Judge raw output</summary>
                  <pre className="bench-step__pre">{proposal.categoryEvaluation.rawResponseText}</pre>
                </details>
              ) : null}
            </div>
          </details>
        </>
      ) : null}
```

`formatDuration` is already imported. Add a `.bench-proposal__judge` rule to `frontend/src/benchmark.css` (small padding/left border, reuse existing tokens — copy the pattern from `.bench-call-error`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- GuessChainVisualizer`
Expected: PASS.

- [ ] **Step 6: Write the failing StrategyPuzzlePage test**

In its test file, extend the aggregate-row fixture with `categoryCorrect: 6, categoryPartial: 2, categoryLucky: 2, categoryEvaluated: 10, categoryAccuracy: 60`. Assert the page renders `Category IQ`, `60%`, and the split text `6 correct · 2 partial · 2 lucky`. Add a second case with `categoryEvaluated: 0` asserting `not yet evaluated`.

- [ ] **Step 7: Run test to verify it fails**

Run: `cd frontend && npm test -- StrategyPuzzlePage`
Expected: FAIL.

- [ ] **Step 8: Update `StrategyPuzzlePage.tsx`**

Near the existing success-rate summary (search for `formatSuccessRate` / `successRate` in this file), add a block:

```tsx
      <div className="bench-summary__item">
        <span className="bench-summary__label">Category IQ</span>
        <span className="bench-summary__value">
          {row.categoryEvaluated === 0
            ? "not yet evaluated"
            : formatSuccessRate(row.categoryAccuracy ?? 0)}
        </span>
        {row.categoryEvaluated > 0 ? (
          <span className="bench-muted bench-mono">
            {row.categoryCorrect} correct · {row.categoryPartial} partial ·{" "}
            {row.categoryLucky} lucky (of {row.categoryEvaluated})
          </span>
        ) : null}
      </div>
```

Match the surrounding markup's actual class names — adapt the `className`s to whatever the existing summary items in that file use. Import `formatSuccessRate` from `../../data/benchmark/metrics` if not already imported.

- [ ] **Step 9: Update remaining fixtures**

Any other `LlmProposalRecord` fixture in `frontend/src` (search `mockData.ts`, `GuessChainVisualizer` tests, `PuzzleRunsPage.test.tsx`, `benchmark` fixtures) gains `categoryEvaluation: null`.

- [ ] **Step 10: Run the frontend suite**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/mockData.ts \
  frontend/src/pages/benchmark/StrategyPuzzlePage.tsx frontend/src/pages/benchmark/__tests__ \
  frontend/src/components/benchmark/GuessChainVisualizer.tsx \
  frontend/src/components/benchmark/__tests__ frontend/src/benchmark.css
git commit -m "feat: show category verdict on the per-model page and in the guess chain"
```

---

## Task 13: End-to-end wiring check + docs

**Files:**
- Modify: `backend/test/app.e2e-spec.ts` (add a `/judge-category`-mocked flow if the e2e harness already stubs the orchestrator; otherwise skip and rely on unit coverage)
- Modify: `DESIGN.md` (short paragraph under the benchmark/leaderboard section noting the Category IQ column + `/dispatch/evaluate-categories`)

- [ ] **Step 1: Full backend suite**

Run: `cd backend && npm test`
Expected: PASS. Then `cd backend && npx tsc --noEmit` — no type errors.

- [ ] **Step 2: Full orchestrator + frontend suites**

Run: `cd orchestrator && npm test` and `cd frontend && npm test && npm run build`
Expected: all PASS, frontend builds.

- [ ] **Step 3: Manual smoke (compose stack)**

With `docker compose -p connections-dev up` and at least one completed LLM run that solved at least one group:

1. `curl -X POST 'http://localhost:4000/api/dispatch/evaluate-categories?limit=3' -H 'content-type: application/json' -d '{}'` → `{ enqueued: N, ... }`.
2. Watch the worker log process `evaluate-category` jobs.
3. `SELECT verdict, "proposedCategory", "actualCategory", rationale FROM "CategoryEvaluation";` → rows present.
4. Reload `/leaderboard` → LLM table shows a `Category IQ` value for that model; sort by `Category IQ` works.
5. Open that model's detail page → breakdown block shows the split.
6. Open a solved run's guess chain → the winning proposal shows a verdict pill and an expandable "Category judge" block with the request/response detail.

- [ ] **Step 4: Update `DESIGN.md`**

Add a short paragraph (2-4 sentences) under the leaderboard section: what Category IQ measures, that it's populated by `POST /dispatch/evaluate-categories` enqueuing LLM-judge jobs on the judge provider's queue, and that per-verdict detail with full judge-call diagnostics is on the guess-chain view.

- [ ] **Step 5: Commit**

```bash
git add DESIGN.md backend/test/app.e2e-spec.ts
git commit -m "docs: note category-accuracy evaluation in DESIGN.md"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
| --- | --- |
| §1 `CategoryEvaluation` entity + migration + registration | Task 1 |
| §2 population (used + success) + word→group match | Task 5 (`matchAnswerGroup`, `evaluateProposal` guards), Task 6 (`enqueuePending` query) |
| §3 orchestrator `/judge-category` + prompt + `generateObject` + env + `OrchestratorService.judgeCategory` | Task 2 (endpoint/prompt), Task 3 (backend client + env) |
| §4a finish `llm-google` queue wiring | Task 4 |
| §4b job (one per proposal, name, jobId, judge-provider queue) | Task 4 (helpers), Task 6 (`enqueuePending` adds jobs) |
| §4c worker `job.name` branch | Task 7 |
| §4d `POST /dispatch/evaluate-categories` behind `DispatchAuthGuard` | Task 6 |
| §4e `CategoryEvaluatorService` (`evaluateProposal`, `enqueuePending`, `EVALUATOR_VERSION`, callError row, idempotency) | Task 5, Task 6 |
| §4f CLI script + npm script | Task 8 |
| §4g future inline hook (not built) | noted in Task 5 interfaces / spec non-goal — no task, intentional |
| §5 leaderboard aggregation query + accumulator + DTO fields + callError excluded | Task 9 |
| §6a `LeaderboardRow` type | Task 11 |
| §6b "Category IQ" column | Task 11 |
| §6c sortable metric | Task 11 |
| §6d per-model detail breakdown | Task 12 |
| §6e guess-chain: `LlmProposalDto.categoryEvaluation`, `CategoryEvaluationDto`, `buildSolvePromptDtos` attach, `ProposalRow` pill + details | Task 10 (backend), Task 12 (frontend) |
| §7 testing | every task is TDD; Task 13 runs the full suites + manual smoke |

No gaps.

**2. Placeholder scan** — Task 10 Step 1 leaves the exact test-file choice ("`strategy.service.spec.ts` or `prompt-reconstruction.spec.ts`") to a Step-1 read of `prompt-reconstruction.ts`; this is a genuine "inspect then decide" branch with both outcomes specified, not a deferred detail. Task 8's `--force` extension is fully specified inline (query clause dropped, job-data flag, handler read, one new test). No `TODO`/`TBD`/"handle edge cases".

**3. Type consistency**

- `evaluateProposal(llmProposalId: number, opts?: { force?: boolean })` — same signature in Task 5 (definition), Task 7 (`handleLlmJob` calls `evaluateProposal(llmProposalId)` / `{ force: true }`), Task 8 (force path).
- `enqueuePending(opts?: { limit?: number; force?: boolean })` returning `{ enqueued: number; llmProposalIds: number[] }` — consistent across Tasks 6, 8, and the dispatch controller.
- `queueForStrategy` 5-arg form — defined Task 4, updated at its one call site in the same task.
- Verdict enum: backend `CategoryEvalVerdict` (`correct`/`partial`/`lucky`) in Task 1; DTO/type string unions `"correct" | "partial" | "lucky" | null` in Tasks 10–12 — the `null` is the `callError` case, consistent with the nullable entity column.
- `CategoryEvaluationDto` field list identical in Task 10 (backend) and `CategoryEvaluationRecord` in Task 12 (frontend, `evaluatedAt` narrowed to `string`).
- Leaderboard fields `categoryCorrect/Partial/Lucky/Evaluated/Accuracy` identical in Task 9 (DTO) and Task 11 (`LeaderboardRow`).
- `job.name === "evaluate-category"` and job data `{ llmProposalId }` — same string/shape in Task 4 (`categoryEvalJobId` comment), Task 6 (`queue.add`), Task 7 (handler).

Consistent.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-27-llm-category-accuracy-evaluation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
