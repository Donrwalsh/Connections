# SambaNova Cloud Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth LLM strategy, `llm-sambanova`, dispatched and rate-limit-managed the way `llm-groq` is today — SambaNova Cloud's free-tier caps are **per-model** (20 req/min, 20 req/day, 200K tokens/day each), delivered via `x-ratelimit-*` response headers whose reset is a duration from the hit, so this clones Groq's shape (per-model `RateLimitHold`, self-rescheduling resume) rather than OpenRouter's account-wide shape.

**Architecture:** The orchestrator reaches SambaNova through the community `sambanova-ai-provider` package (OpenAI-compatible API). The 429 classifier uses a **reset-distance threshold** (OpenRouter's discriminator style) on SambaNova's duration-style reset headers: a 429 whose reset is more than `DAILY_RESET_THRESHOLD_SECONDS` out is a per-model daily park (`StrategyRunStatus.RATE_LIMITED_DAILY`), anything sooner is a per-minute wait-and-retry. Hold state is **per (strategyName, modelName)** — a structural copy of `GroqRateLimitHold`. Resume is a **self-rescheduling** sweep keyed off the soonest live hold's `resetAt` (a copy of `GroqRpdResumeService` — no fixed cron, because SambaNova's reset clock is a per-hit duration). Dispatch is a **dispatch-until-held** cycle (a copy of `GroqFreeDispatchService` — no self-counted budget) with its own conservative `SAMBANOVA_DISPATCH_*` pacing knobs sized for the fixed 20 RPM / 20 RPD-per-model free tier. Ships free-tier-safe by default; the knobs raise to SambaNova Developer-tier throughput with no code change.

**Tech Stack:** NestJS + TypeORM + BullMQ (backend/worker), Hono + Vercel AI SDK (`sambanova-ai-provider`) (orchestrator), React + TanStack Query (frontend). Jest (backend), Vitest (orchestrator, frontend).

**Spec:** [docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md](../specs/2026-09-05-sambanova-cloud-provider-design.md)

## Global Constraints

- Seed exactly these five `llm-sambanova` models, no others — `modelName` is SambaNova's own model id, `openRouterSlug` is a **separate mapping** to the OpenRouter catalog entry (the Groq split, not OpenRouter's identical-value seeding):
  - `DeepSeek-V3.1` → `deepseek/deepseek-chat-v3.1`
  - `DeepSeek-V3.2` → `deepseek/deepseek-v3.2`
  - `Meta-Llama-3.3-70B-Instruct` → `meta-llama/llama-3.3-70b-instruct`
  - `gpt-oss-120b` → `openai/gpt-oss-120b`
  - `gemma-4-31B-it` → `google/gemma-4-31b-it`
- Re-confirm all five OpenRouter slugs live against `GET https://openrouter.ai/api/v1/models/{slug}/endpoints` and probe each SambaNova model with a real `generateObject`-shaped call before writing the seed migration (Task 12). Any model that cannot reliably return structured output is seeded `supported = false` (like `minimax-m2.7` was for Groq), not dropped.
- `freeTier` is seeded `NULL` for every SambaNova row — SambaNova is not part of either OpenAI token tier.
- Hold state is **per (strategyName, modelName)** — `SambaNovaRateLimitHold` has a unique constraint on `("strategyName", "modelName")`, identical to `GroqRateLimitHold`. There is one hold row per held model and per-model resume logic.
- The resume sweep has **no fixed cron**. `SambaNovaRpdResumeBootstrap` only enqueues one startup catch-up sweep; `SambaNovaRpdResumeService.runResume()`'s own `rearm()` self-schedules the next sweep at the soonest live hold's `resetAt` (clamped to `REARM_MAX_DELAY_MS = 15 * 60_000`). This is Groq's exact mechanism — SambaNova's reset is a per-hit duration, not a fixed clock.
- The 429 classifier writes **no per-minute cooldown hold** and no account-wide anything. A per-minute `rate_limited` hit is pure wait-and-retry (the provider-agnostic `state.rateLimitWaitMs` path). There is no `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` equivalent.
- No manual `POST` start endpoint for SambaNova dispatch — automation-only, same as Google/Groq/OpenRouter (`GET`/`DELETE` on `/dispatch/sambanova`).
- No new `SolveErrorCode` values and no new `SolveErrorDetails` fields — reuse `"rate_limited"` / `"rate_limited_daily"` and the existing `retryAfterSeconds` / `dailyResetSeconds` fields (both already added for Groq), and reuse `StrategyRunStatus.RATE_LIMITED_DAILY`.
- `DAILY_RESET_THRESHOLD_SECONDS = 120` already exists as a non-configurable module constant in `orchestrator/src/solver.ts` (added by the OpenRouter feature) — reuse it, do not redefine it.
- Reuse `parseGroqResetDuration` and `parseSecondsHeader` from `orchestrator/src/solver.ts` (both already present) for SambaNova's reset headers. SambaNova's reset header is **assumed** to be a Groq-style duration string (e.g. `"23h59m"`); Task 2 Step 1 confirms the exact header name and format against a real captured 429 and adds a dedicated parser only if it differs.
- Google's, Groq's, and OpenRouter's own constants/services are never modified to also serve SambaNova — every SambaNova behavior gets its own parallel name.
- Config defaults, copied verbatim into `strategies.ts` as `DEFAULT_*` constants:
  - `LLM_SAMBANOVA_CONCURRENCY` → `1`
  - `LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS` → `60`
  - `LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS` → `3600`
  - `SAMBANOVA_DISPATCH_TICK_MS` → `15000`
  - `SAMBANOVA_DISPATCH_MAX_BATCH` → `2`
  - `SAMBANOVA_DISPATCH_MAX_IN_FLIGHT` → `2`
- `DEFAULT_SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct"` (orchestrator).
- New migration timestamps are the next four sequential slots above the current highest (`1791000000000-add-automation-openrouter-leg.ts`): `1792` models, `1793` rate-limit-hold, `1794` dispatch-state, `1795` automation-leg. Verify nothing new has landed above `1791` before writing them; bump all four together if so.
- The two new entities — `SambaNovaRateLimitHold` and `SambaNovaDispatchState` — MUST be added to the explicit `entities: [...]` array in **both** `backend/src/app.module.ts` (`TypeOrmModule.forRootAsync`) and `backend/src/data-source.ts` (`AppDataSource`), in the task that creates each entity. `TypeOrmModule.forFeature([...])` does not register root-connection metadata; omitting either array throws `EntityMetadataNotFoundError` on the first real query. This has bitten Groq and OpenRouter. Verify with `AppDataSource.initialize()` + `AppDataSource.hasMetadata("SambaNovaRateLimitHold")` / `hasMetadata("SambaNovaDispatchState")` against the live dev DB in Task 16.
- Every new NestJS constructor parameter uses an explicit injection decorator — `@Inject(Token)`, `@InjectRepository(Entity)`, `@InjectDataSource()` — never bare-type inference, which resolves to `undefined` under the worker's `tsx`/esbuild runtime without throwing at boot.
- Orchestrator tests use **Vitest** (`orchestrator/src/*.test.ts`, run via `npx vitest run`); backend tests use **Jest** (`backend/**/*.spec.ts`, run via `npx jest`); frontend tests use **Vitest** (`frontend/... --run`). Don't mix the APIs.
- Every commit message ends with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

**Orchestrator (new/modified):**
- Modify `orchestrator/src/provider.ts` — add `"sambanova"` to `ModelProvider`, `DEFAULT_SAMBANOVA_MODEL`, `defaultProvider`/`getModel`/`getModelName` branches.
- Modify `orchestrator/src/solver.ts` — SambaNova reset-distance 429 classification branch (reuses `DAILY_RESET_THRESHOLD_SECONDS`, `parseGroqResetDuration`, `parseSecondsHeader`).
- Modify `orchestrator/src/types.ts` — `"sambanova"` added to the `provider` enums on `SolveAssistRequestSchema` / `JudgeCategoryRequestSchema`.
- Modify `orchestrator/package.json` — add `sambanova-ai-provider` dependency.

**Backend (new/modified):**
- Modify `backend/src/modules/strategy/orchestrator.service.ts` (+ `.spec.ts`) — widen the `provider` param unions to include `"sambanova"`.
- Modify `backend/src/strategies.ts` (+ `strategies.spec.ts`) — `LLM_SAMBANOVA`, all config accessors.
- Create `backend/src/modules/strategy/entities/sambanova-rate-limit-hold.entity.ts`.
- Create `backend/src/modules/strategy/sambanova-rate-limit-hold.service.ts` (+ `.spec.ts`) — per-model hold, copy of `GroqRateLimitHoldService`.
- Modify `backend/src/modules/strategy/llm-strategy-runner.service.ts` (+ `.spec.ts`) — SambaNova provider resolution, per-model top gate, on-daily-hit hold, per-provider rate-limit fallback.
- Modify `backend/src/modules/queue/strategy.queue.ts` (+ `.spec.ts`) — `llmSambaNovaQueue`, `queueForStrategy` extended to 8 args.
- Modify `backend/src/modules/queue/queue.module.ts` — `LLM_SAMBANOVA_QUEUE`, `SAMBANOVA_FREE_DISPATCH_QUEUE`, `SAMBANOVA_RPD_RESUME_QUEUE` tokens.
- Create `backend/src/modules/queue/sambanova-free-dispatch.queue.ts`.
- Create `backend/src/modules/queue/sambanova-rpd-resume.queue.ts`.
- Modify `backend/src/modules/strategy/strategy.service.ts` (+ `.spec.ts`) — inject `LLM_SAMBANOVA_QUEUE`, extend `queueFor` / `queuedCountsByKey`.
- Modify `backend/src/modules/strategy/strategy.module.ts` — register the new entity/services.
- Create `backend/src/modules/sambanova-free-dispatch/entities/sambanova-dispatch-state.entity.ts`.
- Create `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.module.ts`.
- Create `backend/src/modules/strategy/sambanova-rpd-resume.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.ts` (+ `.spec.ts`).
- Modify `backend/src/app.module.ts` and `backend/src/data-source.ts` — root `entities: [...]` arrays.
- Modify `backend/src/worker.ts` — three new worker handlers.
- Modify `backend/src/modules/dispatch/dispatch.controller.ts` (+ `dispatch.module.ts`) — `GET`/`DELETE /dispatch/sambanova`.
- Modify `backend/src/modules/automation/daily-automation.service.ts` (+ `.spec.ts`) — `runSambaNovaBurnLeg`.
- Modify `backend/src/modules/automation/entities/automation-run-log.entity.ts` — `sambaNovaBurnOutcome` / `sambaNovaBurnMessage`.
- Modify `backend/src/modules/automation/automation.controller.ts` — `sambaNovaBurn` in the status DTO.
- Modify `backend/src/modules/automation/automation.module.ts` — import `SambaNovaFreeDispatchModule`.
- Create migrations `1792`–`1795` (verify the timestamps first).

**Frontend (new/modified):**
- Modify `frontend/src/data/benchmark/types.ts` — `SambaNovaDispatchStatus`, `AutomationStatus.sambaNovaBurn`.
- Modify `frontend/src/data/benchmark/api.ts` — `fetchSambaNovaDispatchStatus` / `stopSambaNovaDispatch`.
- Create `frontend/src/components/benchmark/SambaNovaDispatchWidget.tsx` (+ `__tests__/SambaNovaDispatchWidget.test.tsx`).
- Modify `frontend/src/pages/benchmark/ActivityPage.tsx` — wire the new widget.

**Docs:**
- Modify `.env.sample`, `docker-compose.yml`, `README.md` — SambaNova env vars.

---

### Task 1: Orchestrator — SambaNova model resolution

**Files:**
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/package.json`
- Modify: `.env.sample`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Test: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Produces: `ModelProvider` now includes `"sambanova"`. `DEFAULT_SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct"`. `getModel("sambanova", modelOverride?, contextWindow?): LanguageModel`. `getModelName("sambanova", modelOverride?): string`. `defaultProvider()` returns `"sambanova"` for `MODEL_PROVIDER=sambanova`.

- [ ] **Step 1: Confirm the `sambanova-ai-provider` API**

Run `cd orchestrator && npm view sambanova-ai-provider version` and note the latest published major. Read its README/types (`npm view sambanova-ai-provider readme`, or the package's `dist/*.d.ts` after install) to confirm: the factory is `createSambaNova({ apiKey })`, and a chat model is obtained by calling the provider instance directly — `provider(modelId)` — like `@ai-sdk/groq`'s `createGroq`, NOT via a `.chat(...)` method (that is OpenRouter's shape). Also confirm its `peerDependencies` on `ai` overlap the orchestrator's installed `ai` version (`npm ls ai`). Record which call form this version uses; Step 5's code assumes `provider(modelId)` and must be adjusted if the confirmed API differs. This mirrors how the Groq and OpenRouter work confirmed their providers before wiring them.

- [ ] **Step 2: Write the failing tests**

Add to `orchestrator/src/provider.test.ts`, matching the exact style the file already uses for `@ai-sdk/groq` (`vi.hoisted` + `vi.mock`):

```ts
const createSambaNovaMock = vi.hoisted(() => {
  const model = vi.fn();
  const factory = vi.fn(() => model);
  return Object.assign(factory, { model });
});

vi.mock("sambanova-ai-provider", () => ({
  createSambaNova: createSambaNovaMock,
}));
```

Add `createSambaNovaMock.mockClear(); createSambaNovaMock.model.mockClear();` to the existing `afterEach` in `describe("getModel", ...)`.

Add inside `describe("getModel", ...)`:

```ts
  it("resolves the SambaNova model via createSambaNova()(modelId), without num_ctx", () => {
    getModel("sambanova");

    expect(createSambaNovaMock).toHaveBeenCalledTimes(1);
    expect(createSambaNovaMock).toHaveBeenCalledWith(expect.objectContaining({}));
    // the returned provider instance was called with the resolved model id
    const providerInstance = createSambaNovaMock.mock.results[0].value;
    expect(providerInstance).toHaveBeenCalledWith("Meta-Llama-3.3-70B-Instruct");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes SAMBANOVA_API_KEY to createSambaNova", () => {
    vi.stubEnv("SAMBANOVA_API_KEY", "test-sn-key");

    getModel("sambanova");

    expect(createSambaNovaMock).toHaveBeenCalledWith({ apiKey: "test-sn-key" });
  });

  it("uses the model override instead of SAMBANOVA_MODEL when given", () => {
    vi.stubEnv("SAMBANOVA_MODEL", "DeepSeek-V3.1");

    getModel("sambanova", "gpt-oss-120b");

    const providerInstance = createSambaNovaMock.mock.results.at(-1)!.value;
    expect(providerInstance).toHaveBeenCalledWith("gpt-oss-120b");
  });

  it("accepts a contextWindow for sambanova without using it", () => {
    getModel("sambanova", undefined, 262144);

    const providerInstance = createSambaNovaMock.mock.results.at(-1)!.value;
    expect(providerInstance).toHaveBeenCalledWith("Meta-Llama-3.3-70B-Instruct");
  });
```

Add inside `describe("getModelName", ...)`:

```ts
  it("returns the configured SambaNova model for the sambanova provider", () => {
    vi.stubEnv("SAMBANOVA_MODEL", "DeepSeek-V3.1");
    expect(getModelName("sambanova")).toBe("DeepSeek-V3.1");
  });

  it("falls back to the SambaNova default when unset", () => {
    expect(getModelName("sambanova")).toBe("Meta-Llama-3.3-70B-Instruct");
  });

  it("prefers the model override over SAMBANOVA_MODEL", () => {
    vi.stubEnv("SAMBANOVA_MODEL", "DeepSeek-V3.1");
    expect(getModelName("sambanova", "gpt-oss-120b")).toBe("gpt-oss-120b");
  });
```

Add inside `describe("effectiveContextWindow", ...)`:

```ts
  it("never caps sambanova — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("sambanova", 262144)).toBe(262144);
  });
```

Add inside `describe("defaultProvider", ...)`:

```ts
  it("returns sambanova when MODEL_PROVIDER=sambanova", () => {
    vi.stubEnv("MODEL_PROVIDER", "sambanova");
    expect(defaultProvider()).toBe("sambanova");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: FAIL — `getModel`/`getModelName`/`defaultProvider` don't handle `"sambanova"`; `ModelProvider` type error on the `"sambanova"` literal.

- [ ] **Step 4: Add the `sambanova-ai-provider` dependency**

In `orchestrator/package.json`, add to `dependencies` (alphabetically — after the `@openrouter/*` entry, before `ai`):

```json
    "sambanova-ai-provider": "^1.0.0",
```

Run `cd orchestrator && npm install`. If `^1.0.0` doesn't resolve, use `npm view sambanova-ai-provider versions` and pin the latest major's `^x.0.0` (matching the version confirmed in Step 1).

- [ ] **Step 5: Implement the `sambanova` branch in `provider.ts`**

Add the import (after the `@openrouter/ai-sdk-provider` import):

```ts
import { createSambaNova } from "sambanova-ai-provider";
```

Add the default constant (after `DEFAULT_OPENROUTER_MODEL`):

```ts
export const DEFAULT_SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct";
```

Extend the type:

```ts
export type ModelProvider = "openai" | "ollama" | "google" | "groq" | "openrouter" | "sambanova";
```

`defaultProvider()` — add before the final `return "openai";`:

```ts
  if (provider === "sambanova") return "sambanova";
```

`getModel()` — add before the final `openai(...)` fallback:

```ts
  if (provider === "sambanova") {
    const sambanova = createSambaNova({ apiKey: process.env.SAMBANOVA_API_KEY });
    return sambanova(modelOverride ?? process.env.SAMBANOVA_MODEL ?? DEFAULT_SAMBANOVA_MODEL);
  }
```

(If Step 1 found this version reaches chat models via a method instead of a direct call, use that form here and update the Step 2 mock/assertions to match.)

`getModelName()` — add before the final `return`:

```ts
  if (provider === "sambanova") {
    return modelOverride ?? process.env.SAMBANOVA_MODEL ?? DEFAULT_SAMBANOVA_MODEL;
  }
```

`effectiveContextWindow()` needs no change — its `provider !== "ollama"` passthrough already covers `"sambanova"`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: PASS

- [ ] **Step 7: Document the new env vars**

In `.env.sample`, after the `OPENROUTER_MODEL=...` line add:

```
# SambaNova Cloud API key (used by sambanova-ai-provider in the orchestrator)
SAMBANOVA_API_KEY=

# SambaNova model id (used when MODEL_PROVIDER=sambanova). Free-tier caps
# are per-model: 20 req/min, 20 req/day, 200K tokens/day each.
SAMBANOVA_MODEL=Meta-Llama-3.3-70B-Instruct
```

Update the `MODEL_PROVIDER` comment block to name the sixth provider: `... 'llm-openrouter' OpenRouter, 'llm-sambanova' SambaNova. All six providers are always configured and can be used simultaneously.`

In `docker-compose.yml`, in the `orchestrator` service's `environment:` block, after `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}` add `SAMBANOVA_API_KEY: ${SAMBANOVA_API_KEY}`, and after `OPENROUTER_MODEL: ${OPENROUTER_MODEL:-google/gemma-4-31b-it:free}` add `SAMBANOVA_MODEL: ${SAMBANOVA_MODEL:-Meta-Llama-3.3-70B-Instruct}`.

In `README.md`'s env var table, after the `OPENROUTER_API_KEY` row add:

```
| `SAMBANOVA_API_KEY` | — | SambaNova Cloud API key (orchestrator only) |
```

and after the `OPENROUTER_MODEL` row add:

```
| `SAMBANOVA_MODEL` | `Meta-Llama-3.3-70B-Instruct` | SambaNova model id (used by the `llm-sambanova` strategy and provider-less requests) |
```

Update the `MODEL_PROVIDER` row's description to also list `sambanova` / `llm-sambanova`.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/provider.ts orchestrator/src/provider.test.ts orchestrator/package.json orchestrator/package-lock.json .env.sample docker-compose.yml README.md
git commit -m "$(cat <<'EOF'
feat(orchestrator): add SambaNova Cloud as a model provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Orchestrator — SambaNova rate-limit classification

**Files:**
- Modify: `orchestrator/src/solver.ts`
- Modify: `orchestrator/src/types.ts`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from Task 1 (now includes `"sambanova"`); the pre-existing `DAILY_RESET_THRESHOLD_SECONDS`, `parseGroqResetDuration`, `parseSecondsHeader` in `solver.ts`.
- Produces: `classifyModelCallError(err, "sambanova", details)` returns `SolveError` with code `"rate_limited_daily"` (carrying `dailyResetSeconds`) when the 429's reset is more than `DAILY_RESET_THRESHOLD_SECONDS` out, else `"rate_limited"` (carrying `retryAfterSeconds`), else `"model_error"` when no reset/retry header is parseable. No new `SolveError*` fields.

- [ ] **Step 1: Confirm SambaNova's 429 header shape**

Before writing the parser, capture a real SambaNova free-tier 429 (exhaust a model's 20 req/min from a scratch script with a valid `SAMBANOVA_API_KEY`, or find one in existing logs). Confirm: the reset header's exact name (`x-ratelimit-reset-requests-day` and `x-ratelimit-reset-requests` are assumed), and that its value is a Groq-style duration string that `parseGroqResetDuration` already parses (e.g. `"2h59m59s"`, `"45s"`). If the format differs (bare seconds, ISO-8601 duration, epoch), add a dedicated `parseSambaNovaResetDuration` helper in `solver.ts` next to `parseGroqResetDuration` and use it in Step 3 instead. Also note whether `retry-after` appears on per-minute 429s. Record findings as a comment in the Step 3 branch.

- [ ] **Step 2: Write the failing tests**

Add to `orchestrator/src/solver.test.ts`. The `makeAPICallError` helper already accepts `responseHeaders`. Add a new `describe` block:

```ts
describe("classifyModelCallError — sambanova", () => {
  it("classifies a 429 whose reset-requests-day is hours out as rate_limited_daily", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: {
        "x-ratelimit-remaining-requests-day": "0",
        "x-ratelimit-reset-requests-day": "23h10m",
      },
    });

    const result = classifyModelCallError(err, "sambanova", { model: "DeepSeek-V3.1" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBeGreaterThan(80_000);
    expect(result.details.dailyResetSeconds).toBeLessThanOrEqual(83_401);
  });

  it("classifies a 429 whose per-minute reset is seconds away as rate_limited", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-reset-requests": "8s" },
    });

    const result = classifyModelCallError(err, "sambanova", { model: "DeepSeek-V3.1" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.details.retryAfterSeconds).toBeLessThanOrEqual(9);
  });

  it("prefers retry-after seconds for a per-minute hit when present", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "retry-after": "5" },
    });

    const result = classifyModelCallError(err, "sambanova", { model: "DeepSeek-V3.1" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBe(5);
  });

  it("classifies a 429 with no parseable rate-limit headers as model_error", () => {
    const err = makeAPICallError({ statusCode: 429, responseHeaders: {} });

    const result = classifyModelCallError(err, "sambanova", { model: "DeepSeek-V3.1" });

    expect(result.code).toBe("model_error");
  });

  it("does not classify a non-sambanova provider's 429 using SambaNova headers", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-reset-requests-day": "23h" },
    });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("unwraps a RetryError around a SambaNova daily-limit APICallError", () => {
    const inner = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining-requests-day": "0", "x-ratelimit-reset-requests-day": "20h" },
    });
    const err = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner],
    });

    const result = classifyModelCallError(err, "sambanova", { model: "DeepSeek-V3.1" });

    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBeGreaterThan(60_000);
  });
});
```

(If Step 1 found a different reset-header format, change the header values in these fixtures to match the real format before running.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: FAIL — no `sambanova` branch in `classifyModelCallError`, every case falls through to `model_error` (so the two `model_error` cases pass and the other four fail).

- [ ] **Step 4: Implement the SambaNova branch in `solver.ts`**

Add the branch in `classifyModelCallError`, right after the existing `openrouter` `if` block (all branches fall through to the same `model_error` return, so order is only for reading):

```ts
  if (provider === "sambanova" && APICallError.isInstance(err) && err.statusCode === 429) {
    // SambaNova's free-tier caps are per-model (20 req/min, 20 req/day, 200K
    // tokens/day). Its 429 carries duration-style reset headers (confirmed
    // against a real 429 — see plan Task 2 Step 1). Classify by reset
    // distance, like the OpenRouter branch: a long reset is the per-model
    // daily (requests or tokens) hit, a short one is the 20 RPM hit.
    const headers = err.responseHeaders ?? {};
    const dayResetSeconds = parseGroqResetDuration(headers["x-ratelimit-reset-requests-day"]);
    const minuteResetSeconds =
      parseGroqResetDuration(headers["x-ratelimit-reset-requests"]) ??
      parseSecondsHeader(headers["retry-after"]);
    const resetSeconds = dayResetSeconds ?? minuteResetSeconds;

    if (resetSeconds === undefined) {
      // No usable rate-limit signal — fall through to model_error, same as
      // the Groq and OpenRouter branches do when their headers are absent.
    } else if (resetSeconds > DAILY_RESET_THRESHOLD_SECONDS) {
      return new SolveError("rate_limited_daily", `SambaNova daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        dailyResetSeconds: resetSeconds,
      });
    } else {
      return new SolveError("rate_limited", `SambaNova rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds: minuteResetSeconds ?? resetSeconds,
      });
    }
  }
```

(If Step 1 required a dedicated `parseSambaNovaResetDuration`, swap it in for the two `parseGroqResetDuration` calls above.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: PASS

- [ ] **Step 6: Extend the provider enums in `types.ts`**

In `orchestrator/src/types.ts`, change both `provider: z.enum([...])` occurrences (in `SolveAssistRequestSchema` and `JudgeCategoryRequestSchema`) to append `"sambanova"`:

```ts
    provider: z.enum(["openai", "ollama", "google", "groq", "openrouter", "sambanova"]).optional()
```

- [ ] **Step 7: Run the full orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: PASS (all suites)

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts orchestrator/src/types.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): classify SambaNova 429s by reset distance

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Backend — widen `OrchestratorService` provider unions

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `solveAssist(...)` / `judgeCategory(...)` accept `provider?: "openai" | "ollama" | "google" | "groq" | "openrouter" | "sambanova"`. `SolveAssistFailure.dailyResetSeconds` already exists and already flows through `extractCallDetail` — no change there.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/strategy/orchestrator.service.spec.ts`, find the existing OpenRouter/Groq `dailyResetSeconds` passthrough test and add a sibling that calls with `provider: "sambanova"`:

```ts
  it("accepts sambanova as a provider and passes dailyResetSeconds through", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "SambaNova daily quota exhausted",
        code: "rate_limited_daily",
        details: { dailyResetSeconds: 7200 },
      }),
    }) as unknown as typeof fetch;

    const service = new OrchestratorService();
    const result = await service.solveAssist([{ role: "user", content: "hi" }], undefined, "sambanova");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rate_limited_daily");
      expect(result.error.dailyResetSeconds).toBe(7200);
    }
  });
```

(Match the exact argument positions/mocking style of the file's existing OpenRouter test — read it first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest orchestrator.service.spec.ts -t "sambanova"`
Expected: FAIL — TypeScript rejects `"sambanova"` as a `provider` argument.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/orchestrator.service.ts`, widen every `"openai" | "ollama" | "google" | "groq" | "openrouter"` union (in the `solveAssist` and `judgeCategory` signatures, and any local type alias) to add `| "sambanova"`. Grep the file for `"openrouter"` to find all sites. `extractCallDetail` and `SolveAssistFailure` already carry `dailyResetSeconds` — leave them unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest orchestrator.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): accept sambanova as an OrchestratorService provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Backend — `strategies.ts` additions

**Files:**
- Modify: `backend/src/strategies.ts`
- Modify: `.env.sample`
- Modify: `README.md`
- Test: `backend/src/strategies.spec.ts`

**Interfaces:**
- Produces: `LLM_SAMBANOVA = "llm-sambanova"`, added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`. Accessors: `llmSambaNovaConcurrency(env?)`, `llmSambaNovaRateLimitFallbackSeconds(env?)`, `llmSambaNovaDailyHoldFallbackSeconds(env?)`, `sambaNovaDispatchTickMs(env?)`, `sambaNovaDispatchMaxBatch(env?)`, `sambaNovaDispatchMaxInFlight(env?)`. Matching `DEFAULT_*` constants.

- [ ] **Step 1: Write the failing tests**

Add the new symbols to `backend/src/strategies.spec.ts`'s import list. Add these `describe` blocks (mirror the existing OpenRouter/Groq blocks' exact style — read one first for the assertion shape):

```ts
  describe("llmSambaNovaConcurrency", () => {
    it("defaults when the env var is missing", () => {
      expect(llmSambaNovaConcurrency({})).toBe(DEFAULT_LLM_SAMBANOVA_CONCURRENCY);
    });
    it("defaults when the env var is invalid", () => {
      expect(llmSambaNovaConcurrency({ LLM_SAMBANOVA_CONCURRENCY: "abc" })).toBe(DEFAULT_LLM_SAMBANOVA_CONCURRENCY);
      expect(llmSambaNovaConcurrency({ LLM_SAMBANOVA_CONCURRENCY: "0" })).toBe(DEFAULT_LLM_SAMBANOVA_CONCURRENCY);
    });
    it("reads a valid positive integer", () => {
      expect(llmSambaNovaConcurrency({ LLM_SAMBANOVA_CONCURRENCY: "3" })).toBe(3);
    });
  });

  describe("llmSambaNovaRateLimitFallbackSeconds", () => {
    it("defaults to 60 when missing", () => {
      expect(llmSambaNovaRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS);
      expect(DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS).toBe(60);
    });
    it("defaults when invalid", () => {
      expect(llmSambaNovaRateLimitFallbackSeconds({ LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
      );
    });
    it("reads a valid positive integer", () => {
      expect(llmSambaNovaRateLimitFallbackSeconds({ LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
    });
  });

  describe("llmSambaNovaDailyHoldFallbackSeconds", () => {
    it("defaults to 3600 when missing", () => {
      expect(llmSambaNovaDailyHoldFallbackSeconds({})).toBe(DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS);
      expect(DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS).toBe(3600);
    });
    it("reads a valid positive integer", () => {
      expect(llmSambaNovaDailyHoldFallbackSeconds({ LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS: "7200" })).toBe(7200);
    });
  });

  describe("sambaNovaDispatch* pacing knobs", () => {
    it("default correctly", () => {
      expect(sambaNovaDispatchTickMs({})).toBe(DEFAULT_SAMBANOVA_DISPATCH_TICK_MS);
      expect(sambaNovaDispatchMaxBatch({})).toBe(DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH);
      expect(sambaNovaDispatchMaxInFlight({})).toBe(DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT);
      expect(DEFAULT_SAMBANOVA_DISPATCH_TICK_MS).toBe(15000);
      expect(DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH).toBe(2);
      expect(DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT).toBe(2);
    });
    it("read valid overrides", () => {
      expect(sambaNovaDispatchTickMs({ SAMBANOVA_DISPATCH_TICK_MS: "20000" })).toBe(20000);
      expect(sambaNovaDispatchMaxBatch({ SAMBANOVA_DISPATCH_MAX_BATCH: "5" })).toBe(5);
      expect(sambaNovaDispatchMaxInFlight({ SAMBANOVA_DISPATCH_MAX_IN_FLIGHT: "5" })).toBe(5);
    });
  });
```

Update the existing `isLlmStrategy` test to add `expect(isLlmStrategy(LLM_SAMBANOVA)).toBe(true);` (read the file first for its exact current assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: FAIL — the new symbols don't exist (ts-jest compile error).

- [ ] **Step 3: Implement in `strategies.ts`**

Add `"llm-sambanova"` to `SUPPORTED_STRATEGIES` (after `"llm-openrouter"`).

```ts
export const LLM_OPENROUTER = "llm-openrouter" as const;
export const LLM_SAMBANOVA = "llm-sambanova" as const;

export const LLM_STRATEGIES = [LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE, LLM_GROQ, LLM_OPENROUTER, LLM_SAMBANOVA] as const;
```

Add the constants near the OpenRouter ones:

```ts
export const DEFAULT_LLM_SAMBANOVA_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying a SambaNova per-minute (20 RPM)
// rate-limit hit, used only when neither retry-after nor a short reset
// duration parsed — see orchestrator/src/solver.ts. A per-minute hit is
// never a run failure; it waits and retries.
export const DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS = 60;

// How long a SambaNova model is held after a daily (requests-per-day or
// tokens-per-day) 429 that carried no parseable reset duration. The resume
// sweep re-checks after this elapses. See
// docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §4.
export const DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS = 3600;

// Dedicated conservative pacing for the fixed 20 req/min + 20 req/day
// per-model free-tier ceiling — NOT the FREE_TIER_DISPATCH_* knobs. Raise
// MAX_BATCH / MAX_IN_FLIGHT (and lower TICK_MS) after linking a payment
// method to unlock SambaNova's Developer tier; no code change.
export const DEFAULT_SAMBANOVA_DISPATCH_TICK_MS = 15_000;
export const DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH = 2;
export const DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT = 2;
```

Add the accessors near `llmOpenRouterConcurrency` (use the same `positiveTrialCount` helper the Groq/OpenRouter accessors use):

```ts
export function llmSambaNovaConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_SAMBANOVA_CONCURRENCY, DEFAULT_LLM_SAMBANOVA_CONCURRENCY);
}

export function llmSambaNovaRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

export function llmSambaNovaDailyHoldFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
    DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
  );
}

export function sambaNovaDispatchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SAMBANOVA_DISPATCH_TICK_MS, DEFAULT_SAMBANOVA_DISPATCH_TICK_MS);
}

export function sambaNovaDispatchMaxBatch(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SAMBANOVA_DISPATCH_MAX_BATCH, DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH);
}

export function sambaNovaDispatchMaxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.SAMBANOVA_DISPATCH_MAX_IN_FLIGHT,
    DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: PASS (including the pre-existing loop-based `SUPPORTED_STRATEGIES` / `LLM_STRATEGIES` tests, which now cover `LLM_SAMBANOVA` automatically).

- [ ] **Step 5: Document the new env vars**

In `.env.sample`, after the OpenRouter block add:

```

# --- SambaNova Cloud (llm-sambanova strategy) ---

# Worker concurrency for llm-sambanova-runs (own queue; never blocks the
# other providers). (default: 1)
LLM_SAMBANOVA_CONCURRENCY=1

# Fallback wait (seconds) before retrying a SambaNova per-minute (20 RPM)
# rate-limit hit — only used when the 429's own headers don't yield a wait.
# A per-minute hit is never a run failure; it waits and retries. (default: 60)
LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS=60

# How long a SambaNova model is held after a daily (req/day or tokens/day)
# 429 that carried no parseable reset duration. (default: 3600)
LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS=3600

# Dedicated conservative pacing for the fixed 20 req/min + 20 req/day
# per-model free tier. Raise MAX_BATCH / MAX_IN_FLIGHT (and lower TICK_MS)
# after linking a payment method for SambaNova's Developer tier.
SAMBANOVA_DISPATCH_TICK_MS=15000
SAMBANOVA_DISPATCH_MAX_BATCH=2
SAMBANOVA_DISPATCH_MAX_IN_FLIGHT=2
```

In `README.md`'s env var table, after the OpenRouter rows add one row per new var with the same descriptions.

- [ ] **Step 6: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts .env.sample README.md
git commit -m "$(cat <<'EOF'
feat(backend): register the llm-sambanova strategy and its config knobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Backend — `SambaNovaRateLimitHold` entity and service

**Files:**
- Create: `backend/src/modules/strategy/entities/sambanova-rate-limit-hold.entity.ts`
- Create: `backend/src/modules/strategy/sambanova-rate-limit-hold.service.ts`
- Create: `backend/src/migrations/1793000000000-add-sambanova-rate-limit-hold.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/data-source.ts`
- Test: `backend/src/modules/strategy/sambanova-rate-limit-hold.service.spec.ts`

**Interfaces:**
- Consumes: nothing besides `SambaNovaRateLimitHold` (defined here) and `LLM_SAMBANOVA` (Task 4).
- Produces:
  - `SambaNovaRateLimitHoldService.hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void>`
  - `.isHeld(strategyName: string, modelName: string): Promise<boolean>`
  - `.heldModels(strategyName: string): Promise<string[]>`
  - `.nextResetAt(strategyName: string): Promise<Date | null>`
  - `.clearExpired(): Promise<string[]>` — returns freed model names

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/sambanova-rate-limit-hold.service.spec.ts`, modeled 1:1 on `backend/src/modules/strategy/groq-rate-limit-hold.service.spec.ts` (read that file, then substitute `Groq` → `SambaNova`, `llm-groq` → `llm-sambanova`, model ids → `"DeepSeek-V3.1"` / `"gpt-oss-120b"`). It must cover:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SambaNovaRateLimitHoldService } from "./sambanova-rate-limit-hold.service";
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";

const STRATEGY = "llm-sambanova";

describe("SambaNovaRateLimitHoldService", () => {
  let service: SambaNovaRateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SambaNovaRateLimitHoldService,
        { provide: getRepositoryToken(SambaNovaRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(SambaNovaRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("hold(strategy, model, n) upserts on (strategyName, modelName) with resetAt = now + n", async () => {
    const before = Date.now();
    await service.hold(STRATEGY, "DeepSeek-V3.1", 3600);
    const after = Date.now();

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: STRATEGY, modelName: "DeepSeek-V3.1" });
    expect(row.resetAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(row.resetAt.getTime()).toBeLessThanOrEqual(after + 3600 * 1000);
    expect(conflictPaths).toEqual(["strategyName", "modelName"]);
  });

  it("isHeld reflects only a live row for that exact model", async () => {
    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld(STRATEGY, "DeepSeek-V3.1")).toBe(true);

    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld(STRATEGY, "DeepSeek-V3.1")).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.isHeld(STRATEGY, "gpt-oss-120b")).toBe(false);
  });

  it("heldModels returns model names with a still-future resetAt", async () => {
    repo.find.mockResolvedValueOnce([
      { modelName: "DeepSeek-V3.1", resetAt: new Date(Date.now() + 60_000) },
      { modelName: "gpt-oss-120b", resetAt: new Date(Date.now() + 120_000) },
    ]);
    expect(await service.heldModels(STRATEGY)).toEqual(["DeepSeek-V3.1", "gpt-oss-120b"]);
  });

  it("nextResetAt returns the soonest still-future resetAt, or null", async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);
    repo.find.mockResolvedValueOnce([{ resetAt: later }, { resetAt: soon }]);
    expect(await service.nextResetAt(STRATEGY)).toEqual(soon);

    repo.find.mockResolvedValueOnce([]);
    expect(await service.nextResetAt(STRATEGY)).toBeNull();
  });

  it("clearExpired removes elapsed rows and returns their model names", async () => {
    const expired = [{ modelName: "DeepSeek-V3.1", resetAt: new Date(Date.now() - 1000) }];
    repo.find.mockResolvedValueOnce(expired);
    expect(await service.clearExpired()).toEqual(["DeepSeek-V3.1"]);
    expect(repo.remove).toHaveBeenCalledWith(expired);

    repo.find.mockResolvedValueOnce([]);
    expect(await service.clearExpired()).toEqual([]);
    expect(repo.remove).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest sambanova-rate-limit-hold.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/strategy/entities/sambanova-rate-limit-hold.entity.ts`:

```ts
import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for which SambaNova models are currently held for
 * exhausting a free-tier per-day quota (requests-per-day or tokens-per-day).
 * One row per held (strategyName, modelName); SambaNovaRpdResumeService
 * clears rows whose resetAt has passed. A structural copy of
 * GroqRateLimitHold — SambaNova's free-tier caps are per-model, and its
 * rate-limit headers give a reset *duration* from the hit rather than a
 * shared reset clock, so resetAt is heldAt plus that hit's parsed reset
 * distance. See docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §3.
 */
@Entity("SambaNovaRateLimitHold")
@Unique("UQ_SambaNovaRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class SambaNovaRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Column({ type: "timestamptz" })
  resetAt: Date;
}
```

- [ ] **Step 4: Create the service**

Create `backend/src/modules/strategy/sambanova-rate-limit-hold.service.ts` — a near-verbatim copy of `groq-rate-limit-hold.service.ts` with the `Groq` → `SambaNova` renames:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";

/**
 * The SambaNova counterpart to GroqRateLimitHoldService: source of truth
 * for which SambaNova models are currently held for exhausting a free-tier
 * per-day quota. No timezone math — SambaNova's rate-limit headers give a
 * reset *duration* from the moment of the hit (see
 * orchestrator/src/solver.ts's sambanova branch), not a fixed daily clock
 * boundary. See docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md.
 */
@Injectable()
export class SambaNovaRateLimitHoldService {
  private readonly logger = new Logger(SambaNovaRateLimitHoldService.name);

  constructor(
    @InjectRepository(SambaNovaRateLimitHold)
    private readonly repo: Repository<SambaNovaRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void> {
    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert({ strategyName, modelName, heldAt, resetAt }, ["strategyName", "modelName"]);
    this.logger.warn(`RPD hold set for ${strategyName}/${modelName} until ${resetAt.toISOString()}`);
  }

  async isHeld(strategyName: string, modelName: string): Promise<boolean> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row !== null && row.resetAt.getTime() > Date.now();
  }

  async heldModels(strategyName: string): Promise<string[]> {
    const rows = await this.repo.find({ where: { strategyName, resetAt: MoreThan(new Date()) } });
    return rows.map((r) => r.modelName);
  }

  async nextResetAt(strategyName: string): Promise<Date | null> {
    const rows = await this.repo.find({ where: { strategyName, resetAt: MoreThan(new Date()) } });
    if (rows.length === 0) return null;
    return rows.reduce((soonest, row) =>
      row.resetAt.getTime() < soonest.resetAt.getTime() ? row : soonest,
    ).resetAt;
  }

  async clearExpired(): Promise<string[]> {
    const expired = await this.repo.find({ where: { resetAt: LessThanOrEqual(new Date()) } });
    if (expired.length > 0) {
      await this.repo.remove(expired);
    }
    return expired.map((r) => r.modelName);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx jest sambanova-rate-limit-hold.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Register the entity on the root connection**

In `backend/src/app.module.ts`: add `import { SambaNovaRateLimitHold } from "./modules/strategy/entities/sambanova-rate-limit-hold.entity";` next to the `OpenRouterRateLimitHold` import, and add `SambaNovaRateLimitHold,` to the `entities: [...]` array right after `OpenRouterRateLimitHold,`.

In `backend/src/data-source.ts`: the same import and the same array addition.

- [ ] **Step 7: Create the migration**

Create `backend/src/migrations/1793000000000-add-sambanova-rate-limit-hold.ts` (verify `1793...` is free above the current highest, `1791`; bump all four SambaNova migration timestamps together if not):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the SambaNovaRateLimitHold table (one row per SambaNova model held
 * for hitting a free-tier per-day quota) — a structural copy of
 * GroqRateLimitHold. No enum migration needed: 'rateLimitedDaily' already
 * exists on strategy_run_status_enum and is reused. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md.
 */
export class AddSambaNovaRateLimitHold1793000000000 implements MigrationInterface {
  name = "AddSambaNovaRateLimitHold1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SambaNovaRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_SambaNovaRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SambaNovaRateLimitHold_resetAt"
       ON "SambaNovaRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "SambaNovaRateLimitHold"`);
  }
}
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/strategy/entities/sambanova-rate-limit-hold.entity.ts backend/src/modules/strategy/sambanova-rate-limit-hold.service.ts backend/src/modules/strategy/sambanova-rate-limit-hold.service.spec.ts backend/src/migrations/1793000000000-add-sambanova-rate-limit-hold.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "$(cat <<'EOF'
feat(backend): add SambaNovaRateLimitHold (per-model hold rows)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Backend — wire SambaNova into `LlmStrategyRunner`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `LLM_SAMBANOVA`, `llmSambaNovaRateLimitFallbackSeconds`, `llmSambaNovaDailyHoldFallbackSeconds` (Task 4); `SambaNovaRateLimitHoldService` (Task 5); `SolveAssistFailure.dailyResetSeconds` (already present).
- Produces: no new exports — changes `runLlmStrategy`'s internal behavior only.

- [ ] **Step 1: Write the failing tests**

In `llm-strategy-runner.service.spec.ts`, add a mock `mockSambaNovaHold` matching the shape of the existing `mockGroqRpdHold`: `{ isHeld: jest.fn(), hold: jest.fn(), heldModels: jest.fn(), nextResetAt: jest.fn(), clearExpired: jest.fn() }`. Provide it via `{ provide: SambaNovaRateLimitHoldService, useValue: mockSambaNovaHold }`. Default `mockSambaNovaHold.isHeld.mockResolvedValue(false)` in `beforeEach`.

Add tests mirroring the Groq per-model block (read the existing `llm-groq` `rate_limited_daily` tests to copy the harness helpers `makeRun` / `solvePuzzle` / `makeAssistResponse`):

```ts
    it("parks a held sambanova run at RATE_LIMITED_DAILY without calling the orchestrator", async () => {
      mockSambaNovaHold.isHeld.mockResolvedValue(true);
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);

      const result = await runner.runLlmStrategy(100, "llm-sambanova", 0, "DeepSeek-V3.1");

      expect(mockOrchestratorService.solveAssist).not.toHaveBeenCalled();
      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockSambaNovaHold.hold).not.toHaveBeenCalled();
    });

    it("records a per-model SambaNova hold using dailyResetSeconds and parks the run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "SambaNova daily quota exhausted", code: "rate_limited_daily", dailyResetSeconds: 7200 },
      });

      const result = await runner.runLlmStrategy(100, "llm-sambanova", 0, "DeepSeek-V3.1");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockSambaNovaHold.hold).toHaveBeenCalledWith("llm-sambanova", "DeepSeek-V3.1", 7200);
    });

    it("falls back to llmSambaNovaDailyHoldFallbackSeconds when a daily hit carries no dailyResetSeconds", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      await runner.runLlmStrategy(100, "llm-sambanova", 0, "DeepSeek-V3.1");

      expect(mockSambaNovaHold.hold).toHaveBeenCalledWith(
        "llm-sambanova",
        "DeepSeek-V3.1",
        DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
      );
    });

    it("does not write a hold on a sambanova per-minute rate_limited hit, and keeps retrying (not a failure)", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce({ ok: false, error: { error: "rate limited", code: "rate_limited" } })
        .mockResolvedValue(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]));

      const result = await runner.runLlmStrategy(100, "llm-sambanova", 0, "DeepSeek-V3.1");

      expect(mockSambaNovaHold.hold).not.toHaveBeenCalled();
      expect(result.status).not.toBe(StrategyRunStatus.ERROR);
    });

    it("never ends a sambanova run in ERROR on a rate_limited_daily hit", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      const result = await runner.runLlmStrategy(100, "llm-sambanova", 0, "DeepSeek-V3.1");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
    });
```

Import `DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS` from `"../../strategies"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts -t "sambanova"`
Expected: FAIL — `SambaNovaRateLimitHoldService` isn't injected/used; `llm-sambanova` routes to no provider branch.

- [ ] **Step 3: Implement in `llm-strategy-runner.service.ts`**

Update imports — add `LLM_SAMBANOVA`, `llmSambaNovaRateLimitFallbackSeconds`, `llmSambaNovaDailyHoldFallbackSeconds` to the `"../../strategies"` import, and:

```ts
import { SambaNovaRateLimitHoldService } from "./sambanova-rate-limit-hold.service";
```

Add the constructor param, alongside `groqRpdHold` (explicit `@Inject`):

```ts
    @Inject(SambaNovaRateLimitHoldService)
    private readonly sambaNovaHold: SambaNovaRateLimitHoldService,
```

Provider resolution — extend the ternary chain, adding the SambaNova arm before the `"openai"` default (after the `LLM_OPENROUTER` arm):

```ts
            : strategyName === LLM_OPENROUTER
              ? "openrouter"
              : strategyName === LLM_SAMBANOVA
                ? "sambanova"
                : "openai";
```

Top gate — extend the existing per-model `groqRpdHold` gate condition so it also covers SambaNova (both are per-model `isHeld(strategyName, modelName)` checks with the identical park-and-return body). Read the existing Groq gate and add an OR arm or a parallel `if` with the same body:

```ts
    if (
      strategyName === LLM_SAMBANOVA &&
      model &&
      (await this.sambaNovaHold.isHeld(strategyName, model))
    ) {
      // identical to the Groq per-model gate: park immediately, zero
      // orchestrator calls
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
      await this.strategyRunRepo.save(run);
      return { status: run.status };
    }
```

(Match the exact fields/return shape of the Groq gate block in this file.)

Per-provider rate-limit fallback — extend the existing computation with a SambaNova arm:

```ts
    const rateLimitFallbackSeconds =
      strategyName === LLM_GROQ
        ? llmGroqRateLimitFallbackSeconds()
        : strategyName === LLM_OPENROUTER
          ? llmOpenRouterRateLimitFallbackSeconds()
          : strategyName === LLM_SAMBANOVA
            ? llmSambaNovaRateLimitFallbackSeconds()
            : llmGoogleRateLimitFallbackSeconds();
```

On the failed-call classification — in the `outcome.error.code === "rate_limited_daily" && model` block, add the SambaNova arm alongside Groq's (it is the same per-model `hold(strategyName, model, seconds)` call):

```ts
          } else if (strategyName === LLM_SAMBANOVA) {
            await this.sambaNovaHold.hold(
              strategyName,
              model,
              outcome.error.dailyResetSeconds ?? llmSambaNovaDailyHoldFallbackSeconds(),
            );
          }
```

Do **not** add any `rate_limited` (per-minute) hold-writing branch for SambaNova — the per-minute path stays pure wait-and-retry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS (full file — confirms the Google/Groq/OpenRouter paths are unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-sambanova runs through the per-model hold gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Backend — SambaNova's own BullMQ queue and `queueForStrategy`

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/strategy.queue.spec.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`

**Interfaces:**
- Produces: `llmSambaNovaQueue: Queue` (name `"llm-sambanova-runs"`). `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, groqQueue, openRouterQueue, sambaNovaQueue, strategyName): Queue` (8 args). `LLM_SAMBANOVA_QUEUE` DI token, exported from `QueueModule`.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/queue/strategy.queue.spec.ts`, extend the `queueForStrategy` describe block — add `LLM_SAMBANOVA` to the strategies import, `const sambanova = { name: "sambanova" } as never;`, and:

```ts
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, sambanova, LLM_SAMBANOVA)).toBe(sambanova);
```

Add `sambanova` as the seventh queue arg to every existing `queueForStrategy(...)` call in that describe block (before the `strategyName` arg).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: FAIL — TypeScript arity mismatch (`queueForStrategy` takes 7 args today, this calls it with 8).

- [ ] **Step 3: Implement**

In `backend/src/modules/queue/strategy.queue.ts` — add `LLM_SAMBANOVA` to the strategies import, then:

```ts
export const llmSambaNovaQueue = new Queue("llm-sambanova-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

(Match the exact `defaultJobOptions` of `llmOpenRouterQueue` in this file — copy them verbatim.)

```ts
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  groqQueue: Queue,
  openRouterQueue: Queue,
  sambaNovaQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  if (strategyName === LLM_GROQ) return groqQueue;
  if (strategyName === LLM_OPENROUTER) return openRouterQueue;
  if (strategyName === LLM_SAMBANOVA) return sambaNovaQueue;
  return defaultQueue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire the token into `queue.module.ts`**

Import `llmSambaNovaQueue` from `./strategy.queue`. Add `export const LLM_SAMBANOVA_QUEUE = "LLM_SAMBANOVA_QUEUE";`. Add `{ provide: LLM_SAMBANOVA_QUEUE, useValue: llmSambaNovaQueue }` to `providers` and `LLM_SAMBANOVA_QUEUE` to `exports`.

If `queue.module.ts` builds a Bull Board / queue-list array (the repo added `llm-groq-runs` to Bull Board in commit `651c29c`), add `llmSambaNovaQueue` to that list too.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/strategy.queue.spec.ts backend/src/modules/queue/queue.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the llm-sambanova-runs queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Backend — wire SambaNova's queue into `StrategyService` and `StrategyModule`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`

**Interfaces:**
- Consumes: `LLM_SAMBANOVA_QUEUE` (Task 7); `SambaNovaRateLimitHold` / `SambaNovaRateLimitHoldService` (Task 5).
- Produces: `queueFor` routes `llm-sambanova` to its queue; `queuedCountsByKey` includes it.

- [ ] **Step 1: Write the failing test**

Add a `mockLlmSambaNovaQueue` sibling in `strategy.service.spec.ts`'s `TestingModule` (same mock shape as the existing `mockLlmOpenRouterQueue`), provided via `LLM_SAMBANOVA_QUEUE`.

```ts
  it("routes llm-sambanova runs to the llm-sambanova-runs queue", async () => {
    mockSupportedModelService.assertSupported.mockResolvedValue(undefined);

    await service.triggerRun(1, "llm-sambanova", "2026-01-01", 0, "DeepSeek-V3.1");

    expect(mockLlmSambaNovaQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-sambanova", model: "DeepSeek-V3.1" }),
      expect.anything(),
    );
  });
```

(Match the file's actual `triggerRun` signature — read an existing `routes llm-openrouter` test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest strategy.service.spec.ts -t "sambanova"`
Expected: FAIL — `LLM_SAMBANOVA_QUEUE` unknown token; `queueFor` doesn't route `llm-sambanova`.

- [ ] **Step 3: Implement in `strategy.service.ts`**

Add `LLM_SAMBANOVA_QUEUE` to the `../queue/queue.module` import. Add the constructor param after `@Inject(LLM_OPENROUTER_QUEUE)`:

```ts
    @Inject(LLM_SAMBANOVA_QUEUE) private readonly llmSambaNovaQueue: Queue,
```

`queueFor` — add `this.llmSambaNovaQueue` as the seventh queue arg to the `queueForStrategy(...)` call (before `strategyName`).

`queuedCountsByKey`'s queue list — append `this.llmSambaNovaQueue`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest strategy.service.spec.ts`
Expected: PASS (full file)

- [ ] **Step 5: Register the SambaNova hold in `StrategyModule`**

In `strategy.module.ts`:

```ts
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";
import { SambaNovaRateLimitHoldService } from "./sambanova-rate-limit-hold.service";
```

Add `SambaNovaRateLimitHold` to `TypeOrmModule.forFeature([...])`, `SambaNovaRateLimitHoldService` to `providers`, and to `exports` (Task 9's dispatch module and Task 10's resume service both need it).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-sambanova dispatch through its own queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Backend — `SambaNovaFreeDispatchService`

**Files:**
- Create: `backend/src/modules/sambanova-free-dispatch/entities/sambanova-dispatch-state.entity.ts`
- Create: `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.ts`
- Create: `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.module.ts`
- Create: `backend/src/modules/queue/sambanova-free-dispatch.queue.ts`
- Create: `backend/src/migrations/1794000000000-add-sambanova-dispatch-state.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/data-source.ts`
- Test: `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `StrategyService.findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` / `countInFlightByModel` / `countTodayDispatchByModel`; `SupportedModelService.findModelNamesByStrategy`; `SambaNovaRateLimitHoldService.heldModels` (Task 5); `sambaNovaDispatch*` accessors (Task 4).
- Produces: `SambaNovaFreeDispatchService.start()`, `.stop()`, `.getStatus()`, `.runTick()`. `SambaNovaDispatchStatusDto = { active: boolean; startedAt: Date | null }` — consumed by Task 11 (worker), Task 13 (endpoints), Task 14 (automation).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.spec.ts`. Start from `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.spec.ts` as the harness template (`TestingModule` setup, `stateRepo` single-row mock, the exact mock shapes below), then substitute `Groq` → `SambaNova`, `llm-groq` → `llm-sambanova`, `"groq"` state id → `"sambanova"`, model names → `["DeepSeek-V3.1", "gpt-oss-120b"]`, and swap the Groq pacing knobs for the SambaNova ones. The behaviors to cover (identical set to Groq's spec — this service is a rename, not a redesign):

```ts
  const stateRepo = { findOne: jest.fn(), save: jest.fn(), update: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const strategyService = {
    countInFlightByModel: jest.fn().mockResolvedValue(new Map()),
    countTodayDispatchByModel: jest.fn().mockResolvedValue(new Map()),
    findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2026-01-01" }]),
    triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
  };
  const supportedModelService = {
    findModelNamesByStrategy: jest.fn().mockResolvedValue(["DeepSeek-V3.1", "gpt-oss-120b"]),
  };
  const holdService = { heldModels: jest.fn().mockResolvedValue([]) };
```

Tests:

```ts
  describe("start", () => {
    it("starts a cycle and enqueues the first tick when at least one model is free", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "sambanova", active: false });
      const { outcome } = await service.start();
      expect(outcome).toBe("started");
      expect(stateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: "sambanova", active: true }));
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("returns alreadyExhausted (no tick) when every configured model is held", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "sambanova", active: false });
      holdService.heldModels.mockResolvedValue(["DeepSeek-V3.1", "gpt-oss-120b"]);
      const { outcome } = await service.start();
      expect(outcome).toBe("alreadyExhausted");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("throws when a cycle is already active", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "sambanova", active: true });
      await expect(service.start()).rejects.toThrow(/already running/i);
    });
  });

  describe("runTick", () => {
    beforeEach(() => stateRepo.findOne.mockResolvedValue({ id: "sambanova", active: true }));

    it("does nothing when not active", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "sambanova", active: false });
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("stops the cycle when every configured model is held", async () => {
      holdService.heldModels.mockResolvedValue(["DeepSeek-V3.1", "gpt-oss-120b"]);
      await service.runTick();
      expect(stateRepo.update).toHaveBeenCalledWith({ id: "sambanova" }, { active: false });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("dispatches a batch across the least-allocated non-held models and reschedules", async () => {
      holdService.heldModels.mockResolvedValue([]);
      strategyService.countTodayDispatchByModel.mockResolvedValue(
        new Map([["DeepSeek-V3.1", 0], ["gpt-oss-120b", 0]]),
      );
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: 15_000 }));
    });

    it("waits (reschedules, no dispatch) when in-flight is at the cap", async () => {
      strategyService.countInFlightByModel.mockResolvedValue(new Map([["DeepSeek-V3.1", 2]]));
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: 15_000 }));
    });

    it("stops when every eligible model is out of unrun puzzles", async () => {
      strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);
      await service.runTick();
      expect(stateRepo.update).toHaveBeenCalledWith({ id: "sambanova" }, { active: false });
    });

    it("honours SAMBANOVA_DISPATCH_MAX_BATCH / MAX_IN_FLIGHT overrides", async () => {
      process.env.SAMBANOVA_DISPATCH_MAX_BATCH = "1";
      strategyService.countTodayDispatchByModel.mockResolvedValue(
        new Map([["DeepSeek-V3.1", 0], ["gpt-oss-120b", 0]]),
      );
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).toHaveBeenCalledTimes(1);
      delete process.env.SAMBANOVA_DISPATCH_MAX_BATCH;
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest sambanova-free-dispatch.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/sambanova-free-dispatch/entities/sambanova-dispatch-state.entity.ts` — a copy of `groq-dispatch-state.entity.ts` with `Groq` → `SambaNova` and `id is always "groq"` → `"sambanova"`:

```ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "sambanova") tracking whether the
 * SambaNova free-tier dispatch cycle (SambaNovaFreeDispatchService) is
 * currently running — the SambaNova counterpart to GroqDispatchState.
 */
@Entity("SambaNovaDispatchState")
export class SambaNovaDispatchState {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ type: "boolean", default: false })
  active: boolean;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @UpdateDateColumn({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  updatedAt: Date;
}
```

- [ ] **Step 4: Create the queue**

Create `backend/src/modules/queue/sambanova-free-dispatch.queue.ts` — a copy of `groq-free-dispatch.queue.ts` with the renames:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the SambaNova free-tier dispatch cycle (see
// SambaNovaFreeDispatchService) — the SambaNova counterpart to
// groq-free-dispatch.queue.ts. Each job is one "tick": it checks which
// SambaNova models are currently RPD-held, queues the next small batch of
// trials against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const sambaNovaFreeDispatchQueue = new Queue("sambanova-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
```

Wire into `queue.module.ts`: import it, add `export const SAMBANOVA_FREE_DISPATCH_QUEUE = "SAMBANOVA_FREE_DISPATCH_QUEUE";`, and its provider/export entries.

- [ ] **Step 5: Create the service**

Create `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.ts` — a copy of `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts` with these mechanical changes:

- `Groq` → `SambaNova` / `groq` → `sambanova` throughout (class name, logger strings, `STATE_ID = "sambanova"`, `GROQ_DISPATCH_STATE_ID` → `SAMBANOVA_DISPATCH_STATE_ID`, `freshTickJobId` prefix `sambanova-free-dispatch-`).
- Import `SambaNovaDispatchState`, `SAMBANOVA_FREE_DISPATCH_QUEUE`, `SambaNovaRateLimitHoldService`, and from `"../../strategies"`: `LLM_SAMBANOVA`, `sambaNovaDispatchMaxBatch`, `sambaNovaDispatchMaxInFlight`, `sambaNovaDispatchTickMs` — replacing the Groq imports (`LLM_GROQ`, `freeTierDispatchMaxBatch`, `freeTierDispatchMaxInFlight`, `freeTierDispatchTickMs`).
- Every `freeTierDispatchMaxInFlight()` → `sambaNovaDispatchMaxInFlight()`, `freeTierDispatchMaxBatch()` → `sambaNovaDispatchMaxBatch()`, `freeTierDispatchTickMs()` → `sambaNovaDispatchTickMs()`.
- Every `LLM_GROQ` → `LLM_SAMBANOVA`.
- `export interface SambaNovaDispatchStatusDto { active: boolean; startedAt: Date | null; }` — unchanged shape from Groq's (no `callsToday`).
- The stop condition, batching, `leastAllocatedModel`, `heldModels`-filter, and self-rescheduling tick are all **kept exactly as Groq's** — this is dispatch-until-held, no budget math.
- Seed the `allocation` map from `eligibleModels` at `0` before the dispatch loop if Groq's version does (per the note in the OpenRouter plan — check `countTodayDispatchByModel`'s return and match Groq's handling so `leastAllocatedModel` considers every eligible model).

The resulting file should differ from `groq-free-dispatch.service.ts` only by identifier renames and the four accessor swaps.

- [ ] **Step 6: Create the module**

Create `backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { SambaNovaDispatchState } from "./entities/sambanova-dispatch-state.entity";
import { SambaNovaFreeDispatchService } from "./sambanova-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([SambaNovaDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [SambaNovaFreeDispatchService],
  exports: [SambaNovaFreeDispatchService],
})
export class SambaNovaFreeDispatchModule {}
```

(Match `groq-free-dispatch.module.ts`'s exact import list — copy it and rename.)

- [ ] **Step 7: Register the entity on the root connection**

In `backend/src/app.module.ts`: import `SambaNovaDispatchState` next to `OpenRouterDispatchState`, add `SambaNovaDispatchState,` to `entities: [...]` right after `OpenRouterDispatchState,`.
In `backend/src/data-source.ts`: the same.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && npx jest sambanova-free-dispatch.service.spec.ts`
Expected: PASS

- [ ] **Step 9: Create the migration**

Create `backend/src/migrations/1794000000000-add-sambanova-dispatch-state.ts` — a copy of `1783000000000-add-groq-dispatch-state.ts` with `Groq` → `SambaNova`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the SambaNova free-tier dispatch cycle
 * is currently running — the SambaNova counterpart to GroqDispatchState.
 */
export class AddSambaNovaDispatchState1794000000000 implements MigrationInterface {
  name = "AddSambaNovaDispatchState1794000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SambaNovaDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "SambaNovaDispatchState"`);
  }
}
```

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/sambanova-free-dispatch backend/src/modules/queue/sambanova-free-dispatch.queue.ts backend/src/modules/queue/queue.module.ts backend/src/migrations/1794000000000-add-sambanova-dispatch-state.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "$(cat <<'EOF'
feat(backend): add SambaNovaFreeDispatchService (dispatch-until-held)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Backend — `SambaNovaRpdResumeService` and bootstrap (self-rescheduling)

**Files:**
- Create: `backend/src/modules/strategy/sambanova-rpd-resume.service.ts`
- Create: `backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.ts`
- Create: `backend/src/modules/queue/sambanova-rpd-resume.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`
- Test: `backend/src/modules/strategy/sambanova-rpd-resume.service.spec.ts`
- Test: `backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.spec.ts`

**Interfaces:**
- Consumes: `SambaNovaRateLimitHoldService` (Task 5), `LLM_SAMBANOVA_QUEUE` (Task 7), `SAMBANOVA_RPD_RESUME_QUEUE` (this task), `runStrategyJobId` (pre-existing, `./queue/strategy.queue`).
- Produces: `SambaNovaRpdResumeService.runResume(triggerJobId: string): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }>` — used by Task 11 (worker).

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/modules/strategy/sambanova-rpd-resume.service.spec.ts`, modeled 1:1 on `backend/src/modules/strategy/groq-rpd-resume.service.spec.ts` (read it, then substitute `Groq` → `SambaNova`, `llm-groq` → `llm-sambanova`, `GROQ_RPD_RESUME_QUEUE` → `SAMBANOVA_RPD_RESUME_QUEUE`, `LLM_GROQ_QUEUE` → `LLM_SAMBANOVA_QUEUE`, model ids → `"DeepSeek-V3.1"`). It must cover the same cases Groq's spec covers, including the `rearm()` self-scheduling case:

- clears expired holds via `holdService.clearExpired()`, re-dispatches every parked `llm-sambanova` run whose model is no longer in `heldModels`, flips it to `RUNNING`, and enqueues onto `LLM_SAMBANOVA_QUEUE` with a `-resume-<stamp>` job id built from `runStrategyJobId(puzzleId, strategyName, trialNumber)`;
- a run whose model is still held is skipped and triggers `rearm()` — a job enqueued onto `SAMBANOVA_RPD_RESUME_QUEUE` with `delay` = time to the soonest live hold's `resetAt`, clamped to `REARM_MAX_DELAY_MS`;
- `triggerJobId` is used as the resume stamp (stable across a retried sweep);
- an enqueue failure leaves that run parked (not flipped to `RUNNING`);
- no parked runs → `{ cleared, redispatched: 0 }`, no `rearm`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest sambanova-rpd-resume.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `backend/src/modules/strategy/sambanova-rpd-resume.service.ts` — a copy of `backend/src/modules/strategy/groq-rpd-resume.service.ts` with `Groq` → `SambaNova` / `groq` → `sambanova` throughout (class name, logger strings, `LLM_GROQ` → `LLM_SAMBANOVA`, `GROQ_RPD_RESUME_QUEUE` → `SAMBANOVA_RPD_RESUME_QUEUE`, `LLM_GROQ_QUEUE` → `LLM_SAMBANOVA_QUEUE`, the rearm job id prefix `groq-rpd-resume-rearm-` → `sambanova-rpd-resume-rearm-`, the resume-job name `resume-groq-rpd` → `resume-sambanova-rpd`). Keep `REARM_MAX_DELAY_MS = 15 * 60_000`, the `runResume(triggerJobId)` signature, the `stamp = triggerJobId` behavior, the `heldModels` skip check, and the `rearm()` self-scheduling logic **exactly as Groq's**. Update the doc comment to reference `docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §6` and say "SambaNova's rate-limit headers give a per-hit reset duration, so — like Groq, unlike Google/OpenRouter — there is no fixed daily cron; `rearm()` is the sole ongoing scheduler."

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest sambanova-rpd-resume.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Create the queue**

Create `backend/src/modules/queue/sambanova-rpd-resume.queue.ts` — a copy of `groq-rpd-resume.queue.ts` with `groq` → `sambanova`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the SambaNova per-model requests-per-day hold resume (see
// SambaNovaRpdResumeService / SambaNovaRpdResumeBootstrap). Like
// groq-rpd-resume.queue.ts and unlike google-rpd-resume.queue.ts, no fixed
// daily schedule is registered — SambaNovaRpdResumeBootstrap only enqueues
// one startup catch-up job; every job after that is a self-scheduled
// "rearm" from SambaNovaRpdResumeService.runResume() targeting the soonest
// live hold's own resetAt.
export const sambaNovaRpdResumeQueue = new Queue("sambanova-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
```

Wire into `queue.module.ts`: import it, add `export const SAMBANOVA_RPD_RESUME_QUEUE = "SAMBANOVA_RPD_RESUME_QUEUE";`, and its provider/export entries.

- [ ] **Step 6: Write the failing test for the bootstrap**

Create `backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.spec.ts`, modeled on `groq-rpd-resume.bootstrap.spec.ts` (read it):

```ts
import { Queue } from "bullmq";
import { SambaNovaRpdResumeBootstrap } from "./sambanova-rpd-resume.bootstrap";

describe("SambaNovaRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { add: jest.Mock; upsertJobScheduler: jest.Mock };

  beforeEach(() => {
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("enqueues one startup catch-up sweep and registers NO fixed cron", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new SambaNovaRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-sambanova-rpd");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `sambanova-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new SambaNovaRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd backend && npx jest sambanova-rpd-resume.bootstrap.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the bootstrap**

Create `backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.ts` — a copy of `groq-rpd-resume.bootstrap.ts` with `Groq` → `SambaNova` / `groq` → `sambanova` (class name, `GROQ_RPD_RESUME_QUEUE` → `SAMBANOVA_RPD_RESUME_QUEUE`, resume-job name `resume-groq-rpd` → `resume-sambanova-rpd`, startup job id prefix `groq-rpd-resume-startup-catch-up-` → `sambanova-rpd-resume-startup-catch-up-`, log strings). Keep the "no fixed cron — see `rearm()`" structure exactly. Update the doc comment to reference the SambaNova spec §6.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend && npx jest sambanova-rpd-resume.bootstrap.spec.ts`
Expected: PASS

- [ ] **Step 10: Wire both into `StrategyModule`**

In `strategy.module.ts`, import `SambaNovaRpdResumeService` and `SambaNovaRpdResumeBootstrap`, add both to `providers`, and add `SambaNovaRpdResumeService` to `exports` (Task 11's worker reads it via `appContext.get`).

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/strategy/sambanova-rpd-resume.service.ts backend/src/modules/strategy/sambanova-rpd-resume.service.spec.ts backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.ts backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.spec.ts backend/src/modules/queue/sambanova-rpd-resume.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add SambaNovaRpdResumeService with a self-rescheduling sweep

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Backend — wire the three new workers into `worker.ts`

**Files:**
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `SambaNovaFreeDispatchService` (Task 9), `SambaNovaRpdResumeService` (Task 10), `llmSambaNovaConcurrency` (Task 4).
- Produces: nothing exported — verified by typecheck + the Task 16 smoke test.

- [ ] **Step 1: Implement**

Add imports (next to the OpenRouter equivalents):

```ts
import { SambaNovaFreeDispatchService } from "./modules/sambanova-free-dispatch/sambanova-free-dispatch.service";
import { SambaNovaRpdResumeService } from "./modules/strategy/sambanova-rpd-resume.service";
```

Add `LLM_SAMBANOVA` and `llmSambaNovaConcurrency` to the existing `"./strategies"` import.

In `bootstrap()`, alongside the other `appContext.get(...)` calls:

```ts
  const sambaNovaFreeDispatchService = appContext.get(SambaNovaFreeDispatchService);
  const sambaNovaRpdResumeService = appContext.get(SambaNovaRpdResumeService);
```

Extend `createLlmWorker`'s `queueName` parameter type to add `| "llm-sambanova-runs"`.

In the `if (role !== "ollama")` block, right after the `llmOpenRouterWorker` push:

```ts
    const llmSambaNovaWorker = createLlmWorker(
      "llm-sambanova-runs",
      LLM_SAMBANOVA,
      llmSambaNovaConcurrency(),
    );
    activeWorkers.push(llmSambaNovaWorker);
    activeQueueNames.push("llm-sambanova-runs");
```

Right after the `openRouterFreeDispatchWorker` block:

```ts
    // Each job is one tick of the SambaNova free-tier dispatch cycle (see
    // SambaNovaFreeDispatchService) — same self-chaining shape as the
    // Groq/OpenRouter dispatch workers above.
    const sambaNovaFreeDispatchWorker = new Worker(
      "sambanova-free-dispatch",
      async (job: Job) => {
        logger.log(`starting sambanova free-tier dispatch tick ${job.id}`);
        await sambaNovaFreeDispatchService.runTick();
        logger.log(`finished sambanova free-tier dispatch tick ${job.id}`);
      },
      { connection: redisConnection, concurrency: 1 },
    );

    sambaNovaFreeDispatchWorker.on("failed", (job, err) => {
      logger.error(`sambanova free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(sambaNovaFreeDispatchWorker);
    activeQueueNames.push("sambanova-free-dispatch");
```

Right after the `openRouterRpdResumeWorker` block (note SambaNova's `runResume` takes a `triggerJobId`, like Groq's — pass `job.id ?? String(job.timestamp)`):

```ts
    const sambaNovaRpdResumeWorker = new Worker(
      "sambanova-rpd-resume",
      async (job) => {
        logger.log(`starting sambanova-rpd resume sweep ${job.id}`);
        const result = await sambaNovaRpdResumeService.runResume(job.id ?? String(job.timestamp));
        logger.log(`finished sambanova-rpd resume sweep ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      { connection: redisConnection, concurrency: 1 },
    );

    sambaNovaRpdResumeWorker.on("failed", (job, err) => {
      logger.error(`sambanova-rpd resume sweep ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(sambaNovaRpdResumeWorker);
    activeQueueNames.push("sambanova-rpd-resume");
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/worker.ts
git commit -m "$(cat <<'EOF'
feat(backend): run the three new SambaNova queues in the worker process

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Backend — seed the five SambaNova models

**Files:**
- Create: `backend/src/migrations/1792000000000-add-sambanova-models.ts`
- Possibly modify: leaderboard link building / any model-id path param (see Step 1)

**Interfaces:**
- Produces: five `SupportedModel` rows for `strategyName = 'llm-sambanova'`, each with `modelName` = SambaNova id and `openRouterSlug` = the mapped catalog slug.

- [ ] **Step 1: Audit model-id encoding**

The five SambaNova ids (`DeepSeek-V3.1`, `DeepSeek-V3.2`, `Meta-Llama-3.3-70B-Instruct`, `gpt-oss-120b`, `gemma-4-31B-it`) contain no `/` and no `:`, so the leaderboard slash-encoding fix (`d540f82`) and OpenRouter's colon concern do not apply. Still confirm a `Meta-Llama-3.3-70B-Instruct`-shaped id round-trips through every model-id-bearing URL:

```bash
cd frontend && grep -rn "encodeURIComponent\|modelId\|/model/\|leaderboard.*model" src | grep -iv test
cd ../backend && grep -rn ":model\|:modelName\|/model/\|@Param(.model" src | grep -iv spec
```

For each hit that builds a link/route from a model id: confirm it already `encodeURIComponent`s (or uses a catch-all param). A dot and mixed case are URL-safe, so the expectation is **no change needed** — note that in the commit message. Only if a route does something surprising (e.g. lowercases the segment, or splits on `-`) fix it and add a round-trip test.

- [ ] **Step 2: Re-confirm the five slugs are live and structured-output-capable**

For each `(sambaNovaId, openRouterSlug)` pair:

```bash
for s in "deepseek/deepseek-chat-v3.1" "deepseek/deepseek-v3.2" "meta-llama/llama-3.3-70b-instruct" "openai/gpt-oss-120b" "google/gemma-4-31b-it"; do
  curl -s "https://openrouter.ai/api/v1/models/$s/endpoints" | python -c "import sys,json;d=json.load(sys.stdin).get('data',{});e=d.get('endpoints',[]);print('$s', bool(e), sorted(set(p for ep in e for p in ep.get('supported_parameters',[]) if p in ('response_format','structured_outputs'))))" 2>/dev/null || echo "$s LOOKUP_FAILED"
done
```

If a slug 404s, find its current canonical slug on `openrouter.ai/models` and use that (the mapping is only for metadata backfill, so an approximate same-family slug is acceptable — note it in the migration comment).

Then probe each **SambaNova** model for real structured output — a minimal `generateObject`-shaped chat completion against `https://api.sambanova.ai/v1/chat/completions` with `response_format: { type: "json_schema", ... }` (or `{ type: "json_object" }`) and `SAMBANOVA_API_KEY`. Any model that errors on `response_format` or returns unparseable output is seeded `supported = false` in Step 3 (keep the row — `ModelMetadataRefreshService` still fills its metadata, and it can be flipped later), exactly as `minimax-m2.7` was handled for Groq. Record the probe result for each of the five.

- [ ] **Step 3: Create the migration**

Create `backend/src/migrations/1792000000000-add-sambanova-models.ts` (verify `1792...` is the next free timestamp above `1791`). Set each `"supported"` value from the Step 2 probe result — the block below assumes all five passed; change any that failed to `false`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the five SambaNova Cloud free-tier chat models for the
 * llm-sambanova strategy. `modelName` is SambaNova's own model id;
 * `openRouterSlug` is a separate mapping to the OpenRouter catalog entry
 * (the Groq split — see 1785000000000-set-groq-model-openrouter-slugs.ts),
 * so ModelMetadataRefreshService fills contextWindow/releaseDate/pricing on
 * its next run. `freeTier` is NULL (SambaNova is not part of either OpenAI
 * token tier). Slugs and each model's structured-output support were
 * confirmed live at authoring time (OpenRouter /endpoints + a real
 * response_format probe against api.sambanova.ai). Any model that failed
 * the structured-output probe is seeded supported = false, like
 * minimax-m2.7 was for Groq. Trigger POST /dispatch/refresh-model-metadata
 * once after this deploys so the rows aren't blank until the next daily
 * cron tick. See docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §8.
 */
export class AddSambaNovaModels1792000000000 implements MigrationInterface {
  name = "AddSambaNovaModels1792000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug", "freeTier")
      VALUES
        ('llm-sambanova', 'DeepSeek-V3.1',               true, 'deepseek/deepseek-chat-v3.1',        NULL),
        ('llm-sambanova', 'DeepSeek-V3.2',               true, 'deepseek/deepseek-v3.2',             NULL),
        ('llm-sambanova', 'Meta-Llama-3.3-70B-Instruct', true, 'meta-llama/llama-3.3-70b-instruct',  NULL),
        ('llm-sambanova', 'gpt-oss-120b',                true, 'openai/gpt-oss-120b',                NULL),
        ('llm-sambanova', 'gemma-4-31B-it',              true, 'google/gemma-4-31b-it',              NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-sambanova'
        AND "modelName" IN (
          'DeepSeek-V3.1', 'DeepSeek-V3.2', 'Meta-Llama-3.3-70B-Instruct',
          'gpt-oss-120b', 'gemma-4-31B-it'
        )
    `);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/1792000000000-add-sambanova-models.ts
git commit -m "$(cat <<'EOF'
feat(backend): seed the five SambaNova free-tier chat models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(Stage frontend/backend encoding files too only if Step 1 actually changed them.)

---

### Task 13: Backend — `/dispatch/sambanova` status/stop endpoints

**Files:**
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `backend/src/modules/dispatch/dispatch.module.ts`
- Test: `backend/src/modules/dispatch/dispatch.controller.spec.ts` (only if one already exists)

**Interfaces:**
- Consumes: `SambaNovaFreeDispatchService` (Task 9).
- Produces: `GET /dispatch/sambanova`, `DELETE /dispatch/sambanova`.

- [ ] **Step 1: Check for a controller spec and add mirrored tests if present**

Read `backend/src/modules/dispatch/dispatch.controller.spec.ts`. If it exists and has OpenRouter/Groq route tests, add mirrored ones:

```ts
  it("GET /dispatch/sambanova returns the SambaNova dispatch status", async () => {
    mockSambaNovaFreeDispatchService.getStatus.mockResolvedValue({ active: true, startedAt: new Date() });
    const result = await controller.getSambaNovaDispatchStatus();
    expect(result.active).toBe(true);
  });

  it("DELETE /dispatch/sambanova stops the SambaNova dispatch cycle", async () => {
    mockSambaNovaFreeDispatchService.stop.mockResolvedValue({ active: false, startedAt: null });
    const result = await controller.stopSambaNovaDispatch();
    expect(mockSambaNovaFreeDispatchService.stop).toHaveBeenCalled();
    expect(result.active).toBe(false);
  });
```

If no such spec exists, skip to Step 2 and rely on the Step 3 typecheck + Task 16 smoke test.

- [ ] **Step 2: Implement**

In `dispatch.controller.ts`:

```ts
import { SambaNovaFreeDispatchService } from "../sambanova-free-dispatch/sambanova-free-dispatch.service";
```

```ts
    @Inject(SambaNovaFreeDispatchService)
    private readonly sambaNovaFreeDispatchService: SambaNovaFreeDispatchService,
```

After the existing `stopOpenRouterDispatch` method:

```ts
  // Read-only SambaNova free-tier dispatch status — see
  // SambaNovaFreeDispatchService. Automation-only; no POST start.
  @Get("sambanova")
  async getSambaNovaDispatchStatus() {
    return this.sambaNovaFreeDispatchService.getStatus();
  }

  // Deactivates the SambaNova dispatch cycle — a no-op (not an error) if it
  // wasn't running.
  @Delete("sambanova")
  async stopSambaNovaDispatch() {
    return this.sambaNovaFreeDispatchService.stop();
  }
```

In `dispatch.module.ts`, import `SambaNovaFreeDispatchModule` and add it to `imports` alongside `OpenRouterFreeDispatchModule`.

- [ ] **Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS. If Step 1 added tests: `cd backend && npx jest dispatch.controller.spec.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/dispatch/dispatch.controller.ts backend/src/modules/dispatch/dispatch.module.ts backend/src/modules/dispatch/dispatch.controller.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GET/DELETE /dispatch/sambanova

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Backend — `sambaNovaBurn` leg in the daily-automation chain

**Files:**
- Modify: `backend/src/modules/automation/daily-automation.service.ts`
- Modify: `backend/src/modules/automation/daily-automation.service.spec.ts`
- Modify: `backend/src/modules/automation/entities/automation-run-log.entity.ts`
- Modify: `backend/src/modules/automation/automation.controller.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`
- Create: `backend/src/migrations/1795000000000-add-automation-sambanova-leg.ts`

**Interfaces:**
- Consumes: `SambaNovaFreeDispatchService` (Task 9).
- Produces: `DailyAutomationService.run()` also fires a `sambaNovaBurn` leg; `GET /automation/status` includes a `sambaNovaBurn` field.

- [ ] **Step 1: Write the failing tests**

In `daily-automation.service.spec.ts`, import `SambaNovaFreeDispatchService`, add a mock alongside `mockOpenRouterFreeDispatchService`:

```ts
    mockSambaNovaFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest.fn().mockResolvedValue({
        status: { active: true, startedAt: new Date() },
        outcome: "started",
      }),
    };
```

Register it: `{ provide: SambaNovaFreeDispatchService, useValue: mockSambaNovaFreeDispatchService }`.

Add tests inside `describe("run", ...)`, mirroring the existing `openRouterBurn` tests exactly:

```ts
    it("starts the SambaNova burn when no cycle is already running", async () => {
      await service.run();
      expect(mockSambaNovaFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { sambaNovaBurnOutcome: "started", sambaNovaBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the SambaNova leg from start()'s outcome", async () => {
      mockSambaNovaFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });
      await service.run();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { sambaNovaBurnOutcome: "alreadyExhausted", sambaNovaBurnMessage: "every SambaNova model is daily-held" },
      );
    });

    it("records alreadyActive for the SambaNova leg without calling start", async () => {
      mockSambaNovaFreeDispatchService.getStatus.mockResolvedValueOnce({ active: true, startedAt: new Date() });
      await service.run();
      expect(mockSambaNovaFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { sambaNovaBurnOutcome: "alreadyActive", sambaNovaBurnMessage: "already running" },
      );
    });

    it("records a SambaNova leg failure without throwing, and still lets the other legs run", async () => {
      mockSambaNovaFreeDispatchService.start.mockRejectedValueOnce(new Error("sambanova down"));
      await expect(service.run()).resolves.toBeUndefined();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { sambaNovaBurnOutcome: "error", sambaNovaBurnMessage: "sambanova down" },
      );
    });
```

Also update the pre-existing "judge leg failure ... still runs the other legs" test to add `expect(mockSambaNovaFreeDispatchService.start).toHaveBeenCalled();`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: FAIL — `SambaNovaFreeDispatchService` unknown, `runSambaNovaBurnLeg` missing.

- [ ] **Step 3: Implement in `daily-automation.service.ts`**

```ts
import { SambaNovaFreeDispatchService } from "../sambanova-free-dispatch/sambanova-free-dispatch.service";
```

```ts
    @Inject(SambaNovaFreeDispatchService)
    private readonly sambaNovaFreeDispatchService: SambaNovaFreeDispatchService,
```

In `run()`, after `await this.runOpenRouterBurnLeg(date);`:

```ts
    await this.runSambaNovaBurnLeg(date);
```

After `runOpenRouterBurnLeg` (a direct copy with the renames and its own `alreadyExhausted` message):

```ts
  private async runSambaNovaBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.sambaNovaFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { sambaNovaBurnOutcome: "alreadyActive", sambaNovaBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.sambaNovaFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted" ? "every SambaNova model is daily-held" : "started";
      await this.runLogRepo.update(
        { date },
        { sambaNovaBurnOutcome: result.outcome, sambaNovaBurnMessage: message },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start SambaNova burn";
      this.logger.error(`daily automation sambanova-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { sambaNovaBurnOutcome: "error", sambaNovaBurnMessage: message },
      );
    }
  }
```

Update the class doc comment's leg list to **seven** legs (add a `sambaNovaBurn` bullet mirroring `openRouterBurn`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the entity columns**

In `automation-run-log.entity.ts`, after `openRouterBurnMessage`:

```ts
  @Column({ type: "varchar", nullable: true })
  sambaNovaBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  sambaNovaBurnMessage: string | null;
```

(Match the exact type name the OpenRouter columns use — `AutomationLegOutcome` here is a placeholder for whatever `openRouterBurnOutcome` is typed as.)

- [ ] **Step 6: Create the migration**

Create `backend/src/migrations/1795000000000-add-automation-sambanova-leg.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the sambaNovaBurn leg's outcome/message columns to
 * AutomationRunLog — the SambaNova counterpart to
 * openRouterBurnOutcome/openRouterBurnMessage. */
export class AddAutomationSambaNovaLeg1795000000000 implements MigrationInterface {
  name = "AddAutomationSambaNovaLeg1795000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "sambaNovaBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "sambaNovaBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "sambaNovaBurnOutcome",
        DROP COLUMN IF EXISTS "sambaNovaBurnMessage"
    `);
  }
}
```

- [ ] **Step 7: Update `AutomationController`**

In `automation.controller.ts`, after the `openRouterBurn` field in the returned object:

```ts
      sambaNovaBurn: {
        outcome: log?.sambaNovaBurnOutcome ?? null,
        message: log?.sambaNovaBurnMessage ?? null,
      },
```

- [ ] **Step 8: Update `AutomationModule`**

In `automation.module.ts`, import `SambaNovaFreeDispatchModule` and add it to `imports` alongside `OpenRouterFreeDispatchModule`.

- [ ] **Step 9: Verify**

Run: `cd backend && npx tsc --noEmit && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/automation backend/src/migrations/1795000000000-add-automation-sambanova-leg.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the sambaNovaBurn leg to the daily-automation chain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Frontend — `SambaNovaDispatchWidget` and Activity page wiring

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Create: `frontend/src/components/benchmark/SambaNovaDispatchWidget.tsx`
- Create: `frontend/src/components/benchmark/__tests__/SambaNovaDispatchWidget.test.tsx`
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`

**Interfaces:**
- Consumes: `GET /automation/status` (now includes `sambaNovaBurn`, Task 14), `GET`/`DELETE /dispatch/sambanova` (Task 13).
- Produces: `SambaNovaDispatchWidget` component on the Activity page.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/benchmark/__tests__/SambaNovaDispatchWidget.test.tsx` from `GroqDispatchWidget.test.tsx` (NOT the OpenRouter one — no calls-today line) with substitutions: `GroqDispatchWidget` → `SambaNovaDispatchWidget`, `GroqDispatchStatus` → `SambaNovaDispatchStatus`, `/dispatch/groq` → `/dispatch/sambanova`, `"Groq daily quota"` → `"SambaNova daily quota"`, `"Couldn't load Groq dispatch status: boom"` → `"Couldn't load SambaNova dispatch status: boom"`. Status fixtures are `{ active, startedAt }` only — no `callsToday` / `dailyBudget`. Do NOT add a calls-today assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/SambaNovaDispatchWidget.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `frontend/src/data/benchmark/types.ts`, after `OpenRouterDispatchStatus`:

```ts
/** GET /dispatch/sambanova — whether the SambaNova free-tier dispatch
 * cycle (backend SambaNovaFreeDispatchService) is running. SambaNova's
 * free-tier caps are per-model, so — like Groq/Google, unlike OpenRouter —
 * there is no single account-wide number to show. */
export interface SambaNovaDispatchStatus {
  active: boolean;
  startedAt: string | null;
}
```

Add `sambaNovaBurn: AutomationBurnLeg;` to `AutomationStatus`, after `openRouterBurn` (match the exact type name the `openRouterBurn` field uses).

- [ ] **Step 4: Add the API client functions**

In `frontend/src/data/benchmark/api.ts`, add `SambaNovaDispatchStatus` to the type-only import list, and after `stopOpenRouterDispatch`:

```ts
/** Whether the SambaNova free-tier dispatch cycle is running — see
 * SambaNovaDispatchStatus. Polled the same way fetchGroqDispatchStatus is. */
export function fetchSambaNovaDispatchStatus(signal?: AbortSignal): Promise<SambaNovaDispatchStatus> {
  return fetchJson("/dispatch/sambanova", signal);
}

/** Stops the SambaNova dispatch cycle — a no-op (not an error) if it wasn't
 * running. */
export function stopSambaNovaDispatch(signal?: AbortSignal): Promise<SambaNovaDispatchStatus> {
  return fetchJson("/dispatch/sambanova", signal, { method: "DELETE" });
}
```

(Match `fetchJson`'s actual signature in this file.)

- [ ] **Step 5: Create the widget**

Create `frontend/src/components/benchmark/SambaNovaDispatchWidget.tsx` — copy `GroqDispatchWidget.tsx` with the Groq → SambaNova renames. `TITLE` becomes `"SambaNova daily quota"`; the error string becomes `Couldn't load SambaNova dispatch status: {error}`; imports point at `fetchSambaNovaDispatchStatus` / `stopSambaNovaDispatch` and `SambaNovaDispatchStatus`. No calls-today line — keep it a straight rename of the Groq widget.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/SambaNovaDispatchWidget.test.tsx`
Expected: PASS

- [ ] **Step 7: Wire it into `ActivityPage.tsx`**

```ts
import { SambaNovaDispatchWidget } from "../../components/benchmark/SambaNovaDispatchWidget";
```

After the `openRouterBurnAutomation` block:

```ts
  const sambaNovaBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.sambaNovaBurn.outcome === "error"
            ? `failed: ${automationStatus.sambaNovaBurn.message}`
            : automationStatus.sambaNovaBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.sambaNovaBurn.outcome === "error",
      }
    : null;
```

In the JSX, right after `<OpenRouterDispatchWidget automation={openRouterBurnAutomation} />`:

```tsx
          <SambaNovaDispatchWidget automation={sambaNovaBurnAutomation} />
```

- [ ] **Step 8: Run the full frontend suite**

Run: `cd frontend && npm test -- --run`
Expected: PASS (including `ActivityPage.test.tsx` / `App.test.tsx` — if either asserts an exact widget count or exact `bench-free-tiers` child list, update it to include the new widget).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/components/benchmark/SambaNovaDispatchWidget.tsx frontend/src/components/benchmark/__tests__/SambaNovaDispatchWidget.test.tsx frontend/src/pages/benchmark/ActivityPage.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add SambaNovaDispatchWidget to the Activity page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Full-repo verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full orchestrator suite** — `cd orchestrator && npm test` → PASS
- [ ] **Step 2: Full backend suite** — `cd backend && npm test` → PASS
- [ ] **Step 3: Full frontend suite** — `cd frontend && npm test -- --run` → PASS
- [ ] **Step 4: Typecheck everything** — `cd orchestrator && npm run typecheck && cd ../backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit` → PASS

- [ ] **Step 5: Root-connection metadata check (the provider mistake)**

With the dev DB reachable, run a one-off script (or `ts-node -e`) that calls `AppDataSource.initialize()` then asserts `AppDataSource.hasMetadata("SambaNovaRateLimitHold") === true` and `AppDataSource.hasMetadata("SambaNovaDispatchState") === true`. Both must be `true` — if either is `false`, the entity is missing from `app.module.ts` and/or `data-source.ts` (Task 5 Step 6 / Task 9 Step 7).

- [ ] **Step 6: Manual migration round-trip against a real dev database**

With the branch's own Postgres (or the shared dev DB if free):

```bash
cd backend && npm run typeorm -- migration:run -d src/data-source.ts
# revert the four new migrations, newest first:
npm run typeorm -- migration:revert -d src/data-source.ts   # add-automation-sambanova-leg (1795)
npm run typeorm -- migration:revert -d src/data-source.ts   # add-sambanova-dispatch-state (1794)
npm run typeorm -- migration:revert -d src/data-source.ts   # add-sambanova-rate-limit-hold (1793)
npm run typeorm -- migration:revert -d src/data-source.ts   # add-sambanova-models (1792)
npm run typeorm -- migration:run -d src/data-source.ts
```

(Adjust `npm run typeorm` to this repo's actual script.) Expected: every migration applies and reverts cleanly; the five `SupportedModel` rows exist after the final `run` with the correct `openRouterSlug` mapping and `freeTier IS NULL`.

- [ ] **Step 7: Boot the stack and smoke-test**

```bash
docker compose -p connections-dev up -d --build
```

With `SAMBANOVA_API_KEY` set in `.env`:
- `GET /dispatch/sambanova` → `{ "active": false, "startedAt": null }` before automation fires.
- Worker log's "listening for jobs on" line includes `llm-sambanova-runs`, `sambanova-free-dispatch`, `sambanova-rpd-resume`.
- Optionally trigger the daily chain and confirm `AutomationRunLog.sambaNovaBurnOutcome` gets written and a couple of `llm-sambanova` `StrategyRun` rows appear; then `DELETE /dispatch/sambanova` stops it.
- If a model hits its 20 req/day wall, confirm one `SambaNovaRateLimitHold` row appears for it and the run parks at `RATE_LIMITED_DAILY` (not `ERROR`).

Record the outcome in the PR description — this is a manual smoke test, not automated.

- [ ] **Step 8: Report results**

Summarize pass/fail for Steps 1–5 and the outcome of Steps 6–7 before considering the plan complete. Do not proceed to `finishing-a-development-branch` until every automated suite passes.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 Provider (orchestrator) | Task 1 |
| §2 Reset-distance 429 classification | Task 2 |
| §3 Per-model `SambaNovaRateLimitHold` + service | Task 5 |
| §4 Runner: provider resolution, per-model top gate, on-daily-hit hold, per-provider fallback, no per-minute hold | Task 6 |
| §5 `SambaNovaFreeDispatchService` (dispatch-until-held) + `SambaNovaDispatchState` | Task 9 |
| §5b Dedicated `SAMBANOVA_DISPATCH_*` pacing knobs | Tasks 4, 9 |
| §5c Queues (`llm-sambanova-runs`, `sambanova-free-dispatch`) | Tasks 7, 9 |
| §6 Self-rescheduling resume sweep + bootstrap (no cron) + `sambanova-rpd-resume` queue | Task 10 |
| §7 Config (env vars, `strategies.ts` accessors, worker routing) | Tasks 1, 4, 11 |
| §8 Model seeding (`modelName` != `openRouterSlug`, five models, structured-output probe) | Task 12 |
| §9 `sambaNovaBurn` automation leg + `/dispatch/sambanova` | Tasks 13, 14 |
| §10 `SambaNovaDispatchWidget` (no calls-today line) | Task 15 |
| §11 Implementation-time verification | Task 1 Step 1, Task 2 Step 1, Task 12 Steps 1–2 |
| §12 The provider mistake (root `entities` arrays, explicit `@Inject`) | Tasks 5, 9 (arrays); every backend task (`@Inject`); Task 16 Step 5 (verify) |
| Testing | every task is TDD; Task 16 is the full pass |

No spec section is left without a task.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Task 5/9/10 direct the implementer to copy a named existing file and list every rename — that is a concrete instruction, not a placeholder, and each still carries its own failing-test-first cycle. Task 2 Step 1, Task 12 Steps 1–2 are explicitly conditional (verify-then-branch) with defined fallbacks.

**3. Type consistency:**
- `SambaNovaRateLimitHoldService.hold(strategyName, modelName, resetInSeconds)` — signature identical between Task 5 (definition), Task 6 (call), Task 10 (spec references). Per-model, three args (matches Groq, not OpenRouter's two-arg `hold(reason, seconds)`).
- `heldModels(strategyName): Promise<string[]>` — consistent Task 5 / Task 9 / Task 10.
- `nextResetAt(strategyName): Promise<Date | null>` — consistent Task 5 / Task 10.
- `clearExpired(): Promise<string[]>` — consistent Task 5 / Task 10.
- `SambaNovaDispatchStatusDto = { active: boolean; startedAt: Date | null }` — no `callsToday`; consistent across Tasks 9, 13, 14, 15 (frontend `SambaNovaDispatchStatus` matches with `string | null` for the serialized date).
- `queueForStrategy` — 8 args (adds `sambaNovaQueue` before `strategyName`); consistent Task 7 (definition), Task 8 (call).
- `runResume(triggerJobId: string): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }>` — consistent Task 10 (definition), Task 11 (worker passes `job.id ?? String(job.timestamp)`, matches Groq).
- `LLM_SAMBANOVA = "llm-sambanova"` — one definition (Task 4), used verbatim everywhere.

**4. Divergences from the OpenRouter plan, intentional (SambaNova is Groq-shaped, not OpenRouter-shaped):**
- Hold is per-model (`(strategyName, modelName)` unique), not a single account-wide row — Task 5.
- Resume self-reschedules via `rearm()`; the bootstrap registers **no cron** — Task 10.
- No `countTodayLlmCalls`, no daily-call budget, no `callsPerTrialEstimate` — dispatch is dispatch-until-held — Tasks 8, 9.
- No per-minute cooldown hold and no `RPM_COOLDOWN_MS` knob — the per-minute path is pure wait-and-retry — Tasks 4, 6.
- The widget has no calls-today line — Task 15.
- 429 classification reuses `parseGroqResetDuration` on a duration header (not `parseResetTimestampSeconds` on an epoch) — Task 2.

**5. Migration count:** four new migrations (`1792` models, `1793` rate-limit-hold, `1794` dispatch-state, `1795` automation-leg), one per concern, each created in the task whose deliverable needs it — the same split the merged OpenRouter feature used.
