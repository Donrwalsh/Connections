# NVIDIA NIM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NVIDIA NIM as an eighth LLM provider (`nvidia` / `llm-nvidia`), wired identically in shape to the existing seven, with an initial batch of three seeded models.

**Architecture:** NIM is hosted, OpenAI-compatible, and reached through `@ai-sdk/openai-compatible`'s `createOpenAICompatible` (no dedicated AI SDK package exists for it). It gets a full `PROVIDER_POOLS` row with `freeTier: null` — its own dedicated BullMQ queue/worker, but excluded from every free-tier automation consumer (all of which filter on `freeTier !== null`). The 429 classifier ships as `null` (generic retry handling) since NIM's real rate-limit shape is unverified.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai` v7, provider packages on the v4-generation line), NestJS, BullMQ, TypeORM/Postgres, Vitest.

**Spec:** `docs/specs/2026-09-21-nvidia-nim-provider-design.md`

## Global Constraints

- Provider id: `nvidia`. Strategy name: `llm-nvidia`. Env vars: `NVIDIA_API_KEY`, `NVIDIA_MODEL`, `LLM_NVIDIA_CONCURRENCY`.
- Base URL: `https://integrate.api.nvidia.com/v1`. Default model: `meta/llama-3.3-70b-instruct`.
- AI SDK package: `@ai-sdk/openai-compatible@^3.0.53` (confirmed compatible with this repo's `ai@^7.0.41` / `@ai-sdk/mistral@^4.0.0`-generation stack — all resolve to the same `@ai-sdk/provider@4.0.17` / `@ai-sdk/provider-utils@5.0.45` pair).
- `createOpenAICompatible` MUST be called with `supportsStructuredOutputs: true`, or a schema-bearing call silently downgrades to loose `json_object` mode instead of `json_schema` — unacceptable since this app calls `generateObject` exclusively.
- NVIDIA is a **non-free-tier** pool (`freeTier: null`), same shape as `openai`/`ollama` — it gets no `FreeTierConfig`, no free-dispatch/RPD-resume queues, and needs no entry in `pool-knobs.ts`.
- `RATE_LIMIT_429_CLASSIFIERS.nvidia = null` — do not write a real classifier; NIM's 429 shape is unverified.
- Every "seven providers" reference touched by this plan becomes "eight"; every ordered list of provider ids gets `nvidia` appended at the end (after `ollama`), matching this plan's insertion order everywhere.
- Package manager is npm with root-level workspaces (`orchestrator`, `backend`, `packages/*`) — run `npm install` from the repo root, not inside `orchestrator/`.

---

### Task 1: Orchestrator provider wiring

**Files:**
- Modify: `orchestrator/package.json`
- Modify: `orchestrator/src/provider.ts`
- Test: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Produces: `ModelProvider` union gains `"nvidia"`; `DEFAULT_NVIDIA_MODEL = "meta/llama-3.3-70b-instruct"`; `getModel("nvidia", modelOverride?, contextWindow?)`, `getModelName("nvidia", modelOverride?)`, `defaultProvider()` all handle `"nvidia"`.

- [ ] **Step 1: Add the dependency**

In `orchestrator/package.json`, add a new line to `dependencies` right after `"@ai-sdk/openai": "^4.0.0",`:

```json
    "@ai-sdk/openai-compatible": "^3.0.53",
```

- [ ] **Step 2: Install it**

Run from the repo root: `npm install`
Expected: `package-lock.json` updates to include `@ai-sdk/openai-compatible@3.0.53` (or a compatible patch) and its transitive deps; no other dependency versions change.

- [ ] **Step 3: Write the failing tests**

In `orchestrator/src/provider.test.ts`, add a new hoisted mock next to the existing ones (after `const createSambaNovaMock = vi.hoisted(() => vi.fn(() => vi.fn()));`):

```ts
const createOpenAICompatibleMock = vi.hoisted(() => vi.fn(() => vi.fn()));
```

Add a new `vi.mock` block next to the `sambanova-ai-provider` one:

```ts
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));
```

In the `getModel` describe block's `afterEach`, add `createOpenAICompatibleMock.mockClear();` next to `createSambaNovaMock.mockClear();`.

At the end of the `getModel` describe block (after the `"accepts a contextWindow for sambanova without using it"` test, before its closing `});`), add:

```ts
  it("resolves the Nvidia model without num_ctx", () => {
    getModel("nvidia");

    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    const modelFactory = createOpenAICompatibleMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("meta/llama-3.3-70b-instruct");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes NVIDIA_API_KEY, the NIM base URL, and supportsStructuredOutputs to createOpenAICompatible", () => {
    vi.stubEnv("NVIDIA_API_KEY", "test-nvidia-key");

    getModel("nvidia");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      name: "nvidia",
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: "test-nvidia-key",
      supportsStructuredOutputs: true,
    });
  });

  it("uses the model override instead of NVIDIA_MODEL when given", () => {
    vi.stubEnv("NVIDIA_MODEL", "mistralai/mixtral-8x22b-instruct-v0.1");

    getModel("nvidia", "nvidia/nemotron-3-ultra-550b-a55b");

    const modelFactory = createOpenAICompatibleMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("accepts a contextWindow for nvidia without using it", () => {
    getModel("nvidia", undefined, 262144);

    const modelFactory = createOpenAICompatibleMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("meta/llama-3.3-70b-instruct");
  });
```

In the `getModelName` describe block, after the `"prefers the model override over SAMBANOVA_MODEL"` test, add:

```ts
  it("returns the configured Nvidia model for the nvidia provider", () => {
    vi.stubEnv("NVIDIA_MODEL", "mistralai/mixtral-8x22b-instruct-v0.1");
    expect(getModelName("nvidia")).toBe("mistralai/mixtral-8x22b-instruct-v0.1");
  });

  it("falls back to the Nvidia default when unset", () => {
    expect(getModelName("nvidia")).toBe("meta/llama-3.3-70b-instruct");
  });

  it("prefers the model override over NVIDIA_MODEL", () => {
    vi.stubEnv("NVIDIA_MODEL", "mistralai/mixtral-8x22b-instruct-v0.1");
    expect(getModelName("nvidia", "nvidia/nemotron-3-ultra-550b-a55b")).toBe(
      "nvidia/nemotron-3-ultra-550b-a55b",
    );
  });
```

In the `defaultProvider` describe block, after the `"returns sambanova when MODEL_PROVIDER is set to sambanova"` test, add:

```ts
  it("returns nvidia when MODEL_PROVIDER is set to nvidia", () => {
    vi.stubEnv("MODEL_PROVIDER", "nvidia");
    expect(defaultProvider()).toBe("nvidia");
  });
```

In the `effectiveContextWindow` describe block, after the `"never caps openrouter"` test, add:

```ts
  it("never caps nvidia — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("nvidia", 262144)).toBe(262144);
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd orchestrator && npx vitest run provider.test.ts`
Expected: FAIL — `"nvidia"` is not assignable to `ModelProvider`, and `createOpenAICompatibleMock` is never called (module doesn't exist yet as a real import target in `provider.ts`).

- [ ] **Step 5: Implement the provider wiring**

In `orchestrator/src/provider.ts`, add the import after the SambaNova import (line 7):

```ts
import { createSambaNova } from "sambanova-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
```

Add the default-model constant after `DEFAULT_SAMBANOVA_MODEL` (line 16):

```ts
export const DEFAULT_SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct";
export const DEFAULT_NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";
```

Extend the `ModelProvider` union (lines 22–29):

```ts
export type ModelProvider =
  | "openai"
  | "ollama"
  | "google"
  | "groq"
  | "openrouter"
  | "mistral"
  | "sambanova"
  | "nvidia";
```

In `defaultProvider()`, add a branch before the final `return "openai";` (after line 49):

```ts
  if (provider === "sambanova") return "sambanova";
  if (provider === "nvidia") return "nvidia";
  return "openai";
```

In `getModel()`, add a branch before the final `return openai(...)` (after the `sambanova` block, line 123):

```ts
  if (provider === "nvidia") {
    const nvidia = createOpenAICompatible({
      name: "nvidia",
      baseURL: "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
      // NIM's structured-output support varies by model; this codebase calls
      // generateObject exclusively, so every seeded NIM model must support
      // OpenAI-style json_schema mode — leaving this unset would silently
      // downgrade to the looser, unenforced json_object fallback instead.
      supportsStructuredOutputs: true,
    });
    return nvidia(modelOverride ?? process.env.NVIDIA_MODEL ?? DEFAULT_NVIDIA_MODEL);
  }

  return openai(modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
```

In `getModelName()`, add a branch before the final `return modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;` (after the `sambanova` block, line 168):

```ts
  if (provider === "nvidia") {
    return modelOverride ?? process.env.NVIDIA_MODEL ?? DEFAULT_NVIDIA_MODEL;
  }
  return modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
```

`effectiveContextWindow()` needs no change — it already returns `contextWindow` unchanged for every provider except `"ollama"`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd orchestrator && npx vitest run provider.test.ts`
Expected: PASS, all tests including the new `nvidia` ones.

- [ ] **Step 7: Typecheck**

Run: `cd orchestrator && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/package.json orchestrator/package-lock.json orchestrator/src/provider.ts orchestrator/src/provider.test.ts
git commit -m "feat(orchestrator): add NVIDIA NIM provider wiring"
```

---

### Task 2: Orchestrator 429 classifier placeholder

**Files:**
- Modify: `orchestrator/src/solver.ts:330`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from Task 1 (now includes `"nvidia"`).
- Produces: `RATE_LIMIT_429_CLASSIFIERS` is a total map again (compiles).

- [ ] **Step 1: Write the failing test**

In `orchestrator/src/solver.test.ts`, inside the `describe("classifyModelCallError", ...)` block, add (near the existing `"does not classify a non-google provider's per-day 429 as rate_limited_daily"` test):

```ts
  it("falls back to model_error for nvidia — no classifier configured yet", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: "rate limited" });

    const result = classifyModelCallError(err, "nvidia", { model: "meta/llama-3.3-70b-instruct" });

    expect(result.code).toBe("model_error");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd orchestrator && npx vitest run solver.test.ts`
Expected: FAIL to compile — `RATE_LIMIT_429_CLASSIFIERS` is missing the required `nvidia` key on `Record<ModelProvider, ...>` now that Task 1 added `"nvidia"` to `ModelProvider`.

- [ ] **Step 3: Add the placeholder classifier entry**

In `orchestrator/src/solver.ts`, in the `RATE_LIMIT_429_CLASSIFIERS` object (starts line 330), add `nvidia: null,` next to `openai`/`ollama`:

```ts
const RATE_LIMIT_429_CLASSIFIERS: Record<ModelProvider, RateLimit429Classifier | null> = {
  openai: null,
  ollama: null,
  nvidia: null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd orchestrator && npx vitest run solver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts
git commit -m "feat(orchestrator): treat nvidia 429s as generic model_error for now"
```

---

### Task 3: Backend strategy registration

**Files:**
- Modify: `backend/src/strategies.ts`
- Test: `backend/src/strategies.spec.ts`

**Interfaces:**
- Produces: `LLM_NVIDIA = "llm-nvidia"`; `"llm-nvidia"` is a member of `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`.

- [ ] **Step 1: Write the failing test**

In `backend/src/strategies.spec.ts`, add `LLM_NVIDIA` to the import list from `./strategies` (next to `LLM_SAMBANOVA`), then add a new describe block after the `"LLM_SAMBANOVA membership"` block:

```ts
  describe("LLM_NVIDIA membership", () => {
    it("is a supported LLM strategy", () => {
      expect(SUPPORTED_STRATEGIES).toContain("llm-nvidia");
      expect(isLlmStrategy("llm-nvidia")).toBe(true);
      expect(LLM_STRATEGIES).toContain(LLM_NVIDIA);
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: FAIL — `LLM_NVIDIA` is not exported from `./strategies`.

- [ ] **Step 3: Add the strategy constant**

In `backend/src/strategies.ts`, add `"llm-nvidia"` to `SUPPORTED_STRATEGIES` (line 14, after `"llm-sambanova"`):

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
  "llm-groq",
  "llm-openrouter",
  "llm-mistral",
  "llm-sambanova",
  "llm-nvidia",
] as const;
```

Add the constant after `LLM_SAMBANOVA` (line 29):

```ts
export const LLM_SAMBANOVA = "llm-sambanova" as const;
export const LLM_NVIDIA = "llm-nvidia" as const;
```

Add it to `LLM_STRATEGIES` (line 38):

```ts
export const LLM_STRATEGIES = [
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_OPENROUTER,
  LLM_MISTRAL,
  LLM_SAMBANOVA,
  LLM_NVIDIA,
] as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts
git commit -m "feat(backend): register the llm-nvidia strategy"
```

---

### Task 4: Backend provider-pool row

**Files:**
- Modify: `backend/src/modules/provider-pool/provider-pool.config.ts`
- Test: `backend/src/modules/provider-pool/provider-pool.config.spec.ts`

**Interfaces:**
- Consumes: `LLM_NVIDIA` from Task 3.
- Produces: `ProviderPoolId` includes `"nvidia"`; `PROVIDER_POOLS` has a `nvidia` row with `freeTier: null`, `queues: { runs: "llm-nvidia-runs" }`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/provider-pool/provider-pool.config.spec.ts`, change `NON_FREE_TIER_IDS` (line 14):

```ts
const NON_FREE_TIER_IDS = ["openai", "ollama", "nvidia"];
```

Change the "seven known pools" test (lines 22–33) to eight, with `nvidia` last:

```ts
  it("has exactly the eight known pools, in burn order then non-free-tier", () => {
    expect(PROVIDER_POOLS.map((p) => p.id)).toEqual([
      "google",
      "groq",
      "openrouter",
      "mistral",
      "sambanova",
      "openai",
      "ollama",
      "nvidia",
    ]);
  });
```

The parametrized `%s: id / strategyName / ...` test, the `%s: has no free-tier machinery` test (now run against `NON_FREE_TIER_IDS`), and the `lookups` describe block's `providerPoolById`/`providerPool` tests all already iterate the arrays generically — no further edits needed there, but add one explicit lookup assertion next to the existing `providerPool("llm-mistral")` one in the `lookups` describe block:

```ts
  it("providerPool resolves nvidia to its row", () => {
    expect(providerPool("llm-nvidia")).toBe(byId("nvidia"));
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest provider-pool.config.spec.ts`
Expected: FAIL — `PROVIDER_POOLS` has only seven entries and no `nvidia` id.

- [ ] **Step 3: Add the row**

In `backend/src/modules/provider-pool/provider-pool.config.ts`, add `LLM_NVIDIA` to the import from `"../../strategies"` (line 19–27):

```ts
import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_NVIDIA,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
} from "../../strategies";
```

Extend `ProviderPoolId` (lines 53–60):

```ts
export type ProviderPoolId =
  | "openai"
  | "google"
  | "groq"
  | "openrouter"
  | "mistral"
  | "sambanova"
  | "ollama"
  | "nvidia";
```

Add the row to `PROVIDER_POOLS`, after the `ollama` entry (after line 304, before the closing `];`):

```ts
  {
    id: "ollama",
    label: "Ollama",
    strategyName: LLM_OLLAMA,
    orchestratorProvider: "ollama",
    concurrency: () => intEnv("LLM_OLLAMA_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: { runs: "llm-ollama-runs" },
    freeTier: null,
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    strategyName: LLM_NVIDIA,
    orchestratorProvider: "nvidia",
    concurrency: () => intEnv("LLM_NVIDIA_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: { runs: "llm-nvidia-runs" },
    freeTier: null,
  },
];
```

Update the doc comment above `PROVIDER_POOLS` (lines 145–150) to reflect three non-free-tier pools:

```ts
/**
 * Every pool, ordered google → groq → openrouter → mistral → sambanova (the
 * daily-automation burn order that step 6's loop must reproduce), then the
 * three non-free-tier pools (openai, ollama, nvidia). The UI renders pools in
 * its own order — the parity test compares as an unordered set.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest provider-pool.config.spec.ts`
Expected: PASS. (The "frontend parity" test will still fail until Task 6 adds the matching frontend row — that's expected at this point in the plan.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/provider-pool/provider-pool.config.ts backend/src/modules/provider-pool/provider-pool.config.spec.ts
git commit -m "feat(backend): add the nvidia provider-pool row (no free-tier machinery)"
```

---

### Task 5: Backend queue wiring

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/modules/strategy/strategy-dispatch.service.ts`
- Modify: `backend/src/modules/strategy/strategy-read.service.ts`
- Modify: `backend/src/app.setup.ts`
- Test: `backend/src/modules/queue/strategy.queue.spec.ts`

**Interfaces:**
- Consumes: `LLM_NVIDIA` (Task 3), `ProviderPoolId` including `"nvidia"` (Task 4).
- Produces: `llmNvidiaQueue: Queue` on `"llm-nvidia-runs"`; DI token `LLM_NVIDIA_QUEUE`; `nvidia` present in every `runsQueueByPool` map.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/queue/strategy.queue.spec.ts`, add `LLM_NVIDIA` to the import from `"../../strategies"`, add a `nvidia` fixture and map entry, and extend both routing tests:

```ts
import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_NVIDIA,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
} from "../../strategies";
```

```ts
const sambanova = { name: "sambanova" } as never;
const nvidia = { name: "nvidia" } as never;
const shared = { name: "shared" } as never;

const runsQueueByPool = new Map<ProviderPoolId, Queue>([
  ["openai", openai],
  ["ollama", ollama],
  ["google", google],
  ["groq", groq],
  ["openrouter", openrouter],
  ["mistral", mistral],
  ["sambanova", sambanova],
  ["nvidia", nvidia],
]);
```

In `describe("queueForStrategy", ...)`, add a line to the first test:

```ts
    expect(queueForStrategy(runsQueueByPool, shared, LLM_SAMBANOVA)).toBe(sambanova);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_NVIDIA)).toBe(nvidia);
    expect(queueForStrategy(runsQueueByPool, shared, "alphabetical")).toBe(shared);
```

In `describe("queueForJudgeProvider", ...)`, add a line to the first test:

```ts
    expect(queueForJudgeProvider("sambanova", runsQueueByPool)).toBe(sambanova);
    expect(queueForJudgeProvider("nvidia", runsQueueByPool)).toBe(nvidia);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: FAIL — `LLM_NVIDIA` doesn't exist yet at this import (it does, from Task 3 — this will actually pass compilation; the failure is the two new assertions throwing since `queueForStrategy`/`queueForJudgeProvider` behavior is already generic and map-driven). Confirm the two new assertions fail (they will, trivially, only if the map or constant were wrong — if Task 3/4 are already done this step may in fact pass immediately; if so, skip ahead noting it as a currently-passing regression check rather than a red step).

- [ ] **Step 3: Add the queue export**

In `backend/src/modules/queue/strategy.queue.ts`, add after the `llmSambaNovaQueue` export (line 90):

```ts
export const llmNvidiaQueue = new Queue("llm-nvidia-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

- [ ] **Step 4: Wire the DI token and maps**

In `backend/src/modules/queue/queue.module.ts`:

Add `llmNvidiaQueue` to the import from `"./strategy.queue"` (line 4–13):

```ts
import {
  strategyQueue,
  llmOpenAIQueue,
  llmOllamaQueue,
  llmGoogleQueue,
  llmGroqQueue,
  llmOpenRouterQueue,
  llmMistralQueue,
  llmSambaNovaQueue,
  llmNvidiaQueue,
} from "./strategy.queue";
```

Add the token constant after `LLM_SAMBANOVA_QUEUE` (line 36):

```ts
export const LLM_SAMBANOVA_QUEUE = "LLM_SAMBANOVA_QUEUE";
export const LLM_NVIDIA_QUEUE = "LLM_NVIDIA_QUEUE";
```

Add it to `runsQueueByPool` (line 62–70):

```ts
const runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue> = new Map([
  ["openai", llmOpenAIQueue],
  ["ollama", llmOllamaQueue],
  ["google", llmGoogleQueue],
  ["groq", llmGroqQueue],
  ["openrouter", llmOpenRouterQueue],
  ["mistral", llmMistralQueue],
  ["sambanova", llmSambaNovaQueue],
  ["nvidia", llmNvidiaQueue],
]);
```

Add it to the `providers` array (after line 97) and the `exports` array (after line 124):

```ts
    { provide: LLM_SAMBANOVA_QUEUE, useValue: llmSambaNovaQueue },
    { provide: LLM_NVIDIA_QUEUE, useValue: llmNvidiaQueue },
```

```ts
    LLM_SAMBANOVA_QUEUE,
    LLM_NVIDIA_QUEUE,
```

- [ ] **Step 5: Inject it into StrategyDispatch**

In `backend/src/modules/strategy/strategy-dispatch.service.ts`, add `LLM_NVIDIA_QUEUE` to the import from `"../queue/queue.module"` (line 3–12):

```ts
import {
  STRATEGY_QUEUE,
  LLM_OPENAI_QUEUE,
  LLM_OLLAMA_QUEUE,
  LLM_GOOGLE_QUEUE,
  LLM_GROQ_QUEUE,
  LLM_OPENROUTER_QUEUE,
  LLM_MISTRAL_QUEUE,
  LLM_SAMBANOVA_QUEUE,
  LLM_NVIDIA_QUEUE,
} from "../queue/queue.module";
```

Add the constructor parameter after `llmSambaNovaQueue` (line 52):

```ts
    @Inject(LLM_SAMBANOVA_QUEUE) private readonly llmSambaNovaQueue: Queue,
    @Inject(LLM_NVIDIA_QUEUE) private readonly llmNvidiaQueue: Queue,
```

Add it to the `runsQueueByPool` map built in `queueFor()` (line 71–79):

```ts
    this.runsQueueByPool ??= new Map<ProviderPoolId, Queue>([
      ["openai", this.llmOpenAIQueue],
      ["ollama", this.llmOllamaQueue],
      ["google", this.llmGoogleQueue],
      ["groq", this.llmGroqQueue],
      ["openrouter", this.llmOpenRouterQueue],
      ["mistral", this.llmMistralQueue],
      ["sambanova", this.llmSambaNovaQueue],
      ["nvidia", this.llmNvidiaQueue],
    ]);
```

- [ ] **Step 6: Inject it into RunHistoryReadModel**

In `backend/src/modules/strategy/strategy-read.service.ts`, add `LLM_NVIDIA_QUEUE` to the import from `"../queue/queue.module"` (line 3–12), add the constructor parameter after `llmSambaNovaQueue` (line 221), and add `this.llmNvidiaQueue,` to the `queues` array in `queuedCountsByKey()` (line 627–636):

```ts
import {
  STRATEGY_QUEUE,
  LLM_OPENAI_QUEUE,
  LLM_OLLAMA_QUEUE,
  LLM_GOOGLE_QUEUE,
  LLM_GROQ_QUEUE,
  LLM_OPENROUTER_QUEUE,
  LLM_MISTRAL_QUEUE,
  LLM_SAMBANOVA_QUEUE,
  LLM_NVIDIA_QUEUE,
} from "../queue/queue.module";
```

```ts
    @Inject(LLM_SAMBANOVA_QUEUE) private readonly llmSambaNovaQueue: Queue,
    @Inject(LLM_NVIDIA_QUEUE) private readonly llmNvidiaQueue: Queue,
```

```ts
    const queues = [
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      this.llmGroqQueue,
      this.llmOpenRouterQueue,
      this.llmMistralQueue,
      this.llmSambaNovaQueue,
      this.llmNvidiaQueue,
    ];
```

- [ ] **Step 7: Register it with Bull Board**

In `backend/src/app.setup.ts`, add `llmNvidiaQueue` to the import from `"./modules/queue/strategy.queue"` (line 11–20), and add `new BullMQAdapter(llmNvidiaQueue),` to the `queues` array passed to `createBullBoard` (after line 210):

```ts
import {
  strategyQueue,
  llmOpenAIQueue,
  llmOllamaQueue,
  llmGoogleQueue,
  llmGroqQueue,
  llmOpenRouterQueue,
  llmMistralQueue,
  llmSambaNovaQueue,
  llmNvidiaQueue,
} from "./modules/queue/strategy.queue";
```

```ts
      new BullMQAdapter(llmMistralQueue),
      new BullMQAdapter(llmSambaNovaQueue),
      new BullMQAdapter(llmNvidiaQueue),
      new BullMQAdapter(puzzleQueue),
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: PASS.

- [ ] **Step 8b: Fix two more provider unions a full-suite typecheck surfaces**

Running `npx tsc --noEmit` across the whole `backend` workspace (not just the files this task names) surfaces two more hand-maintained provider lists this plan's research missed:

In `backend/src/modules/strategy/orchestrator.service.ts`, two methods (`requestSolveStep` and `judgeCategory`) each declare their `provider?:` parameter as an inline literal union (the backend's HTTP payload shape to the orchestrator, not imported from anywhere) — add `| "nvidia"` to both, at lines matching:

```ts
    provider?: "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral" | "sambanova",
```

→

```ts
    provider?: "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral" | "sambanova" | "nvidia",
```

In `backend/src/modules/automation/daily-automation.service.spec.ts`, a test-only `BURN_LABEL: Record<ProviderPoolId, string>` fixture needs a matching entry:

```ts
  ollama: "ollamaBurn",
  nvidia: "nvidiaBurn",
};
```

And two more test files construct their own explicit NestJS `TestingModule` `providers` arrays that must independently list every queue token (adding a queue to `queue.module.ts` does not make Nest's real DI container available in these tests — each duplicates the wiring by hand): `backend/src/modules/strategy/strategy-dispatch.service.spec.ts` and `backend/src/modules/strategy/strategy-read.service.spec.ts`. In each, add `LLM_NVIDIA_QUEUE` to the import from `../queue/queue.module`, add a `mockNvidiaQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock }` fixture (mirroring `mockSambaNovaQueue`'s declaration, its `beforeEach` initialization, and its `{ provide: LLM_SAMBANOVA_QUEUE, useValue: mockSambaNovaQueue }` provider-array entry).

- [ ] **Step 9: Typecheck and run the broader backend unit suite**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: no type errors; all unit tests pass (`npm test` runs Jest scoped to `rootDir: "src"`, so it naturally excludes the `backend/test/*.e2e-spec.ts` suite — this also exercises `strategy-dispatch.service.spec.ts` / `strategy-read.service.spec.ts` if they exist and construct these services, where a missing constructor arg would fail loudly).

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/strategy-dispatch.service.ts backend/src/modules/strategy/strategy-read.service.ts backend/src/app.setup.ts backend/src/modules/queue/strategy.queue.spec.ts
git commit -m "feat(backend): wire llm-nvidia-runs into the queue module, dispatch, read model, and Bull Board"
```

---

### Task 6: Frontend provider-pool row

**Files:**
- Modify: `frontend/src/data/benchmark/providerPools.ts`
- Test: `frontend/src/data/benchmark/providerPools.test.ts`

**Interfaces:**
- Produces: `ProviderPoolId` includes `"nvidia"`; `PROVIDER_POOLS` has a matching `{ id: "nvidia", label: "NVIDIA NIM", strategyName: "llm-nvidia" }` row — required for Task 4's backend "frontend parity" test to pass.

- [ ] **Step 1: Write the failing test**

In `frontend/src/data/benchmark/providerPools.test.ts`, update the `"maps each llm-* dispatching strategy to its pool id"` test and the `"covers all seven pools once, in a stable order"` test:

```ts
  it("maps each llm-* dispatching strategy to its pool id", () => {
    expect(poolFromStrategyName("llm-openai")).toBe("openai");
    expect(poolFromStrategyName("llm-google")).toBe("google");
    expect(poolFromStrategyName("llm-groq")).toBe("groq");
    expect(poolFromStrategyName("llm-openrouter")).toBe("openrouter");
    expect(poolFromStrategyName("llm-mistral")).toBe("mistral");
    expect(poolFromStrategyName("llm-sambanova")).toBe("sambanova");
    expect(poolFromStrategyName("llm-ollama")).toBe("ollama");
    expect(poolFromStrategyName("llm-nvidia")).toBe("nvidia");
  });
```

```ts
describe("PROVIDER_POOLS", () => {
  it("covers all eight pools once, in a stable order", () => {
    expect(PROVIDER_POOLS.map((p) => p.id)).toEqual([
      "openai",
      "google",
      "groq",
      "openrouter",
      "mistral",
      "sambanova",
      "ollama",
      "nvidia",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run providerPools.test.ts`
Expected: FAIL — `PROVIDER_POOLS` has no `nvidia` row yet.

- [ ] **Step 3: Add the row**

In `frontend/src/data/benchmark/providerPools.ts`, extend `ProviderPoolId` (lines 8–15):

```ts
export type ProviderPoolId =
  | "openai"
  | "google"
  | "groq"
  | "openrouter"
  | "mistral"
  | "sambanova"
  | "ollama"
  | "nvidia";
```

Add the row after `ollama` (line 35, before the closing `];`):

```ts
export const PROVIDER_POOLS: ProviderPool[] = [
  { id: "openai", label: "OpenAI", strategyName: "llm-openai" },
  { id: "google", label: "Google", strategyName: "llm-google" },
  { id: "groq", label: "Groq", strategyName: "llm-groq" },
  { id: "openrouter", label: "OpenRouter", strategyName: "llm-openrouter" },
  { id: "mistral", label: "Mistral", strategyName: "llm-mistral" },
  { id: "sambanova", label: "SambaNova", strategyName: "llm-sambanova" },
  { id: "ollama", label: "Ollama", strategyName: "llm-ollama" },
  { id: "nvidia", label: "NVIDIA NIM", strategyName: "llm-nvidia" },
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run providerPools.test.ts`
Expected: PASS.

- [ ] **Step 4b: Fix two more pool-keyed spots a full-suite typecheck/test run surfaces**

`ProviderPill` passes a `ProviderPoolId` straight through as `StatusPill`'s `tone` prop, whose type (`PillTone` in `frontend/src/data/benchmark/runStatus.ts`) is a THIRD independent copy of the same provider-id union (not imported from `providerPools.ts`) — add `| "nvidia"` there too. `frontend/src/benchmark.css` has one `.bench-pill--<id>` color rule per pool for badge styling (after `.bench-pill--ollama`, add `.bench-pill--nvidia { color: #a67c1e; border-color: #e6d9b8; }`, a hue distinct from the other seven). `frontend/src/components/benchmark/__tests__/ProviderFilter.test.tsx`'s `"renders a toggle for every provider pool"` test enumerates every pool's label explicitly — add `"NVIDIA NIM"` to that list.

Note what did NOT need a change: `frontend/src/data/benchmark/types.ts`'s `AutomationStatus`-shaped burn-leg fields (`googleBurn`/`groqBurn`/.../`sambaNovaBurn`) and `PoolDispatchWidget.test.tsx`'s `FREE_TIER_POOL_IDS` are both correctly scoped to only the five free-tier pools — nvidia (non-free-tier) is rightly absent from both.

- [ ] **Step 5: Run Task 4's backend parity test now that both sides agree**

Run: `cd backend && npx jest provider-pool.config.spec.ts`
Expected: PASS, including the `"frontend parity"` test that was expected to fail at the end of Task 4.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/data/benchmark/providerPools.ts frontend/src/data/benchmark/providerPools.test.ts
git commit -m "feat(frontend): add the nvidia provider-pool filter row"
```

---

### Task 7: Judge-provider support

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/src/config/env.spec.ts`

**Interfaces:**
- Produces: `AppEnv.JUDGE_PROVIDER` accepts `"nvidia"`; `loadEnv({ JUDGE_PROVIDER: "nvidia", ... })` no longer throws.

- [ ] **Step 1: Write the failing test**

In `backend/src/config/env.spec.ts`, add a line to the `"should accept each supported provider"` test:

```ts
  it("should accept each supported provider", () => {
    expect(loadEnv({ ...baseEnv, JUDGE_PROVIDER: "google" }).JUDGE_PROVIDER).toBe("google");
    expect(loadEnv({ ...baseEnv, JUDGE_PROVIDER: "ollama" }).JUDGE_PROVIDER).toBe("ollama");
    expect(loadEnv({ ...baseEnv, JUDGE_PROVIDER: "nvidia" }).JUDGE_PROVIDER).toBe("nvidia");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest env.spec.ts`
Expected: FAIL — `loadEnv` throws `JUDGE_PROVIDER must be one of ...` for `"nvidia"`.

- [ ] **Step 3: Add nvidia to the judge-provider allowlist**

In `backend/src/config/env.ts`, extend the `AppEnv.JUDGE_PROVIDER` type (line 21):

```ts
  JUDGE_PROVIDER: "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral" | "sambanova" | "nvidia";
```

Extend `JUDGE_PROVIDERS` (lines 27–35):

```ts
const JUDGE_PROVIDERS = [
  "openai",
  "ollama",
  "google",
  "groq",
  "openrouter",
  "mistral",
  "sambanova",
  "nvidia",
] as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest env.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/env.spec.ts
git commit -m "feat(backend): allow nvidia as a JUDGE_PROVIDER"
```

---

### Task 8: Live structured-output verification (manual, gates Task 9)

**Files:**
- Create (temporary, deleted at the end of this task): `orchestrator/verify-nvidia-models.ts`

**Interfaces:**
- Consumes: `getModel` from Task 1.
- Produces: a pass/fail verdict per candidate model, recorded in this task's own notes — no code artifact survives this task.

This task requires a real `NVIDIA_API_KEY` already present in `orchestrator/.env` (or exported in your shell) — get one from build.nvidia.com and set it before starting. It cannot be run by an agent without that key; a human (or a session with the key already configured) must run it.

- [ ] **Step 1: Write the verification script**

Create `orchestrator/verify-nvidia-models.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./src/provider.js";

const schema = z.object({
  answer: z.string(),
  confidence: z.number(),
});

const candidates = [
  "meta/llama-3.3-70b-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "nvidia/nemotron-3-ultra-550b-a55b",
];

for (const modelId of candidates) {
  try {
    const { object } = await generateObject({
      model: getModel("nvidia", modelId),
      schema,
      prompt: "Reply with a one-word answer to 2+2 and a confidence between 0 and 1.",
    });
    console.log(`${modelId}: OK ->`, object);
  } catch (err) {
    console.error(`${modelId}: FAILED ->`, err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 2: Run it**

Run from `orchestrator/`: `npx tsx verify-nvidia-models.ts`
Expected: three lines of output, one per model, each either `OK -> { answer: ..., confidence: ... }` or `FAILED -> <error message>`.

- [ ] **Step 3: Record the verdict**

Write down, for each of the three models, whether it printed `OK` (schema-conformant object returned) or `FAILED`. This verdict feeds Task 9 directly:
- `meta/llama-3.3-70b-instruct` and `nvidia/nemotron-3-ultra-550b-a55b` are expected to pass, per NVIDIA's own documented structured-output confirmation for both — if either fails, treat that as a real finding (not expected) and investigate before proceeding (wrong model id string, expired key, endpoint change).
- `mistralai/mixtral-8x22b-instruct-v0.1` had no prior confirmation — this is the actual gate. **If it fails, do not substitute a different model on your own and do not proceed to Task 9 with a guess** — stop here and get a replacement candidate before continuing the plan.

- [ ] **Step 4: Delete the script**

```bash
rm orchestrator/verify-nvidia-models.ts
```

This is a one-time live probe against a third-party API with real credentials, not a reusable repo tool — it doesn't get committed.

---

### Task 9: Model registration migration

**Superseded model list:** Task 8's live verification found that both `meta/llama-3.3-70b-instruct` (HTTP 410, EOL 2026-08-26) and `mistralai/mixtral-8x22b-instruct-v0.1` (HTTP 410, EOL 2026-05-21) are genuinely dead — not merely unverified, actually retired. A live probe of the account's full catalog (`GET /v1/models`, 81 entries) found only 6 models this account can actually call with working structured output: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `mistralai/mistral-nemotron`, `google/gemma-4-31b-it`, `openai/gpt-oss-20b`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. The user chose to seed all 6. This task's migration reflects that real list, not the plan's original 3-model assumption.

**Files:**
- Create: `backend/src/migrations/1803000000000-add-nvidia-models.ts`

**Interfaces:**
- Produces: six `SupportedModel` rows for `strategyName = 'llm-nvidia'`.

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/1803000000000-add-nvidia-models.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers six NVIDIA NIM (build.nvidia.com) models for the llm-nvidia
 * strategy. The originally-researched candidates
 * (meta/llama-3.3-70b-instruct, mistralai/mixtral-8x22b-instruct-v0.1) turned
 * out to be genuinely dead — live calls returned HTTP 410 Gone with explicit
 * end-of-life dates (2026-08-26 and 2026-05-21), despite no deprecation
 * notice being found in documentation-era research. A live probe of this
 * account's full NIM catalog (GET /v1/models, 81 entries, ~50 plausible
 * chat/instruct candidates after filtering out embedding/vision/
 * classifier models) found these 6 actually callable with working
 * structured output — NVIDIA Build's per-account model entitlements are a
 * real, specific allowlist, not a single account-wide toggle and not
 * "every catalog-listed model works".
 *
 * `modelName` is NIM's own model id; `openRouterSlug` is the separate
 * OpenRouter-catalog mapping ModelMetadataRefreshService uses to backfill
 * contextWindow / pricing / releaseDate. gemma-4-31b-it reuses the slug
 * already confirmed for SambaNova's identical model
 * (1796000000000-add-sambanova-models.ts); gpt-oss-20b's slug is inferred
 * from that same migration's gpt-oss-120b row using its own model id as its
 * OpenRouter slug verbatim (same publisher/family, one size down) rather
 * than an independent OpenRouter lookup. The four NVIDIA-exclusive/NIM-tuned
 * models have no confirmed OpenRouter match and are left NULL; they stay
 * metadata-blank until a match is confirmed or added to OpenRouter later. No
 * ModelPrice row is inserted for any of the six, matching the Groq/Mistral/
 * SambaNova convention of letting ModelMetadataRefreshService backfill real
 * per-token pricing asynchronously.
 *
 * This app relies exclusively on generateObject (structured output only), so
 * `supported` requires a real response_format probe per model, not
 * documentation alone. All six passed a live generateObject probe.
 * nemotron-3-nano-omni-30b-a3b-reasoning's probe validated against the
 * schema but its answer field's content looked slightly off (extra text
 * bled in alongside the answer) — worth extra scrutiny once real
 * puzzle-solving traffic hits it; flip it to supported = false if it proves
 * unreliable in practice rather than guessing now.
 *
 * llm-nvidia is seeded but NOT part of PROVIDER_POOLS' free-tier automation
 * (its pool row has freeTier: null) — dispatch is manual only until NIM's
 * real-world rate-limit behavior is understood.
 *
 * Trigger POST /dispatch/refresh-model-metadata once applied so
 * contextWindow / pricing aren't left blank until the next daily cron tick.
 * See docs/specs/2026-09-21-nvidia-nim-provider-design.md.
 */
export class AddNvidiaModels1803000000000 implements MigrationInterface {
  name = "AddNvidiaModels1803000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-nvidia', 'nvidia/nemotron-3-ultra-550b-a55b',              true, NULL),
        ('llm-nvidia', 'nvidia/nemotron-3-super-120b-a12b',              true, NULL),
        ('llm-nvidia', 'mistralai/mistral-nemotron',                    true, NULL),
        ('llm-nvidia', 'google/gemma-4-31b-it',                         true, 'google/gemma-4-31b-it'),
        ('llm-nvidia', 'openai/gpt-oss-20b',                            true, 'openai/gpt-oss-20b'),
        ('llm-nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', true, NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-nvidia'
        AND "modelName" IN (
          'nvidia/nemotron-3-ultra-550b-a55b',
          'nvidia/nemotron-3-super-120b-a12b',
          'mistralai/mistral-nemotron',
          'google/gemma-4-31b-it',
          'openai/gpt-oss-20b',
          'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
        )
    `);
  }
}
```

- [ ] **Step 2: Run the migration against your local dev database**

Run: `cd backend && npm run migration:run`
Expected: `AddNvidiaModels1803000000000` reports as applied; no errors.

- [ ] **Step 3: Verify the rows landed**

Run: `psql <your local connection string> -c "SELECT \"strategyName\", \"modelName\", \"supported\", \"openRouterSlug\" FROM \"SupportedModel\" WHERE \"strategyName\" = 'llm-nvidia'"`
Expected: three rows, matching the migration's `VALUES` exactly.

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/1803000000000-add-nvidia-models.ts
git commit -m "feat(backend): seed the initial llm-nvidia model batch"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.sample`

- [ ] **Step 1: Update `.env.sample`**

Add after the `SAMBANOVA_API_KEY` line (line 28):

```
# NVIDIA NIM API key (used by @ai-sdk/openai-compatible in the orchestrator)
NVIDIA_API_KEY=
```

Update the `MODEL_PROVIDER` comment block (lines 30–37) to mention all eight:

```
# Default AI model provider for requests that don't specify one — i.e. the
# in-game AI Assist endpoint. Strategy runs always select their own provider
# via the strategy name: 'llm-openai' consults OpenAI, 'llm-ollama' the
# bundled Ollama service, 'llm-google' Google AI Studio, 'llm-groq' Groq,
# 'llm-openrouter' OpenRouter, 'llm-mistral' Mistral La Plateforme,
# 'llm-sambanova' SambaNova Cloud, 'llm-nvidia' NVIDIA NIM. All eight
# providers are always configured and can be used simultaneously.
MODEL_PROVIDER=openai
```

Add after the `SAMBANOVA_MODEL` line (line 57):

```
# NVIDIA NIM model id (used when MODEL_PROVIDER=nvidia). Manual dispatch
# only — not part of automatic free-tier rotation. NIM's real-world
# rate-limit shape is unverified, so 429s fall back to generic retry
# handling for now.
NVIDIA_MODEL=meta/llama-3.3-70b-instruct
```

Add a new section after the SambaNova block (after `SAMBANOVA_DISPATCH_MAX_IN_FLIGHT=2`, line 233):

```

# --- NVIDIA NIM (llm-nvidia strategy) ---

# Maximum llm-nvidia runs the worker processes at once (own queue). NVIDIA
# NIM has no free-tier dispatch/hold machinery configured yet — dispatch is
# manual only (default: 1)
LLM_NVIDIA_CONCURRENCY=1
```

- [ ] **Step 2: Update `README.md`**

Add after the `SAMBANOVA_API_KEY` row (line 101):

```
| `NVIDIA_API_KEY` | — | NVIDIA NIM API key (orchestrator only) |
```

Update the `MODEL_PROVIDER` row (line 102) to mention nvidia:

```
| `MODEL_PROVIDER` | `openai` | Default provider for provider-less requests (e.g. in-game AI Assist): `openai`, `ollama`, `google`, `groq`, `openrouter`, `mistral`, `sambanova`, or `nvidia`. Strategy runs pick their provider via strategy name (`llm-openai` / `llm-ollama` / `llm-google` / `llm-groq` / `llm-openrouter` / `llm-mistral` / `llm-sambanova` / `llm-nvidia`), so all eight are always active |
```

Add after the `SAMBANOVA_MODEL` row (line 108):

```
| `NVIDIA_MODEL` | `meta/llama-3.3-70b-instruct` | NVIDIA NIM model id (used by the `llm-nvidia` strategy and provider-less requests). Manual dispatch only — not part of automatic free-tier rotation; NIM's real-world rate-limit shape is unverified, so 429s fall back to generic retry handling for now |
```

Add after the `LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS` / `SAMBANOVA_DISPATCH_MAX_IN_FLIGHT` block (after line 154):

```
| `LLM_NVIDIA_CONCURRENCY` | `1` | Maximum `llm-nvidia` runs the worker processes at once (own queue). No free-tier dispatch/hold machinery yet — dispatch is manual only |
```

- [ ] **Step 3: Commit**

```bash
git add README.md .env.sample
git commit -m "docs: document the nvidia provider's env vars"
```

---

### Task 11: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck every workspace**

There is no root-level aggregate script (the root `package.json` only declares `workspaces`, no `scripts`) — run each workspace individually:
Run: `cd orchestrator && npm run typecheck`
Run: `cd backend && npx tsc --noEmit`
Run: `cd frontend && npx tsc -b`
Expected: no errors in any of the three.

- [ ] **Step 2: Run the full orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: all tests pass, including the new `nvidia` cases from Tasks 1–2.

- [ ] **Step 3: Run the full backend unit suite**

Run: `cd backend && npm test`
Expected: all tests pass, including the new `nvidia` cases from Tasks 3, 4, 5, 7.

- [ ] **Step 4: Run the backend e2e suite**

Run: `cd backend && npm run test:e2e`
Expected: `provider-pool-dispatch.e2e-spec.ts` and the rest of the e2e suite pass unchanged — adding an eighth pool row must not break DI wiring or migration application for the existing scenarios it covers.

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npm run test:run`
Expected: all tests pass, including the new `nvidia` case from Task 6.

- [ ] **Step 6: Manual smoke check**

With `NVIDIA_API_KEY` set in your `.env` and the stack running (`docker compose up` or your usual dev flow), dispatch one manual run per seeded model via the existing admin dispatch endpoint (`POST /dispatch/model/:modelName/:date`, per README's dispatch section) for `llm-nvidia`, and confirm in Bull Board (`/bull/queues`) that each run lands on the new `llm-nvidia-runs` queue and completes (or fails for a reason unrelated to provider wiring, e.g. an actual puzzle-solving miss).

No commit for this task — it's verification only.
