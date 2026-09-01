# LLM Google RPD Hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Google (`llm-google`) model exhausts its free-tier requests-per-day quota, hold every `llm-google` run for that one model until the next midnight Pacific, then resume the parked runs automatically.

**Architecture:** The orchestrator learns to classify a Google per-day 429 as a new `rate_limited_daily` error code (distinct from the existing per-minute `rate_limited`). The backend runner reacts to that code by writing a per-model row to a new `GoogleRateLimitHold` table (with `resetAt` = next `America/Los_Angeles` midnight) and parking the run at a new non-terminal `StrategyRunStatus.RATE_LIMITED_DAILY`. A top-gate in the runner short-circuits any already-queued job whose model is currently held, costing one indexed read instead of a doomed Google call. A dedicated `google-rpd-resume` BullMQ queue runs a sweep on a `00:01` Pacific cron that clears expired holds and re-dispatches the parked runs, which resume from their flushed guesses.

**Tech Stack:** NestJS + TypeORM + Postgres + BullMQ (backend/worker), Hono + `@ai-sdk/google` + Vitest (orchestrator), React + Vitest (frontend). Backend tests: Jest. Orchestrator/frontend tests: Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md`

## Global Constraints

- Detection is **reactive only** — the hold engages when Google actually returns a per-day 429. No proactive request counting, no configured per-model RPD numbers.
- The hold is scoped to the **single model** that hit its RPD. Other `llm-google` models keep processing.
- Reset zone is **fixed** to `America/Los_Angeles` (DST-aware). Not configurable. **No new environment variables** are introduced.
- `StrategyRunStatus.RATE_LIMITED_DAILY` (enum string value `"rateLimitedDaily"`) is **not** a terminal status — it must stay out of `TERMINAL_STATUSES` so `loadOrCreateRun` resumes it.
- New migration timestamp: `1777000000000` (the next free slot after `1776000000000-add-gemini-flash-models.ts`).
- The per-minute `rate_limited` path is **unchanged**. This feature only adds the per-day sibling.
- TDD throughout: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Match surrounding code style: explicit `@Inject(Token)` for every class-to-class constructor injection in the backend (bare typed params resolve to `undefined` under the worker's `tsx`/`esbuild` runtime).

---

### Task 1: Orchestrator — classify a Google per-day 429 as `rate_limited_daily`

**Files:**
- Modify: `orchestrator/src/types.ts:58-64` (`SolveErrorCodeSchema`)
- Modify: `orchestrator/src/solver.ts` (add `isGoogleDailyRateLimit`, extend `classifyModelCallError`)
- Modify: `orchestrator/src/app.ts:18-23` (`ERROR_STATUS`)
- Test: `orchestrator/src/solver.test.ts` (rewrite the existing RPD test, add two)
- Test: `orchestrator/src/app.test.ts` (add a round-trip test after the `rate_limited` one near line 285)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the string `"rate_limited_daily"` as a member of `SolveErrorCode` / `SolveErrorCodeSchema`; `classifyModelCallError(err, "google", details)` returns a `SolveError` with `code === "rate_limited_daily"` and no `retryAfterSeconds` when the 429 body is a `QuotaFailure` whose `quotaId`/`quotaMetric` contains `"PerDay"`; the orchestrator HTTP layer maps that code to status `429`.

- [ ] **Step 1: Rewrite the failing RPD test and add coverage**

In `orchestrator/src/solver.test.ts`, replace the existing test `it("classifies a Google daily (RPD) hit as model_error, not rate_limited", ...)` with:

```ts
  it("classifies a Google daily (RPD) hit as rate_limited_daily with no retryAfterSeconds", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPD_BODY });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.retryAfterSeconds).toBeUndefined();
  });

  it("does not classify a non-google provider's per-day 429 as rate_limited_daily", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPD_BODY });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("classifies a Google 429 with neither PerMinute nor PerDay as model_error", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateContentInputTokensPerModel-FreeTier" }],
          },
        ],
      },
    });
    const err = makeAPICallError({ statusCode: 429, responseBody: body });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: FAIL — the rewritten test expects `"rate_limited_daily"` but the code still returns `"model_error"`; TypeScript may also error that `"rate_limited_daily"` is not assignable to `SolveErrorCode`.

- [ ] **Step 3: Add `"rate_limited_daily"` to the error-code schema**

In `orchestrator/src/types.ts`, extend `SolveErrorCodeSchema`:

```ts
export const SolveErrorCodeSchema = z.enum([
  "duplicate_group",
  "invalid_group",
  "model_error",
  "rate_limited",
  "rate_limited_daily",
]);
```

- [ ] **Step 4: Add the per-day detector and classify branch in `solver.ts`**

In `orchestrator/src/solver.ts`, add this function directly below `parseGoogleRateLimit` (it reuses the `GoogleQuotaFailureDetail` interface already defined above `parseGoogleRateLimit`):

```ts
/**
 * True when a Google 429 responseBody carries a QuotaFailure whose violation
 * names a per-day quota ("PerDay" in the quotaId or quotaMetric). Uses the
 * same defensive parsing as parseGoogleRateLimit — never throws, returns
 * false for any shape it doesn't recognize (not JSON, no QuotaFailure, a
 * per-minute violation, etc). The daily reset time is not carried in the
 * body; the backend computes it as the next America/Los_Angeles midnight.
 */
function isGoogleDailyRateLimit(responseBody: unknown): boolean {
  if (typeof responseBody !== "string") return false;

  let parsed: { error?: { details?: Array<GoogleQuotaFailureDetail> } };
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return false;
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return false;

  const quotaFailure = details.find(
    (d): d is GoogleQuotaFailureDetail =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as GoogleQuotaFailureDetail)["@type"] === "string" &&
      (d as GoogleQuotaFailureDetail)["@type"].endsWith("QuotaFailure"),
  );

  return (
    quotaFailure?.violations?.some(
      (v) =>
        (typeof v.quotaId === "string" && v.quotaId.includes("PerDay")) ||
        (typeof v.quotaMetric === "string" && v.quotaMetric.includes("PerDay")),
    ) ?? false
  );
}
```

Then in `classifyModelCallError`, extend the existing Google 429 block so it reads:

```ts
  if (provider === "google" && APICallError.isInstance(err) && err.statusCode === 429) {
    const retryAfterSeconds = parseGoogleRateLimit(err.responseBody);
    if (retryAfterSeconds !== null) {
      return new SolveError("rate_limited", `Google rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds,
      });
    }
    if (isGoogleDailyRateLimit(err.responseBody)) {
      return new SolveError("rate_limited_daily", `Google daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
      });
    }
  }
```

- [ ] **Step 5: Map the new code to HTTP 429**

In `orchestrator/src/app.ts`, extend `ERROR_STATUS`:

```ts
const ERROR_STATUS: Record<SolveError["code"], 409 | 400 | 429 | 502> = {
  duplicate_group: 409,
  invalid_group: 400,
  model_error: 502,
  rate_limited: 429,
  rate_limited_daily: 429,
};
```

- [ ] **Step 6: Add the app-level round-trip test**

In `orchestrator/src/app.test.ts`, directly after the `it("returns 429 with retryAfterSeconds for a rate_limited failure", ...)` test, add:

```ts
    it("returns 429 for a rate_limited_daily failure", async () => {
      const { SolveError } = await import("./solver.js");
      solveAssistMock.mockRejectedValueOnce(
        new SolveError("rate_limited_daily", "Google daily quota exhausted"),
      );

      const res = await solveAssistRequest({
        messages: SOLVE_ASSIST_BODY.messages,
        model: "gemini-3.6-flash",
        provider: "google",
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("rate_limited_daily");
    });
```

- [ ] **Step 7: Run the orchestrator test suite to verify green**

Run: `cd orchestrator && npm test`
Expected: PASS — all of `solver.test.ts` and `app.test.ts`, including the new cases.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/types.ts orchestrator/src/solver.ts orchestrator/src/app.ts orchestrator/src/solver.test.ts orchestrator/src/app.test.ts
git commit -m "feat: classify a Google per-day 429 as rate_limited_daily"
```

---

### Task 2: Backend orchestrator client — carry `rate_limited_daily` through untouched

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts:4` (`SolveErrorCode` union) and `:201-208` (`isKnownErrorCode`)
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts` (add one test near the existing `rate_limited` test around line 138)

**Interfaces:**
- Consumes: the `"rate_limited_daily"` code produced by the orchestrator (Task 1).
- Produces: `OrchestratorService.SolveErrorCode` includes `"rate_limited_daily"`; a `solveAssist` outcome for a 429 body carrying `code: "rate_limited_daily"` returns `{ ok: false, error: { code: "rate_limited_daily", ... } }` rather than coercing to `"model_error"`.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/strategy/orchestrator.service.spec.ts`, add after the `it("should extract retryAfterSeconds from a rate_limited failure", ...)` test:

```ts
  it("should pass rate_limited_daily through instead of coercing it to model_error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "Google daily quota exhausted",
          code: "rate_limited_daily",
          details: {},
        },
      }),
    );

    const outcome = await service.solveAssist(
      [{ role: "user", content: "hi" }],
      "gemini-3.6-flash",
      "google",
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("rate_limited_daily");
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/orchestrator.service.spec.ts -t "rate_limited_daily"`
Expected: FAIL — `outcome.error.code` is `"model_error"` because `isKnownErrorCode` rejects the unknown string; TypeScript also errors on the `.toBe("rate_limited_daily")` comparison against the current union.

- [ ] **Step 3: Extend the union and the guard**

In `backend/src/modules/strategy/orchestrator.service.ts`:

```ts
export type SolveErrorCode =
  | "duplicate_group"
  | "invalid_group"
  | "model_error"
  | "rate_limited"
  | "rate_limited_daily";
```

```ts
  private isKnownErrorCode(code: string | undefined): code is SolveErrorCode {
    return (
      code === "duplicate_group" ||
      code === "invalid_group" ||
      code === "model_error" ||
      code === "rate_limited" ||
      code === "rate_limited_daily"
    );
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/modules/strategy/orchestrator.service.spec.ts`
Expected: PASS — the whole file.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat: carry the rate_limited_daily code through the orchestrator client"
```

---

### Task 3: `GoogleRateLimitHold` entity, `RATE_LIMITED_DAILY` status, and migration

**Files:**
- Create: `backend/src/modules/strategy/entities/google-rate-limit-hold.entity.ts`
- Modify: `backend/src/modules/strategy/entities/strategy-run.entity.ts:17-33` (add enum member; leave `TERMINAL_STATUSES` alone)
- Create: `backend/src/migrations/1777000000000-add-google-rate-limit-hold.ts`
- Modify: `backend/src/app.module.ts:23,47-58` (import + register entity)
- Modify: `backend/src/data-source.ts` (import + register entity)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `StrategyRunStatus.RATE_LIMITED_DAILY` (enum, string value `"rateLimitedDaily"`), NOT in `TERMINAL_STATUSES`.
  - Entity `GoogleRateLimitHold` with fields `id: number`, `strategyName: string`, `modelName: string`, `heldAt: Date`, `resetAt: Date`; table `"GoogleRateLimitHold"`; unique constraint `UQ_GoogleRateLimitHold_strategyName_modelName` on `(strategyName, modelName)`; index `IDX_GoogleRateLimitHold_resetAt` on `resetAt`.
  - Postgres enum `strategy_run_status_enum` gains value `'rateLimitedDaily'`.

- [ ] **Step 1: Add the enum member**

In `backend/src/modules/strategy/entities/strategy-run.entity.ts`:

```ts
export enum StrategyRunStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  DUPLICATE = "duplicate",
  MALFORMED_RESPONSE = "malformedResponse",
  ERROR = "error",
  // A Google model hit its free-tier requests-per-day quota. NOT terminal —
  // the google-rpd-resume sweep flips it back to RUNNING after the daily
  // reset and re-dispatches the job, which resumes from flushed guesses.
  RATE_LIMITED_DAILY = "rateLimitedDaily",
}
```

Leave `TERMINAL_STATUSES` exactly as it is — `RATE_LIMITED_DAILY` must not be added.

- [ ] **Step 2: Create the entity**

`backend/src/modules/strategy/entities/google-rate-limit-hold.entity.ts`:

```ts
import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from "typeorm";

/**
 * One row per Google model currently held because it hit its free-tier
 * requests-per-day (RPD) quota. `resetAt` is the next America/Los_Angeles
 * midnight — after that instant the row is stale and the google-rpd-resume
 * sweep deletes it. `strategyName` is always "llm-google" today; it is kept
 * explicit so the table is not provider-locked. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Entity("GoogleRateLimitHold")
@Unique("UQ_GoogleRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class GoogleRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Index("IDX_GoogleRateLimitHold_resetAt")
  @Column({ type: "timestamptz" })
  resetAt: Date;
}
```

- [ ] **Step 3: Create the migration**

`backend/src/migrations/1777000000000-add-google-rate-limit-hold.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the GoogleRateLimitHold table (one row per Google model held for
 * hitting its free-tier requests-per-day quota) and a new
 * 'rateLimitedDaily' value on strategy_run_status_enum for a run parked by
 * such a hold. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
export class AddGoogleRateLimitHold1777000000000 implements MigrationInterface {
  name = "AddGoogleRateLimitHold1777000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "strategy_run_status_enum" ADD VALUE 'rateLimitedDaily'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GoogleRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_GoogleRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_GoogleRateLimitHold_resetAt"
       ON "GoogleRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GoogleRateLimitHold"`);
    // Postgres has no "remove enum value" short of recreating the type, so
    // rolling back leaves 'rateLimitedDaily' a valid-but-unused status
    // value — harmless, same as 1767000000000-add-solve-prompt-call-detail.
  }
}
```

- [ ] **Step 4: Register the entity in both entity lists**

In `backend/src/app.module.ts`, add the import next to the other strategy entities:

```ts
import { GoogleRateLimitHold } from "./modules/strategy/entities/google-rate-limit-hold.entity";
```

and add `GoogleRateLimitHold` to the `entities: [...]` array in the `TypeOrmModule.forRootAsync` factory (after `SolvePrompt`).

In `backend/src/data-source.ts`, add the same import:

```ts
import { GoogleRateLimitHold } from "./modules/strategy/entities/google-rate-limit-hold.entity";
```

and add `GoogleRateLimitHold` to its `entities: [...]` array (after `SolvePrompt`).

- [ ] **Step 5: Migration run/revert — DEFERRED**

This session runs parallel to other work against the shared `connections-dev`
Postgres, so **do not run `npm run migration:run` / `migration:revert` here.**
Write the migration file and move on. The up/down/up round-trip is verified
later, serially, in Final Verification once this branch has the DB to itself.

Sanity check the SQL by eye instead: the `CREATE TABLE` names match the
entity, the `ALTER TYPE ... ADD VALUE 'rateLimitedDaily'` matches the enum
member, and `down()` drops the table.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/entities/google-rate-limit-hold.entity.ts backend/src/modules/strategy/entities/strategy-run.entity.ts backend/src/migrations/1777000000000-add-google-rate-limit-hold.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "feat: add GoogleRateLimitHold entity and rateLimitedDaily run status"
```

---

### Task 4: `GoogleRateLimitHoldService`

**Files:**
- Create: `backend/src/modules/strategy/google-rate-limit-hold.service.ts`
- Create: `backend/src/modules/strategy/google-rate-limit-hold.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts` (register entity + provider + export)

**Interfaces:**
- Consumes: `GoogleRateLimitHold` entity (Task 3).
- Produces: injectable `GoogleRateLimitHoldService` with:
  - `hold(strategyName: string, modelName: string): Promise<void>` — upsert a row keyed on `(strategyName, modelName)` with `heldAt = new Date()` and `resetAt = nextPacificMidnight()`.
  - `isHeld(strategyName: string, modelName: string): Promise<boolean>` — true iff a row exists whose `resetAt` is still in the future.
  - `heldModels(strategyName: string): Promise<string[]>` — model names with a still-future `resetAt`.
  - `clearExpired(): Promise<string[]>` — delete every row whose `resetAt <= now`, return their model names.
  - exported function `nextPacificMidnight(now?: Date): Date` — the UTC instant of the next `00:00` in `America/Los_Angeles`.

- [ ] **Step 1: Write the failing test**

`backend/src/modules/strategy/google-rate-limit-hold.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MoreThan, LessThanOrEqual } from "typeorm";
import {
  GoogleRateLimitHoldService,
  nextPacificMidnight,
} from "./google-rate-limit-hold.service";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";

describe("nextPacificMidnight", () => {
  it("returns the next Pacific midnight in UTC during PST (UTC-8)", () => {
    // 2026-01-15 12:00 PST
    const now = new Date("2026-01-15T20:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("returns the next Pacific midnight in UTC during PDT (UTC-7)", () => {
    // 2026-07-15 11:00 PDT
    const now = new Date("2026-07-15T18:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  it("returns the upcoming midnight (not one 24h later) when already late Pacific evening", () => {
    // 2026-01-15 23:30 PST
    const now = new Date("2026-01-16T07:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("rolls to the following day when just past Pacific midnight", () => {
    // 2026-01-16 00:30 PST
    const now = new Date("2026-01-16T08:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-17T08:00:00.000Z");
  });
});

describe("GoogleRateLimitHoldService", () => {
  let service: GoogleRateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleRateLimitHoldService,
        { provide: getRepositoryToken(GoogleRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(GoogleRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("upserts a hold row keyed on (strategyName, modelName) with a future resetAt", async () => {
    await service.hold("llm-google", "gemini-3.6-flash");

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: "llm-google", modelName: "gemini-3.6-flash" });
    expect(row.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(conflictPaths).toEqual(["strategyName", "modelName"]);
  });

  it("isHeld is true only while resetAt is in the future", async () => {
    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld("llm-google", "m")).toBe(true);

    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld("llm-google", "m")).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.isHeld("llm-google", "m")).toBe(false);
  });

  it("heldModels queries for future resetAt and returns the model names", async () => {
    repo.find.mockResolvedValueOnce([{ modelName: "a" }, { modelName: "b" }]);

    const result = await service.heldModels("llm-google");

    expect(result).toEqual(["a", "b"]);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-google", resetAt: MoreThan(expect.any(Date)) },
    });
  });

  it("clearExpired deletes rows whose resetAt has passed and returns their models", async () => {
    const expired = [{ modelName: "x" }, { modelName: "y" }];
    repo.find.mockResolvedValueOnce(expired);

    const result = await service.clearExpired();

    expect(repo.find).toHaveBeenCalledWith({
      where: { resetAt: LessThanOrEqual(expect.any(Date)) },
    });
    expect(repo.remove).toHaveBeenCalledWith(expired);
    expect(result).toEqual(["x", "y"]);
  });

  it("clearExpired does not call remove when nothing is expired", async () => {
    repo.find.mockResolvedValueOnce([]);

    const result = await service.clearExpired();

    expect(repo.remove).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/google-rate-limit-hold.service.spec.ts`
Expected: FAIL — module `./google-rate-limit-hold.service` not found.

- [ ] **Step 3: Implement the service**

`backend/src/modules/strategy/google-rate-limit-hold.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";

const PACIFIC_TZ = "America/Los_Angeles";

/**
 * The UTC instant of 00:00:00 on the given Pacific calendar date. Measures
 * the zone's UTC offset *at that date* (via toLocaleString round-tripping)
 * so it stays correct on either side of a DST transition.
 */
function pacificMidnightToUtc(year: number, month: number, day: number): Date {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const asPacificWall = new Date(utcGuess).toLocaleString("en-US", { timeZone: PACIFIC_TZ });
  const asUtcWall = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs = new Date(asPacificWall).getTime() - new Date(asUtcWall).getTime();
  return new Date(utcGuess - offsetMs);
}

/**
 * The next 00:00 in America/Los_Angeles, expressed as a UTC Date. Google AI
 * Studio's free-tier requests-per-day quota resets at Pacific midnight, so
 * this is when a hold should lift.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  // Today's Pacific calendar date, advanced one day with date-only UTC math
  // (no clock component, so DST cannot skew it).
  const tomorrow = new Date(Date.UTC(part("year"), part("month") - 1, part("day")) + 86_400_000);

  return pacificMidnightToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
  );
}

/**
 * The source of truth for which Google models are currently held for
 * exhausting their free-tier requests-per-day quota. One row per held
 * (strategyName, modelName); the google-rpd-resume sweep clears rows whose
 * resetAt has passed. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Injectable()
export class GoogleRateLimitHoldService {
  private readonly logger = new Logger(GoogleRateLimitHoldService.name);

  constructor(
    @InjectRepository(GoogleRateLimitHold)
    private readonly repo: Repository<GoogleRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string): Promise<void> {
    const resetAt = nextPacificMidnight();
    await this.repo.upsert(
      { strategyName, modelName, heldAt: new Date(), resetAt },
      ["strategyName", "modelName"],
    );
    this.logger.warn(
      `RPD hold set for ${strategyName}/${modelName} until ${resetAt.toISOString()}`,
    );
  }

  async isHeld(strategyName: string, modelName: string): Promise<boolean> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row !== null && row.resetAt.getTime() > Date.now();
  }

  async heldModels(strategyName: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { strategyName, resetAt: MoreThan(new Date()) },
    });
    return rows.map((r) => r.modelName);
  }

  async clearExpired(): Promise<string[]> {
    const expired = await this.repo.find({
      where: { resetAt: LessThanOrEqual(new Date()) },
    });
    if (expired.length > 0) {
      await this.repo.remove(expired);
    }
    return expired.map((r) => r.modelName);
  }
}
```

- [ ] **Step 4: Register in `StrategyModule`**

In `backend/src/modules/strategy/strategy.module.ts`:
- Add `GoogleRateLimitHold` to the import list and to `TypeOrmModule.forFeature([...])`.
- Add `GoogleRateLimitHoldService` to `providers` and to `exports`.

```ts
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
```

```ts
  imports: [
    TypeOrmModule.forFeature([
      Puzzle,
      StrategyRun,
      Guess,
      LlmProposal,
      SolvePrompt,
      GoogleRateLimitHold,
    ]),
    QueueModule,
    GameModule,
    SupportedModelModule,
  ],
  controllers: [StrategyController],
  providers: [
    StrategyService,
    StrategyRunStore,
    LlmStrategyRunner,
    OrchestratorService,
    FreeTierUsageService,
    GoogleRateLimitHoldService,
  ],
  exports: [StrategyService, LlmStrategyRunner, FreeTierUsageService, GoogleRateLimitHoldService],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest src/modules/strategy/google-rate-limit-hold.service.spec.ts`
Expected: PASS — all `nextPacificMidnight` and service cases.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/google-rate-limit-hold.service.ts backend/src/modules/strategy/google-rate-limit-hold.service.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "feat: add GoogleRateLimitHoldService with Pacific-midnight reset"
```

---

### Task 5: Runner — top-gate held models and record a hold on a per-day hit

**Files:**
- Modify: `backend/src/modules/strategy/strategy-run-store.service.ts` (add `saveRun`)
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts` (inject service; add gate; add `classifyFailedCall` branch; add hold write in the failed-call block)
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts` (add the mock provider to `beforeEach`; add three tests)

**Interfaces:**
- Consumes: `GoogleRateLimitHoldService` (`isHeld`, `hold`) from Task 4; `StrategyRunStatus.RATE_LIMITED_DAILY` from Task 3; the `"rate_limited_daily"` outcome code from Task 2.
- Produces: `StrategyRunStore.saveRun(run: StrategyRun): Promise<StrategyRun>`. Behavioral guarantee: `runLlmStrategy` for an `llm-google` run whose model `isHeld` returns immediately with `{ status: RATE_LIMITED_DAILY, guessCount }` and zero `orchestratorService.solveAssist` calls; a `"rate_limited_daily"` failure mid-run sets `run.status = RATE_LIMITED_DAILY`, calls `holdService.hold(strategyName, model)`, and increments no failure counter.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`:

First, extend the shared setup. Add the import:

```ts
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
```

Add a mock declaration alongside the others:

```ts
  let mockRpdHold: { isHeld: jest.Mock; hold: jest.Mock };
```

In `beforeEach`, before `Test.createTestingModule`:

```ts
    mockRpdHold = {
      isHeld: jest.fn().mockResolvedValue(false),
      hold: jest.fn().mockResolvedValue(undefined),
    };
```

Add to the `providers` array:

```ts
        { provide: GoogleRateLimitHoldService, useValue: mockRpdHold },
```

Then add these tests inside `describe("runLlmStrategy", ...)`:

```ts
    it("parks a held google run at RATE_LIMITED_DAILY without calling the orchestrator", async () => {
      mockRpdHold.isHeld.mockResolvedValue(true);
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-google", modelName: "gemini-3.6-flash" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);

      const result = await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

      expect(mockOrchestratorService.solveAssist).not.toHaveBeenCalled();
      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockRpdHold.hold).not.toHaveBeenCalled();
    });

    it("records a hold and parks the run on a rate_limited_daily failure, touching no failure counter", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-google", modelName: "gemini-3.6-flash" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "Google daily quota exhausted", code: "rate_limited_daily" },
      });

      const result = await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockRpdHold.hold).toHaveBeenCalledWith("llm-google", "gemini-3.6-flash");
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(1);
    });

    it("never ends a run in ERROR on a rate_limited_daily hit", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-google", modelName: "gemini-3.6-flash" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      const result = await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

      expect(result.status).not.toBe(StrategyRunStatus.ERROR);
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts -t "rate_limited_daily|RATE_LIMITED_DAILY|held google run"`
Expected: FAIL — the runner has no `GoogleRateLimitHoldService` dependency yet (Nest DI resolution error), and no gate/branch logic.

- [ ] **Step 3: Add `saveRun` to the store**

In `backend/src/modules/strategy/strategy-run-store.service.ts`, add a method to `StrategyRunStore` (next to `countGuesses`):

```ts
  /** Persist a single run row. Used for status-only transitions (e.g.
   * parking a run at RATE_LIMITED_DAILY) that don't need the batched
   * guess/proposal/prompt flush of flushBatch. */
  async saveRun(run: StrategyRun): Promise<StrategyRun> {
    return this.strategyRunRepo.save(run);
  }
```

- [ ] **Step 4: Inject the hold service into the runner**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, add the imports:

```ts
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
```

Extend the constructor:

```ts
  constructor(
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
    @Inject(OrchestratorService) private readonly orchestratorService: OrchestratorService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(GoogleRateLimitHoldService) private readonly rpdHold: GoogleRateLimitHoldService,
  ) {}
```

- [ ] **Step 5: Add the top-gate**

In `runLlmStrategy`, immediately after the existing `TERMINAL_STATUSES` early-return block and before the `priorGuesses` rebuild:

```ts
    // Top-gate: an llm-google run whose model is currently out of daily
    // quota parks immediately — one indexed read instead of a doomed Google
    // call. The google-rpd-resume sweep re-dispatches it after the reset.
    if (
      strategyName === LLM_GOOGLE &&
      model &&
      (await this.rpdHold.isHeld(strategyName, model))
    ) {
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
      await this.store.saveRun(run);
      return {
        status: run.status,
        guessCount: await this.store.countGuesses(run.id),
      };
    }
```

- [ ] **Step 6: Add the `classifyFailedCall` branch**

In `classifyFailedCall`, add a new first branch (before `if (code === "rate_limited")`):

```ts
    if (code === "rate_limited_daily") {
      // A per-day quota hit. Park the run — no counter touched, so it never
      // rolls into ERROR — and let the run loop's status check break out.
      // The hold row itself is written by the caller (it has `model` and can
      // await), see runLlmStrategy's failed-call block.
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
    } else if (code === "rate_limited") {
```

(Keep the rest of the `else if` chain exactly as it is.)

- [ ] **Step 7: Write the hold row from the failed-call block**

In the run loop's `else` (failed call) block, immediately after the `this.classifyFailedCall(...)` call:

```ts
        if (
          outcome.error.code === "rate_limited_daily" &&
          strategyName === LLM_GOOGLE &&
          model
        ) {
          await this.rpdHold.hold(strategyName, model);
        }
```

- [ ] **Step 8: Run the runner tests to verify green**

Run: `cd backend && npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts`
Expected: PASS — the whole file, including the three new tests and every pre-existing test (the shared `beforeEach` now supplies the new mock).

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/strategy/strategy-run-store.service.ts backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: hold llm-google runs per-model on a requests-per-day hit"
```

---

### Task 6: `GoogleRpdResumeService` — the midnight sweep logic

**Files:**
- Create: `backend/src/modules/strategy/google-rpd-resume.service.ts`
- Create: `backend/src/modules/strategy/google-rpd-resume.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts` (register provider + export)

**Interfaces:**
- Consumes: `GoogleRateLimitHoldService` (`clearExpired`, `heldModels`) from Task 4; `StrategyRunStatus.RATE_LIMITED_DAILY` (Task 3); `LLM_GOOGLE_QUEUE` token and `runStrategyJobId` (both already exist); `LLM_GOOGLE` const from `../../strategies`.
- Produces: injectable `GoogleRpdResumeService` with `runResume(): Promise<{ cleared: string[]; redispatched: number }>` — deletes expired hold rows, then for every `StrategyRun` at `RATE_LIMITED_DAILY` for strategy `llm-google` whose `modelName` is no longer held: sets `status = RUNNING`, saves, and re-enqueues a `"run-strategy"` job on the `llm-google-runs` queue with the deterministic `runStrategyJobId` id.

- [ ] **Step 1: Write the failing test**

`backend/src/modules/strategy/google-rpd-resume.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GoogleRpdResumeService } from "./google-rpd-resume.service";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { LLM_GOOGLE_QUEUE } from "../queue/queue.module";

describe("GoogleRpdResumeService", () => {
  let service: GoogleRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; heldModels: jest.Mock };
  let queue: { add: jest.Mock };

  const parkedRun = (over: Partial<StrategyRun> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    strategyName: "llm-google",
    trialNumber: 0,
    modelName: "gemini-3.6-flash",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = { find: jest.fn().mockResolvedValue([]), save: jest.fn().mockResolvedValue(undefined) };
    holdService = { clearExpired: jest.fn().mockResolvedValue([]), heldModels: jest.fn().mockResolvedValue([]) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: GoogleRateLimitHoldService, useValue: holdService },
        { provide: LLM_GOOGLE_QUEUE, useValue: queue },
      ],
    }).compile();

    service = module.get(GoogleRpdResumeService);
  });

  afterEach(() => jest.clearAllMocks());

  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue(["gemini-3.6-flash"]);
    holdService.heldModels.mockResolvedValue(["gemini-3.6-flash-lite"]);
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "gemini-3.6-flash", puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "gemini-3.6-flash-lite", puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).toHaveBeenCalledTimes(1);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "run-strategy",
      {
        puzzleId: 10,
        strategyName: "llm-google",
        date: "2026-01-01",
        trialNumber: 0,
        model: "gemini-3.6-flash",
      },
      { jobId: "run-10-llm-google-0" },
    );
    expect(result).toEqual({ cleared: ["gemini-3.6-flash"], redispatched: 1 });
  });

  it("does nothing when there are no parked runs", async () => {
    holdService.clearExpired.mockResolvedValue([]);
    strategyRunRepo.find.mockResolvedValue([]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: [], redispatched: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/google-rpd-resume.service.spec.ts`
Expected: FAIL — module `./google-rpd-resume.service` not found.

- [ ] **Step 3: Implement the service**

`backend/src/modules/strategy/google-rpd-resume.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_GOOGLE } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";

/**
 * Runs on a 00:01 America/Los_Angeles cron (see GoogleRpdResumeBootstrap).
 * Clears every GoogleRateLimitHold row whose resetAt has passed, then flips
 * each llm-google run parked at RATE_LIMITED_DAILY (whose model is no longer
 * held) back to RUNNING and re-dispatches it. The runner resumes each from
 * its flushed guesses. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Injectable()
export class GoogleRpdResumeService {
  private readonly logger = new Logger(GoogleRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(GoogleRateLimitHoldService)
    private readonly holdService: GoogleRateLimitHoldService,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number }> {
    const cleared = await this.holdService.clearExpired();
    const stillHeld = new Set(await this.holdService.heldModels(LLM_GOOGLE));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_GOOGLE },
      relations: { puzzle: true },
    });

    let redispatched = 0;
    for (const run of parked) {
      if (run.modelName && stillHeld.has(run.modelName)) continue;

      run.status = StrategyRunStatus.RUNNING;
      await this.strategyRunRepo.save(run);

      await this.llmGoogleQueue.add(
        "run-strategy",
        {
          puzzleId: run.puzzleId,
          strategyName: run.strategyName,
          date: run.puzzle.date,
          trialNumber: run.trialNumber,
          model: run.modelName,
        },
        { jobId: runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber) },
      );
      redispatched++;
    }

    this.logger.log(
      `google-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)`,
    );
    return { cleared, redispatched };
  }
}
```

- [ ] **Step 4: Register in `StrategyModule`**

In `backend/src/modules/strategy/strategy.module.ts`, add the import, then add `GoogleRpdResumeService` to `providers` and `exports`:

```ts
import { GoogleRpdResumeService } from "./google-rpd-resume.service";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest src/modules/strategy/google-rpd-resume.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/google-rpd-resume.service.ts backend/src/modules/strategy/google-rpd-resume.service.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "feat: add GoogleRpdResumeService to revive parked llm-google runs"
```

---

### Task 7: `google-rpd-resume` queue, bootstrap scheduler, and worker wiring

**Files:**
- Create: `backend/src/modules/queue/google-rpd-resume.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts` (token + provider + export)
- Create: `backend/src/modules/strategy/google-rpd-resume.bootstrap.ts`
- Create: `backend/src/modules/strategy/google-rpd-resume.bootstrap.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts` (register bootstrap provider)
- Modify: `backend/src/worker.ts` (add the resume worker in the `role !== "ollama"` block)

**Interfaces:**
- Consumes: `GoogleRpdResumeService.runResume()` from Task 6.
- Produces:
  - `googleRpdResumeQueue` — a BullMQ `Queue` for `"google-rpd-resume"`.
  - `GOOGLE_RPD_RESUME_QUEUE` DI token exported from `queue.module.ts`.
  - `GoogleRpdResumeBootstrap` (`OnApplicationBootstrap`) — registers a job scheduler `"google-rpd-resume"` with `{ pattern: "1 0 * * *", tz: "America/Los_Angeles" }` and job name `"resume-google-rpd"`, skipped under `NODE_ENV=test`.
  - A worker on queue `"google-rpd-resume"` (concurrency 1) that calls `runResume()`.

- [ ] **Step 1: Write the failing bootstrap test**

`backend/src/modules/strategy/google-rpd-resume.bootstrap.spec.ts`:

```ts
import { Queue } from "bullmq";
import { GoogleRpdResumeBootstrap } from "./google-rpd-resume.bootstrap";

describe("GoogleRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { upsertJobScheduler: jest.Mock };

  beforeEach(() => {
    queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("registers a daily 00:01 America/Los_Angeles resume scheduler", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "google-rpd-resume",
      { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      expect.objectContaining({ name: "resume-google-rpd" }),
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new GoogleRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/modules/strategy/google-rpd-resume.bootstrap.spec.ts`
Expected: FAIL — module `./google-rpd-resume.bootstrap` not found.

- [ ] **Step 3: Create the queue instance**

`backend/src/modules/queue/google-rpd-resume.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the daily Google requests-per-day hold resume (see
// GoogleRpdResumeService / GoogleRpdResumeBootstrap). One scheduled job per
// day at 00:01 America/Los_Angeles: it clears expired GoogleRateLimitHold
// rows and re-dispatches every llm-google run parked at RATE_LIMITED_DAILY.
export const googleRpdResumeQueue = new Queue("google-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
```

- [ ] **Step 4: Register the token in `queue.module.ts`**

In `backend/src/modules/queue/queue.module.ts`:
- import `googleRpdResumeQueue` from `./google-rpd-resume.queue`
- add `export const GOOGLE_RPD_RESUME_QUEUE = "GOOGLE_RPD_RESUME_QUEUE";`
- add `{ provide: GOOGLE_RPD_RESUME_QUEUE, useValue: googleRpdResumeQueue },` to `providers`
- add `GOOGLE_RPD_RESUME_QUEUE` to `exports`

- [ ] **Step 5: Implement the bootstrap**

`backend/src/modules/strategy/google-rpd-resume.bootstrap.ts`:

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { GOOGLE_RPD_RESUME_QUEUE } from "../queue/queue.module";

// Schedules the daily Google RPD hold resume. Fires at 00:01 (not 00:00)
// America/Los_Angeles: the one-minute offset guarantees that by the time the
// sweep runs, every hold whose resetAt was the just-passed midnight is a
// full minute expired, so clearExpired clears it and Google's daily quota is
// definitely live again — no race with Google's own reset clock.
@Injectable()
export class GoogleRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(GoogleRpdResumeBootstrap.name);

  constructor(@Inject(GOOGLE_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping google-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.upsertJobScheduler(
      "google-rpd-resume",
      { pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      {
        name: "resume-google-rpd",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 5,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log('google-rpd-resume scheduled: "1 0 * * *" (America/Los_Angeles)');
  }
}
```

- [ ] **Step 6: Register the bootstrap in `StrategyModule`**

In `backend/src/modules/strategy/strategy.module.ts`, add the import and add `GoogleRpdResumeBootstrap` to `providers` (it does not need to be exported):

```ts
import { GoogleRpdResumeBootstrap } from "./google-rpd-resume.bootstrap";
```

- [ ] **Step 7: Run the bootstrap test to verify green**

Run: `cd backend && npx jest src/modules/strategy/google-rpd-resume.bootstrap.spec.ts`
Expected: PASS — both cases.

- [ ] **Step 8: Wire the worker**

In `backend/src/worker.ts`:

Add the import:

```ts
import { GoogleRpdResumeService } from "./modules/strategy/google-rpd-resume.service";
```

After `const modelMetadataRefreshService = appContext.get(ModelMetadataRefreshService);`:

```ts
  const googleRpdResumeService = appContext.get(GoogleRpdResumeService);
```

Inside the `if (role !== "ollama") { ... }` block that already holds the `modelMetadataWorker` and `freeTierDispatchWorker`, add:

```ts
    const googleRpdResumeWorker = new Worker(
      "google-rpd-resume",
      async (job) => {
        logger.log(`starting google-rpd resume sweep ${job.id}`);
        const result = await googleRpdResumeService.runResume();
        logger.log(`finished google-rpd resume sweep ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    googleRpdResumeWorker.on("failed", (job, err) => {
      logger.error(`google-rpd resume sweep ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(googleRpdResumeWorker);
    activeQueueNames.push("google-rpd-resume");
```

- [ ] **Step 9: Typecheck and build the worker entrypoint**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Full backend test run**

Run: `cd backend && npm test`
Expected: PASS — whole suite, no regressions.

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/queue/google-rpd-resume.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/google-rpd-resume.bootstrap.ts backend/src/modules/strategy/google-rpd-resume.bootstrap.spec.ts backend/src/modules/strategy/strategy.module.ts backend/src/worker.ts
git commit -m "feat: schedule and process the daily google-rpd-resume sweep"
```

---

### Task 8: Frontend — display the `rateLimitedDaily` run status

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts:9-17` (`RunStatus` union) — also see the doc comment at lines 7-8
- Modify: `frontend/src/data/benchmark/runStatus.ts` (`RUN_STATUS_LABEL`, `RUN_HISTORY_STATUSES`, `runStatusTone`)
- Create: `frontend/src/data/benchmark/runStatus.test.ts`

**Interfaces:**
- Consumes: the backend now serializes `status: "rateLimitedDaily"` on run DTOs (Task 3).
- Produces: `RunStatus` includes `"rateLimitedDaily"`; `runStatusLabel("rateLimitedDaily") === "Paused — daily quota"`; `runStatusTone("rateLimitedDaily") === "active"`; `isFailedStatus("rateLimitedDaily") === false`; `RUN_HISTORY_STATUSES` includes it.

- [ ] **Step 1: Write the failing test**

`frontend/src/data/benchmark/runStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isFailedStatus, runStatusLabel, runStatusTone } from "./runStatus";

describe("rateLimitedDaily run status", () => {
  it("labels it as a daily-quota pause", () => {
    expect(runStatusLabel("rateLimitedDaily")).toBe("Paused — daily quota");
  });

  it("tones it as an in-progress state, not a failure", () => {
    expect(runStatusTone("rateLimitedDaily")).toBe("active");
    expect(isFailedStatus("rateLimitedDaily")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/data/benchmark/runStatus.test.ts`
Expected: FAIL — TypeScript rejects `"rateLimitedDaily"` as a `RunStatus`, and `runStatusLabel` has no entry for it.

- [ ] **Step 3: Extend the `RunStatus` union**

In `frontend/src/data/benchmark/types.ts`, add the member to the `RunStatus` union (after `"error"`):

```ts
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "duplicate"
  | "malformedResponse"
  | "error"
  | "rateLimitedDaily";
```

- [ ] **Step 4: Add the label, history option, and tone**

In `frontend/src/data/benchmark/runStatus.ts`:

Add to `RUN_STATUS_LABEL` (this is a `Record<RunStatus, string>`, so it will not compile until the entry exists):

```ts
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  duplicate: "Duplicate",
  malformedResponse: "Malformed",
  error: "Error",
  rateLimitedDaily: "Paused — daily quota",
};
```

Add to `RUN_HISTORY_STATUSES`:

```ts
export const RUN_HISTORY_STATUSES: RunStatus[] = [
  "running",
  "completed",
  "failed",
  "duplicate",
  "malformedResponse",
  "error",
  "rateLimitedDaily",
];
```

Extend `runStatusTone` so the parked state reads as in-progress, not failed:

```ts
export function runStatusTone(status: RunStatus): PillTone {
  if (status === "queued") return "queued";
  if (status === "running") return "active";
  if (status === "rateLimitedDaily") return "active";
  if (status === "completed") return "completed";
  return "failed";
}
```

Do **not** add `"rateLimitedDaily"` to `FAILED_STATUSES` — it is not a failure.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/data/benchmark/runStatus.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck / build the frontend to catch other exhaustive switches**

Run: `cd frontend && npm run build`
Expected: build succeeds. If the compiler flags any other exhaustive `switch`/`Record` over `RunStatus` (e.g. in a pill-rendering component), handle `"rateLimitedDaily"` there the same way `"running"` is handled (in-progress / active styling, never failure styling). Re-run the build until clean.

- [ ] **Step 7: Run the frontend unit suite**

Run: `cd frontend && npm run test:run`
Expected: PASS — no regressions.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/runStatus.ts frontend/src/data/benchmark/runStatus.test.ts
git commit -m "feat: show the rateLimitedDaily run status as a daily-quota pause"
```

---

## Final verification

- [ ] **Orchestrator:** `cd orchestrator && npm test` — all green.
- [ ] **Backend:** `cd backend && npm test` — all green.
- [ ] **Backend typecheck:** `cd backend && npx tsc --noEmit` — clean.
- [ ] **Frontend:** `cd frontend && npm run test:run && npm run build` — all green.
- [ ] **Migration round-trip — RUN SEPARATELY, after this branch has the dev DB to itself** (this plan was executed alongside parallel work against the shared `connections-dev` Postgres, so it was skipped during task execution): `cd backend && npm run migration:run && npm run migration:revert && npm run migration:run` — clean each way.
- [ ] **Manual smoke — RUN SEPARATELY (needs the live stack + a real Google key at/near its RPD):** dispatch an `llm-google` run for a model whose daily quota is spent; confirm the run lands at `rateLimitedDaily`, a `GoogleRateLimitHold` row appears with `resetAt` at the next Pacific midnight, subsequent `llm-google` dispatches for that model park immediately with no orchestrator call in the logs, and other Google models keep running.
