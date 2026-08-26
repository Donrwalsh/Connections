# Google AI Studio Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google AI Studio (Gemini) as a third fully benchmarked LLM provider — `llm-google` — alongside the existing `llm-openai` and `llm-ollama` strategies, with its own queue, concurrency, two registered models, and OpenRouter-sourced metadata/pricing.

**Architecture:** `ModelProvider` (orchestrator) and the provider-resolution ternaries (backend) widen from a 2-way to a 3-way choice, following the exact shape OpenAI/Ollama already use. `@ai-sdk/google`'s `createGoogleGenerativeAI` supplies the language model, keyed off `GOOGLE_API_KEY`. A new BullMQ queue (`llm-google-runs`) and concurrency setting keep Google runs from blocking OpenAI/Ollama runs. Two `SupportedModel` rows are added with `openRouterSlug` pre-mapped, so the existing daily `ModelMetadataRefreshService` populates their context window, pricing, and description — no hand-written `ModelPrice` row.

**Tech Stack:** NestJS + TypeORM + BullMQ + Jest (backend), Hono + Zod + Vercel AI SDK + Vitest (orchestrator), React + Vitest + Testing Library (frontend).

**Spec:** [docs/superpowers/specs/2026-08-26-google-ai-studio-support-design.md](../specs/2026-08-26-google-ai-studio-support-design.md)

## Global Constraints

- Two models only, this pass: `gemini-2.5-flash` (default) and `gemini-2.5-flash-lite`.
- `openRouterSlug` values are pre-verified live on OpenRouter — `google/gemini-2.5-flash` and `google/gemini-2.5-flash-lite` — do not re-verify or change them.
- `freeTier` stays `null` for both rows — no automated free-tier usage tracking in this pass (spec non-goal).
- No Vertex AI / GCP service-account auth — Google AI Studio API key only (`GOOGLE_API_KEY`), via `@ai-sdk/google`'s `createGoogleGenerativeAI`.
- `@ai-sdk/google` pinned to `^4.0.0`, matching `@ai-sdk/openai`'s existing major version in `orchestrator/package.json`.
- `contextWindow` is accepted by the google branch of `getModel`/wherever it's threaded through, for signature consistency with the ollama branch, but has no effect — Gemini has no `num_ctx`-equivalent per-call setting.
- Every new piece of logic follows this repo's TDD workflow: failing test first, watch it fail, minimal implementation, watch it pass.
- Backend tests run via `npm test` from `backend/`; orchestrator tests via `npm test` from `orchestrator/`; frontend tests via `npm test` from `frontend/`.

---

## Task 1: Orchestrator — add the Google provider to `provider.ts`

**Files:**
- Modify: `orchestrator/package.json`
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Produces: `ModelProvider` gains `"google"`. `DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash"`. `getModel(provider, modelOverride?, contextWindow?)` and `getModelName(provider, modelOverride?)` both handle `provider === "google"`. `defaultProvider()` recognizes `MODEL_PROVIDER=google`.

- [ ] **Step 1: Add the dependency**

In `orchestrator/package.json`, add to `dependencies` (alphabetical, alongside the other `@ai-sdk/*` packages):

```json
    "@ai-sdk/google": "^4.0.0",
```

Run (from `orchestrator/`): `npm install`

- [ ] **Step 2: Write the failing tests**

Add to `orchestrator/src/provider.test.ts`. First, extend the imports and mocks at the top of the file:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultProvider,
  getContextWindow,
  getModel,
  getModelName,
} from "./provider.js";

const createOllamaMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const openaiMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const createGoogleGenerativeAIMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("ai-sdk-ollama", () => ({
  createOllama: createOllamaMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiMock,
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleGenerativeAIMock,
}));
```

Update the `getModel` describe block's `afterEach` to also clear the new mock:

```ts
describe("getModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createOllamaMock.mockClear();
    openaiMock.mockClear();
    createGoogleGenerativeAIMock.mockClear();
  });
```

Then add these tests inside the `describe("getModel", ...)` block, after the existing "uses the model override instead of OLLAMA_MODEL" test:

```ts
  it("resolves the Google model without num_ctx", () => {
    getModel("google");

    expect(createGoogleGenerativeAIMock).toHaveBeenCalledTimes(1);
    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes GOOGLE_API_KEY to createGoogleGenerativeAI", () => {
    vi.stubEnv("GOOGLE_API_KEY", "test-google-key");

    getModel("google");

    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
  });

  it("uses the model override instead of GOOGLE_MODEL when given", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-2.5-flash-lite");

    getModel("google", "gemini-2.5-pro");

    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-pro");
  });

  it("accepts a contextWindow for google without using it", () => {
    getModel("google", undefined, 1048576);

    const modelFactory = createGoogleGenerativeAIMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-flash");
  });
```

Then add these tests inside `describe("getModelName", ...)`, after the existing "prefers the model override over the env var" test:

```ts
  it("returns the configured Google model for the google provider", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-2.5-flash-lite");
    expect(getModelName("google")).toBe("gemini-2.5-flash-lite");
  });

  it("falls back to the Google default when unset", () => {
    expect(getModelName("google")).toBe("gemini-2.5-flash");
  });

  it("prefers the model override over GOOGLE_MODEL", () => {
    vi.stubEnv("GOOGLE_MODEL", "gemini-2.5-flash-lite");
    expect(getModelName("google", "gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });
```

Then add this test inside `describe("defaultProvider", ...)`, after the existing "returns ollama when MODEL_PROVIDER is set to ollama" test:

```ts
  it("returns google when MODEL_PROVIDER is set to google", () => {
    vi.stubEnv("MODEL_PROVIDER", "google");
    expect(defaultProvider()).toBe("google");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `orchestrator/`): `npm test -- provider.test.ts`
Expected: FAIL — `getModel("google")`/`getModelName("google")` don't recognize `"google"` as a `ModelProvider` (TypeScript compile error) and `defaultProvider` never returns `"google"`.

- [ ] **Step 4: Implement the google branch**

In `orchestrator/src/provider.ts`:

```ts
import { openai } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-nano";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
export const DEFAULT_CONTEXT_WINDOW = 8192;

export type ModelProvider = "openai" | "ollama" | "google";

/**
 * Resolves the default model provider from the MODEL_PROVIDER env var.
 * Defaults to OpenAI to keep existing behavior unchanged; set it to
 * "ollama" to run models locally against the bundled Ollama service, or
 * "google" to call Google AI Studio's Gemini models.
 *
 * Unlike the strategy runs (which select their provider explicitly by
 * strategy name), this default is only used for provider-less requests —
 * e.g. the in-game AI Assist endpoint.
 */
export function defaultProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase();
  if (provider === "ollama") return "ollama";
  if (provider === "google") return "google";
  return "openai";
}
```

Update `getModel`'s doc comment and body to add the google branch (insert the `if (provider === "google")` block between the existing `ollama` block and the final `return openai(...)`):

```ts
/**
 * Returns the AI SDK language model for the given provider.
 * All three providers are exposed through the same LanguageModel interface,
 * so solver.ts (and any future callers) never need to know which backend is
 * active. Config is read on every call so a restart isn't needed to flip
 * providers in development.
 *
 * `modelOverride` names the exact model to call — set on every strategy-run
 * call (the backend validates it against SupportedModel first), omitted on
 * the provider-less /diagnose AI Assist path, which falls back to the
 * env-configured default. `contextWindow` overrides MODEL_CONTEXT_WINDOW for
 * Ollama's num_ctx only — Google has no per-call context-window setting, so
 * it's accepted here for signature consistency but unused.
 */
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

  if (provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
    return google(modelOverride ?? process.env.GOOGLE_MODEL ?? DEFAULT_GOOGLE_MODEL);
  }

  return openai(modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
}
```

Update `getModelName`:

```ts
/**
 * Returns the model name that will be (or was) used for the given provider —
 * `modelOverride` if given, else OPENAI_MODEL/OLLAMA_MODEL/GOOGLE_MODEL.
 * Unlike `result.response.modelId` this is known even for a failed call, so
 * per-prompt telemetry can always name the model the prompt was sent to.
 */
export function getModelName(provider: ModelProvider, modelOverride?: string): string {
  if (provider === "ollama") {
    return modelOverride ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  }
  if (provider === "google") {
    return modelOverride ?? process.env.GOOGLE_MODEL ?? DEFAULT_GOOGLE_MODEL;
  }
  return modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}
```

`getContextWindow()` is unchanged — it's Ollama-specific and google never calls it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- provider.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/package.json orchestrator/package-lock.json orchestrator/src/provider.ts orchestrator/src/provider.test.ts
git commit -m "feat: add Google AI Studio as a provider in provider.ts"
```

---

## Task 2: Orchestrator — accept `"google"` in the `/solve-assist` provider schema

**Files:**
- Modify: `orchestrator/src/types.ts`
- Modify: `orchestrator/src/app.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` (Task 1) — `SolveAssistRequestSchema`'s `provider` enum must accept every value `ModelProvider` allows.
- Produces: `POST /solve-assist` accepts `provider: "google"` (currently rejects it with 400, same as any other unrecognized string).

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/src/app.test.ts`, inside `describe("POST /solve-assist", ...)`, after the existing "rejects an unknown provider value" test:

```ts
    it("accepts google as a provider value", async () => {
      solveAssistMock.mockResolvedValueOnce({
        response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
        groups: [["AAAA", "BBBB", "CCCC", "DDDD"]],
        proposals: [],
        model: "gemini-2.5-flash",
        latencyMs: 5,
      });

      const res = await solveAssistRequest({
        messages: SOLVE_ASSIST_BODY.messages,
        model: "gemini-2.5-flash",
        provider: "google",
      });

      expect(res.status).toBe(200);
      expect(solveAssistMock).toHaveBeenCalledWith(
        SOLVE_ASSIST_BODY.messages,
        "gemini-2.5-flash",
        "google",
        undefined,
        expect.any(AbortSignal),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npm test -- app.test.ts`
Expected: FAIL — `res.status` is `400` (Zod rejects `"google"` — not in the current `z.enum(["openai", "ollama"])`).

- [ ] **Step 3: Widen the schema**

In `orchestrator/src/types.ts`, in `SolveAssistRequestSchema`:

```ts
  provider: z
    .enum(["openai", "ollama", "google"])
    .optional()
    .describe("Provider to call, overriding MODEL_PROVIDER"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- app.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/types.ts orchestrator/src/app.test.ts
git commit -m "feat: accept google as a solve-assist provider value"
```

---

## Task 3: Backend — register `llm-google` in `strategies.ts`

**Files:**
- Modify: `backend/src/strategies.ts`
- Modify: `backend/src/strategies.spec.ts`

**Interfaces:**
- Produces: `LLM_GOOGLE = "llm-google"`. `SUPPORTED_STRATEGIES`/`LLM_STRATEGIES` include it. `DEFAULT_LLM_GOOGLE_CONCURRENCY = 1`. `llmGoogleConcurrency(env?): number`.

- [ ] **Step 1: Write the failing tests**

Add `llmGoogleConcurrency` and `DEFAULT_LLM_GOOGLE_CONCURRENCY` to the import block at the top of `backend/src/strategies.spec.ts`:

```ts
import {
  AUTOMATIC_STRATEGIES,
  DEFAULT_LLM_MAX_DUPLICATE_GUESSES,
  DEFAULT_LLM_MAX_FAILED_GUESSES,
  DEFAULT_LLM_MAX_MALFORMED_RESPONSES,
  DEFAULT_LLM_MAX_MODEL_ERRORS,
  DEFAULT_LLM_MAX_PROMPTS,
  DEFAULT_LLM_NUM_RESPONSES,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TRIALS_PER_MODEL,
  DEFAULT_LLM_OPENAI_CONCURRENCY,
  DEFAULT_LLM_OLLAMA_CONCURRENCY,
  DEFAULT_LLM_GOOGLE_CONCURRENCY,
  DEFAULT_SHUFFLE_TRIALS,
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_STRATEGIES,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmMaxPrompts,
  llmNumResponses,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmGoogleConcurrency,
  llmTemperature,
  llmMaxTrialsPerModel,
  shuffleTrialCount,
  strategyTrialNumbers,
  SUPPORTED_STRATEGIES,
  STRATEGY_SET,
  workerRole,
} from "./strategies";
```

Add a new describe block, right after `describe("llmOllamaConcurrency", ...)`:

```ts
  describe("llmGoogleConcurrency", () => {
    it("should default when the env var is missing", () => {
      expect(llmGoogleConcurrency({})).toBe(DEFAULT_LLM_GOOGLE_CONCURRENCY);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "abc" })).toBe(
        DEFAULT_LLM_GOOGLE_CONCURRENCY,
      );
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "0" })).toBe(
        DEFAULT_LLM_GOOGLE_CONCURRENCY,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "4" })).toBe(4);
    });
  });
```

Update `describe("isLlmStrategy", ...)`'s first test to also check `LLM_GOOGLE`:

```ts
  describe("isLlmStrategy", () => {
    it("should identify all three LLM strategies", () => {
      expect(isLlmStrategy(LLM_OPENAI)).toBe(true);
      expect(isLlmStrategy(LLM_OLLAMA)).toBe(true);
      expect(isLlmStrategy(LLM_GOOGLE)).toBe(true);
    });

    it("should reject non-LLM strategies", () => {
      expect(isLlmStrategy("alphabetical")).toBe(false);
      expect(isLlmStrategy("llm")).toBe(false);
    });
  });
```

(`AUTOMATIC_STRATEGIES`'s existing tests already iterate `LLM_STRATEGIES`/`SUPPORTED_STRATEGIES` generically, so they cover `llm-google` automatically once it's added — no change needed there. Same for `strategyTrialNumbers`'s "should return 1..N for each LLM strategy" test.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- strategies.spec.ts`
Expected: FAIL — `llmGoogleConcurrency`/`DEFAULT_LLM_GOOGLE_CONCURRENCY`/`LLM_GOOGLE` don't exist yet (import/compile error).

- [ ] **Step 3: Implement**

In `backend/src/strategies.ts`, update the strategy list and constants:

```ts
export const SUPPORTED_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
  "shuffle-smart",
  "shuffle-foolish",
  "llm-openai",
  "llm-ollama",
  "llm-google",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

export const SHUFFLE_SMART = "shuffle-smart" as const;
export const SHUFFLE_FOOLISH = "shuffle-foolish" as const;
export const LLM_OPENAI = "llm-openai" as const;
export const LLM_OLLAMA = "llm-ollama" as const;
export const LLM_GOOGLE = "llm-google" as const;

export const LLM_STRATEGIES = [LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE] as const;
```

Add the concurrency default next to the existing two (near `DEFAULT_LLM_OLLAMA_CONCURRENCY`):

```ts
export const DEFAULT_LLM_OPENAI_CONCURRENCY = 1;
export const DEFAULT_LLM_OLLAMA_CONCURRENCY = 1;
export const DEFAULT_LLM_GOOGLE_CONCURRENCY = 1;
```

Add the function next to `llmOllamaConcurrency`:

```ts
/**
 * How many llm-google runs the worker may process at once, from
 * LLM_GOOGLE_CONCURRENCY. Falls back to DEFAULT_LLM_GOOGLE_CONCURRENCY for
 * missing/invalid values.
 */
export function llmGoogleConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_GOOGLE_CONCURRENCY, DEFAULT_LLM_GOOGLE_CONCURRENCY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- strategies.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts
git commit -m "feat: register llm-google as a supported strategy"
```

---

## Task 4: Backend — widen `OrchestratorService.solveAssist`'s provider type

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Modify: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `solveAssist(messages, model?, provider?: "openai" | "ollama" | "google", contextWindow?)`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/modules/strategy/orchestrator.service.spec.ts`, after the existing "should include contextWindow in the request body when given" test:

```ts
  it("should include the google provider in the request body when given", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    await service.solveAssist(messages, "gemini-2.5-flash", "google");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://orchestrator.test/solve-assist",
      expect.objectContaining({
        body: JSON.stringify({
          messages,
          model: "gemini-2.5-flash",
          provider: "google",
        }),
      }),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- orchestrator.service.spec.ts`
Expected: FAIL — TypeScript compile error: `"google"` is not assignable to `"openai" | "ollama"`.

- [ ] **Step 3: Widen the type**

In `backend/src/modules/strategy/orchestrator.service.ts`, update `solveAssist`'s signature (and its doc comment's parameter description, which already refers to provider generically — no wording change needed):

```ts
  async solveAssist(
    messages: ChatMessage[],
    model?: string,
    provider?: "openai" | "ollama" | "google",
    contextWindow?: number | null,
  ): Promise<SolveAssistOutcome> {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrator.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat: widen OrchestratorService.solveAssist's provider type for google"
```

---

## Task 5: Backend — resolve `llm-google` to the google provider in `LlmStrategyRunner`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `LLM_GOOGLE` (Task 3), the widened `solveAssist` provider type (Task 4).
- Produces: `runLlmStrategy` resolves `provider = "google"` for the `"llm-google"` strategy.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, after the existing "should consult the Ollama provider for the llm-ollama strategy" test:

```ts
    it("should consult the Google provider for the llm-google strategy", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm-google" }));
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      await runner.runLlmStrategy(100, "llm-google", 0, "gemini-2.5-flash");

      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(1);
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledWith(
        expect.any(Array),
        "gemini-2.5-flash",
        "google",
        null,
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- llm-strategy-runner.service.spec.ts`
Expected: FAIL — `solveAssist` was called with `"openai"` instead of `"google"` (the current ternary treats every non-ollama strategy as openai).

- [ ] **Step 3: Update the provider resolution and import**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, add `LLM_GOOGLE` to the existing import from `"../../strategies"`:

```ts
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmTemperature,
} from "../../strategies";
```

Update the provider resolution line inside `runLlmStrategy`:

```ts
    // The strategy name alone determines the provider (there's no per-run
    // choice of provider today, only of model within it) — resolved once so
    // every orchestrator call for this run tells it which client to use.
    const provider =
      strategyName === LLM_OLLAMA ? "ollama" : strategyName === LLM_GOOGLE ? "google" : "openai";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- llm-strategy-runner.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: resolve llm-google to the google provider in LlmStrategyRunner"
```

---

## Task 6: Backend — add the `llm-google-runs` worker queue

**Files:**
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `LLM_GOOGLE`, `llmGoogleConcurrency` (Task 3).
- Produces: a `llm-google-runs` BullMQ worker, created alongside `llm-openai-runs` in the `role !== "ollama"` branch.

Following this repo's existing convention, `worker.ts` has no dedicated unit test — its logic is proven by the module compiling, `LlmStrategyRunner`'s own tests (Task 5) covering what actually runs a job, and manual verification against a running worker.

- [ ] **Step 1: Update the strategies import**

In `backend/src/worker.ts`, update the import from `"./strategies"`:

```ts
import {
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmGoogleConcurrency,
  STRATEGY_SET,
  workerRole,
} from "./strategies";
```

- [ ] **Step 2: Widen `createLlmWorker`'s queueName type**

```ts
  const createLlmWorker = (
    queueName: "llm-openai-runs" | "llm-ollama-runs" | "llm-google-runs",
    expectedStrategy: string,
    concurrency: number,
  ) => {
```

- [ ] **Step 3: Add the queue**

Immediately after the existing `llmOpenAIWorker` block (which pushes `"llm-openai-runs"` onto `activeQueueNames`, still inside the `if (role !== "ollama")` branch), add:

```ts
    const llmGoogleWorker = createLlmWorker(
      "llm-google-runs",
      LLM_GOOGLE,
      llmGoogleConcurrency(),
    );
    activeWorkers.push(llmGoogleWorker);
    activeQueueNames.push("llm-google-runs");
```

- [ ] **Step 4: Verify the backend still builds**

Run (from `backend/`): `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/worker.ts
git commit -m "feat: add the llm-google-runs worker queue"
```

---

## Task 7: Backend — migration registering the two Gemini models

**Files:**
- Create: `backend/src/migrations/1774000000000-add-google-models.ts`

**Interfaces:**
- Produces: two new `SupportedModel` rows — `('llm-google', 'gemini-2.5-flash', true)` and `('llm-google', 'gemini-2.5-flash-lite', true)` — both with `openRouterSlug` set and `freeTier` left `null`.

This is a schema-plus-data migration with no hand-written `ModelPrice` row (unlike the original OpenAI migrations, which predate the OpenRouter metadata refresh) — both models are pre-mapped to a verified-live `openRouterSlug`, so `ModelMetadataRefreshService` populates `contextWindow`/`paramCount`/`providerDescription`/`releaseDate` and the first `ModelPrice` row itself on its next run. Per this repo's convention, migrations aren't unit-tested — verify by running it against a real database.

- [ ] **Step 1: Write the migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the two Google AI Studio models this pass supports —
 * gemini-2.5-flash and gemini-2.5-flash-lite — for the llm-google strategy.
 * Both openRouterSlug values were confirmed live via
 * GET https://openrouter.ai/api/v1/models/{slug}/endpoints (non-empty
 * endpoints array, real pricing) as of this migration's authoring, per this
 * repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts). No ModelPrice row is
 * inserted here — being pre-mapped, both models get their first price
 * (along with contextWindow/paramCount/providerDescription/releaseDate)
 * from ModelMetadataRefreshService's next run rather than a hand-entered
 * value. Trigger POST /dispatch/refresh-model-metadata once after this
 * migration deploys, so the models aren't left blank until the next daily
 * cron tick.
 */
export class AddGoogleModels1774000000000 implements MigrationInterface {
  name = "AddGoogleModels1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-google', 'gemini-2.5-flash', true, 'google/gemini-2.5-flash'),
        ('llm-google', 'gemini-2.5-flash-lite', true, 'google/gemini-2.5-flash-lite')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-google'
        AND "modelName" IN ('gemini-2.5-flash', 'gemini-2.5-flash-lite')
    `);
  }
}
```

- [ ] **Step 2: Run the migration against a real database**

Run (from `backend/`): `npm run migration:run` (or however this repo runs pending migrations locally — check `package.json`'s scripts if the exact command differs).
Expected: migration applies cleanly; `SELECT * FROM "SupportedModel" WHERE "strategyName" = 'llm-google'` returns both rows with `openRouterSlug` set and `contextWindow`/`paramCount`/etc. still `null` (not yet refreshed).

- [ ] **Step 3: Commit**

```bash
git add backend/src/migrations/1774000000000-add-google-models.ts
git commit -m "feat: register gemini-2.5-flash and gemini-2.5-flash-lite"
```

---

## Task 8: Frontend — `GuessSequencePanel.tsx` Google tab

**Files:**
- Modify: `frontend/src/components/GuessSequencePanel.tsx`
- Modify: `frontend/src/components/__tests__/GuessSequencePanel.test.tsx`

**Interfaces:**
- Produces: the panel's strategy tab list includes an `"llm-google"` entry labeled `"LLM · Google"`, and `formatStrategyName("llm-google")` returns the same label.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/__tests__/GuessSequencePanel.test.tsx`, after the existing "shows LLM runs and renders duplicate + terminal statuses" test:

```ts
  it("shows the Google LLM tab with its own label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const urlStr = String(url);
        const strategyId =
          urlStr.match(/\/strategy\/([^/]+)\//)?.[1] ?? "alphabetical";
        if (urlStr.includes("/run/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 41,
              strategyName: "llm-google",
              trialNumber: 1,
              status: "completed",
              modelName: "gemini-2.5-flash",
              contextWindow: 1048576,
              startedAt: "2024-01-15T00:00:00Z",
              finishedAt: "2024-01-15T00:05:00Z",
              guessCount: 1,
              meta: { total: 1, page: 1, limit: 200 },
              guesses: [
                {
                  sequenceNumber: 1,
                  words: ["APPLE", "BANANA", "CHERRY", "DATE"],
                  result: "success",
                  guessedAt: "2024-01-15T00:00:00Z",
                },
              ],
            }),
          });
        }
        if (strategyId !== "llm-google") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 41,
              strategyName: "llm-google",
              trialNumber: 1,
              status: "completed",
              modelName: "gemini-2.5-flash",
              contextWindow: 1048576,
              guessCount: 1,
            },
          ],
        });
      }),
    );

    renderWithRouter(
      <GuessSequencePanel
        date="2024-01-15"
        puzzleId={100}
        isOpen={true}
        onToggle={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Show LLM · Google/ }),
    );

    expect(
      await screen.findByText(
        "Strategy: LLM · Google · Model: gemini-2.5-flash (1,048,576 ctx) · Status: completed · 1 guess",
      ),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- GuessSequencePanel.test.tsx`
Expected: FAIL — there is no `"Show LLM · Google"` button (no `"llm-google"` entry in `STRATEGIES`).

- [ ] **Step 3: Implement**

In `frontend/src/components/GuessSequencePanel.tsx`, update the `STRATEGIES` list:

```ts
const STRATEGIES = [
  { id: "alphabetical", label: "Alphabetical" },
  { id: "reverse-alphabetical", label: "Rev-Alphabetical" },
  { id: "order", label: "Order" },
  { id: "reverse-order", label: "Rev-Order" },
  { id: "shuffle-smart", label: "Shuffle-Smart" },
  { id: "shuffle-foolish", label: "Shuffle-Foolish" },
  { id: "llm-openai", label: "LLM · OpenAI" },
  { id: "llm-ollama", label: "LLM · Ollama" },
  { id: "llm-google", label: "LLM · Google" },
];
```

And `formatStrategyName`:

```ts
function formatStrategyName(strategyName: string): string {
  if (strategyName === "llm-openai") return "LLM · OpenAI";
  if (strategyName === "llm-ollama") return "LLM · Ollama";
  if (strategyName === "llm-google") return "LLM · Google";
  return strategyName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- GuessSequencePanel.test.tsx`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GuessSequencePanel.tsx frontend/src/components/__tests__/GuessSequencePanel.test.tsx
git commit -m "feat: add the Google LLM tab to GuessSequencePanel"
```

---

## Task 9: Frontend — `describeLeaderboardRow`'s Google provider label

**Files:**
- Modify: `frontend/src/data/benchmark/mockData.ts`
- Modify: `frontend/src/data/benchmark/mockData.test.ts`

**Interfaces:**
- Produces: `describeLeaderboardRow` labels an `"llm-google"` row's provider as `"Google"`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/data/benchmark/mockData.test.ts`, after the existing "labels the provider correctly for an Ollama row" test:

```ts
  it("labels the provider correctly for a Google row", () => {
    const row = makeLlmRow({
      id: "gemini-2.5-flash",
      strategyName: "llm-google",
      modelName: "gemini-2.5-flash",
      contextWindow: 1048576,
      paramCount: null,
    });

    const { description } = describeLeaderboardRow(row);

    expect(description).toBe("Google gemini-2.5-flash · 1049K context");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- mockData.test.ts`
Expected: FAIL — `description` starts with `"OpenAI"` (the current ternary treats every non-ollama strategy as OpenAI).

- [ ] **Step 3: Implement**

In `frontend/src/data/benchmark/mockData.ts`, update `describeLeaderboardRow`'s provider label:

```ts
  if (row.kind === "llm") {
    const providerLabel =
      row.strategyName === "llm-ollama"
        ? "Ollama"
        : row.strategyName === "llm-google"
          ? "Google"
          : "OpenAI";
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mockData.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data/benchmark/mockData.ts frontend/src/data/benchmark/mockData.test.ts
git commit -m "feat: label Google's leaderboard rows correctly"
```

---

## Task 10: Frontend — `useStrategyMeta`'s Google provider label

**Files:**
- Modify: `frontend/src/data/benchmark/useStrategyMeta.ts`
- Modify: `frontend/src/data/benchmark/useStrategyMeta.test.ts`

**Interfaces:**
- Produces: `buildDynamicMeta` labels an `"llm-google"` model's provider as `"Google"`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/data/benchmark/useStrategyMeta.test.ts`, after the existing "resolves an LLM row's description from live model data..." test:

```ts
  it("resolves a Google model's provider label correctly", async () => {
    stubModelsFetch([
      {
        id: 2,
        strategyName: "llm-google",
        modelName: "gemini-2.5-flash",
        inputCostPerMillionTokens: 0.3,
        outputCostPerMillionTokens: 2.5,
        supported: true,
        contextWindow: 1048576,
        paramCount: null,
        providerDescription: null,
        releaseDate: null,
      },
    ]);

    const { result } = renderHook(() => useStrategyMeta("gemini-2.5-flash"));

    await waitFor(() => {
      expect(result.current.meta?.description).toBe("Google gemini-2.5-flash · 1049K context");
    });

    expect(result.current.meta?.name).toBe("LLM · gemini-2.5-flash");
    expect(result.current.meta?.strategyName).toBe("llm-google");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- useStrategyMeta.test.ts`
Expected: FAIL — `description` starts with `"OpenAI"` (the current ternary treats every non-ollama strategy as OpenAI).

- [ ] **Step 3: Implement**

In `frontend/src/data/benchmark/useStrategyMeta.ts`, update `buildDynamicMeta`'s provider label:

```ts
function buildDynamicMeta(model: SupportedModelRecord): StrategyMeta {
  const providerLabel =
    model.strategyName === "llm-ollama"
      ? "Ollama"
      : model.strategyName === "llm-google"
        ? "Google"
        : "OpenAI";
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- useStrategyMeta.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data/benchmark/useStrategyMeta.ts frontend/src/data/benchmark/useStrategyMeta.test.ts
git commit -m "feat: label Google models' provider correctly in useStrategyMeta"
```

---

## Task 11: Config — env vars, compose, and README

**Files:**
- Modify: `.env.sample`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `GOOGLE_API_KEY`, `GOOGLE_MODEL`, `LLM_GOOGLE_CONCURRENCY` (read by Task 1's `provider.ts` and Task 3's `strategies.ts`).
- Produces: no code interface — documentation and container config only. No test; verified by reading the diff and (optionally) booting `docker compose up` locally with a real `GOOGLE_API_KEY`.

- [ ] **Step 1: Update `.env.sample`**

Update the `MODEL_PROVIDER` comment block and add `GOOGLE_API_KEY`/`GOOGLE_MODEL` right after the existing `OPENAI_API_KEY`/`OPENAI_MODEL` entries:

```
# OpenAI API key (used by @ai-sdk/openai in the orchestrator)
OPENAI_API_KEY=

# Google AI Studio API key (used by @ai-sdk/google in the orchestrator)
GOOGLE_API_KEY=

# Default AI model provider for requests that don't specify one — i.e. the
# in-game AI Assist endpoint. Strategy runs always select their own provider
# via the strategy name: 'llm-openai' consults OpenAI, 'llm-ollama' the
# bundled Ollama service, 'llm-google' Google AI Studio. All three providers
# are always configured and can be used simultaneously.
MODEL_PROVIDER=openai

# OpenAI model id (used when MODEL_PROVIDER=openai)
OPENAI_MODEL=gpt-4.1-nano

# Google AI Studio model id (used when MODEL_PROVIDER=google)
GOOGLE_MODEL=gemini-2.5-flash

# Context window (in tokens) used to size the LLM solver prompt (default: 8192)
MODEL_CONTEXT_WINDOW=8192
```

Add `LLM_GOOGLE_CONCURRENCY` right after the existing `LLM_OLLAMA_CONCURRENCY` line:

```
LLM_OPENAI_CONCURRENCY=1
LLM_OLLAMA_CONCURRENCY=1
LLM_GOOGLE_CONCURRENCY=1
```

- [ ] **Step 2: Update `docker-compose.yml`**

In the `orchestrator` service's `environment` block, add `GOOGLE_API_KEY` and `GOOGLE_MODEL` right after `OPENAI_MODEL`:

```yaml
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      GOOGLE_API_KEY: ${GOOGLE_API_KEY}
      MODEL_PROVIDER: ${MODEL_PROVIDER:-openai}
      OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4.1-nano}
      GOOGLE_MODEL: ${GOOGLE_MODEL:-gemini-2.5-flash}
      MODEL_CONTEXT_WINDOW: ${MODEL_CONTEXT_WINDOW:-8192}
```

- [ ] **Step 3: Update `README.md`**

In the env var table, update the `MODEL_PROVIDER` row and add `GOOGLE_API_KEY`/`GOOGLE_MODEL`/`LLM_GOOGLE_CONCURRENCY` rows:

```
| `OPENAI_API_KEY` | — | OpenAI API key (orchestrator only) |
| `GOOGLE_API_KEY` | — | Google AI Studio API key (orchestrator only) |
| `MODEL_PROVIDER` | `openai` | Default provider for provider-less requests (e.g. in-game AI Assist): `openai`, `ollama`, or `google`. Strategy runs pick their provider via strategy name (`llm-openai` / `llm-ollama` / `llm-google`), so all three are always active |
| `OPENAI_MODEL` | `gpt-4.1-nano` | OpenAI model id (used by the `llm-openai` strategy and provider-less requests) |
| `GOOGLE_MODEL` | `gemini-2.5-flash` | Google AI Studio model id (used by the `llm-google` strategy and provider-less requests) |
```

And add `LLM_GOOGLE_CONCURRENCY` right after the existing `LLM_OLLAMA_CONCURRENCY` row:

```
| `LLM_OPENAI_CONCURRENCY` | `1` | Maximum `llm-openai` runs the worker processes at once (own queue, so it never blocks Ollama, Google, or the deterministic strategies) |
| `LLM_OLLAMA_CONCURRENCY` | `1` | Maximum `llm-ollama` runs the worker processes at once (own queue, so it never blocks OpenAI, Google, or the deterministic strategies) |
| `LLM_GOOGLE_CONCURRENCY` | `1` | Maximum `llm-google` runs the worker processes at once (own queue, so it never blocks OpenAI, Ollama, or the deterministic strategies) |
```

Also update line 71's setup instructions ("You must set at least `INTERNAL_API_KEY`... and `OPENAI_API_KEY`...") to mention `GOOGLE_API_KEY` is optional but required to actually dispatch `llm-google` runs — add a short clause, e.g.:

```
You must set at least `INTERNAL_API_KEY` (any shared secret) and `OPENAI_API_KEY` (for AI Assist). `GOOGLE_API_KEY` is only required if you plan to dispatch `llm-google` runs. All variables are documented in `.env.sample`.
```

- [ ] **Step 4: Commit**

```bash
git add .env.sample docker-compose.yml README.md
git commit -m "docs: document Google AI Studio configuration"
```
