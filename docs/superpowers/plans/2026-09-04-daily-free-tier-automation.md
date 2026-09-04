# Daily Free-Tier Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically, once a day: enqueue the category-judge backlog, burn the OpenAI mini/nano free tier up to a ceiling that leaves headroom for judge spend, and burn Google's free daily RPD quota — with a UI surface showing whether today's run happened and when the next one fires.

**Architecture:** A new `DailyAutomationBootstrap` schedules a `"15 0 * * *"` UTC cron. It fires `DailyAutomationService.run()`, which kicks off three independent legs — judge-backlog dispatch, an 80%-ceiling `FreeTierDispatchService.start("mini", 80)` call, and a new `GoogleFreeDispatchService.start()` (a Google-specific sibling of `FreeTierDispatchService` whose stop condition is "every Google model RPD-held" instead of a token threshold) — recording each leg's outcome into a per-UTC-day `AutomationRunLog` row. A new `GET /automation/status` endpoint reads that row; the frontend threads it into the existing `FreeTierBudgetWidget` (mini) and `CategoryJudgingWidget`, plus a new `GoogleDispatchWidget`, each showing an "Auto-run: ... · Next: ..." line.

**Tech Stack:** NestJS + TypeORM + Postgres + BullMQ (backend/worker), React + Vitest (frontend). Backend tests: Jest. Frontend tests: Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md`

## Global Constraints

- **Flagship tier is untouched.** Only the `mini` OpenAI tier and Google get daily automation. Nothing here changes `FreeTierDispatchService`'s existing manual `start`/`stop`/threshold behavior for either tier.
- **Mini/nano burn ceiling is a fixed 80%**, not env-configurable (95% overall safety cap − 15% reserve for judge spend, per the approved spec). A human-started manual cycle can still use any threshold via the existing UI.
- **Judge leg's enqueue limit is 500** — the same `MAX_LIMIT` `CategoryEvaluatorService.enqueuePending` already enforces internally, so the daily leg asks for as much as a manual dispatch is ever allowed to enqueue in one call.
- **Google's tick pacing reuses the existing `FREE_TIER_DISPATCH_*` env knobs** (`freeTierDispatchTickMs`/`MaxBatch`/`MaxInFlight`) rather than introducing a parallel `GOOGLE_FREE_DISPATCH_*` family — no new environment variables in this plan.
- **Daily cron is fixed at `"15 0 * * *"` UTC**, not configurable — matches the pattern `ModelMetadataRefreshBootstrap`/`GoogleRpdResumeBootstrap` already use for their own fixed schedules.
- Every `OnApplicationBootstrap` this plan adds must skip scheduling under `NODE_ENV=test`, exactly like `GoogleRpdResumeBootstrap`/`ModelMetadataRefreshBootstrap`.
- **Explicit `@Inject(Token)` for every class-to-class constructor injection** — bare typed parameters silently resolve to `undefined` under this backend's `tsx`/`esbuild` worker runtime.
- New migration timestamps: `1778000000000` (`AutomationRunLog`) and `1779000000000` (`GoogleDispatchState`) — the next two free slots after `1777000000000-add-google-rate-limit-hold.ts`.
- This backend/worker runs against a shared local `connections-dev` Postgres alongside other active work — **do not run `npm run migration:run` / `migration:revert` during task execution.** Write migration files, sanity-check the SQL by eye, and defer the actual run/revert round-trip to Final Verification.
- TDD throughout: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Controllers and `*.module.ts` files in this codebase are thin DI/routing wiring with no dedicated test files (see `dispatch.controller.ts`, `category-evaluation.controller.ts`, every `*.module.ts`) — this plan follows that convention and does not add spec files for `AutomationController` or any `*.module.ts`; verify those via typecheck and the services they wire.

---

### Task 1: `AutomationRunLog` + `GoogleDispatchState` entities and migrations

**Files:**
- Create: `backend/src/modules/automation/entities/automation-run-log.entity.ts`
- Create: `backend/src/modules/google-free-dispatch/entities/google-dispatch-state.entity.ts`
- Create: `backend/src/migrations/1778000000000-add-automation-run-log.ts`
- Create: `backend/src/migrations/1779000000000-add-google-dispatch-state.ts`
- Modify: `backend/src/app.module.ts` (entity imports + `entities: [...]` array)
- Modify: `backend/src/data-source.ts` (entity imports + `entities: [...]` array)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `AutomationLegOutcome = "started" | "alreadyActive" | "alreadyExhausted" | "error"`.
  - Entity `AutomationRunLog`: `date: string` (PK), `triggeredAt: Date`, `judgeEnqueued: number | null`, `judgeError: string | null`, `miniBurnOutcome: AutomationLegOutcome | null`, `miniBurnMessage: string | null`, `googleBurnOutcome: AutomationLegOutcome | null`, `googleBurnMessage: string | null`, `updatedAt: Date`. Table `"AutomationRunLog"`.
  - Entity `GoogleDispatchState`: `id: string` (PK), `active: boolean`, `startedAt: Date | null`, `updatedAt: Date`. Table `"GoogleDispatchState"`.

- [ ] **Step 1: Create the `AutomationRunLog` entity**

`backend/src/modules/automation/entities/automation-run-log.entity.ts`:

```ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/** Outcome of one leg of the daily-automation chain — see
 * DailyAutomationService. "alreadyExhausted" only ever applies to the
 * Google-burn leg (GoogleFreeDispatchService.start() checks up front whether
 * every Google model is already RPD-held); the OpenAI mini-burn leg only
 * ever reports "started", "alreadyActive", or "error". */
export type AutomationLegOutcome = "started" | "alreadyActive" | "alreadyExhausted" | "error";

/**
 * One row per UTC calendar day (`date`, "YYYY-MM-DD"), upserted as each leg
 * of the daily-automation chain (judge dispatch, OpenAI mini/nano burn,
 * Google burn — see DailyAutomationService) reports its outcome. This is the
 * single source of truth the UI reads to answer "did today's automatic run
 * happen, and what did it do" — rather than inferring it from three
 * different subsystems' own live state. See
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
 */
@Entity("AutomationRunLog")
export class AutomationRunLog {
  @PrimaryColumn({ type: "varchar" })
  date: string;

  @Column({ type: "timestamptz" })
  triggeredAt: Date;

  @Column({ type: "int", nullable: true })
  judgeEnqueued: number | null;

  @Column({ type: "text", nullable: true })
  judgeError: string | null;

  @Column({ type: "varchar", nullable: true })
  miniBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  miniBurnMessage: string | null;

  @Column({ type: "varchar", nullable: true })
  googleBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  googleBurnMessage: string | null;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
```

- [ ] **Step 2: Create the `GoogleDispatchState` entity**

`backend/src/modules/google-free-dispatch/entities/google-dispatch-state.entity.ts`:

```ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "google") tracking whether the Google
 * free-daily-quota dispatch cycle (GoogleFreeDispatchService) is currently
 * running — the Google counterpart to FreeTierDispatchState, minus
 * thresholdPercent: Google has no token budget to compare a percentage
 * against, only a requests-per-day cap enforced by Google itself.
 */
@Entity("GoogleDispatchState")
export class GoogleDispatchState {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ type: "boolean", default: false })
  active: boolean;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
```

- [ ] **Step 3: Create the `AutomationRunLog` migration**

`backend/src/migrations/1778000000000-add-automation-run-log.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One row per UTC calendar day, upserted as each leg of the daily
 * free-tier-automation chain (DailyAutomationService) reports its outcome —
 * the source of truth the UI reads for "did today's automatic run happen,
 * and what did it do". See
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
 */
export class AddAutomationRunLog1778000000000 implements MigrationInterface {
  name = "AddAutomationRunLog1778000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "AutomationRunLog" (
        "date" VARCHAR PRIMARY KEY,
        "triggeredAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "judgeEnqueued" INT,
        "judgeError" TEXT,
        "miniBurnOutcome" VARCHAR,
        "miniBurnMessage" TEXT,
        "googleBurnOutcome" VARCHAR,
        "googleBurnMessage" TEXT,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "AutomationRunLog"`);
  }
}
```

- [ ] **Step 4: Create the `GoogleDispatchState` migration**

`backend/src/migrations/1779000000000-add-google-dispatch-state.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the Google free-daily-quota dispatch
 * cycle (GoogleFreeDispatchService) is currently running — the Google
 * counterpart to FreeTierDispatchState, minus thresholdPercent (Google has
 * no token budget, only a requests-per-day cap enforced by Google itself).
 */
export class AddGoogleDispatchState1779000000000 implements MigrationInterface {
  name = "AddGoogleDispatchState1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GoogleDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GoogleDispatchState"`);
  }
}
```

- [ ] **Step 5: Register both entities in `app.module.ts`**

In `backend/src/app.module.ts`, add imports next to the other entity imports:

```ts
import { AutomationRunLog } from "./modules/automation/entities/automation-run-log.entity";
import { GoogleDispatchState } from "./modules/google-free-dispatch/entities/google-dispatch-state.entity";
```

and add both to the `entities: [...]` array in the `TypeOrmModule.forRootAsync` factory (after `FreeTierDispatchState`).

- [ ] **Step 6: Register both entities in `data-source.ts`**

In `backend/src/data-source.ts`, add the same two imports and add both to its `entities: [...]` array (after `FreeTierDispatchState`).

- [ ] **Step 7: Migration run/revert — DEFERRED**

Do **not** run `npm run migration:run` / `migration:revert` here (shared `connections-dev` Postgres — see Global Constraints). Sanity-check the SQL by eye: table/column names match the entities, and `down()` drops each table. The actual up/down/up round-trip is verified later, serially, in Final Verification.

- [ ] **Step 8: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/automation/entities/automation-run-log.entity.ts backend/src/modules/google-free-dispatch/entities/google-dispatch-state.entity.ts backend/src/migrations/1778000000000-add-automation-run-log.ts backend/src/migrations/1779000000000-add-google-dispatch-state.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "feat: add AutomationRunLog and GoogleDispatchState entities"
```

---

### Task 2: `SupportedModelService.findModelNamesByStrategy`

**Files:**
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Test: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SupportedModelService.findModelNamesByStrategy(strategyName: string): Promise<string[]>` — model names for `strategyName` where `supported: true`, ordered by id. Task 3's `GoogleFreeDispatchService` calls this with `"llm-google"`.

- [ ] **Step 1: Write the failing tests**

Append to the end of the `describe("SupportedModelService", ...)` block in `backend/src/modules/supported-model/supported-model.service.spec.ts` (as a new `describe` alongside the existing `findModelNamesByFreeTier` one):

```ts
  describe("findModelNamesByStrategy", () => {
    it("should return only model names matching the given strategy, supported only", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { id: 1, strategyName: "llm-google", modelName: "gemini-2.5-flash", supported: true },
        { id: 2, strategyName: "llm-google", modelName: "gemini-2.5-pro", supported: true },
      ]);

      const result = await service.findModelNamesByStrategy("llm-google");

      expect(result).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { strategyName: "llm-google", supported: true },
        order: { id: "ASC" },
      });
    });

    it("should return an empty array when no models are configured for the strategy", async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const result = await service.findModelNamesByStrategy("llm-ollama");

      expect(result).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/supported-model/supported-model.service.spec.ts`
Expected: FAIL — `service.findModelNamesByStrategy is not a function`.

- [ ] **Step 3: Implement the method**

In `backend/src/modules/supported-model/supported-model.service.ts`, add after `findModelNamesByFreeTier`:

```ts
  /**
   * Model names currently configured for `strategyName` and marked
   * `supported: true` — the strategy-keyed counterpart to
   * findModelNamesByFreeTier above (which is keyed by the freeTier column
   * instead). Used by GoogleFreeDispatchService to find which models the
   * Google burn cycle should spread across. Ordered by id, same convention
   * as every other lookup in this service.
   */
  async findModelNamesByStrategy(strategyName: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { strategyName, supported: true },
      order: { id: "ASC" },
    });
    return rows.map((row) => row.modelName);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/supported-model/supported-model.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/supported-model.service.ts backend/src/modules/supported-model/supported-model.service.spec.ts
git commit -m "feat: add SupportedModelService.findModelNamesByStrategy"
```

---

### Task 3: `GoogleFreeDispatchService`, its queue/module, and a read-only status route

**Files:**
- Create: `backend/src/modules/queue/google-free-dispatch.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Create: `backend/src/modules/google-free-dispatch/google-free-dispatch.service.ts`
- Test: `backend/src/modules/google-free-dispatch/google-free-dispatch.service.spec.ts`
- Create: `backend/src/modules/google-free-dispatch/google-free-dispatch.module.ts`
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `backend/src/modules/dispatch/dispatch.module.ts`
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `GoogleDispatchState` entity (Task 1), `SupportedModelService.findModelNamesByStrategy` (Task 2), `StrategyService.countInFlightByModel/countTodayDispatchByModel/findUnrunPuzzleDatesForModel/triggerStrategyRuns` (existing), `GoogleRateLimitHoldService.heldModels` (existing), `LLM_GOOGLE` (existing, `../../strategies`).
- Produces: `GoogleDispatchStatusDto = { active: boolean; startedAt: Date | null }`; `GoogleFreeDispatchService.start(): Promise<{ status: GoogleDispatchStatusDto; outcome: "started" | "alreadyExhausted" }>` (throws `BadRequestException` if already active); `.stop(): Promise<GoogleDispatchStatusDto>`; `.getStatus(): Promise<GoogleDispatchStatusDto>`; `.runTick(): Promise<void>`. `GET /dispatch/google` returning `GoogleDispatchStatusDto`. Task 4's `DailyAutomationService` and Task 10's frontend `fetchGoogleDispatchStatus` both depend on this.

- [ ] **Step 1: Write the failing service tests**

`backend/src/modules/google-free-dispatch/google-free-dispatch.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GoogleFreeDispatchService } from "./google-free-dispatch.service";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { GOOGLE_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { GoogleRateLimitHoldService } from "../strategy/google-rate-limit-hold.service";

const GOOGLE_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

describe("GoogleFreeDispatchService", () => {
  let service: GoogleFreeDispatchService;
  let mockStateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStrategyService: {
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  let mockSupportedModelService: { findModelNamesByStrategy: jest.Mock };
  let mockHoldService: { heldModels: jest.Mock };

  const zeroCounts = () => new Map(GOOGLE_MODELS.map((model) => [model, 0]));

  beforeEach(async () => {
    mockStateRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
    mockStrategyService = {
      countInFlightByModel: jest.fn().mockResolvedValue(zeroCounts()),
      countTodayDispatchByModel: jest.fn().mockResolvedValue(zeroCounts()),
      findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2024-01-01" }]),
      triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
    };
    mockSupportedModelService = {
      findModelNamesByStrategy: jest.fn().mockResolvedValue([...GOOGLE_MODELS]),
    };
    mockHoldService = { heldModels: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleFreeDispatchService,
        { provide: getRepositoryToken(GoogleDispatchState), useValue: mockStateRepo },
        { provide: GOOGLE_FREE_DISPATCH_QUEUE, useValue: mockQueue },
        { provide: StrategyService, useValue: mockStrategyService },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
        { provide: GoogleRateLimitHoldService, useValue: mockHoldService },
      ],
    }).compile();

    service = module.get<GoogleFreeDispatchService>(GoogleFreeDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
  });

  describe("start", () => {
    it("should reject starting a cycle that's already active", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });

      await expect(service.start()).rejects.toThrow(BadRequestException);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should not start a cycle, and report alreadyExhausted, when every model is held", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "google",
        active: false,
        startedAt: null,
      });
      mockHoldService.heldModels.mockResolvedValueOnce([...GOOGLE_MODELS]);

      const result = await service.start();

      expect(result.outcome).toBe("alreadyExhausted");
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "google", active: false }),
      );
    });

    it("should start a cycle and queue the first tick when at least one model is free", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "google",
        active: true,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });
      mockHoldService.heldModels.mockResolvedValueOnce(["gemini-2.5-pro"]);

      const result = await service.start();

      expect(result.outcome).toBe("started");
      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "google", active: true }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        {},
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining("google-free-dispatch-") }),
      );
    });
  });

  describe("stop", () => {
    it("should deactivate the cycle and return its status", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: false, startedAt: null });

      const result = await service.stop();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
      expect(result.active).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should report inactive with null startedAt when no state row exists", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getStatus();

      expect(result).toEqual({ active: false, startedAt: null });
    });
  });

  describe("runTick", () => {
    it("should do nothing when the cycle is inactive", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await service.runTick();

      expect(mockSupportedModelService.findModelNamesByStrategy).not.toHaveBeenCalled();
    });

    it("should stop when no Google models are configured", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockSupportedModelService.findModelNamesByStrategy.mockResolvedValueOnce([]);

      await service.runTick();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should stop once every model is RPD-held", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockHoldService.heldModels.mockResolvedValueOnce([...GOOGLE_MODELS]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should hold off dispatching, but keep ticking, once the in-flight backlog hits its cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "2";
      const inFlight = zeroCounts();
      inFlight.set("gemini-2.5-flash", 3);
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: expect.any(Number) }));
    });

    it("should dispatch only to eligible (non-held) models, least-allocated first", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockHoldService.heldModels.mockResolvedValueOnce(["gemini-2.5-flash"]);
      // The real call passes only eligibleModels (held models filtered out
      // before this lookup) — mock it the same way, or leastAllocatedModel
      // would see the held model too and could pick it on a tie.
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(
        new Map([["gemini-2.5-pro", 0]]),
      );
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
        { puzzleId: 9, date: "2024-05-01" },
      ]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledWith(
        9,
        "llm-google",
        "2024-05-01",
        "gemini-2.5-pro",
      );
    });

    it("should stop when every eligible model has run out of unrun puzzles", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should treat a triggerStrategyRuns failure as that model unavailable this tick, not a hard failure", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });
      mockStrategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(service.runTick()).resolves.toBeUndefined();

      expect(mockStateRepo.update).toHaveBeenCalledWith({ id: "google" }, { active: false });
    });

    it("should schedule a further tick after a successful partial dispatch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ id: "google", active: true });

      await service.runTick();

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: expect.any(Number) }));
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/google-free-dispatch/google-free-dispatch.service.spec.ts`
Expected: FAIL — module `./google-free-dispatch.service` not found.

- [ ] **Step 3: Create the queue instance**

`backend/src/modules/queue/google-free-dispatch.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the Google free-daily-quota dispatch cycle (see
// GoogleFreeDispatchService) — the Google counterpart to
// free-tier-dispatch.queue.ts. Each job is one "tick": it checks which
// Google models are currently RPD-held, queues the next batch of trials
// against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const googleFreeDispatchQueue = new Queue("google-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
```

- [ ] **Step 4: Register the queue token in `queue.module.ts`**

In `backend/src/modules/queue/queue.module.ts`:
- import `googleFreeDispatchQueue` from `./google-free-dispatch.queue`
- add `export const GOOGLE_FREE_DISPATCH_QUEUE = "GOOGLE_FREE_DISPATCH_QUEUE";`
- add `{ provide: GOOGLE_FREE_DISPATCH_QUEUE, useValue: googleFreeDispatchQueue },` to `providers`
- add `GOOGLE_FREE_DISPATCH_QUEUE` to `exports`

- [ ] **Step 5: Implement `GoogleFreeDispatchService`**

`backend/src/modules/google-free-dispatch/google-free-dispatch.service.ts`:

```ts
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GOOGLE_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { GoogleRateLimitHoldService } from "../strategy/google-rate-limit-hold.service";
import { LLM_GOOGLE, freeTierDispatchMaxBatch, freeTierDispatchMaxInFlight, freeTierDispatchTickMs } from "../../strategies";

const TICK_JOB_NAME = "tick";
const GOOGLE_DISPATCH_STATE_ID = "google";

export interface GoogleDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
}

/**
 * The Google counterpart to FreeTierDispatchService: a self-rescheduling
 * tick chain that dispatches llm-google trials against unrun puzzles until
 * every configured Google model is RPD-held (see GoogleRateLimitHoldService)
 * or out of unrun puzzles. Unlike the OpenAI tiers, there is no per-token
 * free budget to burn toward a threshold — Google enforces a per-day request
 * cap of its own, so "keep dispatching until held" is the whole stop
 * condition. Reuses the OpenAI tiers' FREE_TIER_DISPATCH_* pacing knobs
 * rather than introducing a parallel env family (see
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md).
 */
@Injectable()
export class GoogleFreeDispatchService {
  private readonly logger = new Logger(GoogleFreeDispatchService.name);

  constructor(
    @InjectRepository(GoogleDispatchState)
    private readonly stateRepo: Repository<GoogleDispatchState>,
    @Inject(GOOGLE_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(GoogleRateLimitHoldService) private readonly holdService: GoogleRateLimitHoldService,
  ) {}

  /**
   * Starts the cycle. Rejects if it's already running. If every configured
   * Google model is already RPD-held, this is a clean no-op (no tick is
   * queued) rather than spinning up a cycle that would immediately find
   * nothing to do — the caller learns this via the returned `outcome`
   * rather than a thrown error, since it isn't a failure.
   */
  async start(): Promise<{ status: GoogleDispatchStatusDto; outcome: "started" | "alreadyExhausted" }> {
    const existing = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "Google free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GOOGLE);
    const held = new Set(await this.holdService.heldModels(LLM_GOOGLE));
    const allExhausted = models.length === 0 || models.every((model) => held.has(model));

    if (allExhausted) {
      await this.stateRepo.save({ id: GOOGLE_DISPATCH_STATE_ID, active: false, startedAt: null });
      this.logger.log("google free-tier dispatch: every model is already RPD-held — not starting a cycle");
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: GOOGLE_DISPATCH_STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });

    this.logger.log("google free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<GoogleDispatchStatusDto> {
    await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
    this.logger.log("google free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<GoogleDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    return { active: state?.active ?? false, startedAt: state?.startedAt ?? null };
  }

  /**
   * One tick: stops if the cycle was deactivated, no Google models are
   * configured, or every configured model is currently RPD-held. Otherwise
   * paces itself against the in-flight cap (same knob the OpenAI tiers use)
   * and dispatches a budget-safe batch spread across whichever eligible
   * (non-held) models are currently behind.
   */
  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    if (!state?.active) {
      this.logger.log("google free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GOOGLE);
    if (models.length === 0) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("google free-tier dispatch: no Google models configured — stopping");
      return;
    }

    const held = new Set(await this.holdService.heldModels(LLM_GOOGLE));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("google free-tier dispatch: every model is RPD-held — stopping");
      return;
    }

    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_GOOGLE, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `google free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick();
      return;
    }

    const maxNewTrials = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);
    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_GOOGLE, eligibleModels);
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < eligibleModels.length) {
      const model = GoogleFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_GOOGLE, model, 1);
      } catch (err) {
        this.logger.warn(
          `google free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyService.triggerStrategyRuns(target.puzzleId, LLM_GOOGLE, target.date, model);
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `google free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`google free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === eligibleModels.length) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("google free-tier dispatch: ran out of unrun puzzles for every eligible model — stopping");
      return;
    }

    await this.scheduleNextTick();
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(TICK_JOB_NAME, {}, { delay: freeTierDispatchTickMs(), jobId: this.freshTickJobId() });
  }

  // See FreeTierDispatchService.freshTickJobId's comment — same reasoning:
  // BullMQ dedupes queue.add() by jobId even against a completed job, so
  // this must always be fresh, never a fixed id reused across cycles.
  private freshTickJobId(): string {
    return `google-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private static leastAllocatedModel(allocation: Map<string, number>, exhausted: Set<string>): string {
    let best: string | null = null;
    let bestCount = Infinity;

    for (const [model, count] of allocation) {
      if (exhausted.has(model)) continue;
      if (count < bestCount) {
        best = model;
        bestCount = count;
      }
    }

    if (best === null) {
      throw new Error("leastAllocatedModel called with every model already exhausted");
    }

    return best;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/google-free-dispatch/google-free-dispatch.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Create `GoogleFreeDispatchModule`**

`backend/src/modules/google-free-dispatch/google-free-dispatch.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { GoogleFreeDispatchService } from "./google-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([GoogleDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [GoogleFreeDispatchService],
  exports: [GoogleFreeDispatchService],
})
export class GoogleFreeDispatchModule {}
```

- [ ] **Step 8: Expose a read-only status route on `DispatchController`**

In `backend/src/modules/dispatch/dispatch.controller.ts`, add the import and constructor param:

```ts
import { GoogleFreeDispatchService } from "../google-free-dispatch/google-free-dispatch.service";
```

```ts
    @Inject(GoogleFreeDispatchService) private readonly googleFreeDispatchService: GoogleFreeDispatchService,
```

(add this constructor param alongside the existing ones, e.g. after `freeTierDispatchService`), and add a new route near `getFreeTierDispatchStatus`:

```ts
  // Read-only Google free-daily-quota dispatch status — see
  // GoogleFreeDispatchService. No token threshold like the OpenAI tiers:
  // active/startedAt only. Not password-gated, same as the free-tier status
  // route above — it enqueues nothing.
  @Get("google")
  async getGoogleDispatchStatus() {
    return this.googleFreeDispatchService.getStatus();
  }
```

- [ ] **Step 9: Wire `GoogleFreeDispatchModule` into `DispatchModule`**

In `backend/src/modules/dispatch/dispatch.module.ts`, import `GoogleFreeDispatchModule` and add it to the `imports` array (alongside `FreeTierDispatchModule`).

- [ ] **Step 10: Wire the tick worker into `worker.ts`**

In `backend/src/worker.ts`:

Add imports:

```ts
import { GoogleFreeDispatchService } from "./modules/google-free-dispatch/google-free-dispatch.service";
```

Add, alongside the other `appContext.get(...)` calls:

```ts
  const googleFreeDispatchService = appContext.get(GoogleFreeDispatchService);
```

Add, in the `role !== "ollama"` block, right after the existing `free-tier-dispatch` worker registration:

```ts
    // Each job is one tick of the Google free-daily-quota dispatch cycle
    // (see GoogleFreeDispatchService) — same self-chaining shape as the
    // free-tier-dispatch worker above, just with no token budget involved.
    const googleFreeDispatchWorker = new Worker(
      "google-free-dispatch",
      async (job: Job) => {
        logger.log(`starting google free-tier dispatch tick ${job.id}`);
        await googleFreeDispatchService.runTick();
        logger.log(`finished google free-tier dispatch tick ${job.id}`);
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    googleFreeDispatchWorker.on("failed", (job, err) => {
      logger.error(`google free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(googleFreeDispatchWorker);
    activeQueueNames.push("google-free-dispatch");
```

- [ ] **Step 11: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add backend/src/modules/queue/google-free-dispatch.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/google-free-dispatch/ backend/src/modules/dispatch/dispatch.controller.ts backend/src/modules/dispatch/dispatch.module.ts backend/src/worker.ts
git commit -m "feat: add GoogleFreeDispatchService for the Google daily-quota burn"
```

---

### Task 4: `DailyAutomationService` and `AutomationModule`

**Files:**
- Create: `backend/src/modules/automation/daily-automation.service.ts`
- Test: `backend/src/modules/automation/daily-automation.service.spec.ts`
- Create: `backend/src/modules/automation/automation.module.ts`
- Modify: `backend/src/app.module.ts`

**Interfaces:**
- Consumes: `AutomationRunLog` entity (Task 1), `CategoryEvaluatorService.enqueuePending` (existing), `FreeTierDispatchService.getStatus/start` (existing), `GoogleFreeDispatchService.getStatus/start` (Task 3).
- Produces: `DailyAutomationService.run(): Promise<void>` and `.getTodayStatus(): Promise<AutomationRunLog | null>`. Task 5's bootstrap and Task 6's controller both depend on this.

- [ ] **Step 1: Write the failing tests**

`backend/src/modules/automation/daily-automation.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DailyAutomationService } from "./daily-automation.service";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { FreeTierDispatchService } from "../free-tier-dispatch/free-tier-dispatch.service";
import { GoogleFreeDispatchService } from "../google-free-dispatch/google-free-dispatch.service";

describe("DailyAutomationService", () => {
  let service: DailyAutomationService;
  let mockRunLogRepo: { upsert: jest.Mock; update: jest.Mock; findOne: jest.Mock };
  let mockCategoryEvaluatorService: { enqueuePending: jest.Mock };
  let mockFreeTierDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockGoogleFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };

  const todayStamp = () => new Date().toISOString().slice(0, 10);

  beforeEach(async () => {
    mockRunLogRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    mockCategoryEvaluatorService = {
      enqueuePending: jest.fn().mockResolvedValue({ enqueued: 12, llmProposalIds: [] }),
    };
    mockFreeTierDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ tier: "mini", active: false, thresholdPercent: null, startedAt: null }),
      start: jest.fn().mockResolvedValue({ tier: "mini", active: true, thresholdPercent: 80, startedAt: new Date() }),
    };
    mockGoogleFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest.fn().mockResolvedValue({ status: { active: true, startedAt: new Date() }, outcome: "started" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyAutomationService,
        { provide: getRepositoryToken(AutomationRunLog), useValue: mockRunLogRepo },
        { provide: CategoryEvaluatorService, useValue: mockCategoryEvaluatorService },
        { provide: FreeTierDispatchService, useValue: mockFreeTierDispatchService },
        { provide: GoogleFreeDispatchService, useValue: mockGoogleFreeDispatchService },
      ],
    }).compile();

    service = module.get<DailyAutomationService>(DailyAutomationService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("run", () => {
    it("upserts today's row before running any leg", async () => {
      await service.run();

      expect(mockRunLogRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ date: todayStamp(), triggeredAt: expect.any(Date) }),
        ["date"],
      );
    });

    it("records the judge leg's enqueued count on success", async () => {
      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { judgeEnqueued: 12, judgeError: null },
      );
    });

    it("records a judge leg failure without throwing, and still runs the other legs", async () => {
      mockCategoryEvaluatorService.enqueuePending.mockRejectedValueOnce(new Error("db down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { judgeEnqueued: null, judgeError: "db down" },
      );
      expect(mockFreeTierDispatchService.start).toHaveBeenCalled();
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
    });

    it("starts the mini burn at an 80% ceiling when no cycle is already running", async () => {
      await service.run();

      expect(mockFreeTierDispatchService.start).toHaveBeenCalledWith("mini", 80);
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "started", miniBurnMessage: "started at 80%" },
      );
    });

    it("records alreadyActive for the mini leg without calling start, when a cycle is already running", async () => {
      mockFreeTierDispatchService.getStatus.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 90,
        startedAt: new Date(),
      });

      await service.run();

      expect(mockFreeTierDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "alreadyActive", miniBurnMessage: "already running at 90%" },
      );
    });

    it("records an error for the mini leg when start throws, without crashing the run", async () => {
      mockFreeTierDispatchService.start.mockRejectedValueOnce(new BadRequestException("boom"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "error", miniBurnMessage: "boom" },
      );
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
    });

    it("starts the Google burn when no cycle is already running", async () => {
      await service.run();

      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "started", googleBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the Google leg from start()'s own outcome", async () => {
      mockGoogleFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "alreadyExhausted", googleBurnMessage: "every Google model is currently RPD-held" },
      );
    });

    it("records alreadyActive for the Google leg without calling start, when a cycle is already running", async () => {
      mockGoogleFreeDispatchService.getStatus.mockResolvedValueOnce({ active: true, startedAt: new Date() });

      await service.run();

      expect(mockGoogleFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "alreadyActive", googleBurnMessage: "already running" },
      );
    });
  });

  describe("getTodayStatus", () => {
    it("returns today's row", async () => {
      const row = { date: todayStamp(), triggeredAt: new Date() } as AutomationRunLog;
      mockRunLogRepo.findOne.mockResolvedValueOnce(row);

      const result = await service.getTodayStatus();

      expect(mockRunLogRepo.findOne).toHaveBeenCalledWith({ where: { date: todayStamp() } });
      expect(result).toBe(row);
    });

    it("returns null when nothing has run today", async () => {
      mockRunLogRepo.findOne.mockResolvedValueOnce(null);

      expect(await service.getTodayStatus()).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/automation/daily-automation.service.spec.ts`
Expected: FAIL — module `./daily-automation.service` not found.

- [ ] **Step 3: Implement `DailyAutomationService`**

`backend/src/modules/automation/daily-automation.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { FreeTierDispatchService } from "../free-tier-dispatch/free-tier-dispatch.service";
import { GoogleFreeDispatchService } from "../google-free-dispatch/google-free-dispatch.service";

// The same MAX_LIMIT CategoryEvaluatorService.enqueuePending already
// enforces internally — the daily leg asks for as much as a manual dispatch
// is ever allowed to enqueue in one call.
export const JUDGE_LEG_LIMIT = 500;

// 95% overall safety cap minus a 15% reserve for judge spend landing later
// in the day — see docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
export const MINI_BURN_CEILING_PERCENT = 80;

function todayUtcDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Runs on a daily UTC cron (see DailyAutomationBootstrap). Fires three
 * independent legs — none waits for another to finish — and records each
 * one's outcome into today's AutomationRunLog row as soon as it resolves:
 *
 *  - judge: enqueues the category-judge backlog (its spend already lands in
 *    the same mini-tier budget FreeTierUsageService tracks);
 *  - miniBurn: starts a FreeTierDispatchService "mini" cycle at an 80%
 *    ceiling, leaving the other 15% (of the 95% overall safety cap) as
 *    headroom for the judge leg's spend;
 *  - googleBurn: starts GoogleFreeDispatchService's cycle, which runs until
 *    every Google model is RPD-held.
 *
 * Each leg checks the relevant service's live status first rather than
 * relying on a thrown exception's message text to distinguish "already
 * running" from a real failure — cleaner to test and to reason about than
 * string-matching a caught error.
 */
@Injectable()
export class DailyAutomationService {
  private readonly logger = new Logger(DailyAutomationService.name);

  constructor(
    @InjectRepository(AutomationRunLog)
    private readonly runLogRepo: Repository<AutomationRunLog>,
    @Inject(CategoryEvaluatorService)
    private readonly categoryEvaluatorService: CategoryEvaluatorService,
    @Inject(FreeTierDispatchService)
    private readonly freeTierDispatchService: FreeTierDispatchService,
    @Inject(GoogleFreeDispatchService)
    private readonly googleFreeDispatchService: GoogleFreeDispatchService,
  ) {}

  async run(): Promise<void> {
    const date = todayUtcDateStamp();
    const triggeredAt = new Date();
    // Upsert only {date, triggeredAt} (not a full save()) so a defensive
    // re-run on the same UTC day refreshes triggeredAt without wiping
    // whichever legs already recorded an outcome from an earlier run today.
    await this.runLogRepo.upsert({ date, triggeredAt }, ["date"]);

    await this.runJudgeLeg(date);
    await this.runMiniBurnLeg(date);
    await this.runGoogleBurnLeg(date);
  }

  async getTodayStatus(): Promise<AutomationRunLog | null> {
    return this.runLogRepo.findOne({ where: { date: todayUtcDateStamp() } });
  }

  private async runJudgeLeg(date: string): Promise<void> {
    try {
      const result = await this.categoryEvaluatorService.enqueuePending({ limit: JUDGE_LEG_LIMIT });
      await this.runLogRepo.update({ date }, { judgeEnqueued: result.enqueued, judgeError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enqueue judge backlog";
      this.logger.error(`daily automation judge leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { judgeEnqueued: null, judgeError: message });
    }
  }

  private async runMiniBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.freeTierDispatchService.getStatus("mini");
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          {
            miniBurnOutcome: "alreadyActive",
            miniBurnMessage: `already running at ${current.thresholdPercent}%`,
          },
        );
        return;
      }

      await this.freeTierDispatchService.start("mini", MINI_BURN_CEILING_PERCENT);
      await this.runLogRepo.update(
        { date },
        {
          miniBurnOutcome: "started",
          miniBurnMessage: `started at ${MINI_BURN_CEILING_PERCENT}%`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start mini/nano burn";
      this.logger.error(`daily automation mini-burn leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { miniBurnOutcome: "error", miniBurnMessage: message });
    }
  }

  private async runGoogleBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.googleFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { googleBurnOutcome: "alreadyActive", googleBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.googleFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted" ? "every Google model is currently RPD-held" : "started";
      await this.runLogRepo.update({ date }, { googleBurnOutcome: result.outcome, googleBurnMessage: message });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Google burn";
      this.logger.error(`daily automation google-burn leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { googleBurnOutcome: "error", googleBurnMessage: message });
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/automation/daily-automation.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Create `AutomationModule` and register it in `AppModule`**

`backend/src/modules/automation/automation.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StrategyModule } from "../strategy/strategy.module";
import { FreeTierDispatchModule } from "../free-tier-dispatch/free-tier-dispatch.module";
import { GoogleFreeDispatchModule } from "../google-free-dispatch/google-free-dispatch.module";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { DailyAutomationService } from "./daily-automation.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationRunLog]),
    StrategyModule,
    FreeTierDispatchModule,
    GoogleFreeDispatchModule,
  ],
  providers: [DailyAutomationService],
  exports: [DailyAutomationService],
})
export class AutomationModule {}
```

In `backend/src/app.module.ts`, import `AutomationModule` and add it to the `imports` array (alongside `StrategyModule`, `DispatchModule`, `CategoryEvaluationModule`) — nothing else imports `AutomationModule`, so it must be registered directly here for `DailyAutomationService` to be resolvable from `NestFactory.createApplicationContext(AppModule)` in `worker.ts` (Task 5).

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/automation/ backend/src/app.module.ts
git commit -m "feat: add DailyAutomationService — judge, mini-burn, and Google-burn legs"
```

---

### Task 5: `DailyAutomationBootstrap`, its queue, and worker wiring

**Files:**
- Create: `backend/src/modules/queue/daily-automation.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Create: `backend/src/modules/automation/daily-automation.bootstrap.ts`
- Test: `backend/src/modules/automation/daily-automation.bootstrap.spec.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `DailyAutomationService.run()` (Task 4).
- Produces: `dailyAutomationQueue` (BullMQ `Queue` for `"daily-automation"`), `DAILY_AUTOMATION_QUEUE` DI token, `DailyAutomationBootstrap` (schedules `"15 0 * * *"` UTC + a per-UTC-day startup catch-up job), a worker on `"daily-automation"` that calls `run()`.

- [ ] **Step 1: Write the failing bootstrap test**

`backend/src/modules/automation/daily-automation.bootstrap.spec.ts`:

```ts
import { Queue } from "bullmq";
import { DailyAutomationBootstrap } from "./daily-automation.bootstrap";

describe("DailyAutomationBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { upsertJobScheduler: jest.Mock; add: jest.Mock };

  beforeEach(() => {
    queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("registers a daily 00:15 UTC automation scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "daily-automation",
      { pattern: "15 0 * * *", tz: "UTC" },
      expect.objectContaining({ name: "run-daily-automation" }),
    );
  });

  it("enqueues one date-stamped startup catch-up run", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("run-daily-automation");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `daily-automation-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new DailyAutomationBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/automation/daily-automation.bootstrap.spec.ts`
Expected: FAIL — module `./daily-automation.bootstrap` not found.

- [ ] **Step 3: Create the queue instance**

`backend/src/modules/queue/daily-automation.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the daily free-tier-automation chain (see DailyAutomationService /
// DailyAutomationBootstrap). One scheduled job per day at 00:15 UTC — after
// the OpenAI mini/nano tier's UTC-midnight usage window has reset — that
// enqueues the judge backlog and starts the mini/nano and Google burn
// cycles.
export const dailyAutomationQueue = new Queue("daily-automation", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential", delay: 30000 },
  },
});
```

- [ ] **Step 4: Register the token in `queue.module.ts`**

In `backend/src/modules/queue/queue.module.ts`:
- import `dailyAutomationQueue` from `./daily-automation.queue`
- add `export const DAILY_AUTOMATION_QUEUE = "DAILY_AUTOMATION_QUEUE";`
- add `{ provide: DAILY_AUTOMATION_QUEUE, useValue: dailyAutomationQueue },` to `providers`
- add `DAILY_AUTOMATION_QUEUE` to `exports`

- [ ] **Step 5: Implement the bootstrap**

`backend/src/modules/automation/daily-automation.bootstrap.ts`:

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { DAILY_AUTOMATION_QUEUE } from "../queue/queue.module";

/**
 * Schedules the daily free-tier-automation chain at 00:15 UTC — a
 * quarter-hour after the OpenAI mini/nano tier's UTC-midnight usage window
 * resets, so DailyAutomationService.run() always sees a fresh day's budget.
 * Also enqueues a startup catch-up run (fixed per-UTC-day jobId) so a
 * backend/worker that was down at 00:15 still gets the day's automation,
 * the same pattern GoogleRpdResumeBootstrap uses for its own daily sweep.
 */
@Injectable()
export class DailyAutomationBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailyAutomationBootstrap.name);

  constructor(@Inject(DAILY_AUTOMATION_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping daily-automation scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "run-daily-automation",
      {},
      {
        jobId: `daily-automation-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    await this.queue.upsertJobScheduler(
      "daily-automation",
      { pattern: "15 0 * * *", tz: "UTC" },
      {
        name: "run-daily-automation",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log('daily-automation scheduled: "15 0 * * *" (UTC)');
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/automation/daily-automation.bootstrap.spec.ts`
Expected: PASS.

- [ ] **Step 7: Register the bootstrap provider**

In `backend/src/modules/automation/automation.module.ts`, import `DailyAutomationBootstrap` and add it to `providers` (`providers: [DailyAutomationService, DailyAutomationBootstrap]`).

- [ ] **Step 8: Wire the worker in `worker.ts`**

In `backend/src/worker.ts`:

Add imports:

```ts
import { DailyAutomationService } from "./modules/automation/daily-automation.service";
```

Add, alongside the other `appContext.get(...)` calls:

```ts
  const dailyAutomationService = appContext.get(DailyAutomationService);
```

Add, in the `role !== "ollama"` block, right after the `google-rpd-resume` worker registration:

```ts
    const dailyAutomationWorker = new Worker(
      "daily-automation",
      async (job) => {
        logger.log(`starting daily automation run ${job.id}`);
        await dailyAutomationService.run();
        logger.log(`finished daily automation run ${job.id}`);
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    dailyAutomationWorker.on("failed", (job, err) => {
      logger.error(`daily automation run ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(dailyAutomationWorker);
    activeQueueNames.push("daily-automation");
```

- [ ] **Step 9: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/queue/daily-automation.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/automation/ backend/src/worker.ts
git commit -m "feat: schedule the daily free-tier automation chain at 00:15 UTC"
```

---

### Task 6: `AutomationController` and `nextDailyAutomationRunAt`

**Files:**
- Modify: `backend/src/strategies.ts`
- Test: `backend/src/strategies.spec.ts`
- Create: `backend/src/modules/automation/automation.controller.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`

**Interfaces:**
- Consumes: `DailyAutomationService.getTodayStatus()` (Task 4).
- Produces: `nextDailyAutomationRunAt(now?: Date): Date` (exported from `strategies.ts`); `GET /automation/status` returning `{ lastRunAt: string | null; nextRunAt: string; judge: { enqueued: number | null; error: string | null }; miniBurn: { outcome: AutomationLegOutcome | null; message: string | null }; googleBurn: { outcome: AutomationLegOutcome | null; message: string | null } }`. Task 7's frontend `fetchAutomationStatus` depends on this route's shape.

- [ ] **Step 1: Write the failing test for `nextDailyAutomationRunAt`**

Add to `backend/src/strategies.spec.ts` (find the existing `describe` block for `startOfTodayUtc` and add a sibling `describe` after it):

```ts
describe("nextDailyAutomationRunAt", () => {
  it("returns today's 00:15 UTC when called before that time", () => {
    const now = new Date("2024-06-01T00:00:00.000Z");
    expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-01T00:15:00.000Z");
  });

  it("returns tomorrow's 00:15 UTC when called after that time", () => {
    const now = new Date("2024-06-01T12:00:00.000Z");
    expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-02T00:15:00.000Z");
  });

  it("returns tomorrow's 00:15 UTC when called exactly at that time", () => {
    const now = new Date("2024-06-01T00:15:00.000Z");
    expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-02T00:15:00.000Z");
  });
});
```

Add `nextDailyAutomationRunAt` to the existing `import { ... } from "./strategies"` line at the top of `strategies.spec.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest src/strategies.spec.ts -t nextDailyAutomationRunAt`
Expected: FAIL — `nextDailyAutomationRunAt is not a function`.

- [ ] **Step 3: Implement `nextDailyAutomationRunAt`**

In `backend/src/strategies.ts`, add after `startOfTodayUtc`:

```ts
/**
 * The next 00:15 UTC instant at or after `now` — when DailyAutomationBootstrap's
 * cron next fires (or just fired, if called exactly at that instant, in
 * which case this returns tomorrow's). Used by AutomationController to tell
 * the UI when the next daily-automation run is expected.
 */
export function nextDailyAutomationRunAt(now: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 15, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/strategies.spec.ts -t nextDailyAutomationRunAt`
Expected: PASS.

- [ ] **Step 5: Implement `AutomationController`**

`backend/src/modules/automation/automation.controller.ts`:

```ts
import { Controller, Get, Inject } from "@nestjs/common";
import { DailyAutomationService } from "./daily-automation.service";
import { nextDailyAutomationRunAt } from "../../strategies";

/**
 * Read-only status for the daily free-tier-automation chain — backs the
 * "Auto-run: ... · Next: ..." line on the mini FreeTierBudgetWidget,
 * CategoryJudgingWidget, and GoogleDispatchWidget. Not password-gated: it
 * enqueues nothing, same as /category-evaluation/coverage.
 */
@Controller("automation")
export class AutomationController {
  constructor(
    @Inject(DailyAutomationService) private readonly dailyAutomationService: DailyAutomationService,
  ) {}

  @Get("status")
  async getStatus() {
    const log = await this.dailyAutomationService.getTodayStatus();

    return {
      lastRunAt: log?.triggeredAt?.toISOString() ?? null,
      nextRunAt: nextDailyAutomationRunAt().toISOString(),
      judge: {
        enqueued: log?.judgeEnqueued ?? null,
        error: log?.judgeError ?? null,
      },
      miniBurn: {
        outcome: log?.miniBurnOutcome ?? null,
        message: log?.miniBurnMessage ?? null,
      },
      googleBurn: {
        outcome: log?.googleBurnOutcome ?? null,
        message: log?.googleBurnMessage ?? null,
      },
    };
  }
}
```

- [ ] **Step 6: Register the controller**

In `backend/src/modules/automation/automation.module.ts`, import `AutomationController` and add `controllers: [AutomationController]` to the `@Module` decorator.

- [ ] **Step 7: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Manual smoke check**

Run: `cd backend && npm run start:dev` (or however this backend is normally run locally), then `curl http://localhost:<port>/automation/status` and confirm it returns the shape above with `lastRunAt: null` (nothing has run yet in a fresh dev DB) and a `nextRunAt` roughly 24h out or less.

- [ ] **Step 9: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts backend/src/modules/automation/automation.controller.ts backend/src/modules/automation/automation.module.ts
git commit -m "feat: add GET /automation/status"
```

---

### Task 7: Frontend types, `api.ts`, and `formatAutomationLine`

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Create: `frontend/src/components/benchmark/automationFormat.ts`
- Test: `frontend/src/components/benchmark/__tests__/automationFormat.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (parallels the backend's `GET /automation/status` and `GET /dispatch/google` shapes from Tasks 3/6 by contract, not by import).
- Produces: types `AutomationLegOutcome`, `AutomationJudgeLeg`, `AutomationBurnLeg`, `AutomationStatus`, `GoogleDispatchStatus`, `AutomationLegDisplay`; functions `fetchAutomationStatus(signal?)`, `fetchGoogleDispatchStatus(signal?)`; `formatAutomationLine(leg: AutomationLegDisplay): string`. Tasks 8-11 depend on all of these.

- [ ] **Step 1: Add the types**

In `frontend/src/data/benchmark/types.ts`, add after `FreeTierDispatchBothStopResult`:

```ts
export type AutomationLegOutcome = "started" | "alreadyActive" | "alreadyExhausted" | "error";

/** One leg's outcome from the judge-dispatch side of GET /automation/status —
 * see the backend's AutomationRunLog.judgeEnqueued/judgeError. */
export interface AutomationJudgeLeg {
  enqueued: number | null;
  error: string | null;
}

/** One leg's outcome from the mini-burn or Google-burn side of
 * GET /automation/status — see the backend's AutomationRunLog
 * miniBurnOutcome/miniBurnMessage (or googleBurnOutcome/googleBurnMessage). */
export interface AutomationBurnLeg {
  outcome: AutomationLegOutcome | null;
  message: string | null;
}

/** GET /automation/status — today's daily-automation run (see the backend's
 * DailyAutomationService/AutomationRunLog): the judge-dispatch leg, the
 * mini/nano burn leg, and the Google burn leg, plus when the chain is next
 * expected to fire. `lastRunAt` is null until the first automatic run of the
 * day has fired. */
export interface AutomationStatus {
  lastRunAt: string | null;
  nextRunAt: string;
  judge: AutomationJudgeLeg;
  miniBurn: AutomationBurnLeg;
  googleBurn: AutomationBurnLeg;
}

/** GET /dispatch/google — whether the Google free-daily-quota dispatch cycle
 * (see the backend's GoogleFreeDispatchService) is currently running. Unlike
 * FreeTierDispatchStatus there's no threshold — Google's constraint is a
 * per-day request cap, not a token budget. */
export interface GoogleDispatchStatus {
  active: boolean;
  startedAt: string | null;
}

/** One daily-automation leg as a widget presents it: a single
 * human-readable message (already assembled server-side for the burn legs,
 * or derived client-side for the judge leg from its enqueued/error fields —
 * see ActivityPage), when it last ran, when it's expected next, and whether
 * that last outcome was an error. Shared shape consumed by
 * FreeTierBudgetWidget (mini), CategoryJudgingWidget, and
 * GoogleDispatchWidget via formatAutomationLine. */
export interface AutomationLegDisplay {
  message: string | null;
  lastRunAt: string | null;
  nextRunAt: string;
  isError: boolean;
}
```

- [ ] **Step 2: Add the API functions**

In `frontend/src/data/benchmark/api.ts`, add the two new types to the `import type { ... } from "./types"` block (`AutomationStatus`, `GoogleDispatchStatus`), and add after `stopBothFreeTierDispatch`:

```ts
/** Today's daily-automation run — see AutomationStatus. Backs the
 * "Auto-run: ... · Next: ..." line on the mini FreeTierBudgetWidget,
 * CategoryJudgingWidget, and GoogleDispatchWidget. */
export function fetchAutomationStatus(signal?: AbortSignal): Promise<AutomationStatus> {
  return fetchJson("/automation/status", signal);
}

/** Whether the Google free-daily-quota dispatch cycle is currently running —
 * see GoogleDispatchStatus. Backs GoogleDispatchWidget's active/inactive
 * indicator, polled the same way fetchFreeTierDispatchStatus is. */
export function fetchGoogleDispatchStatus(signal?: AbortSignal): Promise<GoogleDispatchStatus> {
  return fetchJson("/dispatch/google", signal);
}
```

- [ ] **Step 3: Write the failing test for `formatAutomationLine`**

`frontend/src/components/benchmark/__tests__/automationFormat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAutomationLine } from "../automationFormat";
import type { AutomationLegDisplay } from "../../../data/benchmark/types";

const NEXT_RUN_AT = "2024-06-02T00:15:00.000Z";

function leg(overrides: Partial<AutomationLegDisplay> = {}): AutomationLegDisplay {
  return {
    message: null,
    lastRunAt: null,
    nextRunAt: NEXT_RUN_AT,
    isError: false,
    ...overrides,
  };
}

describe("formatAutomationLine", () => {
  it("says it hasn't run yet today when there's no last run", () => {
    expect(formatAutomationLine(leg())).toBe(
      "Auto-run: hasn't run yet today · Next: Jun 2, 2024, 12:15 AM",
    );
  });

  it("includes the message and timestamp when a run has happened", () => {
    expect(
      formatAutomationLine(
        leg({ message: "started at 80%", lastRunAt: "2024-06-01T00:15:00.000Z" }),
      ),
    ).toBe("Auto-run: started at 80% (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM");
  });

  it("still renders an error message the same way as any other message", () => {
    expect(
      formatAutomationLine(
        leg({ message: "failed: boom", lastRunAt: "2024-06-01T00:15:00.000Z", isError: true }),
      ),
    ).toBe("Auto-run: failed: boom (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/automationFormat.test.ts`
Expected: FAIL — module `../automationFormat` not found.

- [ ] **Step 5: Implement `formatAutomationLine`**

`frontend/src/components/benchmark/automationFormat.ts`:

```ts
import { formatTimestamp } from "../../data/benchmark/metrics";
import type { AutomationLegDisplay } from "../../data/benchmark/types";

/** Builds the "Auto-run: ... · Next: ..." line shared by the mini
 * FreeTierBudgetWidget, CategoryJudgingWidget, and GoogleDispatchWidget —
 * one shared format so all three daily-automation legs read consistently on
 * the page. */
export function formatAutomationLine(leg: AutomationLegDisplay): string {
  const last =
    leg.lastRunAt === null || leg.message === null
      ? "hasn't run yet today"
      : `${leg.message} (${formatTimestamp(leg.lastRunAt)})`;
  return `Auto-run: ${last} · Next: ${formatTimestamp(leg.nextRunAt)}`;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/automationFormat.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck / build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/components/benchmark/automationFormat.ts frontend/src/components/benchmark/__tests__/automationFormat.test.ts
git commit -m "feat: add AutomationStatus types, api client, and formatAutomationLine"
```

---

### Task 8: `FreeTierBudgetWidget` — Auto-run line

**Files:**
- Modify: `frontend/src/components/benchmark/FreeTierBudgetWidget.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/FreeTierBudgetWidget.test.tsx`

**Interfaces:**
- Consumes: `AutomationLegDisplay`, `formatAutomationLine` (Task 7).
- Produces: `FreeTierBudgetWidgetProps.automation?: AutomationLegDisplay | null`. Task 11's `ActivityPage` depends on this prop existing.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/benchmark/__tests__/FreeTierBudgetWidget.test.tsx`, at the end of the `describe("FreeTierBudgetWidget", ...)` block:

```ts
  it("shows the auto-run line when an automation prop is given", async () => {
    stubFetch(miniUsage);

    render(
      <FreeTierBudgetWidget
        tier="mini"
        automation={{
          message: "started at 80%",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText("Auto-run: started at 80% (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });

  it("omits the auto-run line when no automation prop is given", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" />);

    await screen.findByText("238,000 tokens remaining today");
    expect(screen.queryByText(/Auto-run:/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/FreeTierBudgetWidget.test.tsx`
Expected: FAIL — the "Auto-run:" text is never rendered.

- [ ] **Step 3: Add the prop and the line**

In `frontend/src/components/benchmark/FreeTierBudgetWidget.tsx`, add the import:

```ts
import { formatAutomationLine } from "./automationFormat";
import type { FreeTierDispatchStatus, FreeTierId, FreeTierUsage, AutomationLegDisplay } from "../../data/benchmark/types";
```

(replace the existing `import type { ... } from "../../data/benchmark/types";` line with this one, adding `AutomationLegDisplay`).

Add to `FreeTierBudgetWidgetProps`, after `refreshSignal`:

```ts
  /** The daily-automation "burn" leg for this tier (see AutomationStatus) —
   * only meaningful for the mini instance, which is the only tier the daily
   * automation chain touches; the flagship instance is simply never given
   * this prop by the parent. */
  automation?: AutomationLegDisplay | null;
```

Add `automation` to the destructured props: `export function FreeTierBudgetWidget({ tier, spentUsd, refreshSignal, automation }: FreeTierBudgetWidgetProps) {`.

Add, right after the `<span className="bench-muted bench-free-tier__remaining">...tokens remaining today</span>` block and before the `spentUsd` block:

```tsx
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/FreeTierBudgetWidget.test.tsx`
Expected: PASS — full file, no regressions in the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/FreeTierBudgetWidget.tsx frontend/src/components/benchmark/__tests__/FreeTierBudgetWidget.test.tsx
git commit -m "feat: show the daily auto-run line on the mini free-tier widget"
```

---

### Task 9: `CategoryJudgingWidget` — Auto-run line

**Files:**
- Modify: `frontend/src/components/benchmark/CategoryJudgingWidget.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/CategoryJudgingWidget.test.tsx`

**Interfaces:**
- Consumes: `AutomationLegDisplay`, `formatAutomationLine` (Task 7).
- Produces: `CategoryJudgingWidget`'s new `automation?: AutomationLegDisplay | null` prop. Task 11's `ActivityPage` depends on this prop existing.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/benchmark/__tests__/CategoryJudgingWidget.test.tsx`, at the end of the `describe("CategoryJudgingWidget", ...)` block:

```ts
  it("shows the auto-run line when an automation prop is given", async () => {
    stubCoverage({ eligible: 50, judged: 42, pending: 8 });

    render(
      <CategoryJudgingWidget
        automation={{
          message: "enqueued 8",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText("Auto-run: enqueued 8 (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });

  it("omits the auto-run line when no automation prop is given", async () => {
    stubCoverage({ eligible: 12, judged: 12, pending: 0 });

    render(<CategoryJudgingWidget />);

    await screen.findByText("All 12 judged");
    expect(screen.queryByText(/Auto-run:/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/CategoryJudgingWidget.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the prop and the line**

In `frontend/src/components/benchmark/CategoryJudgingWidget.tsx`, add imports:

```ts
import { formatAutomationLine } from "./automationFormat";
import type { AutomationLegDisplay, CategoryEvaluationCoverage } from "../../data/benchmark/types";
```

(replace the existing `import type { CategoryEvaluationCoverage } from "../../data/benchmark/types";` line with the one above).

Add a props interface and accept it:

```ts
export interface CategoryJudgingWidgetProps {
  /** The daily-automation judge-dispatch leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

export function CategoryJudgingWidget({ automation }: CategoryJudgingWidgetProps = {}) {
```

(replace the existing `export function CategoryJudgingWidget() {` line with the two lines above).

Add, right after the `<span className="bench-muted bench-free-tier__remaining">{summary}</span>` line, before the closing `</div>`:

```tsx
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/CategoryJudgingWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/CategoryJudgingWidget.tsx frontend/src/components/benchmark/__tests__/CategoryJudgingWidget.test.tsx
git commit -m "feat: show the daily auto-run line on the category-judging widget"
```

---

### Task 10: `GoogleDispatchWidget`

**Files:**
- Create: `frontend/src/components/benchmark/GoogleDispatchWidget.tsx`
- Test: `frontend/src/components/benchmark/__tests__/GoogleDispatchWidget.test.tsx`

**Interfaces:**
- Consumes: `fetchGoogleDispatchStatus` (Task 7), `AutomationLegDisplay`/`formatAutomationLine` (Task 7), `StatusPill` (existing).
- Produces: `GoogleDispatchWidget` component with `{ automation?: AutomationLegDisplay | null }` props. Task 11's `ActivityPage` renders this.

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/benchmark/__tests__/GoogleDispatchWidget.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDispatchWidget } from "../GoogleDispatchWidget";
import type { GoogleDispatchStatus } from "../../../data/benchmark/types";

function stubStatus(status: GoogleDispatchStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/dispatch/google")) {
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleDispatchWidget", () => {
  it("shows a loading state before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<GoogleDispatchWidget />);

    expect(screen.getByText("Google daily quota")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the active pill and dispatching copy when a cycle is running", async () => {
    stubStatus({ active: true, startedAt: "2024-06-01T00:15:00.000Z" });

    render(<GoogleDispatchWidget />);

    expect(await screen.findByText("Auto-dispatch active")).toBeInTheDocument();
    expect(screen.getByText("Dispatching trials against unrun puzzles.")).toBeInTheDocument();
  });

  it("shows no pill and inactive copy when no cycle is running", async () => {
    stubStatus({ active: false, startedAt: null });

    render(<GoogleDispatchWidget />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<GoogleDispatchWidget />);

    expect(await screen.findByText("Couldn't load Google dispatch status: boom")).toBeInTheDocument();
  });

  it("shows the auto-run line when an automation prop is given", async () => {
    stubStatus({ active: false, startedAt: null });

    render(
      <GoogleDispatchWidget
        automation={{
          message: "started",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText("Auto-run: started (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/GoogleDispatchWidget.test.tsx`
Expected: FAIL — module `../GoogleDispatchWidget` not found.

- [ ] **Step 3: Implement the component**

`frontend/src/components/benchmark/GoogleDispatchWidget.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchGoogleDispatchStatus } from "../../data/benchmark/api";
import type { AutomationLegDisplay, GoogleDispatchStatus } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "Google daily quota";

export interface GoogleDispatchWidgetProps {
  /** The daily-automation Google-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the Google free-daily-quota dispatch cycle
 * (GoogleFreeDispatchService) is currently running, plus (via `automation`)
 * when the daily-automation chain last tried to start it and when it will
 * try again. Unlike the OpenAI tiers there's no token budget to show a
 * progress bar against — Google's constraint is a per-day request cap
 * enforced by Google itself, so this only ever shows active/inactive. */
export function GoogleDispatchWidget({ automation }: GoogleDispatchWidgetProps = {}) {
  const [status, setStatus] = useState<GoogleDispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchGoogleDispatchStatus(controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Google dispatch status");
        });
    };

    poll();
    const intervalId = setInterval(poll, DISPATCH_STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load Google dispatch status: {error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bench-free-tier" role="status" aria-label="Google daily quota dispatch">
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{TITLE}</span>
        {status.active ? <StatusPill label="Auto-dispatch active" tone="active" /> : null}
      </div>
      <span className="bench-muted">
        {status.active ? "Dispatching trials against unrun puzzles." : "Not currently dispatching."}
      </span>
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/GoogleDispatchWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/GoogleDispatchWidget.tsx frontend/src/components/benchmark/__tests__/GoogleDispatchWidget.test.tsx
git commit -m "feat: add GoogleDispatchWidget"
```

---

### Task 11: Wire `AutomationStatus` into `ActivityPage`

**Files:**
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`
- Modify: `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`

**Interfaces:**
- Consumes: `fetchAutomationStatus` (Task 7), `FreeTierBudgetWidget.automation` (Task 8), `CategoryJudgingWidget.automation` (Task 9), `GoogleDispatchWidget` (Task 10).
- Produces: nothing further downstream — this is the final integration point.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`:

Add a stub helper and extend `stubFetch` to accept an `automation` override — replace the existing `stubFetch` function with:

```ts
import type { AutomationStatus } from "../../../data/benchmark/types";

const defaultAutomation: AutomationStatus = {
  lastRunAt: null,
  nextRunAt: "2024-06-02T00:15:00.000Z",
  judge: { enqueued: null, error: null },
  miniBurn: { outcome: null, message: null },
  googleBurn: { outcome: null, message: null },
};

function stubFetch({
  leaderboard = emptyLeaderboard,
  recentActivity = [],
  coverage = { eligible: 0, judged: 0, pending: 0 },
  automation = defaultAutomation,
  googleDispatch = { active: false, startedAt: null },
}: {
  leaderboard?: Leaderboard;
  recentActivity?: RecentActivityEvent[];
  coverage?: { eligible: number; judged: number; pending: number };
  automation?: AutomationStatus;
  googleDispatch?: { active: boolean; startedAt: string | null };
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/strategy/free-tier-usage/flagship")) {
        return Promise.resolve({ ok: true, json: async () => flagshipUsage });
      }
      if (href.includes("/strategy/free-tier-usage/mini")) {
        return Promise.resolve({ ok: true, json: async () => miniUsage });
      }
      if (href.includes("/strategy/activity/recent")) {
        return Promise.resolve({ ok: true, json: async () => recentActivity });
      }
      if (href.includes("/category-evaluation/coverage")) {
        return Promise.resolve({ ok: true, json: async () => coverage });
      }
      if (href.includes("/automation/status")) {
        return Promise.resolve({ ok: true, json: async () => automation });
      }
      if (href.includes("/dispatch/google")) {
        return Promise.resolve({ ok: true, json: async () => googleDispatch });
      }
      return Promise.resolve({ ok: true, json: async () => leaderboard });
    }),
  );
}
```

Add a new test to the `describe("ActivityPage", ...)` block:

```ts
  it("shows each widget's auto-run line and the Google dispatch widget", async () => {
    stubFetch({
      coverage: { eligible: 10, judged: 6, pending: 4 },
      automation: {
        lastRunAt: "2024-06-01T00:15:00.000Z",
        nextRunAt: "2024-06-02T00:15:00.000Z",
        judge: { enqueued: 4, error: null },
        miniBurn: { outcome: "started", message: "started at 80%" },
        googleBurn: { outcome: "started", message: "started" },
      },
    });
    renderActivity();

    expect(screen.getByText("Google daily quota")).toBeInTheDocument();
    expect(
      await screen.findByText("Auto-run: enqueued 4 (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Auto-run: started at 80% (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Auto-run: started (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });

  it("shows the judge leg's auto-run line as a failure when it errored", async () => {
    stubFetch({
      automation: {
        ...defaultAutomation,
        lastRunAt: "2024-06-01T00:15:00.000Z",
        judge: { enqueued: null, error: "db down" },
      },
    });
    renderActivity();

    const line = await screen.findByText(
      "Auto-run: failed: db down (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM",
    );
    expect(line).toHaveClass("bench-error");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/benchmark/__tests__/ActivityPage.test.tsx`
Expected: FAIL — "Google daily quota" and the "Auto-run:" lines are never rendered.

- [ ] **Step 3: Wire it up in `ActivityPage.tsx`**

In `frontend/src/pages/benchmark/ActivityPage.tsx`:

Add two new import lines (`ActivityPage.tsx` has no existing import from `../../data/benchmark/types`, and no existing import of `GoogleDispatchWidget`):

```ts
import { GoogleDispatchWidget } from "../../components/benchmark/GoogleDispatchWidget";
import type { AutomationLegDisplay } from "../../data/benchmark/types";
```

Replace the existing `import { fetchFreeTierUsage, fetchLeaderboard, fetchRecentActivity } from "../../data/benchmark/api";` line with:

```ts
import { fetchAutomationStatus, fetchFreeTierUsage, fetchLeaderboard, fetchRecentActivity } from "../../data/benchmark/api";
```

Add, inside the `ActivityPage` function body, after the `freeTierModels` block:

```ts
  const { data: automationStatus } = useQuery({
    queryKey: ["automation-status"],
    queryFn: ({ signal }) => fetchAutomationStatus(signal),
    refetchInterval: 30_000,
  });

  const judgeAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.judge.error !== null
            ? `failed: ${automationStatus.judge.error}`
            : automationStatus.judge.enqueued !== null
              ? `enqueued ${automationStatus.judge.enqueued}`
              : null,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.judge.error !== null,
      }
    : null;

  const miniBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message: automationStatus.miniBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.miniBurn.outcome === "error",
      }
    : null;

  const googleBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message: automationStatus.googleBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.googleBurn.outcome === "error",
      }
    : null;
```

Replace the existing `<div className="bench-free-tiers" aria-label="Daily free-token budgets">...</div>` block with:

```tsx
      <div className="bench-free-tiers" aria-label="Daily free-token budgets">
        <FreeTierBudgetWidget
          tier="flagship"
          spentUsd={flagshipSpentUsd}
          refreshSignal={dispatchRefreshSignal}
        />
        <FreeTierBudgetWidget
          tier="mini"
          spentUsd={miniSpentUsd}
          refreshSignal={dispatchRefreshSignal}
          automation={miniBurnAutomation}
        />
        <CategoryJudgingWidget automation={judgeAutomation} />
        <GoogleDispatchWidget automation={googleBurnAutomation} />
      </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/benchmark/__tests__/ActivityPage.test.tsx`
Expected: PASS — full file, no regressions in the pre-existing tests.

- [ ] **Step 5: Run the full frontend suite and build**

Run: `cd frontend && npm run test:run && npm run build`
Expected: all green, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/benchmark/ActivityPage.tsx frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx
git commit -m "feat: wire daily-automation status into the Activity page"
```

---

## Final Verification

- [ ] **Backend unit tests:** `cd backend && npx jest` — all green.
- [ ] **Backend typecheck:** `cd backend && npx tsc --noEmit` — clean.
- [ ] **Frontend unit tests + build:** `cd frontend && npm run test:run && npm run build` — all green.
- [ ] **Migration round-trip — RUN SEPARATELY, after this branch has the dev DB to itself** (skipped during task execution — shared `connections-dev` Postgres): `cd backend && npm run migration:run && npm run migration:revert && npm run migration:revert && npm run migration:run` — clean each way. (Two `revert`s: one for each of the two new migrations, in reverse order.)
- [ ] **Manual smoke — RUN SEPARATELY (needs the live stack):**
  - Confirm `GET /automation/status` returns `lastRunAt: null` before the first run of a fresh day, and that after manually invoking `DailyAutomationService.run()` (or waiting for the 00:15 UTC cron, or restarting the worker to trigger the startup catch-up) it reflects real outcomes for all three legs.
  - Confirm the mini/nano tier's dispatch cycle, once started by the automation, actually stops at 80% usage (not 90/95%) by watching `FreeTierBudgetWidget`'s pill and bar.
  - Confirm `GET /dispatch/google` and `GoogleDispatchWidget` correctly reflect an active Google burn cycle, and that it stops on its own once every configured Google model is RPD-held (cross-check against `GoogleRateLimitHold` rows in the DB).
  - Confirm the Activity page shows all three "Auto-run: ... · Next: ..." lines and they update after a new automation run completes.
