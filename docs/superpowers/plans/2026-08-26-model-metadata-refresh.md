# Model Metadata + Pricing Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source per-model context window, parameter count, release date, provider description, and repeatable pricing from OpenRouter's public API; fix historically-inaccurate run costing; retire the flat `MODEL_CONTEXT_WINDOW` env var in favor of each model's real context window.

**Architecture:** New nullable columns on `SupportedModel`, populated by a daily BullMQ-scheduled `ModelMetadataRefreshService` (plus an on-demand admin endpoint) that calls OpenRouter's `GET /api/v1/models`. `ModelPrice` stays append-only; two existing cost queries (`getLeaderboard`, `getRunHistory`) switch from "current price" to "price in effect at the run's `startedAt`". Each model's real context window threads from `SupportedModel` through the backend's `OrchestratorService` into the orchestrator's `/solve-assist` request, replacing the flat env var for Ollama's `num_ctx`, and gets written onto the `StrategyRun` row.

**Tech Stack:** NestJS + TypeORM + BullMQ (backend), Hono + Zod + Vercel AI SDK (orchestrator), React + Vitest + Testing Library (frontend), Jest (backend/orchestrator... actually orchestrator uses Vitest, backend uses Jest — see each task's test command).

**Spec:** [docs/superpowers/specs/2026-08-26-model-metadata-refresh-design.md](../specs/2026-08-26-model-metadata-refresh-design.md)

## Global Constraints

- All mutation of `SupportedModel`/`ModelPrice` outside the refresh job continues through migrations — no admin UI (spec non-goal).
- `openRouterSlug` mapping is explicit and manual — never fuzzy-matched (spec non-goal).
- A model with no live OpenRouter match shows no data (`null`) — never fabricated, never a stale value silently passed off as current (spec goal).
- Every new piece of logic follows this repo's TDD workflow: failing test first, watch it fail, minimal implementation, watch it pass.
- Backend tests run via `npm test` from `backend/`; orchestrator tests via `npm test` from `orchestrator/`; frontend tests via `npm test` from `frontend/`.

---

## Task 1: Schema migration — new SupportedModel columns

**Files:**
- Create: `backend/src/migrations/1770000000000-add-supported-model-metadata-columns.ts`

**Interfaces:**
- Produces: `SupportedModel` gains `openRouterSlug` (text, nullable), `contextWindow` (int, nullable), `paramCount` (bigint, nullable), `providerDescription` (text, nullable), `releaseDate` (timestamptz, nullable), `metadataUpdatedAt` (timestamptz, nullable).

This is a schema-only migration (no data), so it isn't itself unit-tested — its correctness is verified by running it against a real database, same as every other migration in this repo.

- [ ] **Step 1: Write the migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds columns for per-model metadata sourced from OpenRouter's public API
 * (context window, best-effort parameter count, provider description,
 * release date) plus openRouterSlug (the manual mapping a refresh job
 * matches against) and metadataUpdatedAt (last successful refresh). All
 * nullable — a model with no mapping or no live OpenRouter match simply has
 * no data here, never a fabricated value.
 */
export class AddSupportedModelMetadataColumns1770000000000 implements MigrationInterface {
  name = "AddSupportedModelMetadataColumns1770000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SupportedModel"
        ADD COLUMN "openRouterSlug" TEXT NULL,
        ADD COLUMN "contextWindow" INT NULL,
        ADD COLUMN "paramCount" BIGINT NULL,
        ADD COLUMN "providerDescription" TEXT NULL,
        ADD COLUMN "releaseDate" TIMESTAMPTZ NULL,
        ADD COLUMN "metadataUpdatedAt" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SupportedModel"
        DROP COLUMN "openRouterSlug",
        DROP COLUMN "contextWindow",
        DROP COLUMN "paramCount",
        DROP COLUMN "providerDescription",
        DROP COLUMN "releaseDate",
        DROP COLUMN "metadataUpdatedAt"
    `);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/migrations/1770000000000-add-supported-model-metadata-columns.ts
git commit -m "feat: add OpenRouter metadata columns to SupportedModel"
```

---

## Task 2: Backfill openRouterSlug for verified models

**Files:**
- Create: `backend/src/migrations/1771000000000-backfill-openrouter-slugs.ts`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: `openRouterSlug` populated for every model this task's author has actually confirmed live on OpenRouter.

Only two mappings are confirmed live as of writing this plan (verified directly against `GET https://openrouter.ai/api/v1/models/{slug}/endpoints` — a non-empty `endpoints` array with real pricing):

| `SupportedModel` row | `openRouterSlug` |
|---|---|
| `('llm-openai', 'gpt-4.1-nano')` | `openai/gpt-4.1-nano` |
| `('llm-ollama', 'mistral-nemo')` | `mistralai/mistral-nemo` |

The other ~16 registered OpenAI models (`gpt-5.4`, `gpt-5.2`, `gpt-5-mini`, `o3-mini`, etc. — see `backend/src/migrations/1759000000000-add-openai-models.ts` and `1760000000000-add-openai-mini-models.ts`) have **not** been checked against OpenRouter. Do not guess their slugs — fabricating a mapping that happens to be wrong would silently attach a different model's price/context/params to the wrong row, which is worse than leaving it unmapped. Whoever executes this task must, for each remaining model, hit `https://openrouter.ai/api/v1/models/openai/<model-name>/endpoints` (substituting the likely slug) and only add a row to this migration if the response has a non-empty `endpoints` array. Leave anything unconfirmed unmapped — `openRouterSlug` stays `null`, and Task 6's refresh service already handles that correctly (skip, don't fabricate).

- [ ] **Step 1: Write the migration with the two confirmed mappings**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backfills openRouterSlug for models confirmed live on OpenRouter as of
 * this migration's authoring (checked via GET /api/v1/models/{slug}/endpoints
 * — a non-empty endpoints array with real pricing). Only two are confirmed
 * here; the rest of the registered OpenAI models haven't been checked and
 * are deliberately left unmapped rather than guessed — see this task's
 * description in the implementation plan for why.
 */
export class BackfillOpenRouterSlugs1771000000000 implements MigrationInterface {
  name = "BackfillOpenRouterSlugs1771000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = 'openai/gpt-4.1-nano'
      WHERE "strategyName" = 'llm-openai' AND "modelName" = 'gpt-4.1-nano'
    `);
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = 'mistralai/mistral-nemo'
      WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral-nemo'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = NULL
      WHERE "openRouterSlug" IN ('openai/gpt-4.1-nano', 'mistralai/mistral-nemo')
    `);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/migrations/1771000000000-backfill-openrouter-slugs.ts
git commit -m "feat: backfill confirmed openRouterSlug mappings"
```

---

## Task 3: Update SupportedModel entity, SupportedModelWithRate, and findAll()

**Files:**
- Modify: `backend/src/modules/supported-model/entities/supported-model.entity.ts`
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Modify: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: `SupportedModelWithRate` gains `contextWindow: number | null`, `paramCount: number | null`, `providerDescription: string | null`, `releaseDate: string | null`. `findAll()` returns them.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/modules/supported-model/supported-model.service.spec.ts`, inside the existing `describe("findAll", ...)` block (create one if it doesn't exist yet — check the file first):

```ts
it("includes the new metadata fields on every row", async () => {
  mockRepo.find.mockResolvedValueOnce([
    {
      id: 1,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      supported: true,
      contextWindow: 128000,
      paramCount: null,
      providerDescription: "Fast and cheap.",
      releaseDate: new Date("2025-04-14T00:00:00Z"),
    },
  ]);
  mockPriceRepo.find.mockResolvedValueOnce([]);

  const result = await service.findAll();

  expect(result[0]).toMatchObject({
    contextWindow: 128000,
    paramCount: null,
    providerDescription: "Fast and cheap.",
    releaseDate: new Date("2025-04-14T00:00:00Z"),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- supported-model.service.spec.ts`
Expected: FAIL — `result[0].contextWindow` is `undefined`, not `128000` (the current `findAll()` doesn't select these fields).

- [ ] **Step 3: Update the entity**

In `backend/src/modules/supported-model/entities/supported-model.entity.ts`, add after the existing `freeTier` column (before `createdAt`):

```ts
  // OpenRouter's model id, e.g. "openai/gpt-4.1-nano" — set manually per
  // model (same place a model is registered). null means "not mapped, skip
  // this row on refresh" — see ModelMetadataRefreshService.
  @Column({ type: "text", nullable: true })
  openRouterSlug: string | null;

  // From OpenRouter's context_length. Also used as the real per-model
  // context window for Ollama's num_ctx — see provider.ts.
  @Column({ type: "int", nullable: true })
  contextWindow: number | null;

  // Best-effort: parsed from the OpenRouter slug/name or description prose.
  // null for most OpenAI rows — OpenAI doesn't publish parameter counts.
  @Column({ type: "bigint", nullable: true })
  paramCount: number | null;

  // OpenRouter's own natural-language description of the model, verbatim.
  @Column({ type: "text", nullable: true })
  providerDescription: string | null;

  // From OpenRouter's created (Unix timestamp) — the model's real release
  // date, not just when OpenRouter listed it.
  @Column({ type: "timestamptz", nullable: true })
  releaseDate: Date | null;

  // Set on every successful refresh match; null until the first one.
  @Column({ type: "timestamptz", nullable: true })
  metadataUpdatedAt: Date | null;
```

- [ ] **Step 4: Update SupportedModelWithRate and findAll()**

In `backend/src/modules/supported-model/supported-model.service.ts`, update the interface and `findAll()`'s return mapping:

```ts
export interface SupportedModelWithRate {
  id: number;
  strategyName: string;
  modelName: string;
  supported: boolean;
  inputCostPerMillionTokens: number | null;
  outputCostPerMillionTokens: number | null;
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
  releaseDate: Date | null;
}
```

```ts
    return models.map((model) => {
      const price = currentPriceByModelId.get(model.id);
      return {
        id: model.id,
        strategyName: model.strategyName,
        modelName: model.modelName,
        supported: model.supported,
        inputCostPerMillionTokens: price?.inputCostPerMillionTokens ?? null,
        outputCostPerMillionTokens: price?.outputCostPerMillionTokens ?? null,
        contextWindow: model.contextWindow,
        paramCount: model.paramCount,
        providerDescription: model.providerDescription,
        releaseDate: model.releaseDate,
      };
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- supported-model.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/supported-model/entities/supported-model.entity.ts backend/src/modules/supported-model/supported-model.service.ts backend/src/modules/supported-model/supported-model.service.spec.ts
git commit -m "feat: return new metadata fields from SupportedModel.findAll"
```

---

## Task 4: OpenRouter param-count and release-date parsing helpers

**Files:**
- Create: `backend/src/modules/supported-model/openrouter-metadata.util.ts`
- Create: `backend/src/modules/supported-model/openrouter-metadata.util.spec.ts`

**Interfaces:**
- Produces: `parseParamCount(slugOrText: string): number | null`, `parseReleaseDate(createdUnixSeconds: number): Date`.

Pure functions — no DB, no HTTP. Straightforward TDD.

- [ ] **Step 1: Write the failing tests**

```ts
import { parseParamCount, parseReleaseDate } from "./openrouter-metadata.util";

describe("parseParamCount", () => {
  it("parses a param count from a slug like mistral-7b-instruct-v0.3", () => {
    expect(parseParamCount("mistralai/mistral-7b-instruct-v0.3")).toBe(7_000_000_000);
  });

  it("parses a param count from a two-digit slug like llama-3.1-8b-instruct", () => {
    expect(parseParamCount("meta-llama/llama-3.1-8b-instruct")).toBe(8_000_000_000);
  });

  it("parses a param count from description prose", () => {
    expect(
      parseParamCount("A high-performing, industry-standard 7.3B parameter model."),
    ).toBe(7_300_000_000);
  });

  it("prefers the slug over description text when both are checked separately", () => {
    expect(parseParamCount("mistral-nemo")).toBeNull();
  });

  it("returns null when no param count can be found", () => {
    expect(parseParamCount("openai/gpt-4.1-nano")).toBeNull();
    expect(parseParamCount("For tasks that demand low latency.")).toBeNull();
  });
});

describe("parseReleaseDate", () => {
  it("converts a Unix timestamp (seconds) to a Date", () => {
    expect(parseReleaseDate(1744651369)).toEqual(new Date(1744651369 * 1000));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- openrouter-metadata.util.spec.ts`
Expected: FAIL — module `./openrouter-metadata.util` doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

```ts
// Best-effort parameter-count extraction — OpenRouter has no structured
// field for this. Tries the slug/name first (e.g. "8b" in
// "llama-3.1-8b-instruct"), then falls back to description prose (e.g.
// "7.3B parameter model"). Returns null when neither matches; expected for
// most OpenAI rows, since OpenAI doesn't publish parameter counts at all.
const SLUG_PARAM_RE = /(\d+(?:\.\d+)?)b(?:[-_]|$)/i;
const DESCRIPTION_PARAM_RE = /(\d+(?:\.\d+)?)\s*b(?:illion)?\s*param/i;

export function parseParamCount(slugOrText: string): number | null {
  const slugMatch = SLUG_PARAM_RE.exec(slugOrText);
  if (slugMatch) return Math.round(parseFloat(slugMatch[1]) * 1_000_000_000);

  const descriptionMatch = DESCRIPTION_PARAM_RE.exec(slugOrText);
  if (descriptionMatch) return Math.round(parseFloat(descriptionMatch[1]) * 1_000_000_000);

  return null;
}

/** OpenRouter's `created` field is Unix seconds, not milliseconds. */
export function parseReleaseDate(createdUnixSeconds: number): Date {
  return new Date(createdUnixSeconds * 1000);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- openrouter-metadata.util.spec.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/openrouter-metadata.util.ts backend/src/modules/supported-model/openrouter-metadata.util.spec.ts
git commit -m "feat: add OpenRouter param-count/release-date parsing helpers"
```

---

## Task 5: OpenRouterClient

**Files:**
- Create: `backend/src/modules/supported-model/openrouter-client.ts`
- Create: `backend/src/modules/supported-model/openrouter-client.spec.ts`

**Interfaces:**
- Produces: `OpenRouterClient.listModels(): Promise<OpenRouterModel[]>`, `OpenRouterModel { id: string; description: string; created: number; context_length: number; pricing: { prompt: string; completion: string } }`.

- [ ] **Step 1: Write the failing test**

```ts
import { OpenRouterClient } from "./openrouter-client";

describe("OpenRouterClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the parsed model list on success", async () => {
    const body = {
      data: [
        {
          id: "openai/gpt-4.1-nano",
          description: "Fast and cheap.",
          created: 1744651369,
          context_length: 128000,
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
        },
      ],
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient();
    const models = await client.listModels();

    expect(global.fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models");
    expect(models).toEqual(body.data);
  });

  it("throws when the response is not ok", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch;

    const client = new OpenRouterClient();
    await expect(client.listModels()).rejects.toThrow("OpenRouter request failed: 503");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- openrouter-client.spec.ts`
Expected: FAIL — module `./openrouter-client` doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

```ts
import { Injectable } from "@nestjs/common";

export interface OpenRouterModel {
  id: string;
  description: string;
  created: number;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

/**
 * Thin client for OpenRouter's public, unauthenticated model list —
 * https://openrouter.ai/api/v1/models. No API key needed; this is public
 * catalog data, not a proxied inference call.
 */
@Injectable()
export class OpenRouterClient {
  private readonly url = "https://openrouter.ai/api/v1/models";

  async listModels(): Promise<OpenRouterModel[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`OpenRouter request failed: ${response.status}`);
    }
    const body = (await response.json()) as { data: OpenRouterModel[] };
    return body.data;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- openrouter-client.spec.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/openrouter-client.ts backend/src/modules/supported-model/openrouter-client.spec.ts
git commit -m "feat: add OpenRouterClient"
```

---

## Task 6: ModelMetadataRefreshService

**Files:**
- Create: `backend/src/modules/supported-model/model-metadata-refresh.service.ts`
- Create: `backend/src/modules/supported-model/model-metadata-refresh.service.spec.ts`
- Modify: `backend/src/modules/supported-model/supported-model.module.ts`

**Interfaces:**
- Consumes: `OpenRouterClient.listModels()` (Task 5), `parseParamCount`/`parseReleaseDate` (Task 4), `SupportedModel`/`ModelPrice` repos.
- Produces: `ModelMetadataRefreshService.refreshAll(): Promise<{ updated: number; skipped: number; errored: number }>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ModelMetadataRefreshService } from "./model-metadata-refresh.service";
import { OpenRouterClient } from "./openrouter-client";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";

describe("ModelMetadataRefreshService", () => {
  let service: ModelMetadataRefreshService;
  let mockModelRepo: { find: jest.Mock; save: jest.Mock };
  let mockPriceRepo: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let mockClient: { listModels: jest.Mock };

  beforeEach(async () => {
    mockModelRepo = { find: jest.fn(), save: jest.fn() };
    mockPriceRepo = { find: jest.fn(), create: jest.fn((x) => x), save: jest.fn() };
    mockClient = { listModels: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelMetadataRefreshService,
        { provide: getRepositoryToken(SupportedModel), useValue: mockModelRepo },
        { provide: getRepositoryToken(ModelPrice), useValue: mockPriceRepo },
        { provide: OpenRouterClient, useValue: mockClient },
      ],
    }).compile();

    service = module.get(ModelMetadataRefreshService);
  });

  it("updates metadata and inserts a new price row for a matched, changed model", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValue([
      { id: 5, supportedModelId: 1, inputCostPerMillionTokens: 0.05, outputCostPerMillionTokens: 0.2 },
    ]);
    mockClient.listModels.mockResolvedValue([
      {
        id: "openai/gpt-4.1-nano",
        description: "Fast and cheap.",
        created: 1744651369,
        context_length: 128000,
        pricing: { prompt: "0.0000001", completion: "0.0000004" },
      },
    ]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        contextWindow: 128000,
        providerDescription: "Fast and cheap.",
        releaseDate: new Date(1744651369 * 1000),
        metadataUpdatedAt: expect.any(Date),
      }),
    );
    expect(mockPriceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedModelId: 1,
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.4,
      }),
    );
    expect(result).toEqual({ updated: 1, skipped: 0, errored: 0 });
  });

  it("does not insert a new price row when the price hasn't changed", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValue([
      { id: 5, supportedModelId: 1, inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.4 },
    ]);
    mockClient.listModels.mockResolvedValue([
      {
        id: "openai/gpt-4.1-nano",
        description: "Fast and cheap.",
        created: 1744651369,
        context_length: 128000,
        pricing: { prompt: "0.0000001", completion: "0.0000004" },
      },
    ]);

    await service.refreshAll();

    expect(mockPriceRepo.save).not.toHaveBeenCalled();
  });

  it("skips a model whose slug isn't mapped, without touching it", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 2, strategyName: "llm-ollama", modelName: "mistral", openRouterSlug: null },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockResolvedValue([]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, skipped: 1, errored: 0 });
  });

  it("skips a mapped model OpenRouter has no live entry for, without touching it", async () => {
    mockModelRepo.find.mockResolvedValue([
      {
        id: 3,
        strategyName: "llm-ollama",
        modelName: "mistral",
        openRouterSlug: "mistralai/mistral-7b-instruct",
      },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockResolvedValue([]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, skipped: 1, errored: 0 });
  });

  it("counts a thrown OpenRouter client error as errored, without throwing", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockRejectedValue(new Error("network error"));

    const result = await service.refreshAll();

    expect(result).toEqual({ updated: 0, skipped: 0, errored: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- model-metadata-refresh.service.spec.ts`
Expected: FAIL — module `./model-metadata-refresh.service` doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";
import { OpenRouterClient, OpenRouterModel } from "./openrouter-client";
import { parseParamCount, parseReleaseDate } from "./openrouter-metadata.util";

export interface RefreshSummary {
  updated: number;
  skipped: number;
  errored: number;
}

@Injectable()
export class ModelMetadataRefreshService {
  private readonly logger = new Logger(ModelMetadataRefreshService.name);

  constructor(
    @InjectRepository(SupportedModel) private readonly modelRepo: Repository<SupportedModel>,
    @InjectRepository(ModelPrice) private readonly priceRepo: Repository<ModelPrice>,
    private readonly client: OpenRouterClient,
  ) {}

  async refreshAll(): Promise<RefreshSummary> {
    const summary: RefreshSummary = { updated: 0, skipped: 0, errored: 0 };

    let openRouterModels: OpenRouterModel[];
    try {
      openRouterModels = await this.client.listModels();
    } catch (err) {
      this.logger.warn(`OpenRouter fetch failed: ${err instanceof Error ? err.message : err}`);
      const models = await this.modelRepo.find();
      return { updated: 0, skipped: 0, errored: models.filter((m) => m.openRouterSlug).length };
    }

    const byId = new Map(openRouterModels.map((m) => [m.id, m]));
    const models = await this.modelRepo.find();

    for (const model of models) {
      if (!model.openRouterSlug) {
        summary.skipped++;
        continue;
      }

      const match = byId.get(model.openRouterSlug);
      if (!match) {
        this.logger.warn(`No live OpenRouter entry for slug '${model.openRouterSlug}' — skipping.`);
        summary.skipped++;
        continue;
      }

      model.contextWindow = match.context_length;
      model.paramCount = parseParamCount(match.id) ?? parseParamCount(match.description);
      model.providerDescription = match.description;
      model.releaseDate = parseReleaseDate(match.created);
      model.metadataUpdatedAt = new Date();
      await this.modelRepo.save(model);

      await this.maybeInsertNewPrice(model, match);
      summary.updated++;
    }

    return summary;
  }

  private async maybeInsertNewPrice(model: SupportedModel, match: OpenRouterModel): Promise<void> {
    const inputCostPerMillionTokens = Number(match.pricing.prompt) * 1_000_000;
    const outputCostPerMillionTokens = Number(match.pricing.completion) * 1_000_000;

    const existingPrices = await this.priceRepo.find({
      where: { supportedModelId: model.id },
      order: { id: "DESC" },
      take: 1,
    });
    const current = existingPrices[0];

    if (
      current &&
      current.inputCostPerMillionTokens === inputCostPerMillionTokens &&
      current.outputCostPerMillionTokens === outputCostPerMillionTokens
    ) {
      return;
    }

    const newPrice = this.priceRepo.create({
      supportedModelId: model.id,
      inputCostPerMillionTokens,
      outputCostPerMillionTokens,
    });
    await this.priceRepo.save(newPrice);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- model-metadata-refresh.service.spec.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Register in SupportedModelModule**

In `backend/src/modules/supported-model/supported-model.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";
import { SupportedModelService } from "./supported-model.service";
import { OpenRouterClient } from "./openrouter-client";
import { ModelMetadataRefreshService } from "./model-metadata-refresh.service";

@Module({
  imports: [TypeOrmModule.forFeature([SupportedModel, ModelPrice])],
  providers: [SupportedModelService, OpenRouterClient, ModelMetadataRefreshService],
  exports: [SupportedModelService, ModelMetadataRefreshService],
})
export class SupportedModelModule {}
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/supported-model/model-metadata-refresh.service.ts backend/src/modules/supported-model/model-metadata-refresh.service.spec.ts backend/src/modules/supported-model/supported-model.module.ts
git commit -m "feat: add ModelMetadataRefreshService"
```

---

## Task 7: Daily scheduling + manual trigger endpoint

**Files:**
- Create: `backend/src/modules/queue/model-metadata.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Create: `backend/src/modules/supported-model/model-metadata-refresh.bootstrap.ts`
- Modify: `backend/src/modules/supported-model/supported-model.module.ts`
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `.env.sample`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ModelMetadataRefreshService.refreshAll()` (Task 6), `DispatchAuthGuard` (existing).
- Produces: `POST /dispatch/refresh-model-metadata` (password-gated in production, same as the other dispatch routes).

The bootstrap/scheduling piece mirrors `backend/src/modules/game/puzzle-queue.bootstrap.ts` exactly, and — like that file, and like the rest of this codebase's `OnApplicationBootstrap` providers — has no dedicated unit test (its logic is a direct BullMQ `upsertJobScheduler` call with no branching to test beyond the `NODE_ENV=test` skip, which is exercised implicitly by every test run never scheduling real jobs). The endpoint also follows this repo's existing convention of no dedicated controller-level test (see `DispatchController`'s other routes) — its behavior is proven by Task 6's service tests plus the existing `DispatchAuthGuard` test suite.

- [ ] **Step 1: Add the queue**

```ts
// backend/src/modules/queue/model-metadata.queue.ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

export const modelMetadataQueue = new Queue("model-metadata-refresh", {
  connection: redisConnection,
});
```

In `backend/src/modules/queue/queue.module.ts`, add the import and registration:

```ts
import { Module } from "@nestjs/common";
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue } from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";
import { freeTierDispatchQueue } from "./free-tier-dispatch.queue";
import { modelMetadataQueue } from "./model-metadata.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";
export const FREE_TIER_DISPATCH_QUEUE = "FREE_TIER_DISPATCH_QUEUE";
export const MODEL_METADATA_QUEUE = "MODEL_METADATA_QUEUE";

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: LLM_OPENAI_QUEUE, useValue: llmOpenAIQueue },
    { provide: LLM_OLLAMA_QUEUE, useValue: llmOllamaQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
    { provide: FREE_TIER_DISPATCH_QUEUE, useValue: freeTierDispatchQueue },
    { provide: MODEL_METADATA_QUEUE, useValue: modelMetadataQueue },
  ],
  exports: [
    STRATEGY_QUEUE,
    LLM_OPENAI_QUEUE,
    LLM_OLLAMA_QUEUE,
    PUZZLE_QUEUE,
    FREE_TIER_DISPATCH_QUEUE,
    MODEL_METADATA_QUEUE,
  ],
})
export class QueueModule {}
```

- [ ] **Step 2: Add the bootstrap provider**

```ts
// backend/src/modules/supported-model/model-metadata-refresh.bootstrap.ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { MODEL_METADATA_QUEUE } from "../queue/queue.module";

@Injectable()
export class ModelMetadataRefreshBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelMetadataRefreshBootstrap.name);

  constructor(@Inject(MODEL_METADATA_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping model-metadata refresh scheduling (NODE_ENV=test)");
      return;
    }

    const cron = process.env.MODEL_METADATA_REFRESH_CRON || "0 7 * * *"; // 07:00 UTC, after puzzle population
    await this.queue.upsertJobScheduler(
      "daily-model-metadata-refresh",
      { pattern: cron, tz: process.env.PUZZLE_POPULATION_TZ || "UTC" },
      {
        name: "refresh-model-metadata",
        data: {},
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
          attempts: 3,
          backoff: { type: "exponential", delay: 30000 },
        },
      },
    );

    this.logger.log(`Model-metadata refresh scheduled: "${cron}"`);
  }
}
```

Add a BullMQ `Worker` for this queue's `refresh-model-metadata` job, following the same pattern as `backend/src/worker.ts`'s existing `puzzle-population` worker — check that file's structure and add a matching processor that calls `ModelMetadataRefreshService.refreshAll()`.

Update `backend/src/modules/supported-model/supported-model.module.ts` to import `QueueModule` and add `ModelMetadataRefreshBootstrap` to providers:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";
import { SupportedModelService } from "./supported-model.service";
import { OpenRouterClient } from "./openrouter-client";
import { ModelMetadataRefreshService } from "./model-metadata-refresh.service";
import { ModelMetadataRefreshBootstrap } from "./model-metadata-refresh.bootstrap";
import { QueueModule } from "../queue/queue.module";

@Module({
  imports: [TypeOrmModule.forFeature([SupportedModel, ModelPrice]), QueueModule],
  providers: [
    SupportedModelService,
    OpenRouterClient,
    ModelMetadataRefreshService,
    ModelMetadataRefreshBootstrap,
  ],
  exports: [SupportedModelService, ModelMetadataRefreshService],
})
export class SupportedModelModule {}
```

- [ ] **Step 3: Add the manual-trigger endpoint**

In `backend/src/modules/dispatch/dispatch.controller.ts`, add the import and inject `ModelMetadataRefreshService` in the constructor:

```ts
import { ModelMetadataRefreshService } from "../supported-model/model-metadata-refresh.service";
```

```ts
    @Inject(ModelMetadataRefreshService) private readonly modelMetadataRefreshService: ModelMetadataRefreshService,
```

Add the route, after the existing `deleteRun` method:

```ts
  // Runs the same refresh ModelMetadataRefreshBootstrap schedules daily, on
  // demand — e.g. right after registering a new model's openRouterSlug.
  @Post("refresh-model-metadata")
  @UseGuards(DispatchAuthGuard)
  @ApiBody({ type: DispatchAuthDto })
  async refreshModelMetadata() {
    const result = await this.modelMetadataRefreshService.refreshAll();
    return { message: "Model metadata refresh complete", ...result };
  }
```

- [ ] **Step 4: Run the full backend suite**

Run (from `backend/`): `npm test`
Expected: PASS, no regressions (this task adds no new unit-tested logic, just wiring — verified by the module compiling and existing tests staying green).

- [ ] **Step 5: Update docs**

Add `MODEL_METADATA_REFRESH_CRON` to `.env.sample` (near `PUZZLE_POPULATION_CRON`):

```
MODEL_METADATA_REFRESH_CRON=0 7 * * *
```

Add a row to README.md's endpoint table (same table `DELETE /dispatch/run/:runId` is documented in) and its env var table:

```
| `POST /dispatch/refresh-model-metadata` | Re-runs the OpenRouter metadata/pricing refresh on demand (password-gated in production) |
```

```
| `MODEL_METADATA_REFRESH_CRON` | `0 7 * * *` | Cron schedule for the daily OpenRouter metadata/pricing refresh |
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/queue/model-metadata.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/supported-model/model-metadata-refresh.bootstrap.ts backend/src/modules/supported-model/supported-model.module.ts backend/src/modules/dispatch/dispatch.controller.ts backend/src/worker.ts .env.sample README.md
git commit -m "feat: schedule daily model-metadata refresh + manual trigger endpoint"
```

---

## Task 8: Historical cost accuracy — SupportedModelService.findPriceHistory

**Files:**
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Modify: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Produces: `SupportedModelService.findPriceHistory(): Promise<PriceHistoryEntry[]>`, `PriceHistoryEntry { strategyName: string; modelName: string; createdAt: Date; inputCostPerMillionTokens: number; outputCostPerMillionTokens: number }`, sorted ascending by `createdAt` within each model.

- [ ] **Step 1: Write the failing test**

```ts
describe("findPriceHistory", () => {
  it("returns every price row, joined with its model's strategyName/modelName", async () => {
    mockRepo.find.mockResolvedValueOnce([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValueOnce([
      {
        id: 10,
        supportedModelId: 1,
        inputCostPerMillionTokens: 0.05,
        outputCostPerMillionTokens: 0.2,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 11,
        supportedModelId: 1,
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.4,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);

    const result = await service.findPriceHistory();

    expect(result).toEqual([
      {
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        inputCostPerMillionTokens: 0.05,
        outputCostPerMillionTokens: 0.2,
      },
      {
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano",
        createdAt: new Date("2026-06-01T00:00:00Z"),
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.4,
      },
    ]);
  });

  it("omits a price row whose model no longer exists", async () => {
    mockRepo.find.mockResolvedValueOnce([]);
    mockPriceRepo.find.mockResolvedValueOnce([
      {
        id: 10,
        supportedModelId: 999,
        inputCostPerMillionTokens: 0.05,
        outputCostPerMillionTokens: 0.2,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    expect(await service.findPriceHistory()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- supported-model.service.spec.ts`
Expected: FAIL — `service.findPriceHistory` is not a function.

- [ ] **Step 3: Write the minimal implementation**

Add to `backend/src/modules/supported-model/supported-model.service.ts`:

```ts
export interface PriceHistoryEntry {
  strategyName: string;
  modelName: string;
  createdAt: Date;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}
```

```ts
  /**
   * Every ModelPrice row ever inserted, joined with its model's
   * strategyName/modelName, ordered oldest-first per model — lets a caller
   * find "the price in effect at time T" for a given run, rather than only
   * ever seeing the current price. See getLeaderboard/getRunHistory.
   */
  async findPriceHistory(): Promise<PriceHistoryEntry[]> {
    const [models, prices] = await Promise.all([
      this.repo.find(),
      this.priceRepo.find({ order: { id: "ASC" } }),
    ]);

    const modelById = new Map(models.map((model) => [model.id, model]));

    const entries: PriceHistoryEntry[] = [];
    for (const price of prices) {
      const model = modelById.get(price.supportedModelId);
      if (!model) continue;
      entries.push({
        strategyName: model.strategyName,
        modelName: model.modelName,
        createdAt: price.createdAt,
        inputCostPerMillionTokens: price.inputCostPerMillionTokens,
        outputCostPerMillionTokens: price.outputCostPerMillionTokens,
      });
    }
    return entries;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- supported-model.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/supported-model.service.ts backend/src/modules/supported-model/supported-model.service.spec.ts
git commit -m "feat: add SupportedModelService.findPriceHistory"
```

---

## Task 9: Historical cost accuracy — getLeaderboard

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`

**Interfaces:**
- Consumes: `SupportedModelService.findPriceHistory()` (Task 8).
- Produces: `getLeaderboard()`'s `avgCostUsd`/`totalCostUsd` priced per-run at the price in effect at that run's `startedAt`.

- [ ] **Step 1: Write the failing test**

Find the existing `getLeaderboard` describe block in `backend/src/modules/strategy/strategy.service.spec.ts` (search for `mockSupportedModelService.findAll` to find where its mock return value is set up for leaderboard tests) and add:

```ts
it("prices each run at the rate in effect when that run started, not the current rate", async () => {
  mockSupportedModelService.findPriceHistory.mockResolvedValue([
    {
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      inputCostPerMillionTokens: 0.05,
      outputCostPerMillionTokens: 0.2,
    },
    {
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      inputCostPerMillionTokens: 0.1,
      outputCostPerMillionTokens: 0.4,
    },
  ]);
  mockStrategyRunRepo.find.mockResolvedValue([
    {
      id: 1,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      puzzleId: 100,
      status: "completed",
      startedAt: new Date("2026-03-01T00:00:00Z"), // before the June price change
      finishedAt: new Date("2026-03-01T00:01:00Z"),
    },
  ]);
  mockSolvePromptRepo
    .createQueryBuilder()
    .getRawMany.mockResolvedValue([
      { strategyRunId: "1", promptTokens: "1000000", completionTokens: "1000000" },
    ]);

  const result = await service.getLeaderboard();

  const row = result.llm.find((r) => r.id === "gpt-4.1-nano");
  // 1M prompt tokens * 0.05 + 1M completion tokens * 0.2 = 0.25, using the
  // January rate (in effect at startedAt), not the June rate that would
  // give 0.05 + 0.4 = 0.45.
  expect(row?.totalCostUsd).toBeCloseTo(0.25);
});
```

Adapt the exact mock setup (`mockStrategyRunRepo`, `mockSolvePromptRepo`, etc.) to match whatever mocking pattern the existing `getLeaderboard` tests in this file already use — read the file first and follow its established conventions rather than introducing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- strategy.service.spec.ts`
Expected: FAIL — `totalCostUsd` comes out as `0.45` (today's/June's rate applied to every run) instead of `0.25`.

- [ ] **Step 3: Update getLeaderboard**

In `backend/src/modules/strategy/strategy.service.ts`, replace the `this.supportedModelService.findAll()` call inside `getLeaderboard`'s `Promise.all([...])` with `this.supportedModelService.findPriceHistory()`, and update the destructured variable name accordingly (it's currently named `models` — rename to `priceHistory` at both the destructure site and its one other reference).

Replace the `rateByModel` construction (currently):

```ts
    const rateByModel = new Map<string, SupportedModelWithRate>();
    for (const model of models) {
      rateByModel.set(leaderboardKey(model.strategyName, model.modelName), model);
    }
```

with:

```ts
    const priceHistoryByModel = new Map<string, PriceHistoryEntry[]>();
    for (const entry of priceHistory) {
      const key = leaderboardKey(entry.strategyName, entry.modelName);
      const list = priceHistoryByModel.get(key);
      if (list) {
        list.push(entry);
      } else {
        priceHistoryByModel.set(key, [entry]);
      }
    }
```

Replace the cost-accumulation block (currently):

```ts
      if (run.modelName) {
        const tokens = tokensByRun.get(run.id);
        const rate = rateByModel.get(leaderboardKey(run.strategyName, run.modelName));
        if (tokens && rate && hasPrice(rate)) {
          acc.costsUsd.push(computeTokenCostUsd(tokens.promptTokens, tokens.completionTokens, rate));
        }
      }
```

with:

```ts
      if (run.modelName) {
        const tokens = tokensByRun.get(run.id);
        const history = priceHistoryByModel.get(leaderboardKey(run.strategyName, run.modelName));
        const rate = priceAsOf(history, run.startedAt);
        if (tokens && rate) {
          acc.costsUsd.push(computeTokenCostUsd(tokens.promptTokens, tokens.completionTokens, rate));
        }
      }
```

Add the `priceAsOf` helper near the existing `computeTokenCostUsd`/`hasPrice` helpers (top of the file), and add the `PriceHistoryEntry` import:

```ts
import { SupportedModelWithRate, PriceHistoryEntry } from "../supported-model/supported-model.service";
```

```ts
/**
 * The price in effect at `at` — the latest entry in `history` (assumed
 * sorted ascending by createdAt, which findPriceHistory guarantees) whose
 * createdAt is <= at. null when `at` predates the model's first price row —
 * that run has no known cost, same as a model with no price at all, rather
 * than borrowing a later price for it.
 */
function priceAsOf(history: PriceHistoryEntry[] | undefined, at: Date): ModelRate | null {
  if (!history) return null;
  let rate: ModelRate | null = null;
  for (const entry of history) {
    if (entry.createdAt.getTime() > at.getTime()) break;
    rate = entry;
  }
  return rate;
}
```

`hasPrice`/`SupportedModelWithRate` may now be unused in this file if nothing else references them — check with a search before removing; leave them if `getRunHistory` or elsewhere still needs them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- strategy.service.spec.ts`
Expected: PASS, all tests green including the new one.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "fix: price each leaderboard run at its own startedAt's rate"
```

---

## Task 10: Historical cost accuracy — getRunHistory

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`

**Interfaces:**
- Produces: `getRunHistory()`'s `tokenCostUsd` per row priced at that row's `startedAt`.

- [ ] **Step 1: Write the failing test**

Find the existing `getRunHistory` describe block and add a test seeding two `ModelPrice` rows with different `createdAt` values (via whatever test-DB/fixture seeding pattern the existing `getRunHistory` tests already use — this method is tested against a real query builder, not mocked repos, based on its raw SQL; follow that file's existing setup for these tests exactly), then asserting that a run whose `startedAt` predates a price change reports the old rate's cost, while a run after the change reports the new rate's cost.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- strategy.service.spec.ts`
Expected: FAIL — both runs report the same (current) rate's cost.

- [ ] **Step 3: Update the SQL**

In `backend/src/modules/strategy/strategy.service.ts`, in `getRunHistory`'s query builder, change:

```ts
      .leftJoin(
        ModelPrice,
        "mp",
        `mp.id = (
          SELECT id FROM "ModelPrice" WHERE "supportedModelId" = sm.id ORDER BY id DESC LIMIT 1
        )`,
      )
```

to:

```ts
      .leftJoin(
        ModelPrice,
        "mp",
        `mp.id = (
          SELECT id FROM "ModelPrice"
          WHERE "supportedModelId" = sm.id AND "createdAt" <= run."startedAt"
          ORDER BY id DESC LIMIT 1
        )`,
      )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- strategy.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "fix: price each run-history row at its own startedAt's rate"
```

---

## Task 11: Per-model context window — SupportedModelService.getContextWindow

**Files:**
- Modify: `backend/src/modules/supported-model/supported-model.service.ts`
- Modify: `backend/src/modules/supported-model/supported-model.service.spec.ts`

**Interfaces:**
- Produces: `SupportedModelService.getContextWindow(strategyName: string, modelName: string): Promise<number | null>`.

- [ ] **Step 1: Write the failing test**

```ts
describe("getContextWindow", () => {
  it("returns the model's contextWindow when the row exists", async () => {
    mockRepo.findOne.mockResolvedValueOnce({ contextWindow: 131072 });
    expect(await service.getContextWindow("llm-ollama", "mistral-nemo")).toBe(131072);
    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { strategyName: "llm-ollama", modelName: "mistral-nemo" },
    });
  });

  it("returns null when the model has no known context window yet", async () => {
    mockRepo.findOne.mockResolvedValueOnce({ contextWindow: null });
    expect(await service.getContextWindow("llm-ollama", "mistral-nemo")).toBeNull();
  });

  it("returns null when no such model exists", async () => {
    mockRepo.findOne.mockResolvedValueOnce(null);
    expect(await service.getContextWindow("llm-ollama", "unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- supported-model.service.spec.ts`
Expected: FAIL — `service.getContextWindow` is not a function.

- [ ] **Step 3: Write the minimal implementation**

```ts
  /**
   * The model's real context window, if known — used to configure Ollama's
   * num_ctx per-model instead of the flat MODEL_CONTEXT_WINDOW default. null
   * when the model doesn't exist or hasn't been refreshed yet; callers fall
   * back to the env default in that case (see provider.ts).
   */
  async getContextWindow(strategyName: string, modelName: string): Promise<number | null> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row?.contextWindow ?? null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- supported-model.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/supported-model/supported-model.service.ts backend/src/modules/supported-model/supported-model.service.spec.ts
git commit -m "feat: add SupportedModelService.getContextWindow"
```

---

## Task 12: Per-model context window — orchestrator (provider.ts, solve-assist.ts, app.ts, types.ts)

**Files:**
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/src/provider.test.ts`
- Modify: `orchestrator/src/solve-assist.ts`
- Modify: `orchestrator/src/solve-assist.test.ts`
- Modify: `orchestrator/src/app.ts`
- Modify: `orchestrator/src/app.test.ts`
- Modify: `orchestrator/src/types.ts`

**Interfaces:**
- Produces: `getModel(provider, modelOverride?, contextWindow?)`, `solveAssist(messages, model?, provider?, contextWindow?, abortSignal?)`, `SolveAssistRequestSchema` gains optional `contextWindow`.

- [ ] **Step 1: Write the failing test for provider.ts**

Add to `orchestrator/src/provider.test.ts`, inside the existing `describe("getModel", ...)` block:

```ts
it("uses an explicit contextWindow over MODEL_CONTEXT_WINDOW when given", () => {
  vi.stubEnv("MODEL_CONTEXT_WINDOW", "2048");

  getModel("ollama", undefined, 131072);

  const modelFactory = createOllamaMock.mock.results[0].value;
  expect(modelFactory).toHaveBeenCalledWith("llama3.2", {
    options: { num_ctx: 131072 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npm test -- provider.test.ts`
Expected: FAIL — `getModel` only accepts 2 args today; TypeScript compile error / the third arg is silently ignored and `num_ctx` stays `2048`.

- [ ] **Step 3: Update provider.ts**

In `orchestrator/src/provider.ts`, change `getModel`'s signature and Ollama branch:

```ts
export function getModel(
  provider: ModelProvider,
  modelOverride?: string,
  contextWindow?: number,
): LanguageModel {
  if (provider === "ollama") {
    const ollama = createOllama({
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
    return ollama(modelOverride ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL, {
      options: { num_ctx: contextWindow ?? getContextWindow() },
    });
  }

  return openai(modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
}
```

Update the doc comment above `getModel` to note `contextWindow` overrides `MODEL_CONTEXT_WINDOW`, mirroring how `modelOverride` overrides `OLLAMA_MODEL`/`OPENAI_MODEL`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- provider.test.ts`
Expected: PASS, all tests green (existing tests still pass — `contextWindow` is optional).

- [ ] **Step 5: Write the failing test for solve-assist.ts**

Find `orchestrator/src/solve-assist.test.ts`'s test(s) that assert on the `getModel` mock's call args and add:

```ts
it("passes contextWindow through to getModel", async () => {
  // Follow this file's existing mocking pattern for generateText/getModel —
  // read the surrounding tests first. Assert getModel was called with
  // (provider, model, contextWindow) when solveAssist is called with a
  // contextWindow argument.
  await solveAssist([{ role: "user", content: "hi" }], "mistral-nemo", "ollama", 131072);
  expect(getModelMock).toHaveBeenCalledWith("ollama", "mistral-nemo", 131072);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run (from `orchestrator/`): `npm test -- solve-assist.test.ts`
Expected: FAIL — `solveAssist` doesn't accept a `contextWindow` argument yet (it's currently `(messages, model?, provider?, abortSignal?)`).

- [ ] **Step 7: Update solve-assist.ts**

In `orchestrator/src/solve-assist.ts`, change the signature to insert `contextWindow` before `abortSignal`:

```ts
export async function solveAssist(
  messages: ChatMessage[],
  model?: string,
  provider?: ModelProvider,
  contextWindow?: number,
  abortSignal?: AbortSignal,
): Promise<SolveAssistResult> {
  const resolvedProvider = provider ?? defaultProvider();
  ...
  const result = await generateText({
    model: getModel(resolvedProvider, model, contextWindow),
    ...
```

(Only the signature and the `getModel(...)` call site change — everything else in the function body stays the same.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- solve-assist.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 9: Write the failing test for app.ts**

Find `orchestrator/src/app.test.ts`'s existing `/solve-assist` request test(s) and add one asserting that a `contextWindow` field in the request body reaches `solveAssist` as its 4th argument. Follow the file's existing pattern for mocking `solveAssist` and asserting on its call args.

- [ ] **Step 10: Run test to verify it fails**

Run (from `orchestrator/`): `npm test -- app.test.ts`
Expected: FAIL — `parsed.data.contextWindow` isn't parsed (schema doesn't have the field) and isn't passed to `solveAssist`.

- [ ] **Step 11: Update types.ts and app.ts**

In `orchestrator/src/types.ts`, extend `SolveAssistRequestSchema`:

```ts
export const SolveAssistRequestSchema = AssistRequestSchema.extend({
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Model to call, overriding the orchestrator's env-configured default"),
  provider: z
    .enum(["openai", "ollama"])
    .optional()
    .describe("Provider to call, overriding MODEL_PROVIDER"),
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("This model's real context window, overriding MODEL_CONTEXT_WINDOW for Ollama's num_ctx"),
});
```

In `orchestrator/src/app.ts`, update the `/solve-assist` handler's call:

```ts
      const result = await solveAssist(
        parsed.data.messages,
        parsed.data.model,
        parsed.data.provider,
        parsed.data.contextWindow,
        c.req.raw.signal,
      );
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test -- app.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 13: Run the full orchestrator suite**

Run: `npm test`
Expected: PASS, no regressions across `assist.test.ts` or any other file that might call `solveAssist`/`getModel` — check for any other call sites this signature change affects (e.g. `assist.ts`'s `/diagnose` path, which should be unaffected since it doesn't call `solveAssist`, only `runAssistStep`).

- [ ] **Step 14: Commit**

```bash
git add orchestrator/src/provider.ts orchestrator/src/provider.test.ts orchestrator/src/solve-assist.ts orchestrator/src/solve-assist.test.ts orchestrator/src/app.ts orchestrator/src/app.test.ts orchestrator/src/types.ts
git commit -m "feat: thread an explicit per-model contextWindow through solve-assist"
```

---

## Task 13: Per-model context window — backend OrchestratorService

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Modify: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `OrchestratorService.solveAssist(messages, model?, provider?, contextWindow?)`.

- [ ] **Step 1: Write the failing test**

Find the existing test(s) in `orchestrator.service.spec.ts` that assert on the request body sent to `fetch`, and add:

```ts
it("includes contextWindow in the request body when given", async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ response: "text", groups: [], model: "mistral-nemo" }),
  });

  await service.solveAssist([{ role: "user", content: "hi" }], "mistral-nemo", "ollama", 131072);

  const [, init] = mockFetch.mock.calls[0];
  expect(JSON.parse(init.body)).toMatchObject({ contextWindow: 131072 });
});
```

Adapt to this spec file's existing `fetch` mocking convention (variable names, setup) — read it first.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- orchestrator.service.spec.ts`
Expected: FAIL — `solveAssist` doesn't accept a 4th argument, and the request body has no `contextWindow` key.

- [ ] **Step 3: Update orchestrator.service.ts**

In `backend/src/modules/strategy/orchestrator.service.ts`, update `solveAssist`:

```ts
  async solveAssist(
    messages: ChatMessage[],
    model?: string,
    provider?: "openai" | "ollama",
    contextWindow?: number | null,
  ): Promise<SolveAssistOutcome> {
    return this.executeCall<SolveAssistSuccess>(
      "/solve-assist",
      { messages, model, provider, contextWindow: contextWindow ?? undefined },
      (raw) => ({
        response: raw.response,
        groups: raw.groups,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
        requestBody: raw.requestBody,
        responseId: raw.responseId,
        responseHeaders: raw.responseHeaders,
        responseBody: raw.responseBody,
      }),
    );
  }
```

Also update the doc comment above `solveAssist` to mention `contextWindow`, matching how `model`/`provider` are already documented there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrator.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat: pass contextWindow through OrchestratorService.solveAssist"
```

---

## Task 14: Per-model context window — StrategyRunStore + LlmStrategyRunner

**Files:**
- Modify: `backend/src/modules/strategy/strategy-run-store.service.ts`
- Modify: `backend/src/modules/strategy/strategy-run-store.service.spec.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `SupportedModelService.getContextWindow` (Task 11), `OrchestratorService.solveAssist`'s new 4th param (Task 13).
- Produces: `StrategyRunStore.loadOrCreateRun(puzzleId, strategyName, trialNumber, model?, contextWindow?)`; `StrategyRun.contextWindow` populated for every new LLM run.

- [ ] **Step 1: Write the failing test for StrategyRunStore**

Add to `backend/src/modules/strategy/strategy-run-store.service.spec.ts`, in the `describe("loadOrCreateRun", ...)` block:

```ts
it("sets contextWindow on a newly created run when given", async () => {
  mockPuzzleRepo.findOne.mockResolvedValueOnce({ id: 100 });
  mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
  mockStrategyRunRepo.create.mockImplementation((x) => x);
  mockStrategyRunRepo.save.mockImplementation((x) => Promise.resolve(x));

  const { run } = await store.loadOrCreateRun(100, "llm-ollama", 0, "mistral-nemo", 131072);

  expect(run.contextWindow).toBe(131072);
});

it("leaves contextWindow null when not given", async () => {
  mockPuzzleRepo.findOne.mockResolvedValueOnce({ id: 100 });
  mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
  mockStrategyRunRepo.create.mockImplementation((x) => x);
  mockStrategyRunRepo.save.mockImplementation((x) => Promise.resolve(x));

  const { run } = await store.loadOrCreateRun(100, "alphabetical", 0);

  expect(run.contextWindow).toBeNull();
});
```

Adapt mock variable names to this spec file's existing conventions.

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- strategy-run-store.service.spec.ts`
Expected: FAIL — `run.contextWindow` is `undefined` (the field is never set).

- [ ] **Step 3: Update loadOrCreateRun**

In `backend/src/modules/strategy/strategy-run-store.service.ts`:

```ts
  async loadOrCreateRun(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
    model?: string,
    contextWindow?: number | null,
  ): Promise<{ run: StrategyRun; puzzle: Puzzle }> {
    ...
    const run = this.strategyRunRepo.create({
      puzzle,
      strategyName,
      trialNumber,
      status: StrategyRunStatus.RUNNING,
      availableWords: allWords,
      currentCombination: firstCombination(GROUP_SIZE),
      modelName: model ?? null,
      contextWindow: contextWindow ?? null,
    });
    ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- strategy-run-store.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the failing test for LlmStrategyRunner**

Add to `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts` (find its constructor/mock setup for `SupportedModelService` — it needs to be added as a new mocked dependency; check whether it's already imported/mocked anywhere in this file's setup, and add it if not):

```ts
it("looks up and threads the model's contextWindow through to solveAssist and the run", async () => {
  mockSupportedModelService.getContextWindow.mockResolvedValue(131072);
  // ... existing mock setup for a successful llm-ollama run with model "mistral-nemo" ...

  await runner.runLlmStrategy(100, "llm-ollama", 0, "mistral-nemo");

  expect(mockSupportedModelService.getContextWindow).toHaveBeenCalledWith("llm-ollama", "mistral-nemo");
  expect(mockOrchestratorService.solveAssist).toHaveBeenCalledWith(
    expect.any(Array),
    "mistral-nemo",
    "ollama",
    131072,
  );
});

it("does not look up a contextWindow when no model is given", async () => {
  await runner.runLlmStrategy(100, "llm-openai");
  expect(mockSupportedModelService.getContextWindow).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run (from `backend/`): `npm test -- llm-strategy-runner.service.spec.ts`
Expected: FAIL — `LlmStrategyRunner` doesn't depend on `SupportedModelService` yet, and `solveAssist` is called with only 3 args.

- [ ] **Step 7: Update llm-strategy-runner.service.ts**

Add the constructor dependency:

```ts
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
```

(with the matching import: `import { SupportedModelService } from "../supported-model/supported-model.service";`)

At the top of `runLlmStrategy`, before `loadOrCreateRun`:

```ts
    const provider = strategyName === LLM_OLLAMA ? "ollama" : "openai";

    const contextWindow = model
      ? await this.supportedModelService.getContextWindow(strategyName, model)
      : null;

    const { run, puzzle } = await this.store.loadOrCreateRun(
      puzzleId,
      strategyName,
      trialNumber,
      model,
      contextWindow,
    );
```

Update the `solveAssist` call:

```ts
      const outcome = await this.orchestratorService.solveAssist(messages, model, provider, contextWindow);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- llm-strategy-runner.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 9: Update LlmStrategyRunner's NestJS registration**

`backend/src/modules/strategy/strategy.module.ts` already imports `SupportedModelModule` and `LlmStrategyRunner` is already a provider there — no module-file change needed, since Nest resolves the new constructor dependency automatically as long as `SupportedModelModule` exports `SupportedModelService` (it already does).

- [ ] **Step 10: Run the full backend suite**

Run (from `backend/`): `npm test`
Expected: PASS, no regressions.

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/strategy/strategy-run-store.service.ts backend/src/modules/strategy/strategy-run-store.service.spec.ts backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: look up and record each LLM run's real contextWindow"
```

---

## Task 15: Frontend types — SupportedModelRecord and LeaderboardRow

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts`
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`

**Interfaces:**
- Produces: `SupportedModelRecord` and `LeaderboardRow` (frontend) / `LeaderboardRowDto` (backend) gain `contextWindow: number | null`, `paramCount: number | null`, `providerDescription: string | null`.

`SupportedModelRecord` needs no backend change beyond what Task 3 already did (`GET /strategy/models` already returns the new fields via `findAll()`) — only the frontend type needs updating to describe them. `LeaderboardRow`/`LeaderboardRowDto` need both: the backend's `getLeaderboard()` doesn't currently select a single representative model's metadata onto each row, so it needs a small addition.

- [ ] **Step 1: Write the failing backend test**

In `backend/src/modules/strategy/strategy.service.spec.ts`'s `getLeaderboard` tests, extend the earlier historical-pricing test (or add a new one) to also assert:

```ts
expect(row).toMatchObject({
  contextWindow: 128000,
  paramCount: null,
  providerDescription: "Fast and cheap.",
});
```

using a `findPriceHistory`/model-list mock that includes those fields (note: `getLeaderboard` currently has no per-model-metadata lookup besides `findPriceHistory`, which only carries pricing — this task adds a second, small lookup for the latest metadata).

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- strategy.service.spec.ts`
Expected: FAIL — `row.contextWindow` is `undefined` (`LeaderboardRowDto` has no such field).

- [ ] **Step 3: Update the DTO and getLeaderboard**

In `backend/src/modules/strategy/dto/strategy.dto.ts`, add to `LeaderboardRowDto`:

```ts
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
```

In `backend/src/modules/strategy/strategy.service.ts`'s `getLeaderboard`, add `this.supportedModelService.findAll()` back into the `Promise.all([...])` (it was removed from the pricing role in Task 9, but is still useful here for the *current* metadata snapshot — pricing needs history, but context/params/description don't need to be historically accurate, only current). Build a lookup map from it (mirroring the old `rateByModel` pattern), and add the three fields to the row-building `.map()`:

```ts
    const metadataByModel = new Map<string, SupportedModelWithRate>();
    for (const model of currentModels) {
      metadataByModel.set(leaderboardKey(model.strategyName, model.modelName), model);
    }
```

```ts
      const metadata = metadataByModel.get(leaderboardKey(acc.strategyName, acc.modelName));
      return {
        id: acc.modelName ?? acc.strategyName,
        ...
        avgCostUsd: totalCostUsd === null ? null : totalCostUsd / acc.costsUsd.length,
        totalCostUsd,
        contextWindow: metadata?.contextWindow ?? null,
        paramCount: metadata?.paramCount ?? null,
        providerDescription: metadata?.providerDescription ?? null,
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- strategy.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Update frontend types**

In `frontend/src/data/benchmark/types.ts`, add to `SupportedModelRecord`:

```ts
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
  releaseDate: string | null;
```

Add to `LeaderboardRow`:

```ts
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/data/benchmark/types.ts backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat: surface context window/params/description on models and leaderboard rows"
```

---

## Task 16: Frontend — description built from live metadata

**Files:**
- Modify: `frontend/src/data/benchmark/useStrategyMeta.ts`
- Modify: `frontend/src/data/benchmark/useStrategyMeta.test.ts` (create if it doesn't exist — check first)
- Modify: `frontend/src/data/benchmark/mockData.ts`
- Modify: `frontend/src/data/benchmark/mockData.test.ts` (check exact filename first)

**Interfaces:**
- Consumes: `SupportedModelRecord.contextWindow`/`paramCount` (Task 15).
- Produces: `formatModelStatsDescription(providerLabel: string, modelName: string, contextWindow: number | null, paramCount: number | null): string`, used by both `buildDynamicMeta` and `describeLeaderboardRow`.

- [ ] **Step 1: Write the failing tests**

Add a new small module `frontend/src/data/benchmark/formatModelStats.ts` and its test — this is the shared formatter both call sites need, so it gets its own file rather than being duplicated:

```ts
// frontend/src/data/benchmark/formatModelStats.test.ts
import { formatModelStatsDescription } from "./formatModelStats";

describe("formatModelStatsDescription", () => {
  it("includes both context window and param count when both are known", () => {
    expect(formatModelStatsDescription("Ollama", "mistral-nemo", 131072, 12_000_000_000)).toBe(
      "Ollama mistral-nemo · 131K context · 12B params",
    );
  });

  it("omits the params clause when paramCount is null", () => {
    expect(formatModelStatsDescription("OpenAI", "gpt-4.1-nano", 128000, null)).toBe(
      "OpenAI gpt-4.1-nano · 128K context",
    );
  });

  it("omits the context clause when contextWindow is null", () => {
    expect(formatModelStatsDescription("OpenAI", "gpt-4.1-nano", null, null)).toBe(
      "OpenAI gpt-4.1-nano proposes candidate groups",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- formatModelStats.test.ts`
Expected: FAIL — module `./formatModelStats` doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

```ts
// frontend/src/data/benchmark/formatModelStats.ts

/** Formats a model's leaderboard description from live context/param data,
 * falling back to the old generic sentence when neither is known yet
 * (a model that hasn't been through a metadata refresh). */
export function formatModelStatsDescription(
  providerLabel: string,
  modelName: string,
  contextWindow: number | null,
  paramCount: number | null,
): string {
  const parts: string[] = [];
  if (contextWindow !== null) {
    parts.push(`${Math.round(contextWindow / 1000)}K context`);
  }
  if (paramCount !== null) {
    parts.push(`${Math.round(paramCount / 1_000_000_000)}B params`);
  }

  if (parts.length === 0) {
    return `${providerLabel} ${modelName} proposes candidate groups`;
  }

  return `${providerLabel} ${modelName} · ${parts.join(" · ")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- formatModelStats.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Write the failing test for useStrategyMeta**

Read `frontend/src/data/benchmark/useStrategyMeta.ts`'s existing test file (find it via glob — likely `useStrategyMeta.test.ts` or a `.test.tsx` under `__tests__/`) to see its current test setup, then add a test asserting that a model already in `STRATEGY_DEFS` (e.g. `"gpt-4.1-nano-2025-04-14"` — check what's actually in the static list after Task 17 renames it, or use whatever id is present) still ends up with a description built from live `fetchSupportedModels` data, not the old static string — i.e. `useStrategyMeta` now always fetches for `kind === "llm"` rows.

- [ ] **Step 6: Run test to verify it fails**

Run (from `frontend/`): `npm test -- useStrategyMeta` (adjust to the actual test filename found in Step 5)
Expected: FAIL — the static match currently short-circuits the fetch entirely (see `useStrategyMeta.ts`'s `if (!strategyId || getStrategyMeta(strategyId)) { ...; return; }` guard).

- [ ] **Step 7: Update useStrategyMeta.ts**

```ts
import { formatModelStatsDescription } from "./formatModelStats";

function buildDynamicMeta(model: SupportedModelRecord): StrategyMeta {
  const providerLabel = model.strategyName === "llm-ollama" ? "Ollama" : "OpenAI";
  return {
    id: model.modelName,
    name: `LLM · ${model.modelName}`,
    kind: "llm",
    description: formatModelStatsDescription(
      providerLabel,
      model.modelName,
      model.contextWindow,
      model.paramCount,
    ),
    runsPerPuzzle: 3,
    strategyName: model.strategyName,
  };
}
```

Change the effect's early-return guard from skipping every `kind !== undefined` static match to only skipping non-LLM static matches:

```ts
  useEffect(() => {
    const staticMatch = strategyId ? getStrategyMeta(strategyId) : undefined;
    if (!strategyId || (staticMatch && staticMatch.kind !== "llm")) {
      setDynamicMeta(null);
      setIsResolving(false);
      return;
    }

    setIsResolving(true);
    setDynamicMeta(null);

    const controller = new AbortController();
    fetchSupportedModels(controller.signal)
      .then((models) => {
        const match = models.find((model) => model.modelName === strategyId);
        setDynamicMeta(match ? buildDynamicMeta(match) : null);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setIsResolving(false);
      });

    return () => controller.abort();
  }, [strategyId]);
```

The returned `meta` still needs adjusting: for an LLM `strategyId` with a static match, `name`/`kind`/`strategyName`/`runsPerPuzzle` should come from the static entry (identity/copy stays hand-curated) but `description` should come from `dynamicMeta` once it resolves. Update the `meta` computation:

```ts
  const meta =
    staticMeta && staticMeta.kind === "llm" && dynamicMeta
      ? { ...staticMeta, description: dynamicMeta.description }
      : (staticMeta ?? dynamicMeta ?? undefined);
```

(Keep the existing `staticMeta` `const` above this, computed the same way as today: `const staticMeta = strategyId ? getStrategyMeta(strategyId) : undefined;`.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- useStrategyMeta` (matching the actual filename)
Expected: PASS, all tests green, including every existing test in the file (re-run the whole file, not just the new test, since this changes the effect's guard condition for every case).

- [ ] **Step 9: Write the failing test for describeLeaderboardRow**

In `frontend/src/data/benchmark/mockData.test.ts` (check the actual filename), add a test asserting that for an LLM `LeaderboardRow` with `contextWindow`/`paramCount` set, `describeLeaderboardRow` returns a description built by `formatModelStatsDescription`, regardless of whether `row.id` matches a static `STRATEGY_DEFS` entry.

- [ ] **Step 10: Run test to verify it fails**

Run (from `frontend/`): `npm test -- mockData.test.ts` (or the correct filename)
Expected: FAIL — a static match currently wins outright (`if (meta) return { name: meta.name, description: meta.description };`), ignoring the row's live `contextWindow`/`paramCount`.

- [ ] **Step 11: Update mockData.ts**

Remove `description` from every `kind: "llm"` entry in `STRATEGY_DEFS` (the four models currently listed — `gpt-4.1-nano-2025-04-14`, `gpt-4o-mini`, `mistral`, `llama3.1-8b`; note `StrategyMeta.description` stays a required field on the type, so these entries need *some* string — see the note below on `StrategyMeta`).

Actually: since `StrategyMeta.description` is used by non-LLM rows too (deterministic/shuffle, which keep their hand-written descriptions unchanged), don't remove the field from the type — just stop relying on the static LLM entries' `description` value. Update `describeLeaderboardRow`:

```ts
export function describeLeaderboardRow(row: LeaderboardRow): { name: string; description: string } {
  const meta = getStrategyMeta(row.id);

  if (row.kind === "llm") {
    const providerLabel = row.strategyName === "llm-ollama" ? "Ollama" : "OpenAI";
    return {
      name: meta?.name ?? `LLM · ${row.modelName}`,
      description: formatModelStatsDescription(
        providerLabel,
        row.modelName ?? row.id,
        row.contextWindow,
        row.paramCount,
      ),
    };
  }

  if (meta) return { name: meta.name, description: meta.description };

  return {
    name: humanizeStrategyName(row.strategyName),
    description: `Strategy · ${row.strategyName}`,
  };
}
```

Add the import: `import { formatModelStatsDescription } from "./formatModelStats";`

The four `kind: "llm"` entries in `STRATEGY_DEFS` can keep a `description` value (the type still requires one, and `useStrategyMeta`'s static-fallback path before the dynamic fetch resolves briefly uses it) — leave their existing strings as-is; they're now only a same-render placeholder until live data arrives, not the permanent value.

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test -- mockData.test.ts` (matching the actual filename)
Expected: PASS, all tests green.

- [ ] **Step 13: Run the full frontend suite**

Run (from `frontend/`): `npm test`
Expected: PASS, no regressions — check specifically any test asserting on the old static description strings (e.g. `"OpenAI gpt-4.1-nano proposes candidate groups"`) in `PuzzleRunsPage.test.tsx`, `StrategyTable` tests, etc., and update their expected text to match the new format if they now render live-fetched data through the changed code path.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/data/benchmark/formatModelStats.ts frontend/src/data/benchmark/formatModelStats.test.ts frontend/src/data/benchmark/useStrategyMeta.ts frontend/src/data/benchmark/mockData.ts
git commit -m "feat: build LLM row descriptions from live context/param data"
```

---

## Task 17: Frontend — provider description on StrategyPuzzlePage

**Files:**
- Modify: `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`
- Modify: `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`

**Interfaces:**
- Consumes: `LeaderboardRow.providerDescription` (Task 15).

- [ ] **Step 1: Write the failing test**

In `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`, find how the existing tests stub `fetchLeaderboard`'s response for an LLM row, and add:

```ts
it("shows the provider's own description below the stats line for an LLM model", async () => {
  // stub fetchLeaderboard to include a matching row with:
  // providerDescription: "For tasks that demand low latency, GPT-4.1 nano is the fastest..."
  renderPage("/leaderboard/gpt-4.1-nano");

  expect(
    await screen.findByText("For tasks that demand low latency, GPT-4.1 nano is the fastest..."),
  ).toBeInTheDocument();
});

it("shows no provider-description paragraph for a deterministic strategy", async () => {
  renderPage("/leaderboard/alphabetical");
  await screen.findByRole("heading", { name: "Alphabetical" });
  expect(screen.queryByText(/GPT-4.1 nano is the fastest/)).not.toBeInTheDocument();
});
```

Adapt to this test file's actual render helper name/route-stubbing conventions — read the file first.

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- StrategyPuzzlePage.test.tsx`
Expected: FAIL — nothing renders `providerDescription` yet.

- [ ] **Step 3: Update StrategyPuzzlePage.tsx**

Below the existing `<p className="bench-strategy-desc">{meta.description}</p>` line, add:

```tsx
        {meta.kind === "llm" && leaderboardRow?.providerDescription ? (
          <p className="bench-strategy-provider-desc">{leaderboardRow.providerDescription}</p>
        ) : null}
```

(`leaderboardRow` is already fetched and available in this component's state — see the header comment describing how it's sourced from `GET /strategy/leaderboard`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- StrategyPuzzlePage.test.tsx`
Expected: PASS, all tests green.

- [ ] **Step 5: Add the CSS class**

In `frontend/src/benchmark.css`, add a rule for `.bench-strategy-provider-desc` near the existing `.bench-strategy-desc` rule — a muted, slightly smaller paragraph style consistent with the rest of this page's typography (match the existing `.bench-muted`/`.bench-strategy-desc` values already in the file rather than inventing new ones).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/benchmark/StrategyPuzzlePage.tsx frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx frontend/src/benchmark.css
git commit -m "feat: show OpenRouter's provider description on the model page"
```

---

## Task 18: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run (from `backend/`): `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Run the full orchestrator suite**

Run (from `orchestrator/`): `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 3: Run the full frontend suite**

Run (from `frontend/`): `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 4: Manually verify the migrations apply cleanly**

Against a local/dev Postgres with `DB_MIGRATIONS_RUN=true` (the default), boot the backend and confirm both new migrations (Tasks 1 and 2) run without error, and that `mistral-nemo`'s row now has `openRouterSlug = 'mistralai/mistral-nemo'`.

- [ ] **Step 5: Manually trigger a refresh and inspect the result**

With `DISPATCH_PASSWORD` set appropriately for your environment, `POST /dispatch/refresh-model-metadata` and confirm the response's `updated`/`skipped`/`errored` counts match expectations (2 updated for the confirmed mappings, the rest skipped), then check `gpt-4.1-nano` and `mistral-nemo`'s rows in Adminer for populated `contextWindow`/`providerDescription`/`releaseDate` and a new `ModelPrice` row if their price differs from the old placeholder/seed values.

- [ ] **Step 6: Manually verify the leaderboard UI**

Start the frontend against a backend with the above data, visit `/leaderboard`, and confirm `gpt-4.1-nano`'s and `mistral-nemo`'s rows show the new stats-based description, and that `/leaderboard/gpt-4.1-nano` shows the OpenRouter provider description paragraph.
