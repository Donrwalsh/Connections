# Free-Tier DB Config and Prod DB Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the hardcoded flagship/mini free-tier model lists onto a new `SupportedModel.freeTier` column (so they're editable without a redeploy), and add Adminer to the production stack so the deployed database is reviewable/editable without shelling into the DB container.

**Architecture:** A nullable `freeTier` text column is added to the existing `SupportedModel` table via migration, backfilled with today's exact model→tier assignments. `SupportedModelService` gains a `findModelNamesByFreeTier` read method; `FreeTierUsageService` and `FreeTierDispatchService` are rewritten to source model lists and token limits from that method plus a small `FREE_TIER_LIMITS` code constant, instead of the deleted `FLAGSHIP_FREE_TIER`/`MINI_FREE_TIER`/`FREE_TIER_PROGRAMS` consts. Separately, an `adminer` container is added to `docker-compose.prod.yml`, giving direct Postgres browsing/editing in production, gated only by Adminer's own DB-login form.

**Tech Stack:** NestJS, TypeORM (Postgres), Jest, Docker Compose, Adminer.

**Spec:** [docs/superpowers/specs/2026-08-21-free-tier-db-config-and-prod-db-admin-design.md](../specs/2026-08-21-free-tier-db-config-and-prod-db-admin-design.md)

## Global Constraints

- No new backend write endpoints for free-tier config — editing happens directly via Adminer.
- `flagship`/`mini` remain a fixed two-value `FreeTierId` TypeScript union — no dynamic tiers.
- No Basic-Auth (or other) gate in front of Adminer beyond its own DB-credential login.
- No changes to local dev (`docker-compose.yml`) or to the frontend — nothing in this plan is user-facing.
- `dailyLimitTokens`/`label` stay as code constants (`FREE_TIER_LIMITS`), keyed by `FreeTierId` — only model membership moves to the DB.

---

### Task 1: `SupportedModel.freeTier` column (entity + migration)

**Files:**
- Modify: `backend/src/modules/supported-model/entities/supported-model.entity.ts`
- Create: `backend/src/migrations/1766000000000-add-supported-model-free-tier.ts`

**Interfaces:**
- Produces: `SupportedModel.freeTier: string | null` — the column Task 2's `findModelNamesByFreeTier` queries against.

- [ ] **Step 1: Add the `freeTier` column to the entity**

In `backend/src/modules/supported-model/entities/supported-model.entity.ts`, add a new column right after `supported`:

```ts
  @Column({ type: "boolean", default: true })
  supported: boolean;

  // Which free-tier program (see FreeTierId in
  // modules/strategy/free-tier-usage.service.ts) this model counts toward,
  // if any — null for a model that isn't part of either program. Editable
  // directly (e.g. via Adminer) with no redeploy required; the tier-level
  // token limits/labels stay as code constants (FREE_TIER_LIMITS) since
  // they're per-tier, not per-model.
  @Column({ type: "text", nullable: true })
  freeTier: string | null;

  @CreateDateColumn({
```

- [ ] **Step 2: Write the migration**

Create `backend/src/migrations/1766000000000-add-supported-model-free-tier.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds SupportedModel.freeTier and backfills it with the model→program
 * assignments that previously lived as hardcoded FLAGSHIP_FREE_TIER/
 * MINI_FREE_TIER constants in free-tier-usage.service.ts. From here on,
 * changing which models count toward a free-tier program is a direct edit
 * to this column (e.g. via Adminer), not a code change or migration.
 */
export class AddSupportedModelFreeTier1766000000000 implements MigrationInterface {
  name = "AddSupportedModelFreeTier1766000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SupportedModel" ADD COLUMN "freeTier" text`);

    await queryRunner.query(`
      UPDATE "SupportedModel" SET "freeTier" = 'flagship'
      WHERE "strategyName" = 'llm-openai'
        AND "modelName" IN ('gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3')
    `);

    await queryRunner.query(`
      UPDATE "SupportedModel" SET "freeTier" = 'mini'
      WHERE "strategyName" = 'llm-openai'
        AND "modelName" IN (
          'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1-mini',
          'gpt-4.1-nano', 'gpt-4o-mini', 'o3-mini', 'o4-mini', 'gpt-5-nano'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN "freeTier"`);
  }
}
```

- [ ] **Step 3: Run the migration against local dev Postgres and verify the backfill**

```bash
docker compose up -d db
cd backend
npm run migration:run
```

Expected: output includes `Migration AddSupportedModelFreeTier1766000000000 has been executed successfully.`

Then verify the backfill:

```bash
docker compose exec db psql -U postgres -d mydb -c "SELECT \"modelName\", \"freeTier\" FROM \"SupportedModel\" WHERE \"freeTier\" IS NOT NULL ORDER BY \"freeTier\", \"modelName\";"
```

Expected: 8 rows with `freeTier = flagship` (`gpt-4.1`, `gpt-4o`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `o1`, `o3`) and 9 rows with `freeTier = mini` (`gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-mini`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5.4-mini`, `gpt-5.4-nano`, `o3-mini`, `o4-mini`).

- [ ] **Step 4: Verify `down()` reverts cleanly, then re-apply**

```bash
npm run migration:revert
docker compose exec db psql -U postgres -d mydb -c "\d \"SupportedModel\""
```

Expected: the `freeTier` column is absent from the table description.

```bash
npm run migration:run
```

Expected: migration re-applies successfully (leaves the DB migrated for the rest of this plan).

- [ ] **Step 5: Build to confirm the entity change compiles**

```bash
npm run build
```

Expected: builds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/supported-model/entities/supported-model.entity.ts backend/src/migrations/1766000000000-add-supported-model-free-tier.ts
git commit -m "feat: add SupportedModel.freeTier column, backfill current tier data"
```

---

### Task 2: `SupportedModelService.findModelNamesByFreeTier`

**Files:**
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Test: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Consumes: `SupportedModel.freeTier: string | null` (Task 1)
- Produces: `SupportedModelService.findModelNamesByFreeTier(freeTier: string): Promise<string[]>` — consumed by Task 3's `FreeTierUsageService.getUsage`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/supported-model/supported-model.service.spec.ts`, add a new `describe` block (after the existing `findAll` block, before the closing `});` of the outer `describe`):

```ts
  describe("findModelNamesByFreeTier", () => {
    it("should return only model names matching the given free tier", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { id: 1, strategyName: "llm-openai", modelName: "gpt-5.4", freeTier: "flagship" },
        { id: 2, strategyName: "llm-openai", modelName: "gpt-4o", freeTier: "flagship" },
      ]);

      const result = await service.findModelNamesByFreeTier("flagship");

      expect(result).toEqual(["gpt-5.4", "gpt-4o"]);
      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { freeTier: "flagship" },
        order: { id: "ASC" },
      });
    });

    it("should return an empty array when no models are configured for the tier", async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const result = await service.findModelNamesByFreeTier("mini");

      expect(result).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend
npx jest supported-model.service.spec.ts -t findModelNamesByFreeTier
```

Expected: FAIL with `service.findModelNamesByFreeTier is not a function`.

- [ ] **Step 3: Implement the method**

In `backend/src/modules/supported-model/supported-model.service.ts`, add after `findAll`:

```ts
  /**
   * Model names currently assigned to a free-tier program (see FreeTierId
   * in ../strategy/free-tier-usage.service.ts), from the freeTier column —
   * consumed only by FreeTierUsageService.getUsage. Ordered by id (matching
   * getDefaultModel's convention) so the result is deterministic across
   * calls rather than depending on Postgres's unspecified default scan
   * order. Plain `string` (not FreeTierId) to avoid this module depending
   * on the strategy module's types.
   */
  async findModelNamesByFreeTier(freeTier: string): Promise<string[]> {
    const rows = await this.repo.find({ where: { freeTier }, order: { id: "ASC" } });
    return rows.map((row) => row.modelName);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest supported-model.service.spec.ts
```

Expected: PASS, all tests in the file (including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/supported-model.service.ts backend/src/modules/supported-model/supported-model.service.spec.ts
git commit -m "feat: add SupportedModelService.findModelNamesByFreeTier"
```

---

### Task 3: Rewrite `FreeTierUsageService` and `FreeTierDispatchService` to read from the DB

**Files:**
- Modify: `backend/src/modules/strategy/free-tier-usage.service.ts`
- Test: `backend/src/modules/strategy/free-tier-usage.service.spec.ts`
- Modify: `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts`
- Test: `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `SupportedModelService.findModelNamesByFreeTier(freeTier: string): Promise<string[]>` (Task 2)
- Produces: `FreeTierUsageService.getUsage(tier: FreeTierId): Promise<FreeTierUsageDto>` — same shape as before (`tier`, `label`, `usedTokens`, `dailyLimitTokens`, `remainingTokens`, `models`); `FREE_TIER_LIMITS: Record<FreeTierId, { label: string; dailyLimitTokens: number }>` (replaces the deleted `FLAGSHIP_FREE_TIER`/`MINI_FREE_TIER`/`FREE_TIER_PROGRAMS`).

This task touches both services together because `FreeTierDispatchService` imports the same consts being deleted from `FreeTierUsageService` — splitting it would leave the build broken between commits.

- [ ] **Step 1: Update the `FreeTierUsageService` spec to mock `SupportedModelService` instead of the hardcoded consts**

Replace the full contents of `backend/src/modules/strategy/free-tier-usage.service.spec.ts` with:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { SupportedModelService } from "../supported-model/supported-model.service";

const FLAGSHIP_MODELS = ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"];
const MINI_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
  "gpt-5-nano",
];

describe("FreeTierUsageService", () => {
  let service: FreeTierUsageService;
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };
  let mockSupportedModelService: { findModelNamesByFreeTier: jest.Mock };

  function mockUsageQuery(totalTokens: string | null) {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(totalTokens === null ? undefined : { totalTokens }),
    };
    mockSolvePromptRepo.createQueryBuilder.mockReturnValue(qb);
    return qb;
  }

  beforeEach(async () => {
    mockSolvePromptRepo = { createQueryBuilder: jest.fn() };
    mockSupportedModelService = {
      findModelNamesByFreeTier: jest
        .fn()
        .mockImplementation(async (tier: string) =>
          tier === "flagship" ? [...FLAGSHIP_MODELS] : [...MINI_MODELS],
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierUsageService,
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
      ],
    }).compile();

    service = module.get<FreeTierUsageService>(FreeTierUsageService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("getFlagshipUsage", () => {
    it("should query only the flagship program's models, joined through the run", async () => {
      const qb = mockUsageQuery("1000");

      await service.getFlagshipUsage();

      expect(mockSupportedModelService.findModelNamesByFreeTier).toHaveBeenCalledWith("flagship");
      expect(mockSolvePromptRepo.createQueryBuilder).toHaveBeenCalledWith("prompt");
      expect(qb.innerJoin).toHaveBeenCalledWith("prompt.strategyRun", "run");
      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", {
        models: FLAGSHIP_MODELS,
      });
    });

    it("should return used/limit/remaining, tier id, and label for the 250k budget", async () => {
      mockUsageQuery("62340");

      const result = await service.getFlagshipUsage();

      expect(result).toEqual({
        tier: "flagship",
        label: "Flagship models",
        usedTokens: 62340,
        dailyLimitTokens: 250_000,
        remainingTokens: 187_660,
        models: FLAGSHIP_MODELS,
      });
    });

    it("should clamp remainingTokens to zero once usage exceeds the daily limit", async () => {
      mockUsageQuery("300000");

      const result = await service.getFlagshipUsage();

      expect(result.usedTokens).toBe(300_000);
      expect(result.remainingTokens).toBe(0);
    });
  });

  describe("getMiniUsage", () => {
    it("should query only the mini program's models, a disjoint set from the flagship program", async () => {
      const qb = mockUsageQuery("1000");

      await service.getMiniUsage();

      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", { models: MINI_MODELS });
      expect(MINI_MODELS.some((model) => FLAGSHIP_MODELS.includes(model))).toBe(false);
    });

    it("should return used/limit/remaining, tier id, and label for the 2.5M budget", async () => {
      mockUsageQuery("500000");

      const result = await service.getMiniUsage();

      expect(result.tier).toBe("mini");
      expect(result.label).toBe("Mini & nano models");
      expect(result.usedTokens).toBe(500_000);
      expect(result.dailyLimitTokens).toBe(2_500_000);
      expect(result.remainingTokens).toBe(2_000_000);
    });
  });

  it("should scope the query to tokens spent since UTC midnight today", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-18T15:30:00.000Z"));
    const qb = mockUsageQuery("0");

    await service.getFlagshipUsage();

    expect(qb.andWhere).toHaveBeenCalledWith("prompt.createdAt >= :startOfTodayUtc", {
      startOfTodayUtc: new Date("2026-08-18T00:00:00.000Z"),
    });
  });

  it("should treat no matching rows as zero tokens used", async () => {
    mockUsageQuery(null);

    const result = await service.getFlagshipUsage();

    expect(result.usedTokens).toBe(0);
    expect(result.remainingTokens).toBe(250_000);
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

```bash
cd backend
npx jest free-tier-usage.service.spec.ts
```

Expected: FAIL — compile error, `FLAGSHIP_FREE_TIER`/`MINI_FREE_TIER`/`FREE_TIER_PROGRAMS` no longer exist on the still-unmodified `free-tier-usage.service.ts` import surface is fine, but `SupportedModelService` isn't yet a constructor param, so DI resolution fails (`Nest can't resolve dependencies of FreeTierUsageService`).

- [ ] **Step 3: Rewrite `free-tier-usage.service.ts`**

Replace the full contents of `backend/src/modules/strategy/free-tier-usage.service.ts` with:

```ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { startOfTodayUtc } from "../../strategies";
import { SupportedModelService } from "../supported-model/supported-model.service";

// Two separate provider programs, each with its own daily token allowance.
// Model membership lives on SupportedModel.freeTier (see
// SupportedModelService.findModelNamesByFreeTier) so it's editable without a
// code change or redeploy. dailyLimitTokens/label are tier-level, not
// model-level, so they stay as the FREE_TIER_LIMITS constant below rather
// than a column on a model-keyed table.
export type FreeTierId = "flagship" | "mini";

export const FREE_TIER_LIMITS: Record<FreeTierId, { label: string; dailyLimitTokens: number }> = {
  flagship: { label: "Flagship models", dailyLimitTokens: 250_000 },
  mini: { label: "Mini & nano models", dailyLimitTokens: 2_500_000 },
};

export interface FreeTierUsageDto {
  tier: FreeTierId;
  label: string;
  usedTokens: number;
  dailyLimitTokens: number;
  remainingTokens: number;
  // The models counted toward usedTokens — from SupportedModel.freeTier.
  models: string[];
}

@Injectable()
export class FreeTierUsageService {
  constructor(
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
    private readonly supportedModelService: SupportedModelService,
  ) {}

  async getFlagshipUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage("flagship");
  }

  async getMiniUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage("mini");
  }

  /**
   * Tokens spent today (UTC) across every run of `tier`'s models, summed
   * from SolvePrompt.totalTokens — the same per-call token figure
   * StrategyService's cost calculations use. "Today" resets at UTC midnight
   * rather than server-local time, since that's when the provider's own
   * usage window resets. getFlagshipUsage/getMiniUsage are thin wrappers
   * over this; FreeTierDispatchService calls it directly since it needs to
   * look usage up by whichever tier it's currently ticking.
   */
  async getUsage(tier: FreeTierId): Promise<FreeTierUsageDto> {
    const { label, dailyLimitTokens } = FREE_TIER_LIMITS[tier];
    const models = await this.supportedModelService.findModelNamesByFreeTier(tier);

    const raw = await this.solvePromptRepo
      .createQueryBuilder("prompt")
      .innerJoin("prompt.strategyRun", "run")
      .where("run.modelName IN (:...models)", { models })
      .andWhere("prompt.createdAt >= :startOfTodayUtc", { startOfTodayUtc: startOfTodayUtc() })
      .select("COALESCE(SUM(prompt.totalTokens), 0)", "totalTokens")
      .getRawOne<{ totalTokens: string }>();

    const usedTokens = Number(raw?.totalTokens ?? 0);

    return {
      tier,
      label,
      usedTokens,
      dailyLimitTokens,
      remainingTokens: Math.max(0, dailyLimitTokens - usedTokens),
      models,
    };
  }
}
```

- [ ] **Step 4: Run the `FreeTierUsageService` spec to verify it passes**

```bash
npx jest free-tier-usage.service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Update the `FreeTierDispatchService` spec's fixtures**

The spec currently imports `MINI_FREE_TIER`/`FLAGSHIP_FREE_TIER` from `free-tier-usage.service.ts` — both were just deleted in Step 3, so this spec no longer compiles. Replace the full contents of `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.spec.ts` with:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierDispatchService } from "./free-tier-dispatch.service";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { FREE_TIER_DISPATCH_QUEUE } from "../queue/queue.module";
import { StrategyService } from "../strategy/strategy.service";
import { FreeTierId, FreeTierUsageService } from "../strategy/free-tier-usage.service";

const FLAGSHIP_MODELS = ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"];
const MINI_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
  "gpt-5-nano",
];
const FLAGSHIP_LIMIT = 250_000;
const MINI_LIMIT = 2_500_000;
const FLAGSHIP_LABEL = "Flagship models";
const MINI_LABEL = "Mini & nano models";

describe("FreeTierDispatchService", () => {
  let service: FreeTierDispatchService;
  let mockStateRepo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStrategyService: {
    countInFlightByModel: jest.Mock;
    countTodayDispatchByModel: jest.Mock;
    findUnrunPuzzleDatesForModel: jest.Mock;
    triggerStrategyRuns: jest.Mock;
  };
  let mockFreeTierUsageService: { getUsage: jest.Mock };

  const zeroCounts = (tier: FreeTierId = "mini") => {
    const models = tier === "mini" ? MINI_MODELS : FLAGSHIP_MODELS;
    return new Map(models.map((model) => [model, 0]));
  };

  // Default usage stub for a tier: zero spend, full budget remaining. Tests
  // override with mockResolvedValueOnce for the specific numbers they need.
  const usageStub = (tier: FreeTierId, overrides: Record<string, unknown> = {}) => {
    const isMini = tier === "mini";
    return {
      tier,
      label: isMini ? MINI_LABEL : FLAGSHIP_LABEL,
      usedTokens: 0,
      dailyLimitTokens: isMini ? MINI_LIMIT : FLAGSHIP_LIMIT,
      remainingTokens: isMini ? MINI_LIMIT : FLAGSHIP_LIMIT,
      models: [...(isMini ? MINI_MODELS : FLAGSHIP_MODELS)],
      ...overrides,
    };
  };

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
    mockFreeTierUsageService = {
      getUsage: jest.fn().mockImplementation(async (tier: FreeTierId) => usageStub(tier)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierDispatchService,
        { provide: getRepositoryToken(FreeTierDispatchState), useValue: mockStateRepo },
        { provide: FREE_TIER_DISPATCH_QUEUE, useValue: mockQueue },
        { provide: StrategyService, useValue: mockStrategyService },
        { provide: FreeTierUsageService, useValue: mockFreeTierUsageService },
      ],
    }).compile();

    service = module.get<FreeTierDispatchService>(FreeTierDispatchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.FREE_TIER_DISPATCH_MAX_BATCH;
    delete process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT;
    delete process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE;
    delete process.env.FREE_TIER_DISPATCH_TICK_MS;
  });

  describe("start", () => {
    it("should reject a tier that isn't a real free-tier program", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.start("bogus" as FreeTierId, 90)).rejects.toThrow(BadRequestException);
      expect(mockStateRepo.save).not.toHaveBeenCalled();
    });

    it("should reject a non-integer threshold", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 87.5)).rejects.toThrow(BadRequestException);
    });

    it("should reject a threshold of 0 or below", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 0)).rejects.toThrow(BadRequestException);
    });

    it("should reject a threshold above 100", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.start("mini", 101)).rejects.toThrow(BadRequestException);
    });

    it("should reject starting a cycle that's already active", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 80,
      });

      await expect(service.start("mini", 90)).rejects.toThrow(
        new BadRequestException(
          "Free-tier dispatch for 'mini' is already running at a 80% threshold. Stop it first to change the threshold.",
        ),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should save active state and enqueue the first tick with no delay", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 90,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.start("mini", 90);

      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "mini", active: true, thresholdPercent: 90 }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: 0, jobId: expect.stringContaining("free-tier-dispatch-mini-") }),
      );
      expect(result.active).toBe(true);
      expect(result.thresholdPercent).toBe(90);
    });

    it("should start a flagship cycle the same way as mini", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        tier: "flagship",
        active: true,
        thresholdPercent: 75,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.start("flagship", 75);

      expect(mockStateRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "flagship", active: true, thresholdPercent: 75 }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "flagship" },
        expect.objectContaining({ jobId: expect.stringContaining("free-tier-dispatch-flagship-") }),
      );
      expect(result).toEqual(
        expect.objectContaining({ tier: "flagship", active: true, thresholdPercent: 75 }),
      );
    });

    it("should track flagship and mini as independent cycles — starting one doesn't touch the other", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null); // no existing mini cycle

      await service.start("mini", 90);

      // The "already running" check only looked at 'mini's own row.
      expect(mockStateRepo.findOne).toHaveBeenCalledWith({ where: { tier: "mini" } });
      expect(mockStateRepo.findOne).not.toHaveBeenCalledWith({ where: { tier: "flagship" } });
    });

    it("should give each start() call a distinct job id, even for the same tier", async () => {
      mockStateRepo.findOne.mockResolvedValue(null);

      await service.start("mini", 90);
      await service.stop("mini");
      await service.start("mini", 80);

      const jobIds = mockQueue.add.mock.calls.map((call) => call[2].jobId);
      expect(new Set(jobIds).size).toBe(jobIds.length);
    });
  });

  describe("stop", () => {
    it("should deactivate the tier and return its status", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: false,
        thresholdPercent: 90,
        startedAt: new Date("2024-01-01T00:00:00Z"),
      });

      const result = await service.stop("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(result.active).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should report inactive with null threshold when no state row exists", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getStatus("mini");

      expect(result).toEqual({ tier: "mini", active: false, thresholdPercent: null, startedAt: null });
    });

    it("should report the stored state when a row exists", async () => {
      const startedAt = new Date("2024-01-01T00:00:00Z");
      mockStateRepo.findOne.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 85,
        startedAt,
      });

      const result = await service.getStatus("mini");

      expect(result).toEqual({ tier: "mini", active: true, thresholdPercent: 85, startedAt });
    });
  });

  describe("runTick", () => {
    it("should do nothing when the tier has no active state", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce(null);

      await service.runTick("mini");

      expect(mockFreeTierUsageService.getUsage).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should do nothing when the tier's state row is present but inactive", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: false, thresholdPercent: 90 });

      await service.runTick("mini");

      expect(mockFreeTierUsageService.getUsage).not.toHaveBeenCalled();
    });

    it("should stop the cycle once usage reaches the threshold", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 10 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(
        usageStub("mini", { usedTokens: 250_001 }), // 10% of 2.5M is 250,000
      );

      await service.runTick("mini");

      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should hold off on new dispatches, but keep ticking, once the in-flight backlog hits its cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "2";
      // 3 trials already in flight exceeds the cap of 2 set above, on its
      // own, regardless of token budget.
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 3);
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStrategyService.countTodayDispatchByModel).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should dispatch only enough to fill the remaining in-flight headroom, not the full batch cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "5";
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "3";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1"; // budget is never the limiting factor here
      const inFlight = zeroCounts();
      inFlight.set("gpt-4.1-nano", 2); // cap is 3, so only 1 more trial has headroom
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(inFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
    });

    it("should hold off on new dispatches, but keep ticking, when the token budget is nearly spoken for", async () => {
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "4000";
      // Raise the in-flight cap so this test exercises the token-budget
      // check specifically, not the (lower-priority) in-flight cap above.
      process.env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT = "1000";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      // thresholdTokens = 2,250,000; remainingBudget = 2,250,000. With 900
      // trials in flight (100 per model) at the 4000-token estimate, that's
      // 3,600,000 reserved — already well over budget on its own.
      const heavyInFlight = new Map(MINI_MODELS.map((model) => [model, 100]));
      mockStrategyService.countInFlightByModel.mockResolvedValueOnce(heavyInFlight);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should dispatch to the least-allocated models first, up to the batch cap", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1"; // budget is never the limiting factor here
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      // Every model starts well-represented except two, which are the only
      // ones that should receive this tick's dispatches.
      const allocation = new Map(MINI_MODELS.map((model) => [model, 5]));
      allocation.set("o4-mini", 0);
      allocation.set("o3-mini", 0);
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
        { puzzleId: 42, date: "2024-06-01" },
      ]);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(2);
      const dispatchedModels = mockStrategyService.triggerStrategyRuns.mock.calls.map((call) => call[3]);
      expect(new Set(dispatchedModels)).toEqual(new Set(["o4-mini", "o3-mini"]));
    });

    it("should schedule a further tick after a successful partial dispatch", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStateRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith(
        "tick",
        { tier: "mini" },
        expect.objectContaining({ delay: expect.any(Number) }),
      );
    });

    it("should skip a model with no unrun puzzles left and try the next one", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));

      const allocation = zeroCounts();
      mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
      // Every model ties at 0, so iteration order decides who's tried
      // first — exhaust all of them except the last so the loop is forced
      // to fall through to a model that actually has a puzzle.
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);
      mockStrategyService.findUnrunPuzzleDatesForModel.mockImplementation(async (_s, model: string) =>
        model === "gpt-5-nano" ? [{ puzzleId: 1, date: "2024-01-01" }] : [],
      );

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledWith(
        1,
        "llm-openai",
        "2024-01-01",
        "gpt-5-nano",
      );
    });

    it("should stop the cycle when every model has run out of unrun puzzles", async () => {
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

      await service.runTick("mini");

      expect(mockStrategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should treat a triggerStrategyRuns failure as that model being unavailable this tick, not a hard failure", async () => {
      process.env.FREE_TIER_DISPATCH_MAX_BATCH = "1";
      process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
      mockStateRepo.findOne.mockResolvedValueOnce({ tier: "mini", active: true, thresholdPercent: 90 });
      mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("mini"));
      mockStrategyService.triggerStrategyRuns.mockRejectedValue(new Error("model rejected"));

      await expect(service.runTick("mini")).resolves.toBeUndefined();

      // Every model was tried and failed the same way -> cycle stops rather
      // than looping forever.
      expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "mini" }, { active: false });
    });

    describe("flagship tier", () => {
      it("should look up usage and budget for flagship, not mini", async () => {
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 10,
        });
        // 10% of flagship's 250,000 budget is 25,000 — already reached.
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(
          usageStub("flagship", { usedTokens: 25_000 }),
        );

        await service.runTick("flagship");

        expect(mockFreeTierUsageService.getUsage).toHaveBeenCalledWith("flagship");
        expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "flagship" }, { active: false });
      });

      it("should dispatch across flagship's own models, evenly, the same way as mini", async () => {
        process.env.FREE_TIER_DISPATCH_MAX_BATCH = "2";
        process.env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE = "1";
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyService.countInFlightByModel.mockResolvedValueOnce(zeroCounts("flagship"));

        const allocation = new Map(FLAGSHIP_MODELS.map((model) => [model, 5]));
        allocation.set("o1", 0);
        allocation.set("o3", 0);
        mockStrategyService.countTodayDispatchByModel.mockResolvedValueOnce(allocation);
        mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([
          { puzzleId: 7, date: "2024-03-01" },
        ]);

        await service.runTick("flagship");

        expect(mockStrategyService.triggerStrategyRuns).toHaveBeenCalledTimes(2);
        const dispatchedModels = mockStrategyService.triggerStrategyRuns.mock.calls.map(
          (call) => call[3],
        );
        expect(new Set(dispatchedModels)).toEqual(new Set(["o1", "o3"]));
        // Never a mini-tier model, confirming this pulled from the flagship usage stub.
        expect(dispatchedModels).not.toContain("gpt-5-nano");
      });

      it("should run its own independent cycle without affecting mini's state", async () => {
        mockStateRepo.findOne.mockResolvedValueOnce({
          tier: "flagship",
          active: true,
          thresholdPercent: 90,
        });
        mockFreeTierUsageService.getUsage.mockResolvedValueOnce(usageStub("flagship"));
        mockStrategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);

        await service.runTick("flagship");

        expect(mockStateRepo.update).toHaveBeenCalledWith({ tier: "flagship" }, { active: false });
        expect(mockStateRepo.update).not.toHaveBeenCalledWith({ tier: "mini" }, expect.anything());
      });
    });
  });
});
```

- [ ] **Step 6: Run the `FreeTierDispatchService` spec to verify it fails**

```bash
npx jest free-tier-dispatch.service.spec.ts
```

Expected: FAIL — `free-tier-dispatch.service.ts` still reads `program.models`/`program.dailyLimitTokens` off the now-deleted `FREE_TIER_PROGRAMS`, so this won't even compile (`Module '"../strategy/free-tier-usage.service"' has no exported member 'FREE_TIER_PROGRAMS'`).

- [ ] **Step 7: Rewrite `free-tier-dispatch.service.ts`**

In `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts`:

Replace the import block (lines 8-12):

```ts
import {
  FreeTierUsageService,
  FreeTierId,
  FREE_TIER_PROGRAMS,
} from "../strategy/free-tier-usage.service";
```

with:

```ts
import { FreeTierUsageService, FreeTierId } from "../strategy/free-tier-usage.service";
```

Replace the comment above `DISPATCHABLE_TIERS` (lines 30-33):

```ts
// Both programs support continuous dispatch. Kept as an explicit allowlist
// (not "every FreeTierId") rather than deriving it from FREE_TIER_PROGRAMS,
// so adding a future program to that config doesn't silently start
// auto-dispatching against it before that's actually decided.
```

with:

```ts
// Both programs support continuous dispatch. Kept as an explicit allowlist
// (not "every FreeTierId") rather than deriving it from the DB-backed
// free-tier config, so adding a future program there doesn't silently start
// auto-dispatching against it before that's actually decided.
```

In `runTick`, replace:

```ts
    const program = FREE_TIER_PROGRAMS[tier];
    const usage = await this.freeTierUsageService.getUsage(tier);
    const thresholdTokens = Math.floor(program.dailyLimitTokens * (state.thresholdPercent / 100));
```

with:

```ts
    const usage = await this.freeTierUsageService.getUsage(tier);
    const thresholdTokens = Math.floor(usage.dailyLimitTokens * (state.thresholdPercent / 100));
```

Replace:

```ts
    const inFlight = await this.strategyService.countInFlightByModel(LLM_OPENAI, program.models);
```

with:

```ts
    const inFlight = await this.strategyService.countInFlightByModel(LLM_OPENAI, usage.models);
```

Replace:

```ts
    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_OPENAI, program.models);
```

with:

```ts
    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_OPENAI, usage.models);
```

Replace:

```ts
    while (dispatched < maxNewTrials && exhausted.size < program.models.length) {
```

with:

```ts
    while (dispatched < maxNewTrials && exhausted.size < usage.models.length) {
```

Replace:

```ts
    if (exhausted.size === program.models.length) {
```

with:

```ts
    if (exhausted.size === usage.models.length) {
```

- [ ] **Step 8: Run the `FreeTierDispatchService` spec to verify it passes**

```bash
npx jest free-tier-dispatch.service.spec.ts
```

Expected: PASS, all tests.

- [ ] **Step 9: Run the full backend unit test suite and build**

```bash
npm test
npm run build
```

Expected: all suites PASS, build has no TypeScript errors (in particular, no remaining references anywhere in `backend/src` to `FLAGSHIP_FREE_TIER`, `MINI_FREE_TIER`, or `FREE_TIER_PROGRAMS`).

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/strategy/free-tier-usage.service.ts backend/src/modules/strategy/free-tier-usage.service.spec.ts backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.spec.ts
git commit -m "refactor: source free-tier model lists/limits from the DB instead of hardcoded consts"
```

---

### Task 4: Adminer in production + README docs

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `README.md`

**Interfaces:** None (infra/docs only — no code dependency on Tasks 1-3).

- [ ] **Step 1: Add the `adminer` service to `docker-compose.prod.yml`**

Insert after the `db` service's block (after the commented-out `#   - "5432:5432"` line, before the blank line preceding `redis:`):

```yaml

  adminer:
    image: adminer:latest
    container_name: adminer
    restart: unless-stopped
    environment:
      ADMINER_DEFAULT_SERVER: db
    ports:
      - "8091:8080"
    depends_on:
      db:
        condition: service_healthy
```

- [ ] **Step 2: Validate the compose file parses**

```bash
docker compose -f docker-compose.prod.yml config --quiet
```

Expected: exits 0 with no output (warnings about unset env vars with no default, e.g. `INTERNAL_API_KEY`, are expected and fine since no `.env` is loaded for this check).

- [ ] **Step 3: Optional local smoke test**

```bash
cp .env.sample .env.smoke-test
docker compose -f docker-compose.prod.yml --env-file .env.smoke-test up -d db adminer
curl -s http://localhost:8091 | grep -i "adminer"
docker compose -f docker-compose.prod.yml --env-file .env.smoke-test down
rm .env.smoke-test
```

Expected: the `curl` output contains Adminer's login page HTML (its title/branding).

- [ ] **Step 4: Document Adminer in `README.md`**

After the paragraph ending `...never requires a password on these routes.` (the `DispatchAuthGuard`/`NODE_ENV=production` paragraph, immediately before the `### No Ollama in the cloud — Option B` heading), insert:

```markdown
### Reviewing production data (Adminer)

`docker-compose.prod.yml` also runs [Adminer](https://www.adminer.org/), a lightweight Postgres browser, at `http://<host>:8091`. It reuses the existing `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` from `.env` — no separate credentials to set up. Unlike Bull Board (`/admin/queues`, gated by `BULL_BOARD_USER`/`BULL_BOARD_PASS` Basic Auth in front of the tool itself), Adminer runs as its own container and relies solely on its own DB-login form — publishing port 8091 makes that login page reachable by anyone with the URL, though real access still requires the Postgres password. Don't publish this port on a host without other network-level protection (a private tunnel, or Coolify/firewall access rules) — the same caution as the commented-out `db`/`redis` ports in `docker-compose.prod.yml`.

```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml README.md
git commit -m "feat: add Adminer to the production stack for hands-on DB review"
```
