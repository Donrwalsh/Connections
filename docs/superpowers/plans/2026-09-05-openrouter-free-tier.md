# OpenRouter Free-Tier Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth LLM strategy, `llm-openrouter`, dispatched and rate-limit-managed the way `llm-groq` is today — but adapted for OpenRouter's **account-wide** (not per-model) free-tier caps: 20 requests/minute and a configurable 50-or-1,000 requests/day budget that resets at UTC midnight, with failed calls counting toward the daily quota.

**Architecture:** OpenRouter's free tier gates the whole account, not each model, so this plan does **not** clone Groq's per-model `RateLimitHold` shape verbatim. Instead: a single-row `OpenRouterRateLimitHold` for the entire strategy; a dispatch service whose stop condition is a self-counted daily-call budget (counted from `SolvePrompt` rows) rather than "every model held"; dedicated conservative `OPENROUTER_DISPATCH_*` pacing knobs sized for the fixed 20 RPM ceiling; a brief global tick-chain cooldown when a per-minute 429 is seen; and a fixed `00:05` UTC cron resume sweep (no per-hit self-rescheduling — OpenRouter's reset clock is UTC). The orchestrator reaches OpenRouter through `@openrouter/ai-sdk-provider`, and the 429 classifier reads OpenRouter's `X-RateLimit-*` headers.

**Tech Stack:** NestJS + TypeORM + BullMQ (backend/worker), Hono + Vercel AI SDK (`@openrouter/ai-sdk-provider`) (orchestrator), React + TanStack Query (frontend). Jest (backend), Vitest (orchestrator, frontend).

**Spec:** [docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md](../specs/2026-09-05-openrouter-free-tier-design.md)

## Global Constraints

- Seed exactly these four `llm-openrouter` models, no others: `z-ai/glm-5.2:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `minimax/minimax-m3:free`, `google/gemma-4-31b-it:free`.
- For this provider, `modelName` **is** the OpenRouter slug: `openRouterSlug` is seeded equal to `modelName` (the `:free` id), not `NULL` — each `:free` id is a real `/api/v1/models` catalog entry, so `ModelMetadataRefreshService` can fill `contextWindow`/pricing from it. Still re-confirm all four slugs live against `GET https://openrouter.ai/api/v1/models/{slug}/endpoints` before writing the seed migration.
- Hold state is a **single account-wide row** — `OpenRouterRateLimitHold` has a unique constraint on `strategyName` alone, never `(strategyName, modelName)`. There is no per-model hold and no per-model resume logic.
- The resume sweep runs on a **fixed cron `5 0 * * *` in UTC** (`upsertJobScheduler` with `tz: "UTC"`). No `nextResetAt`-based self-rescheduling `rearm()` — that was Groq's answer to a per-hit reset *duration*; OpenRouter resets on a fixed clock.
- No manual `POST` start endpoint for OpenRouter dispatch — automation-only, same as Google/Groq (`GET`/`DELETE` on `/dispatch/openrouter`).
- No new `SolveErrorCode` values and no new `SolveErrorDetails` fields — reuse `"rate_limited"` / `"rate_limited_daily"` and the existing `retryAfterSeconds` / `dailyResetSeconds` fields (both already added for Groq), and reuse `StrategyRunStatus.RATE_LIMITED_DAILY` (already provider-agnostic).
- `DAILY_RESET_THRESHOLD_SECONDS = 120` is a non-configurable module constant in `orchestrator/src/solver.ts` — a 429 whose `X-RateLimit-Reset` is more than this far out is the account-wide daily hit; anything sooner is a per-minute hit.
- Google's and Groq's own constants/services (`llmGoogleRateLimitFallbackSeconds`, `GroqRateLimitHoldService`, `llmGroqDailyHoldFallbackSeconds`, etc.) are never modified to also serve OpenRouter — every OpenRouter behavior gets its own parallel name.
- Config defaults, copied verbatim into `strategies.ts` as `DEFAULT_*` constants:
  - `LLM_OPENROUTER_CONCURRENCY` → `1`
  - `LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS` → `60`
  - `OPENROUTER_FREE_DAILY_BUDGET` → `50` (operator raises to `1000` after a one-time $10 OpenRouter credit purchase; no code change)
  - `OPENROUTER_CALLS_PER_TRIAL_ESTIMATE` → `6`
  - `OPENROUTER_DISPATCH_TICK_MS` → `15000`
  - `OPENROUTER_DISPATCH_MAX_BATCH` → `3`
  - `OPENROUTER_DISPATCH_MAX_IN_FLIGHT` → `3`
  - `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` → `60000`
- `DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free"` (orchestrator).
- Orchestrator tests use **Vitest** (`orchestrator/src/*.test.ts`, run via `npx vitest run`); backend tests use **Jest** (`backend/**/*.spec.ts`, run via `npx jest`); frontend tests use **Vitest** (`frontend/... --run`). Don't mix the APIs.
- Every commit message ends with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## File Structure

**Orchestrator (new/modified):**
- Modify `orchestrator/src/provider.ts` — add `"openrouter"` to `ModelProvider`, `DEFAULT_OPENROUTER_MODEL`, `defaultProvider`/`getModel`/`getModelName` branches.
- Modify `orchestrator/src/solver.ts` — OpenRouter header-based 429 classification, `DAILY_RESET_THRESHOLD_SECONDS` constant, ms-timestamp parser.
- Modify `orchestrator/src/types.ts` — `"openrouter"` added to the `provider` enums on `SolveAssistRequestSchema` / `JudgeCategoryRequestSchema`.
- Modify `orchestrator/package.json` — add `@openrouter/ai-sdk-provider` dependency.

**Backend (new/modified):**
- Modify `backend/src/modules/strategy/orchestrator.service.ts` — widen the `provider` param unions to include `"openrouter"`.
- Modify `backend/src/strategies.ts` (+ `strategies.spec.ts`) — `LLM_OPENROUTER`, all config accessors.
- Create `backend/src/modules/strategy/entities/openrouter-rate-limit-hold.entity.ts`.
- Create `backend/src/modules/strategy/openrouter-rate-limit-hold.service.ts` (+ `.spec.ts`) — single-row hold, `secondsUntilNextUtcMidnight` helper.
- Modify `backend/src/modules/strategy/llm-strategy-runner.service.ts` (+ `.spec.ts`) — OpenRouter provider resolution, top gate, on-daily-hit hold, on-per-minute-hit cooldown hold, per-provider rate-limit fallback.
- Modify `backend/src/modules/queue/strategy.queue.ts` (+ `.spec.ts`) — `llmOpenRouterQueue`, `queueForStrategy` extended.
- Modify `backend/src/modules/queue/queue.module.ts` — `LLM_OPENROUTER_QUEUE`, `OPENROUTER_FREE_DISPATCH_QUEUE`, `OPENROUTER_RPD_RESUME_QUEUE` tokens.
- Create `backend/src/modules/queue/openrouter-free-dispatch.queue.ts`.
- Create `backend/src/modules/queue/openrouter-rpd-resume.queue.ts`.
- Modify `backend/src/modules/strategy/strategy.service.ts` (+ `.spec.ts`) — inject `LLM_OPENROUTER_QUEUE`, extend `queueFor` / `queuedCountsByKey`, add `countTodayLlmCalls`.
- Modify `backend/src/modules/strategy/strategy.module.ts` — register the new entity/services.
- Create `backend/src/modules/openrouter-free-dispatch/entities/openrouter-dispatch-state.entity.ts`.
- Create `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.module.ts`.
- Create `backend/src/modules/strategy/openrouter-rpd-resume.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.ts` (+ `.spec.ts`).
- Modify `backend/src/worker.ts` — three new worker handlers.
- Modify `backend/src/modules/dispatch/dispatch.controller.ts` (+ `dispatch.module.ts`) — `GET`/`DELETE /dispatch/openrouter`.
- Modify `backend/src/modules/automation/daily-automation.service.ts` (+ `.spec.ts`) — `runOpenRouterBurnLeg`.
- Modify `backend/src/modules/automation/entities/automation-run-log.entity.ts` — `openRouterBurnOutcome` / `openRouterBurnMessage`.
- Modify `backend/src/modules/automation/automation.controller.ts` — `openRouterBurn` in the status DTO.
- Modify `backend/src/modules/automation/automation.module.ts` — import `OpenRouterFreeDispatchModule`.
- Create migrations (verify the four timestamps are the next sequential ones above the current highest — expected `1788`–`1791`):
  - `1788000000000-add-openrouter-models.ts`
  - `1789000000000-add-openrouter-rate-limit-hold.ts`
  - `1790000000000-add-openrouter-dispatch-state.ts`
  - `1791000000000-add-automation-openrouter-leg.ts`

**Frontend (new/modified):**
- Modify `frontend/src/data/benchmark/types.ts` — `OpenRouterDispatchStatus`, `AutomationStatus.openRouterBurn`.
- Modify `frontend/src/data/benchmark/api.ts` — `fetchOpenRouterDispatchStatus` / `stopOpenRouterDispatch`.
- Create `frontend/src/components/benchmark/OpenRouterDispatchWidget.tsx` (+ `__tests__/OpenRouterDispatchWidget.test.tsx`).
- Modify `frontend/src/pages/benchmark/ActivityPage.tsx` — wire the new widget.

**Docs:**
- Modify `.env.sample`, `docker-compose.yml`, `README.md` — OpenRouter env vars.

---

### Task 1: Orchestrator — OpenRouter model resolution

**Files:**
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/package.json`
- Modify: `.env.sample`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Test: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Produces: `ModelProvider` now includes `"openrouter"`. `DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free"`. `getModel("openrouter", modelOverride?, contextWindow?): LanguageModel`. `getModelName("openrouter", modelOverride?): string`. `defaultProvider()` returns `"openrouter"` for `MODEL_PROVIDER=openrouter`.

- [ ] **Step 1: Confirm the `@openrouter/ai-sdk-provider` API**

Run `cd orchestrator && npm view @openrouter/ai-sdk-provider version` and note the latest published major. Read its README/types (`npm view @openrouter/ai-sdk-provider readme` or the package's `dist/*.d.ts` after install) to confirm: the factory is `createOpenRouter({ apiKey })`, and a chat model is obtained via `provider.chat(modelId)` (some versions expose the provider instance as directly callable — `provider(modelId)`). Record which form this version uses; the code in Step 4 assumes `provider.chat(modelId)` and must be adjusted if the confirmed API differs. This mirrors how the Groq work confirmed `@ai-sdk/groq`'s `createGroq` before wiring it.

- [ ] **Step 2: Write the failing tests**

Add to `orchestrator/src/provider.test.ts` (alongside the existing `vi.mock` calls at the top — match the exact style the file already uses for `@ai-sdk/groq`):

```ts
const createOpenRouterMock = vi.hoisted(() => {
  const chat = vi.fn(() => vi.fn());
  const factory = vi.fn(() => ({ chat }));
  return Object.assign(factory, { chat });
});

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: createOpenRouterMock,
}));
```

Add `createOpenRouterMock.mockClear(); createOpenRouterMock.chat.mockClear();` to the existing `afterEach` in `describe("getModel", ...)`.

Add inside `describe("getModel", ...)`:

```ts
  it("resolves the OpenRouter model via createOpenRouter().chat, without num_ctx", () => {
    getModel("openrouter");

    expect(createOpenRouterMock).toHaveBeenCalledTimes(1);
    expect(createOpenRouterMock.chat).toHaveBeenCalledWith("google/gemma-4-31b-it:free");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes OPENROUTER_API_KEY to createOpenRouter", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-or-key");

    getModel("openrouter");

    expect(createOpenRouterMock).toHaveBeenCalledWith({ apiKey: "test-or-key" });
  });

  it("uses the model override instead of OPENROUTER_MODEL when given", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");

    getModel("openrouter", "minimax/minimax-m3:free");

    expect(createOpenRouterMock.chat).toHaveBeenCalledWith("minimax/minimax-m3:free");
  });

  it("accepts a contextWindow for openrouter without using it", () => {
    getModel("openrouter", undefined, 262144);

    expect(createOpenRouterMock.chat).toHaveBeenCalledWith("google/gemma-4-31b-it:free");
  });
```

Add inside `describe("getModelName", ...)`:

```ts
  it("returns the configured OpenRouter model for the openrouter provider", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    expect(getModelName("openrouter")).toBe("z-ai/glm-5.2:free");
  });

  it("falls back to the OpenRouter default when unset", () => {
    expect(getModelName("openrouter")).toBe("google/gemma-4-31b-it:free");
  });

  it("prefers the model override over OPENROUTER_MODEL", () => {
    vi.stubEnv("OPENROUTER_MODEL", "z-ai/glm-5.2:free");
    expect(getModelName("openrouter", "minimax/minimax-m3:free")).toBe("minimax/minimax-m3:free");
  });
```

Add inside `describe("effectiveContextWindow", ...)`:

```ts
  it("never caps openrouter — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("openrouter", 262144)).toBe(262144);
  });
```

Add inside `describe("defaultProvider", ...)` (or wherever the file exercises `MODEL_PROVIDER`):

```ts
  it("returns openrouter when MODEL_PROVIDER=openrouter", () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    expect(defaultProvider()).toBe("openrouter");
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: FAIL — `getModel`/`getModelName`/`defaultProvider` don't handle `"openrouter"`; `ModelProvider` type error on the `"openrouter"` literal.

- [ ] **Step 4: Add the `@openrouter/ai-sdk-provider` dependency**

In `orchestrator/package.json`, add to `dependencies` (alphabetically, near the `@ai-sdk/*` and `@openrouter/*` entries):

```json
    "@openrouter/ai-sdk-provider": "^1.0.0",
```

Run `cd orchestrator && npm install` to fetch it and lock the resolved version. If `^1.0.0` doesn't resolve, use `npm view @openrouter/ai-sdk-provider versions` and pin the latest major's `^x.0.0`.

- [ ] **Step 5: Implement the `openrouter` branch in `provider.ts`**

Add the import:

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
```

Add the default constant near `DEFAULT_GROQ_MODEL`:

```ts
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
```

Extend the type:

```ts
export type ModelProvider = "openai" | "ollama" | "google" | "groq" | "openrouter";
```

`defaultProvider()` — add before the final `return "openai";`:

```ts
  if (provider === "openrouter") return "openrouter";
```

`getModel()` — add before the final `openai(...)` fallback:

```ts
  if (provider === "openrouter") {
    const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    return openrouter.chat(
      modelOverride ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
    );
  }
```

(If Step 1 found this version exposes a directly-callable provider instead of `.chat(...)`, use `openrouter(modelId)` here and update the Step 2 mock/assertions to match.)

`getModelName()` — add before the final `return`:

```ts
  if (provider === "openrouter") {
    return modelOverride ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  }
```

`effectiveContextWindow()` needs no change — its `provider !== "ollama"` passthrough already covers `"openrouter"`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: PASS

- [ ] **Step 7: Document the new env vars**

In `.env.sample`, after the Groq `GROQ_MODEL=...` line add:

```
# OpenRouter API key (used by @openrouter/ai-sdk-provider in the orchestrator)
OPENROUTER_API_KEY=

# OpenRouter model id (used when MODEL_PROVIDER=openrouter). Free models
# carry a ":free" suffix and share one account-wide 20 req/min + daily cap.
OPENROUTER_MODEL=google/gemma-4-31b-it:free
```

Update the `MODEL_PROVIDER` comment block to name the fifth provider: `... 'llm-groq' Groq, 'llm-openrouter' OpenRouter. All five providers are always configured and can be used simultaneously.`

In `docker-compose.yml`, in the `orchestrator` service's `environment:` block, after `GROQ_API_KEY: ${GROQ_API_KEY}` add `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}`, and after `GROQ_MODEL: ${GROQ_MODEL:-openai/gpt-oss-20b}` add `OPENROUTER_MODEL: ${OPENROUTER_MODEL:-google/gemma-4-31b-it:free}`.

In `README.md`'s env var table, after the `GROQ_API_KEY` row add:

```
| `OPENROUTER_API_KEY` | — | OpenRouter API key (orchestrator only) |
```

and after the `GROQ_MODEL` row add:

```
| `OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | OpenRouter model id (used by the `llm-openrouter` strategy and provider-less requests) |
```

Update the `MODEL_PROVIDER` row's description to also list `openrouter` / `llm-openrouter`.

- [ ] **Step 8: Commit**

```bash
git add orchestrator/src/provider.ts orchestrator/src/provider.test.ts orchestrator/package.json orchestrator/package-lock.json .env.sample docker-compose.yml README.md
git commit -m "$(cat <<'EOF'
feat(orchestrator): add OpenRouter as a model provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Orchestrator — OpenRouter rate-limit classification

**Files:**
- Modify: `orchestrator/src/solver.ts`
- Modify: `orchestrator/src/types.ts`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from Task 1 (now includes `"openrouter"`).
- Produces: `classifyModelCallError(err, "openrouter", details)` returns `SolveError` with code `"rate_limited_daily"` (carrying `dailyResetSeconds`) when the 429's reset is more than `DAILY_RESET_THRESHOLD_SECONDS` out, else `"rate_limited"` (carrying `retryAfterSeconds`). Reuses the existing `SolveErrorDetails.dailyResetSeconds` / `retryAfterSeconds` fields — no new fields.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/src/solver.test.ts`. The `makeAPICallError` helper already accepts `responseHeaders` (added for Groq). Add a new `describe` block:

```ts
describe("classifyModelCallError — openrouter", () => {
  const HOUR_MS = 3_600_000;

  it("classifies a 429 whose X-RateLimit-Reset is hours out as rate_limited_daily", () => {
    const resetMs = Date.now() + 3 * HOUR_MS;
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: {
        "x-ratelimit-limit": "50",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetMs),
      },
    });

    const result = classifyModelCallError(err, "openrouter", { model: "z-ai/glm-5.2:free" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBeGreaterThan(2 * 3600);
    expect(result.details.dailyResetSeconds).toBeLessThanOrEqual(3 * 3600 + 1);
  });

  it("classifies a 429 whose X-RateLimit-Reset is seconds away as rate_limited (per-minute)", () => {
    const resetMs = Date.now() + 8_000;
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetMs) },
    });

    const result = classifyModelCallError(err, "openrouter", { model: "z-ai/glm-5.2:free" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.details.retryAfterSeconds).toBeLessThanOrEqual(9);
  });

  it("prefers retry-after seconds for a per-minute hit when present", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "retry-after": "5", "x-ratelimit-reset": String(Date.now() + 5_000) },
    });

    const result = classifyModelCallError(err, "openrouter", { model: "z-ai/glm-5.2:free" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBe(5);
  });

  it("classifies a 429 with no parseable rate-limit headers as model_error", () => {
    const err = makeAPICallError({ statusCode: 429, responseHeaders: {} });

    const result = classifyModelCallError(err, "openrouter", { model: "z-ai/glm-5.2:free" });

    expect(result.code).toBe("model_error");
  });

  it("does not classify a non-openrouter provider's 429 using OpenRouter headers", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-reset": String(Date.now() + 3 * HOUR_MS) },
    });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("unwraps a RetryError around an OpenRouter daily-limit APICallError", () => {
    const inner = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.now() + 5 * HOUR_MS) },
    });
    const err = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner],
    });

    const result = classifyModelCallError(err, "openrouter", { model: "z-ai/glm-5.2:free" });

    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBeGreaterThan(4 * 3600);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: FAIL — no `openrouter` branch in `classifyModelCallError`, every case falls through to `model_error`.

- [ ] **Step 3: Implement the OpenRouter branch in `solver.ts`**

Near the top of the module (by the other rate-limit helpers), add:

```ts
// A 429 whose reset window is more than this far out is OpenRouter's
// account-wide daily-quota hit (resets at UTC midnight); anything sooner is
// the fixed 20 req/min per-minute hit. Not configurable — this is a shape
// discriminator, not a tuning knob. See
// docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §2.
const DAILY_RESET_THRESHOLD_SECONDS = 120;

/**
 * Parses OpenRouter's `X-RateLimit-Reset` header — a Unix-milliseconds
 * timestamp — into whole seconds from now (never negative). Returns
 * undefined for a missing, non-numeric, or non-finite value rather than
 * throwing. Confirm the ms-epoch interpretation against a real captured 429
 * before relying on it, per this repo's never-guess-a-response-shape policy.
 */
function parseResetTimestampSeconds(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const resetMs = Number(value);
  if (!Number.isFinite(resetMs)) return undefined;
  return Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
}
```

(Reuse the existing `parseSecondsHeader` helper added for Groq for the `retry-after` read — do not add a second copy.)

Add the OpenRouter branch in `classifyModelCallError`, right after the existing Groq `if` block (all fall through to the same `model_error` return, so order is only for reading):

```ts
  if (provider === "openrouter" && APICallError.isInstance(err) && err.statusCode === 429) {
    const headers = err.responseHeaders ?? {};
    const resetSeconds = parseResetTimestampSeconds(headers["x-ratelimit-reset"]);
    const retryAfter = parseSecondsHeader(headers["retry-after"]);

    if (resetSeconds === undefined && retryAfter === undefined) {
      // No usable rate-limit signal — fall through to model_error, same as
      // the Groq branch does when its headers are absent.
    } else if (resetSeconds !== undefined && resetSeconds > DAILY_RESET_THRESHOLD_SECONDS) {
      return new SolveError("rate_limited_daily", `OpenRouter daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        dailyResetSeconds: resetSeconds,
      });
    } else {
      return new SolveError("rate_limited", `OpenRouter rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds: retryAfter ?? resetSeconds,
      });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: PASS

- [ ] **Step 5: Extend the provider enums in `types.ts`**

In `orchestrator/src/types.ts`, change both `provider: z.enum([...])` occurrences (in `SolveAssistRequestSchema` and `JudgeCategoryRequestSchema`) to append `"openrouter"`:

```ts
    provider: z.enum(["openai", "ollama", "google", "groq", "openrouter"]).optional()
```

- [ ] **Step 6: Run the full orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: PASS (all suites)

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts orchestrator/src/types.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): classify OpenRouter 429s via X-RateLimit-Reset

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
- Consumes: nothing from earlier tasks.
- Produces: `solveAssist(...)` / `judgeCategory(...)` accept `provider?: "openai" | "ollama" | "google" | "groq" | "openrouter"`. `SolveAssistFailure.dailyResetSeconds` already exists (added for Groq) and already flows through `extractCallDetail` — no change needed there.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/strategy/orchestrator.service.spec.ts`, find the existing Groq `dailyResetSeconds` passthrough test and add a sibling that calls with `provider: "openrouter"`:

```ts
  it("accepts openrouter as a provider and passes dailyResetSeconds through", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "OpenRouter daily quota exhausted",
        code: "rate_limited_daily",
        details: { dailyResetSeconds: 7200 },
      }),
    }) as unknown as typeof fetch;

    const service = new OrchestratorService();
    const result = await service.solveAssist([{ role: "user", content: "hi" }], undefined, "openrouter");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rate_limited_daily");
      expect(result.error.dailyResetSeconds).toBe(7200);
    }
  });
```

(Match the exact argument positions/mocking style of the file's existing Groq test — `solveAssist`'s `provider` parameter position may differ; read it first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest orchestrator.service.spec.ts -t "openrouter"`
Expected: FAIL — TypeScript rejects `"openrouter"` as a `provider` argument.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/orchestrator.service.ts`, widen every `"openai" | "ollama" | "google" | "groq"` union (in the `solveAssist` and `judgeCategory` signatures, and any local type alias) to add `| "openrouter"`. Grep the file for `"groq"` to find all sites. `extractCallDetail` and `SolveAssistFailure` already carry `dailyResetSeconds` — leave them unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest orchestrator.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): accept openrouter as an OrchestratorService provider

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
- Produces: `LLM_OPENROUTER = "llm-openrouter"`, added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`. Accessors: `llmOpenRouterConcurrency(env?)`, `llmOpenRouterRateLimitFallbackSeconds(env?)`, `openRouterFreeDailyBudget(env?)`, `openRouterCallsPerTrialEstimate(env?)`, `openRouterDispatchTickMs(env?)`, `openRouterDispatchMaxBatch(env?)`, `openRouterDispatchMaxInFlight(env?)`, `openRouterDispatchRpmCooldownSeconds(env?)`. Matching `DEFAULT_*` constants.

- [ ] **Step 1: Write the failing tests**

Add the new symbols to `backend/src/strategies.spec.ts`'s import list. Add these `describe` blocks (mirror the existing Groq blocks' exact style — `positiveTrialCount`-backed accessors reject `"abc"` and `"0"` and fall back to the default; read one existing block first to copy the assertion shape):

```ts
  describe("llmOpenRouterConcurrency", () => {
    it("defaults when the env var is missing", () => {
      expect(llmOpenRouterConcurrency({})).toBe(DEFAULT_LLM_OPENROUTER_CONCURRENCY);
    });
    it("defaults when the env var is invalid", () => {
      expect(llmOpenRouterConcurrency({ LLM_OPENROUTER_CONCURRENCY: "abc" })).toBe(DEFAULT_LLM_OPENROUTER_CONCURRENCY);
      expect(llmOpenRouterConcurrency({ LLM_OPENROUTER_CONCURRENCY: "0" })).toBe(DEFAULT_LLM_OPENROUTER_CONCURRENCY);
    });
    it("reads a valid positive integer", () => {
      expect(llmOpenRouterConcurrency({ LLM_OPENROUTER_CONCURRENCY: "3" })).toBe(3);
    });
  });

  describe("llmOpenRouterRateLimitFallbackSeconds", () => {
    it("defaults when missing", () => {
      expect(llmOpenRouterRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS);
    });
    it("defaults when invalid", () => {
      expect(llmOpenRouterRateLimitFallbackSeconds({ LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS,
      );
    });
    it("reads a valid positive integer", () => {
      expect(llmOpenRouterRateLimitFallbackSeconds({ LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
    });
  });

  describe("openRouterFreeDailyBudget", () => {
    it("defaults to 50 when missing", () => {
      expect(openRouterFreeDailyBudget({})).toBe(DEFAULT_OPENROUTER_FREE_DAILY_BUDGET);
      expect(DEFAULT_OPENROUTER_FREE_DAILY_BUDGET).toBe(50);
    });
    it("defaults when invalid", () => {
      expect(openRouterFreeDailyBudget({ OPENROUTER_FREE_DAILY_BUDGET: "abc" })).toBe(DEFAULT_OPENROUTER_FREE_DAILY_BUDGET);
      expect(openRouterFreeDailyBudget({ OPENROUTER_FREE_DAILY_BUDGET: "0" })).toBe(DEFAULT_OPENROUTER_FREE_DAILY_BUDGET);
    });
    it("reads a valid positive integer (e.g. 1000 after the $10 unlock)", () => {
      expect(openRouterFreeDailyBudget({ OPENROUTER_FREE_DAILY_BUDGET: "1000" })).toBe(1000);
    });
  });

  describe("openRouterCallsPerTrialEstimate", () => {
    it("defaults to 6 when missing", () => {
      expect(openRouterCallsPerTrialEstimate({})).toBe(DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE);
      expect(DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE).toBe(6);
    });
    it("reads a valid positive integer", () => {
      expect(openRouterCallsPerTrialEstimate({ OPENROUTER_CALLS_PER_TRIAL_ESTIMATE: "4" })).toBe(4);
    });
  });

  describe("openRouterDispatch* pacing knobs", () => {
    it("default correctly", () => {
      expect(openRouterDispatchTickMs({})).toBe(DEFAULT_OPENROUTER_DISPATCH_TICK_MS);
      expect(openRouterDispatchMaxBatch({})).toBe(DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH);
      expect(openRouterDispatchMaxInFlight({})).toBe(DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT);
      expect(openRouterDispatchRpmCooldownSeconds({})).toBe(DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS / 1000);
    });
    it("read valid overrides", () => {
      expect(openRouterDispatchTickMs({ OPENROUTER_DISPATCH_TICK_MS: "20000" })).toBe(20000);
      expect(openRouterDispatchMaxBatch({ OPENROUTER_DISPATCH_MAX_BATCH: "5" })).toBe(5);
      expect(openRouterDispatchMaxInFlight({ OPENROUTER_DISPATCH_MAX_IN_FLIGHT: "5" })).toBe(5);
      expect(openRouterDispatchRpmCooldownSeconds({ OPENROUTER_DISPATCH_RPM_COOLDOWN_MS: "90000" })).toBe(90);
    });
  });
```

Update the existing `isLlmStrategy` test to add `expect(isLlmStrategy(LLM_OPENROUTER)).toBe(true);` (read the file first for its exact current assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: FAIL — the new symbols don't exist (ts-jest compile error).

- [ ] **Step 3: Implement in `strategies.ts`**

Add `"llm-openrouter"` to `SUPPORTED_STRATEGIES` (after `"llm-groq"`).

```ts
export const LLM_GROQ = "llm-groq" as const;
export const LLM_OPENROUTER = "llm-openrouter" as const;

export const LLM_STRATEGIES = [LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE, LLM_GROQ, LLM_OPENROUTER] as const;
```

Add the constants near the Groq ones:

```ts
export const DEFAULT_LLM_OPENROUTER_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying an OpenRouter per-minute (20 RPM)
// rate-limit hit, used only when neither retry-after nor a short
// X-RateLimit-Reset parsed — see orchestrator/src/solver.ts.
export const DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS = 60;

// Account-wide requests-per-day budget the OpenRouter dispatch cycle counts
// toward (OpenRouter's free tier is 50/day until a one-time $10 credit
// purchase raises it to 1000/day — no API exposes which; the operator sets
// this). Counted from SolvePrompt rows, not trials. See
// docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §5a.
export const DEFAULT_OPENROUTER_FREE_DAILY_BUDGET = 50;

// Assumed API calls per solve trial, for the dispatch cycle's in-flight
// cost estimate — one Connections solve is ~4 steps x 1-2 prompts.
export const DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE = 6;

// Dedicated conservative pacing for the fixed account-wide 20 req/min
// ceiling — NOT the FREE_TIER_DISPATCH_* knobs, which aren't tuned for it.
export const DEFAULT_OPENROUTER_DISPATCH_TICK_MS = 15_000;
export const DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH = 3;
export const DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT = 3;

// How long the whole dispatch tick chain backs off after a per-minute 429
// is observed (the runner writes a 'per-minute-cooldown' hold this long).
export const DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS = 60_000;
```

Add the accessors near `llmGroqConcurrency` / `freeTierDispatchTickMs` (use the same `positiveTrialCount` helper the Groq accessors use; for the two `*_MS` ones return milliseconds, for `openRouterDispatchRpmCooldownSeconds` divide the ms constant by 1000 — mirror however `freeTierDispatchTickMs` and any existing seconds-from-ms accessor are written):

```ts
export function llmOpenRouterConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_OPENROUTER_CONCURRENCY, DEFAULT_LLM_OPENROUTER_CONCURRENCY);
}

export function llmOpenRouterRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

export function openRouterFreeDailyBudget(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.OPENROUTER_FREE_DAILY_BUDGET, DEFAULT_OPENROUTER_FREE_DAILY_BUDGET);
}

export function openRouterCallsPerTrialEstimate(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.OPENROUTER_CALLS_PER_TRIAL_ESTIMATE,
    DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE,
  );
}

export function openRouterDispatchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.OPENROUTER_DISPATCH_TICK_MS, DEFAULT_OPENROUTER_DISPATCH_TICK_MS);
}

export function openRouterDispatchMaxBatch(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.OPENROUTER_DISPATCH_MAX_BATCH, DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH);
}

export function openRouterDispatchMaxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.OPENROUTER_DISPATCH_MAX_IN_FLIGHT,
    DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT,
  );
}

export function openRouterDispatchRpmCooldownSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const ms = positiveTrialCount(
    env.OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
    DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
  );
  return Math.ceil(ms / 1000);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: PASS (including the pre-existing loop-based `SUPPORTED_STRATEGIES` / `LLM_STRATEGIES` tests, which now cover `LLM_OPENROUTER` automatically).

- [ ] **Step 5: Document the new env vars**

In `.env.sample`, after the Groq block add:

```

# --- OpenRouter (llm-openrouter strategy) ---

# Worker concurrency for llm-openrouter-runs (own queue; never blocks the
# other providers). (default: 1)
LLM_OPENROUTER_CONCURRENCY=1

# Fallback wait (seconds) before retrying an OpenRouter per-minute (20 RPM)
# rate-limit hit — only used when the 429's own headers don't yield a wait.
# A per-minute hit is never a run failure; it waits and retries. (default: 60)
LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS=60

# Account-wide OpenRouter free-tier requests-per-day budget the dispatch
# cycle counts toward. OpenRouter allows 50/day until a one-time $10 credit
# purchase raises it to 1000/day — set this to match your account.
# Failed calls count too. (default: 50)
OPENROUTER_FREE_DAILY_BUDGET=50

# Assumed API calls per solve trial, for the dispatch cycle's in-flight
# budget estimate. (default: 6)
OPENROUTER_CALLS_PER_TRIAL_ESTIMATE=6

# Dedicated pacing for the fixed 20 req/min account-wide ceiling.
OPENROUTER_DISPATCH_TICK_MS=15000
OPENROUTER_DISPATCH_MAX_BATCH=3
OPENROUTER_DISPATCH_MAX_IN_FLIGHT=3

# How long the whole dispatch tick chain backs off after a per-minute 429.
# (default: 60000)
OPENROUTER_DISPATCH_RPM_COOLDOWN_MS=60000
```

In `README.md`'s env var table, after the Groq rows add one row per new var with the same descriptions.

- [ ] **Step 6: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts .env.sample README.md
git commit -m "$(cat <<'EOF'
feat(backend): register the llm-openrouter strategy and its config knobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Backend — `OpenRouterRateLimitHold` entity and service

**Files:**
- Create: `backend/src/modules/strategy/entities/openrouter-rate-limit-hold.entity.ts`
- Create: `backend/src/modules/strategy/openrouter-rate-limit-hold.service.ts`
- Create: `backend/src/migrations/1789000000000-add-openrouter-rate-limit-hold.ts`
- Test: `backend/src/modules/strategy/openrouter-rate-limit-hold.service.spec.ts`

**Interfaces:**
- Consumes: nothing besides `OpenRouterRateLimitHold` (defined here).
- Produces:
  - `OpenRouterRateLimitHoldService.hold(reason: "daily" | "per-minute-cooldown", resetInSeconds: number): Promise<void>`
  - `.isHeld(): Promise<boolean>`
  - `.heldReason(): Promise<"daily" | "per-minute-cooldown" | null>`
  - `.nextResetAt(): Promise<Date | null>`
  - `.clearExpired(): Promise<boolean>`
  - `secondsUntilNextUtcMidnight(now?: Date): number` — exported module function (not a method), used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/openrouter-rate-limit-hold.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  OpenRouterRateLimitHoldService,
  secondsUntilNextUtcMidnight,
} from "./openrouter-rate-limit-hold.service";
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";

const STRATEGY = "llm-openrouter";

describe("OpenRouterRateLimitHoldService", () => {
  let service: OpenRouterRateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterRateLimitHoldService,
        { provide: getRepositoryToken(OpenRouterRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(OpenRouterRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("hold('daily', n) upserts the single row keyed on strategyName with resetAt = now + n and reason 'daily'", async () => {
    const before = Date.now();
    await service.hold("daily", 3600);
    const after = Date.now();

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: STRATEGY, reason: "daily" });
    expect(row.resetAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(row.resetAt.getTime()).toBeLessThanOrEqual(after + 3600 * 1000);
    expect(conflictPaths).toEqual(["strategyName"]);
  });

  it("a per-minute-cooldown hold does NOT overwrite a live daily hold", async () => {
    repo.findOne.mockResolvedValueOnce({
      strategyName: STRATEGY,
      reason: "daily",
      resetAt: new Date(Date.now() + 3_600_000),
    });

    await service.hold("per-minute-cooldown", 60);

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("a daily hold DOES overwrite a live per-minute-cooldown hold", async () => {
    repo.findOne.mockResolvedValueOnce({
      strategyName: STRATEGY,
      reason: "per-minute-cooldown",
      resetAt: new Date(Date.now() + 60_000),
    });

    await service.hold("daily", 3600);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert.mock.calls[0][0].reason).toBe("daily");
  });

  it("isHeld / heldReason reflect only a live row", async () => {
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld()).toBe(true);

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.heldReason()).toBe("daily");

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld()).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.heldReason()).toBeNull();
  });

  it("nextResetAt returns the live row's resetAt or null", async () => {
    const at = new Date(Date.now() + 120_000);
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: at });
    expect(await service.nextResetAt()).toEqual(at);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.nextResetAt()).toBeNull();
  });

  it("clearExpired deletes an elapsed row and reports whether one was cleared", async () => {
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() - 1000) });
    repo.delete.mockResolvedValueOnce({ affected: 1 });
    expect(await service.clearExpired()).toBe(true);
    expect(repo.delete).toHaveBeenCalledWith({ strategyName: STRATEGY });

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.clearExpired()).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.clearExpired()).toBe(false);
  });
});

describe("secondsUntilNextUtcMidnight", () => {
  it("is the seconds from the given instant to the next 00:00:00 UTC, never negative", () => {
    const at = new Date("2026-09-05T23:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(3600);
  });

  it("returns a full day when called exactly at UTC midnight", () => {
    const at = new Date("2026-09-05T00:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(86_400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest openrouter-rate-limit-hold.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/strategy/entities/openrouter-rate-limit-hold.entity.ts`:

```ts
import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for whether the whole llm-openrouter strategy is
 * currently held. Unlike GoogleRateLimitHold / GroqRateLimitHold, this is
 * NOT per-model — OpenRouter's free-tier caps (20 req/min, 50-or-1000
 * req/day) are account-wide, so a single row per strategyName covers it.
 * `reason` is 'daily' (the account-wide requests-per-day quota is spent,
 * resetAt = next UTC midnight) or 'per-minute-cooldown' (a short global
 * backoff the runner writes after a 20 RPM 429 — see
 * OpenRouterFreeDispatchService). OpenRouterRpdResumeService clears the row
 * once resetAt passes. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §3.
 */
@Entity("OpenRouterRateLimitHold")
@Unique("UQ_OpenRouterRateLimitHold_strategyName", ["strategyName"])
export class OpenRouterRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Column({ type: "timestamptz" })
  resetAt: Date;

  @Column({ type: "text" })
  reason: "daily" | "per-minute-cooldown";
}
```

- [ ] **Step 4: Create the service**

Create `backend/src/modules/strategy/openrouter-rate-limit-hold.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LLM_OPENROUTER } from "../../strategies";
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";

export type OpenRouterHoldReason = "daily" | "per-minute-cooldown";

/**
 * The seconds from `now` to the next 00:00:00 UTC — the fallback resetAt for
 * a 'daily' hold when the orchestrator couldn't parse a dailyResetSeconds
 * from the 429 (OpenRouter's daily quota always resets at UTC midnight).
 * Exported as a plain function so the runner and tests can use it directly.
 */
export function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(0, Math.round((nextMidnight - now.getTime()) / 1000));
}

/**
 * The OpenRouter counterpart to GroqRateLimitHoldService — the simplest of
 * the three, because OpenRouter's free-tier limit is account-wide, not
 * per-model, and its reset clock is fixed UTC (no timezone math, no per-hit
 * duration). There is ever exactly one row (unique on strategyName). See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §3.
 */
@Injectable()
export class OpenRouterRateLimitHoldService {
  private readonly logger = new Logger(OpenRouterRateLimitHoldService.name);

  constructor(
    @InjectRepository(OpenRouterRateLimitHold)
    private readonly repo: Repository<OpenRouterRateLimitHold>,
  ) {}

  private async liveRow(): Promise<OpenRouterRateLimitHold | null> {
    const row = await this.repo.findOne({ where: { strategyName: LLM_OPENROUTER } });
    return row && row.resetAt.getTime() > Date.now() ? row : null;
  }

  /**
   * Sets or refreshes the single hold row. A 'per-minute-cooldown' request
   * is a no-op when a 'daily' hold is already live (the daily hold is the
   * stronger, longer signal); a 'daily' request always wins.
   */
  async hold(reason: OpenRouterHoldReason, resetInSeconds: number): Promise<void> {
    if (reason === "per-minute-cooldown") {
      const live = await this.liveRow();
      if (live?.reason === "daily") return;
    }

    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert(
      { strategyName: LLM_OPENROUTER, heldAt, resetAt, reason },
      ["strategyName"],
    );
    this.logger.warn(
      `OpenRouter ${reason} hold set until ${resetAt.toISOString()}`,
    );
  }

  async isHeld(): Promise<boolean> {
    return (await this.liveRow()) !== null;
  }

  async heldReason(): Promise<OpenRouterHoldReason | null> {
    return (await this.liveRow())?.reason ?? null;
  }

  async nextResetAt(): Promise<Date | null> {
    return (await this.liveRow())?.resetAt ?? null;
  }

  /**
   * Deletes the row if its resetAt has passed. Returns whether a row was
   * actually cleared, so the resume sweep can log/act on it.
   */
  async clearExpired(): Promise<boolean> {
    const row = await this.repo.findOne({ where: { strategyName: LLM_OPENROUTER } });
    if (!row || row.resetAt.getTime() > Date.now()) return false;
    await this.repo.delete({ strategyName: LLM_OPENROUTER });
    return true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx jest openrouter-rate-limit-hold.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Create the migration**

Create `backend/src/migrations/1789000000000-add-openrouter-rate-limit-hold.ts` (verify `1789...` is the next free timestamp above the current highest migration; bump all four OpenRouter migration timestamps together if not):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the OpenRouterRateLimitHold table — a SINGLE row (unique on
 * strategyName) marking the whole llm-openrouter strategy held, since
 * OpenRouter's free-tier caps are account-wide, not per-model. No enum
 * migration needed: 'rateLimitedDaily' already exists on
 * strategy_run_status_enum and is reused. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md.
 */
export class AddOpenRouterRateLimitHold1789000000000 implements MigrationInterface {
  name = "AddOpenRouterRateLimitHold1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "OpenRouterRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" TEXT NOT NULL,
        CONSTRAINT "UQ_OpenRouterRateLimitHold_strategyName" UNIQUE ("strategyName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_OpenRouterRateLimitHold_resetAt"
       ON "OpenRouterRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "OpenRouterRateLimitHold"`);
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/entities/openrouter-rate-limit-hold.entity.ts backend/src/modules/strategy/openrouter-rate-limit-hold.service.ts backend/src/modules/strategy/openrouter-rate-limit-hold.service.spec.ts backend/src/migrations/1789000000000-add-openrouter-rate-limit-hold.ts
git commit -m "$(cat <<'EOF'
feat(backend): add OpenRouterRateLimitHold (single account-wide row)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Backend — wire OpenRouter into `LlmStrategyRunner`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `LLM_OPENROUTER`, `llmOpenRouterRateLimitFallbackSeconds`, `openRouterDispatchRpmCooldownSeconds` (Task 4); `OpenRouterRateLimitHoldService`, `secondsUntilNextUtcMidnight` (Task 5); `SolveAssistFailure.dailyResetSeconds` (already present).
- Produces: no new exports — changes `runLlmStrategy`'s internal behavior only.

- [ ] **Step 1: Write the failing tests**

In `llm-strategy-runner.service.spec.ts`, add a mock `mockOpenRouterHold` matching the shape of the existing `mockGroqRpdHold` but with the OpenRouter method set: `{ isHeld: jest.fn(), hold: jest.fn(), heldReason: jest.fn(), nextResetAt: jest.fn(), clearExpired: jest.fn() }`. Provide it via `{ provide: OpenRouterRateLimitHoldService, useValue: mockOpenRouterHold }`. Default `mockOpenRouterHold.isHeld.mockResolvedValue(false)` in `beforeEach`.

Add tests mirroring the Groq block (read the existing `llm-groq` tests in this file to copy their harness helpers `makeRun` / `solvePuzzle` / `makeAssistResponse`):

```ts
    it("parks a held openrouter run at RATE_LIMITED_DAILY without calling the orchestrator", async () => {
      mockOpenRouterHold.isHeld.mockResolvedValue(true);
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-openrouter", modelName: "z-ai/glm-5.2:free" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);

      const result = await runner.runLlmStrategy(100, "llm-openrouter", 0, "z-ai/glm-5.2:free");

      expect(mockOrchestratorService.solveAssist).not.toHaveBeenCalled();
      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockOpenRouterHold.hold).not.toHaveBeenCalled();
    });

    it("records a daily OpenRouter hold using dailyResetSeconds and parks the run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-openrouter", modelName: "z-ai/glm-5.2:free" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "OpenRouter daily quota exhausted", code: "rate_limited_daily", dailyResetSeconds: 7200 },
      });

      const result = await runner.runLlmStrategy(100, "llm-openrouter", 0, "z-ai/glm-5.2:free");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockOpenRouterHold.hold).toHaveBeenCalledWith("daily", 7200);
    });

    it("falls back to secondsUntilNextUtcMidnight when a daily hit carries no dailyResetSeconds", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-openrouter", modelName: "z-ai/glm-5.2:free" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      await runner.runLlmStrategy(100, "llm-openrouter", 0, "z-ai/glm-5.2:free");

      const [reason, seconds] = mockOpenRouterHold.hold.mock.calls[0];
      expect(reason).toBe("daily");
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(86_400);
    });

    it("writes a per-minute-cooldown hold on an openrouter per-minute rate_limited hit, and keeps retrying (not a failure)", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-openrouter", modelName: "z-ai/glm-5.2:free" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce({ ok: false, error: { error: "rate limited", code: "rate_limited" } })
        .mockResolvedValue(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]));

      const result = await runner.runLlmStrategy(100, "llm-openrouter", 0, "z-ai/glm-5.2:free");

      expect(mockOpenRouterHold.hold).toHaveBeenCalledWith(
        "per-minute-cooldown",
        DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS / 1000,
      );
      expect(result.status).not.toBe(StrategyRunStatus.ERROR);
    });

    it("never ends an openrouter run in ERROR on a rate_limited_daily hit", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-openrouter", modelName: "z-ai/glm-5.2:free" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      const result = await runner.runLlmStrategy(100, "llm-openrouter", 0, "z-ai/glm-5.2:free");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
    });
```

Import `DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` from `"../../strategies"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts -t "openrouter"`
Expected: FAIL — `OpenRouterRateLimitHoldService` isn't injected/used; `llm-openrouter` routes to no provider branch.

- [ ] **Step 3: Implement in `llm-strategy-runner.service.ts`**

Update imports:

```ts
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_OPENROUTER,
  // ...existing...
  llmGoogleRateLimitFallbackSeconds,
  llmGroqRateLimitFallbackSeconds,
  llmGroqDailyHoldFallbackSeconds,
  llmOpenRouterRateLimitFallbackSeconds,
  openRouterDispatchRpmCooldownSeconds,
  llmTemperature,
} from "../../strategies";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
import {
  OpenRouterRateLimitHoldService,
  secondsUntilNextUtcMidnight,
} from "./openrouter-rate-limit-hold.service";
```

Add the constructor param, alongside `groqRpdHold`:

```ts
    @Inject(OpenRouterRateLimitHoldService)
    private readonly openRouterHold: OpenRouterRateLimitHoldService,
```

Provider resolution — extend the chain:

```ts
    const provider =
      strategyName === LLM_OLLAMA
        ? "ollama"
        : strategyName === LLM_GOOGLE
          ? "google"
          : strategyName === LLM_GROQ
            ? "groq"
            : strategyName === LLM_OPENROUTER
              ? "openrouter"
              : "openai";
```

Top gate — after the existing per-model `rpdHoldService` block, add the account-wide OpenRouter check (its body is the same park-and-return the per-model gate uses; duplicate the ~4 lines with a comment rather than contorting the existing ternary, since the OpenRouter hold's `isHeld()` takes no model argument):

```ts
    if (strategyName === LLM_OPENROUTER && (await this.openRouterHold.isHeld())) {
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
      await this.strategyRunRepo.save(run);
      return { status: run.status };
    }
```

(Match the exact fields/return shape of the existing top-gate block in this file — the snippet above assumes `run.finishedAt` and a `{ status }` return; adjust to whatever the Google/Groq gate actually does.)

Per-provider rate-limit fallback — extend the existing computation:

```ts
    const rateLimitFallbackSeconds =
      strategyName === LLM_GROQ
        ? llmGroqRateLimitFallbackSeconds()
        : strategyName === LLM_OPENROUTER
          ? llmOpenRouterRateLimitFallbackSeconds()
          : llmGoogleRateLimitFallbackSeconds();
```

On the failed-call classification (the block that already special-cases `rate_limited_daily` for Google/Groq) — add the OpenRouter arms:

```ts
        if (outcome.error.code === "rate_limited_daily" && model) {
          if (strategyName === LLM_GOOGLE) {
            await this.rpdHold.hold(strategyName, model);
          } else if (strategyName === LLM_GROQ) {
            await this.groqRpdHold.hold(
              strategyName,
              model,
              outcome.error.dailyResetSeconds ?? llmGroqDailyHoldFallbackSeconds(),
            );
          } else if (strategyName === LLM_OPENROUTER) {
            await this.openRouterHold.hold(
              "daily",
              outcome.error.dailyResetSeconds ?? secondsUntilNextUtcMidnight(),
            );
          }
        }

        if (outcome.error.code === "rate_limited" && strategyName === LLM_OPENROUTER) {
          // A 20 RPM hit — back the whole dispatch tick chain off, not just
          // this run. hold() no-ops if a 'daily' hold is already live.
          await this.openRouterHold.hold(
            "per-minute-cooldown",
            openRouterDispatchRpmCooldownSeconds(),
          );
        }
```

(`classifyFailedCall` itself needs no new parameter — it already takes `rateLimitFallbackSeconds` from the Groq work, and the OpenRouter `rate_limited` path uses the same `state.rateLimitWaitMs` wait-and-retry.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS (full file — confirms the Google/Groq paths are unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-openrouter runs through the account-wide hold gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Backend — OpenRouter's own BullMQ queue and `queueForStrategy`

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/strategy.queue.spec.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`

**Interfaces:**
- Produces: `llmOpenRouterQueue: Queue` (name `"llm-openrouter-runs"`). `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, groqQueue, openRouterQueue, strategyName): Queue`. `LLM_OPENROUTER_QUEUE` DI token, exported from `QueueModule`.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/queue/strategy.queue.spec.ts`, extend the `queueForStrategy` describe block:

```ts
import { LLM_GOOGLE, LLM_GROQ, LLM_OLLAMA, LLM_OPENAI, LLM_OPENROUTER } from "../../strategies";

const openrouter = { name: "openrouter" } as never;

describe("queueForStrategy", () => {
  it("routes each LLM strategy to its own queue and everything else to the shared queue", () => {
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OPENAI)).toBe(openai);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OLLAMA)).toBe(ollama);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_GOOGLE)).toBe(google);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_GROQ)).toBe(groq);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OPENROUTER)).toBe(openrouter);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, "alphabetical")).toBe(shared);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: FAIL — TypeScript arity mismatch (`queueForStrategy` takes 6 args today, this calls it with 7).

- [ ] **Step 3: Implement**

In `backend/src/modules/queue/strategy.queue.ts`:

```ts
import { LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE, LLM_GROQ, LLM_OPENROUTER } from "../../strategies";
```

```ts
export const llmOpenRouterQueue = new Queue("llm-openrouter-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

```ts
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  groqQueue: Queue,
  openRouterQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  if (strategyName === LLM_GROQ) return groqQueue;
  if (strategyName === LLM_OPENROUTER) return openRouterQueue;
  return defaultQueue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire the token into `queue.module.ts`**

```ts
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue, llmGoogleQueue, llmGroqQueue, llmOpenRouterQueue } from "./strategy.queue";
```

```ts
export const LLM_OPENROUTER_QUEUE = "LLM_OPENROUTER_QUEUE";
```

Add `{ provide: LLM_OPENROUTER_QUEUE, useValue: llmOpenRouterQueue }` to `providers` and `LLM_OPENROUTER_QUEUE` to `exports`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/strategy.queue.spec.ts backend/src/modules/queue/queue.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the llm-openrouter-runs queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Backend — wire OpenRouter's queue into `StrategyService`, add `countTodayLlmCalls`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`

**Interfaces:**
- Consumes: `LLM_OPENROUTER_QUEUE` (Task 7); `OpenRouterRateLimitHold` / `OpenRouterRateLimitHoldService` (Task 5); `SolvePrompt` entity, `startOfTodayUtc` (both pre-existing).
- Produces: `queueFor` routes `llm-openrouter` to its queue. New `StrategyService.countTodayLlmCalls(strategyName: string): Promise<number>` — count of `SolvePrompt` rows joined to that strategy's runs since UTC midnight — used by Task 9.

- [ ] **Step 1: Write the failing tests**

Add a `mockLlmOpenRouterQueue` sibling in `strategy.service.spec.ts`'s `TestingModule` (same mock shape as the existing `mockLlmGroqQueue`), provided via `LLM_OPENROUTER_QUEUE`.

```ts
  it("routes llm-openrouter runs to the llm-openrouter-runs queue", async () => {
    mockSupportedModelService.assertSupported.mockResolvedValue(undefined);

    await service.triggerRun(1, "llm-openrouter", "2026-01-01", 0, "z-ai/glm-5.2:free");

    expect(mockLlmOpenRouterQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-openrouter", model: "z-ai/glm-5.2:free" }),
      expect.anything(),
    );
  });
```

For `countTodayLlmCalls`, add a test that stubs the `SolvePrompt` repository's query builder (match however this spec already stubs query builders — if it uses a `createQueryBuilder` mock returning a chainable object, mirror that; otherwise stub `repo.count`/`repo.find` per the actual implementation chosen in Step 3):

```ts
  it("countTodayLlmCalls counts SolvePrompt rows for the strategy since UTC midnight", async () => {
    mockSolvePromptQb.getCount.mockResolvedValue(17);

    const n = await service.countTodayLlmCalls("llm-openrouter");

    expect(n).toBe(17);
    expect(mockSolvePromptQb.where).toHaveBeenCalledWith(
      expect.stringContaining("strategyName"),
      { strategyName: "llm-openrouter" },
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest strategy.service.spec.ts -t "openrouter"`
Expected: FAIL — `LLM_OPENROUTER_QUEUE` unknown token; `queueFor` doesn't route `llm-openrouter`; `countTodayLlmCalls` doesn't exist.

- [ ] **Step 3: Implement**

In `strategy.service.ts`:

```ts
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE, LLM_GROQ_QUEUE, LLM_OPENROUTER_QUEUE } from "../queue/queue.module";
```

```ts
    @Inject(LLM_OPENROUTER_QUEUE) private readonly llmOpenRouterQueue: Queue,
```

(after the existing `@Inject(LLM_GROQ_QUEUE)` line)

`queueFor`:

```ts
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      this.llmGroqQueue,
      this.llmOpenRouterQueue,
      strategyName,
    );
  }
```

`queuedCountsByKey`'s queue list:

```ts
    const queues = [this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, this.llmGoogleQueue, this.llmGroqQueue, this.llmOpenRouterQueue];
```

Add `countTodayLlmCalls`. If `StrategyService` doesn't already inject the `SolvePrompt` repository, add `@InjectRepository(SolvePrompt) private readonly solvePromptRepo: Repository<SolvePrompt>` (import `SolvePrompt` from `./entities/solve-prompt.entity`) and register it in `strategy.module.ts`'s `TypeOrmModule.forFeature([...])`. Then:

```ts
  /**
   * How many model API calls this LLM strategy has made so far in the
   * current UTC day — one row per call in SolvePrompt (initial prompt,
   * re-prompt, and backend retries all count). Used by
   * OpenRouterFreeDispatchService as the account-wide daily-budget counter,
   * since OpenRouter's free tier caps total requests (and counts failed
   * ones), not per-model requests. "Today" is the same UTC window
   * startOfTodayUtc defines everywhere else.
   */
  async countTodayLlmCalls(strategyName: string): Promise<number> {
    return this.solvePromptRepo
      .createQueryBuilder("sp")
      .innerJoin("StrategyRun", "run", "run.id = sp.\"strategyRunId\"")
      .where("run.\"strategyName\" = :strategyName", { strategyName })
      .andWhere("sp.\"createdAt\" >= :start", { start: startOfTodayUtc() })
      .getCount();
  }
```

(Adjust the join target/quoting to this repo's TypeORM conventions — check an existing query builder in `strategy.service.ts` for whether it references entity classes or table-name strings, and match it. `startOfTodayUtc` is imported from `"../../strategies"`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest strategy.service.spec.ts`
Expected: PASS (full file)

- [ ] **Step 5: Register the OpenRouter hold in `StrategyModule`**

In `strategy.module.ts`:

```ts
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";
import { OpenRouterRateLimitHoldService } from "./openrouter-rate-limit-hold.service";
```

Add `OpenRouterRateLimitHold` (and `SolvePrompt` if newly needed) to `TypeOrmModule.forFeature([...])`, `OpenRouterRateLimitHoldService` to `providers`, and to `exports` (Task 9's dispatch module and Task 10's resume service both need it).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-openrouter dispatch through its own queue; add countTodayLlmCalls

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Backend — `OpenRouterFreeDispatchService`

**Files:**
- Create: `backend/src/modules/openrouter-free-dispatch/entities/openrouter-dispatch-state.entity.ts`
- Create: `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.ts`
- Create: `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.module.ts`
- Create: `backend/src/modules/queue/openrouter-free-dispatch.queue.ts`
- Create: `backend/src/migrations/1790000000000-add-openrouter-dispatch-state.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Test: `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `StrategyService.findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` / `countInFlightByModel` / `countTodayDispatchByModel` / `countTodayLlmCalls` (Task 8); `SupportedModelService.findModelNamesByStrategy`; `OpenRouterRateLimitHoldService.isHeld` / `heldReason` / `nextResetAt` (Task 5); the `openRouter*` accessors (Task 4).
- Produces: `OpenRouterFreeDispatchService.start()`, `.stop()`, `.getStatus()`, `.runTick()`. `OpenRouterDispatchStatusDto = { active: boolean; startedAt: Date | null; callsToday: number; dailyBudget: number }` — consumed by Task 11 (worker), Task 13 (endpoints), Task 14 (automation).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.spec.ts`. Start from `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.spec.ts` as the harness template (TestingModule setup, repo mocks, `stateRepo` single-row mock), then replace the Groq-specific assertions with these OpenRouter behaviors. Concretely, the mocks needed:

```ts
  const stateRepo = { findOne: jest.fn(), save: jest.fn(), update: jest.fn() };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const strategyService = {
    countTodayLlmCalls: jest.fn().mockResolvedValue(0),
    countInFlightByModel: jest.fn().mockResolvedValue(new Map()),
    countTodayDispatchByModel: jest.fn().mockResolvedValue(new Map()),
    findUnrunPuzzleDatesForModel: jest.fn().mockResolvedValue([{ puzzleId: 1, date: "2026-01-01" }]),
    triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
  };
  const supportedModelService = {
    findModelNamesByStrategy: jest.fn().mockResolvedValue(["z-ai/glm-5.2:free", "minimax/minimax-m3:free"]),
  };
  const holdService = {
    isHeld: jest.fn().mockResolvedValue(false),
    heldReason: jest.fn().mockResolvedValue(null),
    nextResetAt: jest.fn().mockResolvedValue(null),
  };
```

Tests:

```ts
  describe("start", () => {
    it("starts a cycle and enqueues the first tick when under budget and not held", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });
      const { outcome } = await service.start();
      expect(outcome).toBe("started");
      expect(stateRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: "openrouter", active: true }));
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it("returns alreadyExhausted (no tick) when the account hold is live", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });
      holdService.isHeld.mockResolvedValue(true);
      const { outcome } = await service.start();
      expect(outcome).toBe("alreadyExhausted");
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("returns alreadyExhausted when callsToday already meets the budget", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });
      strategyService.countTodayLlmCalls.mockResolvedValue(50);
      const { outcome } = await service.start();
      expect(outcome).toBe("alreadyExhausted");
    });

    it("throws when a cycle is already active", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true });
      await expect(service.start()).rejects.toThrow(/already running/i);
    });
  });

  describe("runTick", () => {
    beforeEach(() => stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: true }));

    it("does nothing and stops when not active", async () => {
      stateRepo.findOne.mockResolvedValue({ id: "openrouter", active: false });
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("stops the cycle when the account is daily-held", async () => {
      holdService.heldReason.mockResolvedValue("daily");
      await service.runTick();
      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("skips dispatching and reschedules after the cooldown when per-minute-cooldown is live", async () => {
      holdService.heldReason.mockResolvedValue("per-minute-cooldown");
      holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 45_000));
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: expect.any(Number) }));
      expect(queue.add.mock.calls[0][2].delay).toBeGreaterThan(30_000);
    });

    it("stops the cycle when callsToday + estimated in-flight cost reaches the budget", async () => {
      strategyService.countTodayLlmCalls.mockResolvedValue(44);
      strategyService.countInFlightByModel.mockResolvedValue(new Map([["z-ai/glm-5.2:free", 1]]));
      // 44 + 1*6 = 50 >= 50
      await service.runTick();
      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("dispatches a batch across the least-allocated models and reschedules", async () => {
      strategyService.countTodayLlmCalls.mockResolvedValue(0);
      strategyService.countTodayDispatchByModel.mockResolvedValue(
        new Map([["z-ai/glm-5.2:free", 0], ["minimax/minimax-m3:free", 0]]),
      );
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith("tick", {}, expect.objectContaining({ delay: 15_000 }));
    });

    it("caps the batch to the budget headroom in trials", async () => {
      // budget 50, callsToday 46, estimate 6 -> 4 calls of headroom -> 0 whole trials affordable
      strategyService.countTodayLlmCalls.mockResolvedValue(46);
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).not.toHaveBeenCalled();
      // still reschedules (in-flight may clear budget) unless it also stopped
    });

    it("stops when every model is out of unrun puzzles", async () => {
      strategyService.findUnrunPuzzleDatesForModel.mockResolvedValue([]);
      await service.runTick();
      expect(stateRepo.update).toHaveBeenCalledWith({ id: "openrouter" }, { active: false });
    });

    it("honours OPENROUTER_FREE_DAILY_BUDGET override", async () => {
      process.env.OPENROUTER_FREE_DAILY_BUDGET = "1000";
      strategyService.countTodayLlmCalls.mockResolvedValue(60);
      await service.runTick();
      expect(strategyService.triggerStrategyRuns).toHaveBeenCalled();
      delete process.env.OPENROUTER_FREE_DAILY_BUDGET;
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest openrouter-free-dispatch.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/openrouter-free-dispatch/entities/openrouter-dispatch-state.entity.ts`:

```ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "openrouter") tracking whether the
 * OpenRouter free-daily-budget dispatch cycle (OpenRouterFreeDispatchService)
 * is currently running — the OpenRouter counterpart to GroqDispatchState.
 */
@Entity("OpenRouterDispatchState")
export class OpenRouterDispatchState {
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

Create `backend/src/modules/queue/openrouter-free-dispatch.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the OpenRouter free-daily-budget dispatch cycle (see
// OpenRouterFreeDispatchService). Each job is one "tick": it checks the
// account-wide hold, counts today's logged OpenRouter API calls against the
// configured daily budget, queues the next small batch of trials, and
// (unless done) schedules its own successor tick.
export const openRouterFreeDispatchQueue = new Queue("openrouter-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
```

Wire into `queue.module.ts`: import it, add `export const OPENROUTER_FREE_DISPATCH_QUEUE = "OPENROUTER_FREE_DISPATCH_QUEUE";`, and its provider/export entries.

- [ ] **Step 5: Create the service**

Create `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.service.ts`:

```ts
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { OPENROUTER_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { OpenRouterDispatchState } from "./entities/openrouter-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { OpenRouterRateLimitHoldService } from "../strategy/openrouter-rate-limit-hold.service";
import {
  LLM_OPENROUTER,
  openRouterCallsPerTrialEstimate,
  openRouterDispatchMaxBatch,
  openRouterDispatchMaxInFlight,
  openRouterDispatchRpmCooldownSeconds,
  openRouterDispatchTickMs,
  openRouterFreeDailyBudget,
} from "../../strategies";

const TICK_JOB_NAME = "tick";
const STATE_ID = "openrouter";

export interface OpenRouterDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
  callsToday: number;
  dailyBudget: number;
}

/**
 * The OpenRouter counterpart to GroqFreeDispatchService — same
 * self-rescheduling tick chain and least-allocated-model round-robin, but
 * three OpenRouter-specific adaptations, because OpenRouter's free tier is
 * account-wide, not per-model:
 *  1. Stop condition is a self-counted daily *call* budget
 *     (StrategyService.countTodayLlmCalls, from SolvePrompt rows) against
 *     OPENROUTER_FREE_DAILY_BUDGET — not "every model held". The
 *     account-wide 'daily' hold is the hard backstop.
 *  2. Global pacing via the dedicated OPENROUTER_DISPATCH_* knobs, sized
 *     for the fixed 20 req/min account-wide ceiling.
 *  3. A live 'per-minute-cooldown' hold (written by the runner on a 20 RPM
 *     429) makes a tick dispatch nothing and reschedule after the cooldown.
 * See docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §5.
 */
@Injectable()
export class OpenRouterFreeDispatchService {
  private readonly logger = new Logger(OpenRouterFreeDispatchService.name);

  constructor(
    @InjectRepository(OpenRouterDispatchState)
    private readonly stateRepo: Repository<OpenRouterDispatchState>,
    @Inject(OPENROUTER_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(OpenRouterRateLimitHoldService) private readonly holdService: OpenRouterRateLimitHoldService,
  ) {}

  async start(): Promise<{ status: OpenRouterDispatchStatusDto; outcome: "started" | "alreadyExhausted" }> {
    const existing = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "OpenRouter free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_OPENROUTER);
    const held = await this.holdService.isHeld();
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);
    const budget = openRouterFreeDailyBudget();

    if (models.length === 0 || held || callsToday >= budget) {
      await this.stateRepo.save({ id: STATE_ID, active: false, startedAt: null });
      this.logger.log(
        `openrouter free-tier dispatch: not starting (models=${models.length}, held=${held}, ` +
          `callsToday=${callsToday}/${budget})`,
      );
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });
    this.logger.log("openrouter free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<OpenRouterDispatchStatusDto> {
    await this.stateRepo.update({ id: STATE_ID }, { active: false });
    this.logger.log("openrouter free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<OpenRouterDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);
    return {
      active: state?.active ?? false,
      startedAt: state?.startedAt ?? null,
      callsToday,
      dailyBudget: openRouterFreeDailyBudget(),
    };
  }

  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    if (!state?.active) {
      this.logger.log("openrouter free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const reason = await this.holdService.heldReason();
    if (reason === "daily") {
      await this.deactivate("account is daily-held");
      return;
    }
    if (reason === "per-minute-cooldown") {
      await this.rescheduleAfterCooldown();
      this.logger.log("openrouter free-tier dispatch tick: per-minute cooldown live — skipped");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_OPENROUTER);
    if (models.length === 0) {
      await this.deactivate("no OpenRouter models configured");
      return;
    }

    const budget = openRouterFreeDailyBudget();
    const callsPerTrial = openRouterCallsPerTrialEstimate();
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);

    const maxInFlight = openRouterDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_OPENROUTER, models);
    const inFlightTotal = [...inFlight.values()].reduce((sum, c) => sum + c, 0);
    const estimatedInFlightCalls = inFlightTotal * callsPerTrial;

    if (callsToday + estimatedInFlightCalls >= budget) {
      await this.deactivate(
        `daily budget reached (${callsToday} logged + ~${estimatedInFlightCalls} in-flight >= ${budget})`,
      );
      return;
    }

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `openrouter free-tier dispatch tick: ${inFlightTotal} trial(s) in flight (cap ${maxInFlight}) — waiting`,
      );
      await this.scheduleNextTick();
      return;
    }

    const callsRemaining = budget - callsToday - estimatedInFlightCalls;
    const trialsAffordable = Math.max(0, Math.floor(callsRemaining / callsPerTrial));
    const maxNewTrials = Math.min(
      openRouterDispatchMaxBatch(),
      maxInFlight - inFlightTotal,
      trialsAffordable,
    );

    if (maxNewTrials <= 0) {
      this.logger.log("openrouter free-tier dispatch tick: no budget headroom for a whole trial — waiting");
      await this.scheduleNextTick();
      return;
    }

    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_OPENROUTER, models);
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < models.length) {
      const model = OpenRouterFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_OPENROUTER, model, 1);
      } catch (err) {
        this.logger.warn(
          `openrouter free-tier dispatch tick: puzzle lookup failed for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyService.triggerStrategyRuns(target.puzzleId, LLM_OPENROUTER, target.date, model);
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `openrouter free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`openrouter free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === models.length) {
      await this.deactivate("out of unrun puzzles for every configured model");
      return;
    }

    await this.scheduleNextTick();
  }

  private async deactivate(why: string): Promise<void> {
    await this.stateRepo.update({ id: STATE_ID }, { active: false });
    this.logger.log(`openrouter free-tier dispatch: stopping — ${why}`);
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(TICK_JOB_NAME, {}, { delay: openRouterDispatchTickMs(), jobId: this.freshTickJobId() });
  }

  private async rescheduleAfterCooldown(): Promise<void> {
    const resetAt = await this.holdService.nextResetAt();
    const delay = resetAt
      ? Math.max(0, resetAt.getTime() - Date.now())
      : openRouterDispatchRpmCooldownSeconds() * 1000;
    await this.queue.add(TICK_JOB_NAME, {}, { delay, jobId: this.freshTickJobId() });
  }

  private freshTickJobId(): string {
    return `openrouter-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

Note: `countTodayDispatchByModel` returns a `Map` keyed only by models that have dispatched today; if a configured model is absent from it, `leastAllocatedModel` won't consider it. Match the Groq service's handling — if Groq's version seeds the allocation map with every eligible model at 0 first, do the same here (seed `allocation` from `models` before the loop).

- [ ] **Step 6: Create the module**

Create `backend/src/modules/openrouter-free-dispatch/openrouter-free-dispatch.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { OpenRouterDispatchState } from "./entities/openrouter-dispatch-state.entity";
import { OpenRouterFreeDispatchService } from "./openrouter-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([OpenRouterDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [OpenRouterFreeDispatchService],
  exports: [OpenRouterFreeDispatchService],
})
export class OpenRouterFreeDispatchModule {}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && npx jest openrouter-free-dispatch.service.spec.ts`
Expected: PASS

- [ ] **Step 8: Create the migration**

Create `backend/src/migrations/1790000000000-add-openrouter-dispatch-state.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the OpenRouter free-daily-budget
 * dispatch cycle is currently running — the OpenRouter counterpart to
 * GroqDispatchState.
 */
export class AddOpenRouterDispatchState1790000000000 implements MigrationInterface {
  name = "AddOpenRouterDispatchState1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "OpenRouterDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "OpenRouterDispatchState"`);
  }
}
```

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/openrouter-free-dispatch backend/src/modules/queue/openrouter-free-dispatch.queue.ts backend/src/modules/queue/queue.module.ts backend/src/migrations/1790000000000-add-openrouter-dispatch-state.ts
git commit -m "$(cat <<'EOF'
feat(backend): add OpenRouterFreeDispatchService (account-wide daily-call budget)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Backend — `OpenRouterRpdResumeService` and bootstrap (fixed UTC cron)

**Files:**
- Create: `backend/src/modules/strategy/openrouter-rpd-resume.service.ts`
- Create: `backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.ts`
- Create: `backend/src/modules/queue/openrouter-rpd-resume.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`
- Test: `backend/src/modules/strategy/openrouter-rpd-resume.service.spec.ts`
- Test: `backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.spec.ts`

**Interfaces:**
- Consumes: `OpenRouterRateLimitHoldService` (Task 5), `LLM_OPENROUTER_QUEUE` (Task 7), `runStrategyJobId` (pre-existing, `./queue/strategy.queue`).
- Produces: `OpenRouterRpdResumeService.runResume(): Promise<{ cleared: boolean; redispatched: number }>` — used by Task 11 (worker).

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/modules/strategy/openrouter-rpd-resume.service.spec.ts`. Model the harness on `google-rpd-resume.service.spec.ts` (it drives a fixed-cron resume, same as this one), with substitutions and **no `rearm` tests** (there is no rearm here):

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { OpenRouterRpdResumeService } from "./openrouter-rpd-resume.service";
import { OpenRouterRateLimitHoldService } from "./openrouter-rate-limit-hold.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { LLM_OPENROUTER_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";

describe("OpenRouterRpdResumeService", () => {
  let service: OpenRouterRpdResumeService;
  let strategyRunRepo: { find: jest.Mock; save: jest.Mock };
  let holdService: { clearExpired: jest.Mock; isHeld: jest.Mock };
  let queue: { add: jest.Mock };

  const parkedRun = (over: Partial<StrategyRun> & { puzzle: { date: string } }) => ({
    id: 1,
    puzzleId: 10,
    trialNumber: 0,
    strategyName: "llm-openrouter",
    modelName: "z-ai/glm-5.2:free",
    status: StrategyRunStatus.RATE_LIMITED_DAILY,
    ...over,
  });

  beforeEach(async () => {
    strategyRunRepo = { find: jest.fn().mockResolvedValue([]), save: jest.fn().mockResolvedValue(undefined) };
    holdService = { clearExpired: jest.fn().mockResolvedValue(true), isHeld: jest.fn().mockResolvedValue(false) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterRpdResumeService,
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: OpenRouterRateLimitHoldService, useValue: holdService },
        { provide: LLM_OPENROUTER_QUEUE, useValue: queue },
      ],
    }).compile();

    service = module.get(OpenRouterRpdResumeService);
  });

  afterEach(() => jest.clearAllMocks());

  it("clears the expired hold and re-dispatches every parked llm-openrouter run", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, puzzle: { date: "2026-01-02" } }),
    ]);

    const result = await service.runResume();

    expect(holdService.clearExpired).toHaveBeenCalled();
    expect(strategyRunRepo.save).toHaveBeenCalledTimes(2);
    expect(strategyRunRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, status: StrategyRunStatus.RUNNING }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-openrouter", puzzleId: 10, date: "2026-01-01" }),
      { jobId: expect.stringMatching(new RegExp(`^${runStrategyJobId(10, "llm-openrouter", 0)}-resume-`)) },
    );
    expect(result).toEqual({ cleared: true, redispatched: 2 });
  });

  it("re-dispatches nothing while the account hold is still live", async () => {
    holdService.clearExpired.mockResolvedValue(false);
    holdService.isHeld.mockResolvedValue(true);
    strategyRunRepo.find.mockResolvedValue([parkedRun({ puzzle: { date: "2026-01-01" } })]);

    const result = await service.runResume();

    expect(queue.add).not.toHaveBeenCalled();
    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false, redispatched: 0 });
  });

  it("uses one stamp for every run in a sweep and an id distinct from the run's original job id", async () => {
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 0, puzzle: { date: "2026-01-02" } }),
    ]);

    await service.runResume();

    const firstId = queue.add.mock.calls[0][2].jobId as string;
    const secondId = queue.add.mock.calls[1][2].jobId as string;
    expect(firstId.split("-resume-")[1]).toBe(secondId.split("-resume-")[1]);
    expect(firstId).not.toBe(runStrategyJobId(10, "llm-openrouter", 0));
  });

  it("leaves a run parked when its enqueue fails", async () => {
    queue.add.mockRejectedValueOnce(new Error("redis down"));
    strategyRunRepo.find.mockResolvedValue([parkedRun({ puzzle: { date: "2026-01-01" } })]);

    const result = await service.runResume();

    expect(strategyRunRepo.save).not.toHaveBeenCalled();
    expect(result.redispatched).toBe(0);
  });

  it("does nothing when there are no parked runs", async () => {
    const result = await service.runResume();
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: true, redispatched: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest openrouter-rpd-resume.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `backend/src/modules/strategy/openrouter-rpd-resume.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { LLM_OPENROUTER_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_OPENROUTER } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { OpenRouterRateLimitHoldService } from "./openrouter-rate-limit-hold.service";

/**
 * The OpenRouter counterpart to GoogleRpdResumeService. Clears the single
 * OpenRouterRateLimitHold row once its resetAt has passed, then flips every
 * llm-openrouter run parked at RATE_LIMITED_DAILY back to RUNNING and
 * re-dispatches it. Driven by a fixed 00:05 UTC cron (see
 * OpenRouterRpdResumeBootstrap) — OpenRouter's daily quota resets on a fixed
 * UTC-midnight clock, so there is no per-hit self-rescheduling the way
 * Groq's resume sweep needs. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §6.
 */
@Injectable()
export class OpenRouterRpdResumeService {
  private readonly logger = new Logger(OpenRouterRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(OpenRouterRateLimitHoldService) private readonly holdService: OpenRouterRateLimitHoldService,
    @Inject(LLM_OPENROUTER_QUEUE) private readonly llmOpenRouterQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: boolean; redispatched: number }> {
    const cleared = await this.holdService.clearExpired();

    if (await this.holdService.isHeld()) {
      this.logger.log("openrouter-rpd resume: account still held — nothing to resume");
      return { cleared, redispatched: 0 };
    }

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_OPENROUTER },
      relations: { puzzle: true },
    });

    if (parked.length === 0) {
      this.logger.log(`openrouter-rpd resume: cleared=${cleared}, no parked runs`);
      return { cleared, redispatched: 0 };
    }

    // One UTC-day stamp for the whole sweep: a fresh id relative to each
    // run's original completed job, but stable across a retried sweep so
    // duplicate enqueues collapse. Same reasoning as Google's
    // pacificDateStamp, in UTC.
    const stamp = new Date().toISOString().slice(0, 10);

    let redispatched = 0;
    for (const run of parked) {
      try {
        await this.llmOpenRouterQueue.add(
          "run-strategy",
          {
            puzzleId: run.puzzleId,
            strategyName: run.strategyName,
            date: run.puzzle.date,
            trialNumber: run.trialNumber,
            model: run.modelName,
          },
          {
            jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber)}-resume-${stamp}`,
          },
        );
        run.status = StrategyRunStatus.RUNNING;
        await this.strategyRunRepo.save(run);
        redispatched++;
      } catch (err) {
        this.logger.warn(`openrouter-rpd resume: failed to re-dispatch run ${run.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`openrouter-rpd resume: cleared=${cleared}, re-dispatched ${redispatched}/${parked.length}`);
    return { cleared, redispatched };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest openrouter-rpd-resume.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Create the queue**

Create `backend/src/modules/queue/openrouter-rpd-resume.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the OpenRouter account-wide daily-hold resume (see
// OpenRouterRpdResumeService / OpenRouterRpdResumeBootstrap). A fixed
// 00:05 UTC daily schedule is registered against this queue by the
// bootstrap, plus one startup catch-up job — OpenRouter's daily quota
// resets on the UTC-midnight clock, so unlike groq-rpd-resume.queue.ts
// there is no self-scheduled per-hit rearm.
export const openRouterRpdResumeQueue = new Queue("openrouter-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
```

Wire into `queue.module.ts`: import it, add `export const OPENROUTER_RPD_RESUME_QUEUE = "OPENROUTER_RPD_RESUME_QUEUE";`, and its provider/export entries.

- [ ] **Step 6: Write the failing test for the bootstrap**

Create `backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.spec.ts`. Model it on `google-rpd-resume.bootstrap.spec.ts` (which asserts a fixed cron is registered) — read that file for the exact `upsertJobScheduler` argument shape it asserts, and mirror it with these values:

```ts
import { Queue } from "bullmq";
import { OpenRouterRpdResumeBootstrap } from "./openrouter-rpd-resume.bootstrap";

describe("OpenRouterRpdResumeBootstrap", () => {
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

  it("registers a 00:05 UTC daily cron and enqueues one startup catch-up sweep", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new OpenRouterRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const schedulerArgs = queue.upsertJobScheduler.mock.calls[0];
    expect(JSON.stringify(schedulerArgs)).toContain("5 0 * * *");
    expect(JSON.stringify(schedulerArgs)).toContain("UTC");

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-openrouter-rpd");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `openrouter-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new OpenRouterRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd backend && npx jest openrouter-rpd-resume.bootstrap.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the bootstrap**

Create `backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.ts`. Match `google-rpd-resume.bootstrap.ts`'s exact `upsertJobScheduler` call signature (argument order and the options object shape differ between BullMQ versions — copy the Google file's form and only change the values):

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { OPENROUTER_RPD_RESUME_QUEUE } from "../queue/queue.module";

/**
 * Registers the OpenRouter daily-hold resume sweep. Unlike
 * GroqRpdResumeBootstrap (no fixed schedule — Groq holds have per-hit
 * resets), OpenRouter's daily quota resets at a fixed UTC midnight, so this
 * is a plain daily cron at 00:05 UTC, mirroring GoogleRpdResumeBootstrap
 * (which uses Pacific). Also enqueues one startup catch-up sweep to revive
 * anything that expired while the process was down. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §6.
 */
@Injectable()
export class OpenRouterRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(OpenRouterRpdResumeBootstrap.name);

  constructor(@Inject(OPENROUTER_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping openrouter-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.upsertJobScheduler(
      "openrouter-rpd-resume-daily",
      { pattern: "5 0 * * *", tz: "UTC" },
      {
        name: "resume-openrouter-rpd",
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 50 },
      },
    );

    await this.queue.add(
      "resume-openrouter-rpd",
      {},
      {
        jobId: `openrouter-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    this.logger.log("openrouter-rpd-resume: registered 00:05 UTC daily cron + startup catch-up sweep");
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend && npx jest openrouter-rpd-resume.bootstrap.spec.ts`
Expected: PASS (if the `upsertJobScheduler` arg shape differs from the Google file, adjust both the bootstrap and the Step 6 assertion together)

- [ ] **Step 10: Wire both into `StrategyModule`**

In `strategy.module.ts`, import `OpenRouterRpdResumeService` and `OpenRouterRpdResumeBootstrap`, add both to `providers`, and add `OpenRouterRpdResumeService` to `exports` (Task 11's worker reads it via `appContext.get`).

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/strategy/openrouter-rpd-resume.service.ts backend/src/modules/strategy/openrouter-rpd-resume.service.spec.ts backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.ts backend/src/modules/strategy/openrouter-rpd-resume.bootstrap.spec.ts backend/src/modules/queue/openrouter-rpd-resume.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add OpenRouterRpdResumeService with a fixed 00:05 UTC cron sweep

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Backend — wire the three new workers into `worker.ts`

**Files:**
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `OpenRouterFreeDispatchService` (Task 9), `OpenRouterRpdResumeService` (Task 10), `llmOpenRouterConcurrency` (Task 4).
- Produces: nothing exported — verified by typecheck + the Task 16 smoke test.

- [ ] **Step 1: Implement**

Add imports:

```ts
import { OpenRouterFreeDispatchService } from "./modules/openrouter-free-dispatch/openrouter-free-dispatch.service";
import { OpenRouterRpdResumeService } from "./modules/strategy/openrouter-rpd-resume.service";
```

Add `LLM_OPENROUTER` and `llmOpenRouterConcurrency` to the existing `"./strategies"` import.

In `bootstrap()`, alongside the other `appContext.get(...)` calls:

```ts
  const openRouterFreeDispatchService = appContext.get(OpenRouterFreeDispatchService);
  const openRouterRpdResumeService = appContext.get(OpenRouterRpdResumeService);
```

Extend `createLlmWorker`'s `queueName` parameter type:

```ts
    queueName: "llm-openai-runs" | "llm-ollama-runs" | "llm-google-runs" | "llm-groq-runs" | "llm-openrouter-runs",
```

In the `if (role !== "ollama")` block, right after the `llmGroqWorker` push:

```ts
    const llmOpenRouterWorker = createLlmWorker(
      "llm-openrouter-runs",
      LLM_OPENROUTER,
      llmOpenRouterConcurrency(),
    );
    activeWorkers.push(llmOpenRouterWorker);
    activeQueueNames.push("llm-openrouter-runs");
```

Right after the `groqFreeDispatchWorker` block:

```ts
    // Each job is one tick of the OpenRouter free-daily-budget dispatch
    // cycle (see OpenRouterFreeDispatchService) — same self-chaining shape
    // as the Groq/Google dispatch workers above.
    const openRouterFreeDispatchWorker = new Worker(
      "openrouter-free-dispatch",
      async (job: Job) => {
        logger.log(`starting openrouter free-tier dispatch tick ${job.id}`);
        await openRouterFreeDispatchService.runTick();
        logger.log(`finished openrouter free-tier dispatch tick ${job.id}`);
      },
      { connection: redisConnection, concurrency: 1 },
    );

    openRouterFreeDispatchWorker.on("failed", (job, err) => {
      logger.error(`openrouter free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(openRouterFreeDispatchWorker);
    activeQueueNames.push("openrouter-free-dispatch");
```

Right after the `groqRpdResumeWorker` block:

```ts
    const openRouterRpdResumeWorker = new Worker(
      "openrouter-rpd-resume",
      async (job) => {
        logger.log(`starting openrouter-rpd resume sweep ${job.id}`);
        const result = await openRouterRpdResumeService.runResume();
        logger.log(`finished openrouter-rpd resume sweep ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      { connection: redisConnection, concurrency: 1 },
    );

    openRouterRpdResumeWorker.on("failed", (job, err) => {
      logger.error(`openrouter-rpd resume sweep ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(openRouterRpdResumeWorker);
    activeQueueNames.push("openrouter-rpd-resume");
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add backend/src/worker.ts
git commit -m "$(cat <<'EOF'
feat(backend): run the three new OpenRouter queues in the worker process

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Backend — seed the four OpenRouter models (+ model-id colon audit)

**Files:**
- Create: `backend/src/migrations/1788000000000-add-openrouter-models.ts`
- Possibly modify: leaderboard link building / any model-id path param (see Step 1)

**Interfaces:**
- Produces: four `SupportedModel` rows for `strategyName = 'llm-openrouter'`, `modelName` = `openRouterSlug` = the `:free` id.

- [ ] **Step 1: Audit model-id encoding for the colon**

OpenRouter ids contain a slash **and** a colon (`z-ai/glm-5.2:free`). The repo fixed slash-encoding in leaderboard links (commit `d540f82`, `fix/leaderboard-slash-model-ids`); the colon is new. Before seeding, grep the frontend and backend for where a model id becomes part of a URL:

```bash
cd frontend && grep -rn "encodeURIComponent\|modelId\|model_id\|/model/\|leaderboard.*model" src | grep -iv test
cd ../backend && grep -rn "':model\|:modelName\|/model/\|modelName.*param\|@Param(.model" src | grep -iv spec
```

For each hit that builds a link or route from a model id: confirm `encodeURIComponent` (or equivalent) is applied so `z-ai/glm-5.2:free` round-trips (`%2F` and `%3A`). If a leaderboard route uses a bare `:model` path segment that would choke on `:` or `/`, fix it the same way the slash fix did (encode on the way out, decode/catch-all param on the way in). Add or extend a test alongside whatever `fix/leaderboard-slash-model-ids` touched, asserting a `z-ai/glm-5.2:free`-shaped id survives the round trip. If the audit finds nothing needs changing, note that in the commit message and move on — do not invent new encoding where none is needed.

- [ ] **Step 2: Re-confirm the four slugs are live and structured-output-capable**

```bash
for s in "z-ai/glm-5.2:free" "nvidia/nemotron-3-super-120b-a12b:free" "minimax/minimax-m3:free" "google/gemma-4-31b-it:free"; do
  curl -s "https://openrouter.ai/api/v1/models/$s/endpoints" | python -c "import sys,json;d=json.load(sys.stdin).get('data',{});e=d.get('endpoints',[]);print('$s', bool(e), [p for p in (e[0].get('supported_parameters',[]) if e else []) if p in ('response_format','structured_outputs')])"
done
```

Every one must return a live free endpoint that lists at least `response_format`. If any has been delisted or lost `response_format`, substitute `minimax/minimax-m2.7:free` (the designated alternate) or raise it before proceeding — do not seed a model that can't do `generateObject`.

- [ ] **Step 3: Create the migration**

Create `backend/src/migrations/1788000000000-add-openrouter-models.ts` (verify `1788...` is the next free timestamp):

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the four OpenRouter free-tier chat models this pass supports
 * for the llm-openrouter strategy. For this provider `modelName` IS the
 * OpenRouter slug (the ":free" id), and openRouterSlug is set to the same
 * value — each ":free" id is a real /api/v1/models catalog entry with its
 * own context_length/created/pricing, so ModelMetadataRefreshService fills
 * contextWindow/releaseDate/pricing on its next run. freeTier stays NULL
 * (OpenRouter is not part of either OpenAI token tier). Excludes tools-only
 * ":free" models with no response_format support (thinkingmachines/inkling,
 * nvidia/nemotron-3.5-lightning) and all audio/safety/embedding ":free"
 * entries. See docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md.
 */
export class AddOpenRouterModels1788000000000 implements MigrationInterface {
  name = "AddOpenRouterModels1788000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug", "freeTier")
      VALUES
        ('llm-openrouter', 'z-ai/glm-5.2:free',                     true, 'z-ai/glm-5.2:free',                     NULL),
        ('llm-openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', true, 'nvidia/nemotron-3-super-120b-a12b:free', NULL),
        ('llm-openrouter', 'minimax/minimax-m3:free',               true, 'minimax/minimax-m3:free',               NULL),
        ('llm-openrouter', 'google/gemma-4-31b-it:free',            true, 'google/gemma-4-31b-it:free',            NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-openrouter'
        AND "modelName" IN (
          'z-ai/glm-5.2:free', 'nvidia/nemotron-3-super-120b-a12b:free',
          'minimax/minimax-m3:free', 'google/gemma-4-31b-it:free'
        )
    `);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/1788000000000-add-openrouter-models.ts frontend/src backend/src
git commit -m "$(cat <<'EOF'
feat(backend): seed the four OpenRouter free-tier chat models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(Only stage the frontend/backend encoding files if Step 1 actually changed them.)

---

### Task 13: Backend — `/dispatch/openrouter` status/stop endpoints

**Files:**
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `backend/src/modules/dispatch/dispatch.module.ts`
- Test: `backend/src/modules/dispatch/dispatch.controller.spec.ts` (only if one already exists)

**Interfaces:**
- Consumes: `OpenRouterFreeDispatchService` (Task 9).
- Produces: `GET /dispatch/openrouter`, `DELETE /dispatch/openrouter`.

- [ ] **Step 1: Check for a controller spec and add mirrored tests if present**

Read `backend/src/modules/dispatch/dispatch.controller.spec.ts`. If it exists and has Groq/Google route tests, add:

```ts
  it("GET /dispatch/openrouter returns the OpenRouter dispatch status", async () => {
    mockOpenRouterFreeDispatchService.getStatus.mockResolvedValue({
      active: true, startedAt: new Date(), callsToday: 12, dailyBudget: 50,
    });
    const result = await controller.getOpenRouterDispatchStatus();
    expect(result.active).toBe(true);
    expect(result.callsToday).toBe(12);
  });

  it("DELETE /dispatch/openrouter stops the OpenRouter dispatch cycle", async () => {
    mockOpenRouterFreeDispatchService.stop.mockResolvedValue({
      active: false, startedAt: null, callsToday: 12, dailyBudget: 50,
    });
    const result = await controller.stopOpenRouterDispatch();
    expect(mockOpenRouterFreeDispatchService.stop).toHaveBeenCalled();
    expect(result.active).toBe(false);
  });
```

If no such spec file exists, skip to Step 2 and rely on the Step 3 typecheck + Task 16 smoke test (matches the Groq feature, which added no new controller spec).

- [ ] **Step 2: Implement**

In `dispatch.controller.ts`:

```ts
import { OpenRouterFreeDispatchService } from "../openrouter-free-dispatch/openrouter-free-dispatch.service";
```

```ts
    @Inject(OpenRouterFreeDispatchService)
    private readonly openRouterFreeDispatchService: OpenRouterFreeDispatchService,
```

After the existing `stopGroqDispatch` method:

```ts
  // Read-only OpenRouter free-daily-budget dispatch status — see
  // OpenRouterFreeDispatchService. Includes callsToday / dailyBudget since
  // OpenRouter's spend is a single countable account-wide number.
  @Get("openrouter")
  async getOpenRouterDispatchStatus() {
    return this.openRouterFreeDispatchService.getStatus();
  }

  // Deactivates the OpenRouter dispatch cycle — a no-op (not an error) if
  // it wasn't running.
  @Delete("openrouter")
  async stopOpenRouterDispatch() {
    return this.openRouterFreeDispatchService.stop();
  }
```

In `dispatch.module.ts`, import `OpenRouterFreeDispatchModule` and add it to `imports` alongside `GroqFreeDispatchModule`.

- [ ] **Step 3: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS. If Step 1 added tests: `cd backend && npx jest dispatch.controller.spec.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/dispatch/dispatch.controller.ts backend/src/modules/dispatch/dispatch.module.ts backend/src/modules/dispatch/dispatch.controller.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GET/DELETE /dispatch/openrouter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Backend — `openRouterBurn` leg in the daily-automation chain

**Files:**
- Modify: `backend/src/modules/automation/daily-automation.service.ts`
- Modify: `backend/src/modules/automation/daily-automation.service.spec.ts`
- Modify: `backend/src/modules/automation/entities/automation-run-log.entity.ts`
- Modify: `backend/src/modules/automation/automation.controller.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`
- Create: `backend/src/migrations/1791000000000-add-automation-openrouter-leg.ts`

**Interfaces:**
- Consumes: `OpenRouterFreeDispatchService` (Task 9).
- Produces: `DailyAutomationService.run()` also fires an `openRouterBurn` leg; `GET /automation/status` includes an `openRouterBurn` field.

- [ ] **Step 1: Write the failing tests**

In `daily-automation.service.spec.ts`, import `OpenRouterFreeDispatchService`, add a mock alongside `mockGroqFreeDispatchService`:

```ts
    mockOpenRouterFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null, callsToday: 0, dailyBudget: 50 }),
      start: jest.fn().mockResolvedValue({
        status: { active: true, startedAt: new Date(), callsToday: 0, dailyBudget: 50 },
        outcome: "started",
      }),
    };
```

Register it in `providers`: `{ provide: OpenRouterFreeDispatchService, useValue: mockOpenRouterFreeDispatchService }`.

Add these tests inside `describe("run", ...)`, mirroring the existing `groqBurn` tests exactly:

```ts
    it("starts the OpenRouter burn when no cycle is already running", async () => {
      await service.run();
      expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "started", openRouterBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the OpenRouter leg from start()'s outcome", async () => {
      mockOpenRouterFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null, callsToday: 50, dailyBudget: 50 },
        outcome: "alreadyExhausted",
      });
      await service.run();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "alreadyExhausted", openRouterBurnMessage: "OpenRouter daily budget spent or account held" },
      );
    });

    it("records alreadyActive for the OpenRouter leg without calling start", async () => {
      mockOpenRouterFreeDispatchService.getStatus.mockResolvedValueOnce({
        active: true, startedAt: new Date(), callsToday: 5, dailyBudget: 50,
      });
      await service.run();
      expect(mockOpenRouterFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "alreadyActive", openRouterBurnMessage: "already running" },
      );
    });

    it("records an OpenRouter leg failure without throwing, and still lets the other legs run", async () => {
      mockOpenRouterFreeDispatchService.start.mockRejectedValueOnce(new Error("openrouter down"));
      await expect(service.run()).resolves.toBeUndefined();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "error", openRouterBurnMessage: "openrouter down" },
      );
    });
```

Also update the pre-existing "judge leg failure ... still runs the other legs" test to add `expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: FAIL — `OpenRouterFreeDispatchService` unknown, `runOpenRouterBurnLeg` missing, columns never written.

- [ ] **Step 3: Implement in `daily-automation.service.ts`**

```ts
import { OpenRouterFreeDispatchService } from "../openrouter-free-dispatch/openrouter-free-dispatch.service";
```

```ts
    @Inject(OpenRouterFreeDispatchService)
    private readonly openRouterFreeDispatchService: OpenRouterFreeDispatchService,
```

In `run()`, after `await this.runGroqBurnLeg(date);`:

```ts
    await this.runOpenRouterBurnLeg(date);
```

After `runGroqBurnLeg`:

```ts
  private async runOpenRouterBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.openRouterFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { openRouterBurnOutcome: "alreadyActive", openRouterBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.openRouterFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted"
          ? "OpenRouter daily budget spent or account held"
          : "started";
      await this.runLogRepo.update(
        { date },
        { openRouterBurnOutcome: result.outcome, openRouterBurnMessage: message },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OpenRouter burn";
      this.logger.error(`daily automation openrouter-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { openRouterBurnOutcome: "error", openRouterBurnMessage: message },
      );
    }
  }
```

Update the class doc comment's leg list to six legs (add an `openRouterBurn` bullet mirroring `groqBurn`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the entity columns**

In `automation-run-log.entity.ts`, after `groqBurnMessage`:

```ts
  @Column({ type: "varchar", nullable: true })
  openRouterBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  openRouterBurnMessage: string | null;
```

- [ ] **Step 6: Create the migration**

Create `backend/src/migrations/1791000000000-add-automation-openrouter-leg.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the openRouterBurn leg's outcome/message columns to
 * AutomationRunLog — the OpenRouter counterpart to
 * groqBurnOutcome/groqBurnMessage. */
export class AddAutomationOpenRouterLeg1791000000000 implements MigrationInterface {
  name = "AddAutomationOpenRouterLeg1791000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "openRouterBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "openRouterBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "openRouterBurnOutcome",
        DROP COLUMN IF EXISTS "openRouterBurnMessage"
    `);
  }
}
```

- [ ] **Step 7: Update `AutomationController`**

In `automation.controller.ts`, after the `groqBurn` field in the returned object:

```ts
      openRouterBurn: {
        outcome: log?.openRouterBurnOutcome ?? null,
        message: log?.openRouterBurnMessage ?? null,
      },
```

- [ ] **Step 8: Update `AutomationModule`**

In `automation.module.ts`, import `OpenRouterFreeDispatchModule` and add it to `imports` alongside `GroqFreeDispatchModule`.

- [ ] **Step 9: Verify**

Run: `cd backend && npx tsc --noEmit && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/automation backend/src/migrations/1791000000000-add-automation-openrouter-leg.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the openRouterBurn leg to the daily-automation chain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Frontend — `OpenRouterDispatchWidget` and Activity page wiring

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Create: `frontend/src/components/benchmark/OpenRouterDispatchWidget.tsx`
- Create: `frontend/src/components/benchmark/__tests__/OpenRouterDispatchWidget.test.tsx`
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`

**Interfaces:**
- Consumes: `GET /automation/status` (now includes `openRouterBurn`, Task 14), `GET`/`DELETE /dispatch/openrouter` (Task 13).
- Produces: `OpenRouterDispatchWidget` component on the Activity page.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/benchmark/__tests__/OpenRouterDispatchWidget.test.tsx` from `GroqDispatchWidget.test.tsx` with substitutions: `GroqDispatchWidget` → `OpenRouterDispatchWidget`, `GroqDispatchStatus` → `OpenRouterDispatchStatus`, `/dispatch/groq` → `/dispatch/openrouter`, `"Groq daily quota"` → `"OpenRouter daily quota"`, `"Couldn't load Groq dispatch status: boom"` → `"Couldn't load OpenRouter dispatch status: boom"`. The status fixtures must include `callsToday` and `dailyBudget`. Add one extra test:

```ts
  it("renders the calls-today / budget line from the status payload", async () => {
    server.use(
      http.get("*/dispatch/openrouter", () =>
        HttpResponse.json({ active: true, startedAt: new Date().toISOString(), callsToday: 18, dailyBudget: 50 }),
      ),
    );

    render(<OpenRouterDispatchWidget />);

    expect(await screen.findByText(/18\s*\/\s*50 calls today/i)).toBeInTheDocument();
  });
```

(Match the file's actual MSW / render helpers — the snippet's `server.use`/`http` names follow the Groq test's own style; copy whatever that file uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/OpenRouterDispatchWidget.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `frontend/src/data/benchmark/types.ts`, after `GroqDispatchStatus`:

```ts
/** GET /dispatch/openrouter — whether the OpenRouter free-daily-budget
 * dispatch cycle (backend OpenRouterFreeDispatchService) is running, plus
 * the account-wide daily-call counter. OpenRouter's free tier caps total
 * requests across all :free models (not per-model), so unlike Groq/Google
 * there IS a single number to show. */
export interface OpenRouterDispatchStatus {
  active: boolean;
  startedAt: string | null;
  callsToday: number;
  dailyBudget: number;
}
```

Add `openRouterBurn: AutomationBurnLeg;` to `AutomationStatus`, after `groqBurn`.

- [ ] **Step 4: Add the API client functions**

In `frontend/src/data/benchmark/api.ts`, add `OpenRouterDispatchStatus` to the type-only import list, and after `stopGroqDispatch`:

```ts
/** Whether the OpenRouter free-daily-budget dispatch cycle is running —
 * see OpenRouterDispatchStatus. Polled the same way fetchGroqDispatchStatus
 * is. */
export function fetchOpenRouterDispatchStatus(signal?: AbortSignal): Promise<OpenRouterDispatchStatus> {
  return fetchJson("/dispatch/openrouter", signal);
}

/** Stops the OpenRouter dispatch cycle — a no-op (not an error) if it
 * wasn't running. */
export function stopOpenRouterDispatch(signal?: AbortSignal): Promise<OpenRouterDispatchStatus> {
  return fetchJson("/dispatch/openrouter", signal, { method: "DELETE" });
}
```

- [ ] **Step 5: Create the widget**

Create `frontend/src/components/benchmark/OpenRouterDispatchWidget.tsx` — copy `GroqDispatchWidget.tsx` with the Groq→OpenRouter renames, and add the calls-today line inside the rendered `bench-free-tier` block (after the active/inactive `bench-muted` span):

```tsx
      <span className="bench-muted">
        {status.callsToday} / {status.dailyBudget} calls today
      </span>
```

`TITLE` becomes `"OpenRouter daily quota"`; the error string becomes `Couldn't load OpenRouter dispatch status: {error}`; imports point at `fetchOpenRouterDispatchStatus` / `stopOpenRouterDispatch` and `OpenRouterDispatchStatus`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/OpenRouterDispatchWidget.test.tsx`
Expected: PASS

- [ ] **Step 7: Wire it into `ActivityPage.tsx`**

```ts
import { OpenRouterDispatchWidget } from "../../components/benchmark/OpenRouterDispatchWidget";
```

After the `groqBurnAutomation` block:

```ts
  const openRouterBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.openRouterBurn.outcome === "error"
            ? `failed: ${automationStatus.openRouterBurn.message}`
            : automationStatus.openRouterBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.openRouterBurn.outcome === "error",
      }
    : null;
```

In the JSX, right after `<GroqDispatchWidget automation={groqBurnAutomation} />`:

```tsx
          <OpenRouterDispatchWidget automation={openRouterBurnAutomation} />
```

- [ ] **Step 8: Run the full frontend suite**

Run: `cd frontend && npm test -- --run`
Expected: PASS (including `ActivityPage.test.tsx` / `App.test.tsx` — if either asserts an exact widget count or exact `bench-free-tiers` child list, update it to include the new widget).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/components/benchmark/OpenRouterDispatchWidget.tsx frontend/src/components/benchmark/__tests__/OpenRouterDispatchWidget.test.tsx frontend/src/pages/benchmark/ActivityPage.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add OpenRouterDispatchWidget to the Activity page

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

- [ ] **Step 5: Manual migration round-trip against a real dev database**

With the branch's own Postgres (`docker compose up -d db` on a throwaway volume, or the shared dev DB if free):

```bash
cd backend && npm run typeorm -- migration:run -d src/data-source.ts
# revert the four new migrations, newest first:
npm run typeorm -- migration:revert -d src/data-source.ts   # add-automation-openrouter-leg
npm run typeorm -- migration:revert -d src/data-source.ts   # add-openrouter-dispatch-state
npm run typeorm -- migration:revert -d src/data-source.ts   # add-openrouter-rate-limit-hold
npm run typeorm -- migration:revert -d src/data-source.ts   # add-openrouter-models
npm run typeorm -- migration:run -d src/data-source.ts
```

(Adjust the `npm run typeorm` invocation to this repo's actual script.) Expected: every migration applies and reverts cleanly; the four `SupportedModel` rows exist after the final `run`, and `SupportedModel.openRouterSlug` equals `modelName` for each.

- [ ] **Step 6: Boot the stack and smoke-test**

```bash
docker compose up -d --build
```

With `OPENROUTER_API_KEY` set in `.env`:
- `GET /dispatch/openrouter` → `{ "active": false, "startedAt": null, "callsToday": 0, "dailyBudget": 50 }` before automation fires.
- Worker log's "listening for jobs on" line includes `llm-openrouter-runs`, `openrouter-free-dispatch`, `openrouter-rpd-resume`.
- Optionally `POST /automation/run` (or trigger the daily chain) and confirm `AutomationRunLog.openRouterBurnOutcome` gets written and a couple of `llm-openrouter` `StrategyRun` rows appear, then `DELETE /dispatch/openrouter` stops it.

Record the outcome in the PR description — this is a manual smoke test, not automated.

- [ ] **Step 7: Report results**

Summarize pass/fail for Steps 1–4 and the outcome of Steps 5–6 before considering the plan complete. Do not proceed to `finishing-a-development-branch` until every automated suite passes.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 Provider (orchestrator) | Task 1 |
| §2 Header-based 429 classification, `DAILY_RESET_THRESHOLD_SECONDS` | Task 2 |
| §3 Single-row `OpenRouterRateLimitHold` + service | Task 5 |
| §4 Runner: provider resolution, top gate, on-daily-hit hold, per-minute-cooldown write, per-provider fallback | Task 6 |
| §5a Daily-call budget stop condition + `countTodayLlmCalls` | Tasks 8, 9 |
| §5b Dedicated `OPENROUTER_DISPATCH_*` pacing knobs | Tasks 4, 9 |
| §5c Per-minute 429 pauses the tick chain | Tasks 6 (write), 9 (react) |
| §6 Fixed 00:05 UTC cron resume sweep + bootstrap | Task 10 |
| §7 Config (env vars, `strategies.ts` accessors, worker routing) | Tasks 1, 4, 11 |
| §8 Model seeding (`modelName` == `openRouterSlug`) + colon audit | Task 12 |
| §9 `openRouterBurn` automation leg + `/dispatch/openrouter` | Tasks 13, 14 |
| §10 `OpenRouterDispatchWidget` (+ calls-today line) | Task 15 |
| §11 Budget reality | documented in the spec; surfaced by Task 15's calls-today line — no code task |
| §12 Testing | every task is TDD; Task 16 is the full pass |

No spec section is left without a task.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code step carries real code. Task 12 Step 1 (encoding audit) and Task 13 Step 1 (spec-file check) are explicitly conditional with a defined fallback, not placeholders.

**3. Type consistency:** `OpenRouterHoldReason` = `"daily" | "per-minute-cooldown"` used identically in Tasks 5, 6, 9. `hold(reason, resetInSeconds)` signature consistent between Task 5 (definition) and Task 6 (call). `countTodayLlmCalls(strategyName): Promise<number>` consistent between Task 8 (definition) and Task 9 (call). `OpenRouterDispatchStatusDto` fields (`active`, `startedAt`, `callsToday`, `dailyBudget`) consistent across Tasks 9, 13, 14, 15. `queueForStrategy` arity (7 args) consistent between Task 7 and the plan's file structure. `runResume(): Promise<{ cleared: boolean; redispatched: number }>` consistent between Tasks 10 and 11.

**4. Refinement of the spec's migration count:** the spec's Testing section says "three new migrations". This plan uses **four** (`add-openrouter-models`, `add-openrouter-rate-limit-hold`, `add-openrouter-dispatch-state`, `add-automation-openrouter-leg`) so each is created inside the task whose deliverable needs it and can be reverted independently — the same 1-migration-per-concern split the merged Groq feature used. Functionally identical; noted here so the reviewer isn't surprised.
