# Groq Free-Tier Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth LLM strategy, `llm-groq`, dispatched and rate-limit-managed the same way `llm-google` is today — per-model RPD hold, self-rescheduling resume, proactive daily-burn dispatch, and a `groqBurn` leg in the existing daily-automation chain — seeded with four confirmed free-tier chat models.

**Architecture:** Groq's free tier gates per-model RPM/RPD, matching Google's shape rather than OpenAI's shared token-budget tiers, so this plan clones Google's `RateLimitHold`/`FreeDispatchService`/`RpdResumeService` trio under Groq-specific names. Two deliberate deviations from the Google original: (1) classification of a Groq 429 reads rate-limit response *headers* (`x-ratelimit-remaining-requests`, etc.) instead of parsing an error body, and (2) the resume sweep has no fixed daily cron — each hold's `resetAt` comes from that hit's own reset-duration header, so the resume chain self-reschedules at the soonest live hold's reset instead of a shared clock boundary.

**Tech Stack:** NestJS + TypeORM + BullMQ (backend/worker), Hono + Vercel AI SDK (`@ai-sdk/groq`) (orchestrator), React + TanStack Query (frontend). Jest (backend), Vitest (orchestrator, frontend).

**Spec:** [docs/superpowers/specs/2026-09-04-groq-free-tier-design.md](../specs/2026-09-04-groq-free-tier-design.md)

## Global Constraints

- Seed exactly these four `llm-groq` models, no others: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b`.
- `openRouterSlug` stays `NULL` at seed time — never guess a slug (repo policy); it's set later once confirmed live against OpenRouter's endpoints API.
- No manual `POST` start endpoint for Groq dispatch — automation-only, same as Google (`GET`/`DELETE` on `/dispatch/groq`).
- No new `SolveErrorCode` values — reuse `"rate_limited"` / `"rate_limited_daily"`, and reuse `StrategyRunStatus.RATE_LIMITED_DAILY` (already provider-agnostic).
- `GroqRateLimitHoldService` does no timezone math — `resetAt = heldAt + resetInSeconds`, not a fixed daily clock boundary.
- `GroqRpdResumeBootstrap` schedules no fixed cron — only a startup catch-up job; `GroqRpdResumeService.rearm()` is the sole ongoing scheduling mechanism.
- Google's own constants/services (`llmGoogleRateLimitFallbackSeconds`, `GoogleRateLimitHoldService`, etc.) are never modified to also serve Groq — every Groq behavior gets its own parallel name.
- Orchestrator tests use **Vitest** (`orchestrator/*.test.ts`, run via `npm test` → `vitest run`); backend tests use **Jest** (`backend/**/*.spec.ts`, run via `npm test` → `jest`). Don't mix the two APIs.

---

## File Structure

**Orchestrator (new/modified):**
- Modify `orchestrator/src/provider.ts` — add `"groq"` to `ModelProvider`, `DEFAULT_GROQ_MODEL`, `getModel`/`getModelName` branches.
- Modify `orchestrator/src/solver.ts` — Groq header-based 429 classification, `dailyResetSeconds` field, duration/seconds parsers.
- Modify `orchestrator/src/types.ts` — `"groq"` added to the `provider` enums on `SolveAssistRequestSchema`/`JudgeCategoryRequestSchema`.
- Modify `orchestrator/package.json` — add `@ai-sdk/groq` dependency.

**Backend (new/modified):**
- Modify `backend/src/modules/strategy/orchestrator.service.ts` — `"groq"` provider type, `dailyResetSeconds` passthrough.
- Modify `backend/src/strategies.ts` — `LLM_GROQ`, concurrency/fallback functions.
- Create `backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts`.
- Create `backend/src/modules/strategy/groq-rate-limit-hold.service.ts` (+ `.spec.ts`).
- Modify `backend/src/modules/strategy/llm-strategy-runner.service.ts` (+ `.spec.ts`) — Groq provider resolution, top gate, on-hit hold, per-provider rate-limit fallback.
- Modify `backend/src/modules/queue/strategy.queue.ts` (+ `.spec.ts`) — `llmGroqQueue`, `queueForStrategy` extended.
- Modify `backend/src/modules/queue/queue.module.ts` — `LLM_GROQ_QUEUE` token.
- Create `backend/src/modules/queue/groq-free-dispatch.queue.ts`.
- Create `backend/src/modules/queue/groq-rpd-resume.queue.ts`.
- Modify `backend/src/modules/strategy/strategy.service.ts` — inject `LLM_GROQ_QUEUE`, extend `queueFor`/`queuedCountsByKey`.
- Modify `backend/src/modules/strategy/strategy.module.ts` — register the new entity/services.
- Create `backend/src/modules/groq-free-dispatch/entities/groq-dispatch-state.entity.ts`.
- Create `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/groq-free-dispatch/groq-free-dispatch.module.ts`.
- Create `backend/src/modules/strategy/groq-rpd-resume.service.ts` (+ `.spec.ts`).
- Create `backend/src/modules/strategy/groq-rpd-resume.bootstrap.ts` (+ `.spec.ts`).
- Modify `backend/src/worker.ts` — three new worker handlers.
- Modify `backend/src/modules/dispatch/dispatch.controller.ts` — `GET`/`DELETE /dispatch/groq`.
- Modify `backend/src/modules/automation/daily-automation.service.ts` (+ `.spec.ts`) — `runGroqBurnLeg`.
- Modify `backend/src/modules/automation/entities/automation-run-log.entity.ts` — `groqBurnOutcome`/`groqBurnMessage`.
- Modify `backend/src/modules/automation/automation.controller.ts` — `groqBurn` in the status DTO.
- Modify `backend/src/modules/automation/automation.module.ts` — import `GroqFreeDispatchModule`.
- Create migrations: `1781000000000-add-groq-models.ts`, `1782000000000-add-groq-rate-limit-hold.ts`, `1783000000000-add-groq-dispatch-state.ts`, `1784000000000-add-automation-groq-leg.ts`.

**Frontend (new/modified):**
- Modify `frontend/src/data/benchmark/types.ts` — `GroqDispatchStatus`, `AutomationStatus.groqBurn`.
- Modify `frontend/src/data/benchmark/api.ts` — `fetchGroqDispatchStatus`/`stopGroqDispatch`.
- Create `frontend/src/components/benchmark/GroqDispatchWidget.tsx` (+ `__tests__/GroqDispatchWidget.test.tsx`).
- Modify `frontend/src/pages/benchmark/ActivityPage.tsx` — wire the new widget.

**Docs:**
- Modify `.env.sample`, `docker-compose.yml`, `README.md` — Groq env vars.

---

### Task 1: Orchestrator — Groq model resolution

**Files:**
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/package.json`
- Modify: `.env.sample`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Test: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Produces: `ModelProvider` now includes `"groq"`. `DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b"`. `getModel("groq", modelOverride?, contextWindow?): LanguageModel`. `getModelName("groq", modelOverride?): string`.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/src/provider.test.ts` (alongside the existing `vi.mock` calls at the top):

```ts
const createGroqMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("@ai-sdk/groq", () => ({
  createGroq: createGroqMock,
}));
```

Add `createGroqMock.mockClear();` to the existing `afterEach` in the `describe("getModel", ...)` block.

Add these tests inside `describe("getModel", ...)`:

```ts
  it("resolves the Groq model without num_ctx", () => {
    getModel("groq");

    expect(createGroqMock).toHaveBeenCalledTimes(1);
    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("openai/gpt-oss-20b");
    expect(openaiMock).not.toHaveBeenCalled();
    expect(createOllamaMock).not.toHaveBeenCalled();
  });

  it("passes GROQ_API_KEY to createGroq", () => {
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");

    getModel("groq");

    expect(createGroqMock).toHaveBeenCalledWith({ apiKey: "test-groq-key" });
  });

  it("uses the model override instead of GROQ_MODEL when given", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");

    getModel("groq", "qwen/qwen3.6-27b");

    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("qwen/qwen3.6-27b");
  });

  it("accepts a contextWindow for groq without using it", () => {
    getModel("groq", undefined, 131072);

    const modelFactory = createGroqMock.mock.results[0].value;
    expect(modelFactory).toHaveBeenCalledWith("openai/gpt-oss-20b");
  });
```

Add these tests inside `describe("getModelName", ...)`:

```ts
  it("returns the configured Groq model for the groq provider", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");
    expect(getModelName("groq")).toBe("openai/gpt-oss-120b");
  });

  it("falls back to the Groq default when unset", () => {
    expect(getModelName("groq")).toBe("openai/gpt-oss-20b");
  });

  it("prefers the model override over GROQ_MODEL", () => {
    vi.stubEnv("GROQ_MODEL", "openai/gpt-oss-120b");
    expect(getModelName("groq", "qwen/qwen3.6-27b")).toBe("qwen/qwen3.6-27b");
  });
```

Add inside `describe("effectiveContextWindow", ...)`:

```ts
  it("never caps groq — returns the given contextWindow unchanged", () => {
    expect(effectiveContextWindow("groq", 131072)).toBe(131072);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: FAIL — `createGroq` import/mock has nothing to hook (`getModel`/`getModelName` don't accept `"groq"` yet; `ModelProvider` type error on `"groq"` literal).

- [ ] **Step 3: Add the `@ai-sdk/groq` dependency**

In `orchestrator/package.json`, add to `dependencies` (alphabetical, alongside the other `@ai-sdk/*` entries):

```json
    "@ai-sdk/groq": "^1.0.0",
```

Run `cd orchestrator && npm install` to fetch it and lock the exact resolved version. If `^1.0.0` doesn't resolve to a real published version, check `npm view @ai-sdk/groq versions` and use the latest major version's `^x.0.0` instead — confirm `createGroq` is the exported factory name before proceeding (per this repo's never-guess-a-package-API policy, same as the design spec's open question).

- [ ] **Step 4: Implement the `groq` branch in `provider.ts`**

In `orchestrator/src/provider.ts`:

```ts
import { openai } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-nano";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const DEFAULT_GOOGLE_MODEL = "gemini-3.6-flash";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_JUDGE_MODEL = "gpt-4.1-nano";
export const DEFAULT_JUDGE_PROVIDER: ModelProvider = "openai";
export const DEFAULT_CONTEXT_WINDOW = 8192;

export type ModelProvider = "openai" | "ollama" | "google" | "groq";
```

Update `defaultProvider()`:

```ts
export function defaultProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase();
  if (provider === "ollama") return "ollama";
  if (provider === "google") return "google";
  if (provider === "groq") return "groq";
  return "openai";
}
```

Update `getModel()` — add a branch before the final `openai(...)` fallback:

```ts
  if (provider === "groq") {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    return groq(modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
  }

  return openai(modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
```

Update `getModelName()` — add a branch before the final `return`:

```ts
  if (provider === "groq") {
    return modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
  }
  return modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
```

`effectiveContextWindow()` needs no change — its `provider !== "ollama"` passthrough already covers `"groq"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: PASS

- [ ] **Step 6: Document the new env vars**

In `.env.sample`, after the `GOOGLE_MODEL=gemini-3.6-flash` line, add:

```
# Groq API key (used by @ai-sdk/groq in the orchestrator)
GROQ_API_KEY=

# Groq model id (used when MODEL_PROVIDER=groq)
GROQ_MODEL=openai/gpt-oss-20b
```

Update the `MODEL_PROVIDER` comment block above `MODEL_PROVIDER=openai` to read:

```
# Default AI model provider for requests that don't specify one — i.e. the
# in-game AI Assist endpoint. Strategy runs always select their own provider
# via the strategy name: 'llm-openai' consults OpenAI, 'llm-ollama' the
# bundled Ollama service, 'llm-google' Google AI Studio, 'llm-groq' Groq.
# All four providers are always configured and can be used simultaneously.
```

In `docker-compose.yml`, in the `orchestrator` service's `environment:` block, after `GOOGLE_API_KEY: ${GOOGLE_API_KEY}` add `GROQ_API_KEY: ${GROQ_API_KEY}`, and after `GOOGLE_MODEL: ${GOOGLE_MODEL:-gemini-3.6-flash}` add `GROQ_MODEL: ${GROQ_MODEL:-openai/gpt-oss-20b}`.

In `README.md`'s env var table, after the `GOOGLE_API_KEY` row add:

```
| `GROQ_API_KEY` | — | Groq API key (orchestrator only) |
```

Update the `MODEL_PROVIDER` row's description to end `..., or \`groq\`. Strategy runs pick their provider via strategy name (\`llm-openai\` / \`llm-ollama\` / \`llm-google\` / \`llm-groq\`), so all four are always active |` and after the `GOOGLE_MODEL` row add:

```
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Groq model id (used by the `llm-groq` strategy and provider-less requests) |
```

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/provider.ts orchestrator/src/provider.test.ts orchestrator/package.json orchestrator/package-lock.json .env.sample docker-compose.yml README.md
git commit -m "$(cat <<'EOF'
feat(orchestrator): add Groq as a model provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Orchestrator — Groq rate-limit classification

**Files:**
- Modify: `orchestrator/src/solver.ts`
- Modify: `orchestrator/src/types.ts`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from Task 1 (now includes `"groq"`).
- Produces: `SolveErrorDetails.dailyResetSeconds?: number`. `classifyModelCallError(err, "groq", details)` returns `SolveError` with code `"rate_limited_daily"` (carrying `dailyResetSeconds`) or `"rate_limited"` (carrying `retryAfterSeconds`), same as it already does for `"google"`.

- [ ] **Step 1: Write the failing tests**

Add to `orchestrator/src/solver.test.ts`. First, extend `makeAPICallError` to accept headers (it currently hardcodes `responseHeaders: {}`):

```ts
function makeAPICallError(overrides: {
  statusCode: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
}): APICallError {
  return new APICallError({
    message: "Request failed",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseBody: overrides.responseBody,
    responseHeaders: overrides.responseHeaders ?? {},
    isRetryable: overrides.statusCode === 429,
  });
}
```

(This is a superset of the existing signature — every existing call site that doesn't pass `responseHeaders` keeps working unchanged.)

Add a new `describe` block:

```ts
describe("classifyModelCallError — groq", () => {
  it("classifies a Groq 429 with zero remaining daily requests as rate_limited_daily, parsing the reset-requests duration", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "2h59m59.56s",
      },
    });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBeCloseTo(2 * 3600 + 59 * 60 + 59.56);
  });

  it("falls back to retry-after for dailyResetSeconds when reset-requests is missing", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining-requests": "0", "retry-after": "86399" },
    });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBe(86399);
  });

  it("classifies a Groq 429 with nonzero remaining requests as rate_limited, using retry-after", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: {
        "x-ratelimit-remaining-requests": "17",
        "x-ratelimit-remaining-tokens": "0",
        "retry-after": "8",
      },
    });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBe(8);
  });

  it("falls back to reset-tokens for retryAfterSeconds when retry-after is missing", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: {
        "x-ratelimit-remaining-requests": "17",
        "x-ratelimit-reset-tokens": "45.2s",
      },
    });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeCloseTo(45.2);
  });

  it("classifies a Groq 429 with no rate-limit headers at all as rate_limited (no counter available)", () => {
    const err = makeAPICallError({ statusCode: 429, responseHeaders: {} });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeUndefined();
  });

  it("does not classify a non-groq provider's 429 using Groq headers", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining-requests": "0" },
    });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("still classifies a non-429 groq error as model_error", () => {
    const err = new Error("network blip");

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("model_error");
  });

  it("unwraps a RetryError around a Groq daily-limit APICallError as rate_limited_daily", () => {
    const inner = makeAPICallError({
      statusCode: 429,
      responseHeaders: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1h0m0s" },
    });
    const err = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner],
    });

    const result = classifyModelCallError(err, "groq", { model: "openai/gpt-oss-20b" });

    expect(result.code).toBe("rate_limited_daily");
    expect(result.details.dailyResetSeconds).toBe(3600);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: FAIL — no `groq` branch exists in `classifyModelCallError`, so every case falls through to `model_error`.

- [ ] **Step 3: Implement the Groq branch in `solver.ts`**

In `orchestrator/src/solver.ts`, add to `SolveErrorDetails`:

```ts
  // Seconds to wait before retrying — set only for a Google "rate_limited"
  // classification, from the response's own RetryInfo.retryDelay.
  retryAfterSeconds?: number;
  // Seconds until a Groq per-model daily (RPD) quota resets — set only for
  // a Groq "rate_limited_daily" classification, parsed from that response's
  // own x-ratelimit-reset-requests header (or its retry-after header as a
  // fallback). Groq's reset is a duration from the hit, not a fixed daily
  // clock boundary the way Google's Pacific-midnight reset is — see
  // GroqRateLimitHoldService on the backend, which uses this value directly
  // as `heldAt + dailyResetSeconds` rather than computing a shared boundary.
  dailyResetSeconds?: number;
```

Add two parsing helpers near `parseGoogleRateLimit`/`isGoogleDailyRateLimit`:

```ts
/**
 * Parses an HTTP-style plain seconds count (e.g. Groq's `retry-after`
 * header, or a fallback read of the same value): a non-negative integer or
 * float string. Returns undefined for anything else (missing, negative,
 * non-numeric) rather than throwing.
 */
function parseSecondsHeader(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Parses a Groq-style rate-limit reset duration (e.g. "2h59m59.56s",
 * mirroring OpenAI's own rate-limit header format) into seconds. Every
 * component is optional but at least one must be present — an empty or
 * unrecognized string returns undefined rather than throwing or silently
 * treating garbage as a zero-second wait.
 */
function parseGroqResetDuration(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}
```

Add the Groq branch in `classifyModelCallError`, right after the existing Google `if` block (both fall through to the same final `model_error` return, so order between them doesn't matter — placed after Google here only for reading order):

```ts
  if (provider === "groq" && APICallError.isInstance(err) && err.statusCode === 429) {
    const headers = err.responseHeaders ?? {};
    const remainingRequests = headers["x-ratelimit-remaining-requests"];

    if (remainingRequests === "0") {
      const dailyResetSeconds =
        parseGroqResetDuration(headers["x-ratelimit-reset-requests"]) ??
        parseSecondsHeader(headers["retry-after"]);
      return new SolveError("rate_limited_daily", `Groq daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        dailyResetSeconds,
      });
    }

    const retryAfterSeconds =
      parseSecondsHeader(headers["retry-after"]) ??
      parseGroqResetDuration(headers["x-ratelimit-reset-tokens"]);
    return new SolveError("rate_limited", `Groq rate limit hit: ${message}`, {
      ...details,
      ...apiDetails,
      errorName: err.name,
      retryAfterSeconds,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: PASS

- [ ] **Step 5: Extend the provider enums in `types.ts`**

In `orchestrator/src/types.ts`, change both occurrences of:

```ts
    provider: z.enum(["openai", "ollama", "google"]).optional()
```

to:

```ts
    provider: z.enum(["openai", "ollama", "google", "groq"]).optional()
```

(one in `SolveAssistRequestSchema`, one in `JudgeCategoryRequestSchema`). No test file covers these schemas directly beyond `solve-assist.test.ts`/`judge-category.test.ts`'s existing request-shape tests, which don't enumerate every provider — no new test needed here, but run the full orchestrator suite to confirm nothing broke.

- [ ] **Step 6: Run the full orchestrator test suite**

Run: `cd orchestrator && npm test`
Expected: PASS (all suites, including `solve-assist.test.ts`, `judge-category.test.ts`, `app.test.ts`)

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts orchestrator/src/types.ts
git commit -m "$(cat <<'EOF'
feat(orchestrator): classify Groq 429s via rate-limit headers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Backend — OrchestratorService client surface for Groq

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Test: (no dedicated spec file exists for this class today — verified by `llm-strategy-runner.service.spec.ts` and `orchestrator.service.spec.ts`, the latter covering only the `isKnownErrorCode`/error-mapping surface)
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `SolveAssistFailure.dailyResetSeconds?: number`. `solveAssist(...)`/`judgeCategory(...)` accept `provider?: "openai" | "ollama" | "google" | "groq"`.

- [ ] **Step 1: Write the failing test**

Read `backend/src/modules/strategy/orchestrator.service.spec.ts` first to find its existing `extractCallDetail`/failure-mapping test(s) for `retryAfterSeconds` and add a sibling next to it:

```ts
  it("passes dailyResetSeconds through from the orchestrator's error details", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "Groq daily quota exhausted",
        code: "rate_limited_daily",
        details: { dailyResetSeconds: 3600 },
      }),
    }) as unknown as typeof fetch;

    const service = new OrchestratorService();
    const result = await service.solveAssist([{ role: "user", content: "hi" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("rate_limited_daily");
      expect(result.error.dailyResetSeconds).toBe(3600);
    }
  });
```

(Match this test's exact mocking style to whatever `retryAfterSeconds`'s existing test in that file already uses — if it stubs `fetch` differently, e.g. via a shared helper, follow that helper instead of `globalThis.fetch` directly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest orchestrator.service.spec.ts -t "dailyResetSeconds"`
Expected: FAIL — `result.error.dailyResetSeconds` is `undefined` (the key doesn't exist on the type or isn't extracted).

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/orchestrator.service.ts`:

Change both provider parameter types from `"openai" | "ollama" | "google"` to `"openai" | "ollama" | "google" | "groq"` (in `solveAssist` and `judgeCategory`).

Add to `SolveAssistFailure`:

```ts
  // Seconds until a Groq per-model daily quota resets — set only when code
  // is "rate_limited_daily" for a Groq call. See the orchestrator's
  // SolveErrorDetails.dailyResetSeconds.
  dailyResetSeconds?: number;
```

Update `extractCallDetail`'s return type and body:

```ts
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    SolveAssistFailure,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
    | "retryAfterSeconds"
    | "dailyResetSeconds"
  > {
    if (!details) return {};
    return {
      requestBody: details.requestBody,
      responseId: details.responseId as string | undefined,
      responseHeaders: details.responseHeaders as Record<string, string> | undefined,
      responseBody: details.responseBody,
      statusCode: details.statusCode as number | undefined,
      errorName: details.errorName as string | undefined,
      isRetryable: details.isRetryable as boolean | undefined,
      retryAfterSeconds: details.retryAfterSeconds as number | undefined,
      dailyResetSeconds: details.dailyResetSeconds as number | undefined,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest orchestrator.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): thread Groq's daily-reset seconds through OrchestratorService

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
- Produces: `LLM_GROQ = "llm-groq"`, added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`. `llmGroqConcurrency(env?): number`. `llmGroqRateLimitFallbackSeconds(env?): number`. `llmGroqDailyHoldFallbackSeconds(env?): number`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/strategies.spec.ts`'s import list: `LLM_GROQ`, `llmGroqConcurrency`, `llmGroqRateLimitFallbackSeconds`, `llmGroqDailyHoldFallbackSeconds`, `DEFAULT_LLM_GROQ_CONCURRENCY`, `DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS`.

Add these `describe` blocks, mirroring the existing Google ones exactly:

```ts
  describe("llmGroqConcurrency", () => {
    it("should default when the env var is missing", () => {
      expect(llmGroqConcurrency({})).toBe(DEFAULT_LLM_GROQ_CONCURRENCY);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGroqConcurrency({ LLM_GROQ_CONCURRENCY: "abc" })).toBe(DEFAULT_LLM_GROQ_CONCURRENCY);
      expect(llmGroqConcurrency({ LLM_GROQ_CONCURRENCY: "0" })).toBe(DEFAULT_LLM_GROQ_CONCURRENCY);
    });

    it("should read a valid positive integer", () => {
      expect(llmGroqConcurrency({ LLM_GROQ_CONCURRENCY: "4" })).toBe(4);
    });
  });

  describe("llmGroqRateLimitFallbackSeconds", () => {
    it("should default when the env var is missing", () => {
      expect(llmGroqRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGroqRateLimitFallbackSeconds({ LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGroqRateLimitFallbackSeconds({ LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
    });
  });

  describe("llmGroqDailyHoldFallbackSeconds", () => {
    it("should default when the env var is missing", () => {
      expect(llmGroqDailyHoldFallbackSeconds({})).toBe(DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGroqDailyHoldFallbackSeconds({ LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGroqDailyHoldFallbackSeconds({ LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS: "3600" })).toBe(3600);
    });
  });
```

Update the existing `isLlmStrategy` test to also cover Groq:

```ts
  describe("isLlmStrategy", () => {
    it("should identify all four LLM strategies", () => {
      expect(isLlmStrategy(LLM_OPENAI)).toBe(true);
      expect(isLlmStrategy(LLM_OLLAMA)).toBe(true);
      expect(isLlmStrategy(LLM_GOOGLE)).toBe(true);
      expect(isLlmStrategy(LLM_GROQ)).toBe(true);
      expect(isLlmStrategy("shuffle-smart")).toBe(false);
    });
  });
```

(Adjust to match whatever the existing test's exact final assertions are — read the file first; the point is adding the `LLM_GROQ` line.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: FAIL — `LLM_GROQ` and the three new functions/constants don't exist yet (TypeScript compile error via ts-jest).

- [ ] **Step 3: Implement in `strategies.ts`**

Add `"llm-groq"` to `SUPPORTED_STRATEGIES`:

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
] as const;
```

Add the constant and extend `LLM_STRATEGIES`:

```ts
export const LLM_GOOGLE = "llm-google" as const;
export const LLM_GROQ = "llm-groq" as const;

export const LLM_STRATEGIES = [LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE, LLM_GROQ] as const;
```

Add the three new constants near `DEFAULT_LLM_GOOGLE_CONCURRENCY`/`DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS`:

```ts
export const DEFAULT_LLM_GROQ_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying after a Groq per-minute
// rate-limit hit, used only when neither Groq's retry-after nor
// x-ratelimit-reset-tokens header parsed — see orchestrator/src/solver.ts.
export const DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS = 60;

// Fallback hold duration (seconds) when a Groq daily-quota 429 carried no
// parseable reset-requests/retry-after header at all — a generous 24h,
// since (unlike Google's fixed Pacific-midnight reset) there is no shared
// clock boundary to fall back to for Groq.
export const DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS = 24 * 60 * 60;
```

Add the three functions near `llmGoogleConcurrency`/`llmGoogleRateLimitFallbackSeconds`:

```ts
/**
 * How many llm-groq runs the worker may process at once, from
 * LLM_GROQ_CONCURRENCY. Falls back to DEFAULT_LLM_GROQ_CONCURRENCY for
 * missing/invalid values.
 */
export function llmGroqConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_GROQ_CONCURRENCY, DEFAULT_LLM_GROQ_CONCURRENCY);
}

/**
 * Fallback wait (seconds) before retrying a Groq per-minute rate-limit hit,
 * from LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS. Only used when Groq's own
 * headers didn't yield a wait. Falls back to
 * DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmGroqRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

/**
 * Fallback daily-hold duration (seconds) when a Groq daily-quota hit carried
 * no parseable reset duration at all, from LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS.
 * Falls back to DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS for
 * missing/invalid values.
 */
export function llmGroqDailyHoldFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
    DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest strategies.spec.ts`
Expected: PASS (including the pre-existing `STRATEGY_SET`/`AUTOMATIC_STRATEGIES`/`strategyTrialNumbers` loop-based tests, which now iterate `LLM_GROQ` automatically since they iterate `SUPPORTED_STRATEGIES`/`LLM_STRATEGIES`)

- [ ] **Step 5: Document the new env vars**

In `.env.sample`, after `LLM_GOOGLE_CONCURRENCY=1` add `LLM_GROQ_CONCURRENCY=1`. After the `LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` block add:

```

# Fallback wait (seconds) before retrying after a Groq per-minute
# rate-limit hit — only used when Groq's own rate-limit headers don't yield
# a wait. A per-minute hit is never treated as a run failure; it waits and
# retries indefinitely. (default: 60)
LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS=60

# Fallback hold duration (seconds) when a Groq daily-quota hit carries no
# parseable reset header at all. Unlike Google's fixed Pacific-midnight
# reset, Groq's reset comes from a per-hit duration header, so this is only
# a last-resort default. (default: 86400, i.e. 24h)
LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS=86400
```

In `README.md`'s env var table, after the `LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` row add:

```
| `LLM_GROQ_CONCURRENCY` | `1` | Maximum `llm-groq` runs the worker processes at once (own queue, so it never blocks the other three providers or the deterministic strategies) |
| `LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS` | `60` | Fallback wait before retrying a Groq per-minute rate-limit hit, used only when Groq's own headers don't yield one. Never a run failure — waits and retries indefinitely |
| `LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS` | `86400` | Fallback daily-hold duration when a Groq daily-quota hit carries no parseable reset header at all |
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts .env.sample README.md
git commit -m "$(cat <<'EOF'
feat(backend): register the llm-groq strategy and its config knobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Backend — `GroqRateLimitHold` entity and service

**Files:**
- Create: `backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts`
- Create: `backend/src/modules/strategy/groq-rate-limit-hold.service.ts`
- Create: `backend/src/migrations/1782000000000-add-groq-rate-limit-hold.ts`
- Test: `backend/src/modules/strategy/groq-rate-limit-hold.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks besides `GroqRateLimitHold` (defined in this task).
- Produces: `GroqRateLimitHoldService.hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void>`, `.isHeld(strategyName, modelName): Promise<boolean>`, `.heldModels(strategyName): Promise<string[]>`, `.nextResetAt(strategyName): Promise<Date | null>`, `.clearExpired(): Promise<string[]>` — used by Task 6 (runner) and Task 9/10 (dispatch/resume).

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/strategy/groq-rate-limit-hold.service.spec.ts`:

```ts
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MoreThan, LessThanOrEqual } from "typeorm";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
import { GroqRateLimitHold } from "./entities/groq-rate-limit-hold.entity";

describe("GroqRateLimitHoldService", () => {
  let service: GroqRateLimitHoldService;
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
        GroqRateLimitHoldService,
        { provide: getRepositoryToken(GroqRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(GroqRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("upserts a hold row keyed on (strategyName, modelName) with resetAt = heldAt + resetInSeconds", async () => {
    const before = Date.now();
    await service.hold("llm-groq", "openai/gpt-oss-20b", 3600);
    const after = Date.now();

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" });
    const deltaMs = row.resetAt.getTime() - row.heldAt.getTime();
    expect(deltaMs).toBe(3600 * 1000);
    expect(row.heldAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.heldAt.getTime()).toBeLessThanOrEqual(after);
    expect(conflictPaths).toEqual(["strategyName", "modelName"]);
  });

  it("isHeld is true only while resetAt is in the future", async () => {
    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld("llm-groq", "m")).toBe(true);

    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld("llm-groq", "m")).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.isHeld("llm-groq", "m")).toBe(false);
  });

  it("heldModels queries for future resetAt and returns the model names", async () => {
    repo.find.mockResolvedValueOnce([{ modelName: "a" }, { modelName: "b" }]);

    const result = await service.heldModels("llm-groq");

    expect(result).toEqual(["a", "b"]);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-groq", resetAt: MoreThan(expect.any(Date)) },
    });
  });

  it("nextResetAt returns the soonest still-future resetAt, or null when nothing is held", async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);
    repo.find.mockResolvedValueOnce([{ resetAt: later }, { resetAt: soon }]);

    expect(await service.nextResetAt("llm-groq")).toEqual(soon);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-groq", resetAt: MoreThan(expect.any(Date)) },
    });

    repo.find.mockResolvedValueOnce([]);
    expect(await service.nextResetAt("llm-groq")).toBeNull();
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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest groq-rate-limit-hold.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts`:

```ts
import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for which Groq models are currently held for
 * exhausting their free-tier requests-per-day quota. One row per held
 * (strategyName, modelName); GroqRpdResumeService clears rows whose resetAt
 * has passed. Unlike GoogleRateLimitHold, resetAt is not a fixed daily
 * clock boundary — it's heldAt plus that hit's own reset-duration header
 * (see GroqRateLimitHoldService.hold), since Groq's rate-limit headers give
 * a countdown from the hit rather than a shared reset clock. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Entity("GroqRateLimitHold")
@Unique("UQ_GroqRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class GroqRateLimitHold {
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

Create `backend/src/modules/strategy/groq-rate-limit-hold.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { GroqRateLimitHold } from "./entities/groq-rate-limit-hold.entity";

/**
 * The Groq counterpart to GoogleRateLimitHoldService: source of truth for
 * which Groq models are currently held for exhausting their free-tier
 * requests-per-day quota. Simpler than the Google version — no timezone
 * math at all, since Groq's own rate-limit headers give a reset *duration*
 * from the moment of the hit (see orchestrator/src/solver.ts's
 * parseGroqResetDuration) rather than a fixed daily clock boundary the way
 * Google's Pacific-midnight reset is. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRateLimitHoldService {
  private readonly logger = new Logger(GroqRateLimitHoldService.name);

  constructor(
    @InjectRepository(GroqRateLimitHold)
    private readonly repo: Repository<GroqRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void> {
    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert({ strategyName, modelName, heldAt, resetAt }, ["strategyName", "modelName"]);
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

  /**
   * The soonest still-future resetAt across this strategy's live holds, or
   * null when nothing is held. GroqRpdResumeService uses this both to
   * decide how long to wait before re-arming itself for runs it could not
   * revive yet, and — unlike Google, where this is only a fallback path —
   * as the sole ongoing scheduling signal, since there is no fixed daily
   * cron for Groq's resume sweep.
   */
  async nextResetAt(strategyName: string): Promise<Date | null> {
    const rows = await this.repo.find({
      where: { strategyName, resetAt: MoreThan(new Date()) },
    });
    if (rows.length === 0) return null;
    return rows.reduce((soonest, row) =>
      row.resetAt.getTime() < soonest.resetAt.getTime() ? row : soonest,
    ).resetAt;
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

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx jest groq-rate-limit-hold.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Create the migration**

Create `backend/src/migrations/1782000000000-add-groq-rate-limit-hold.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the GroqRateLimitHold table (one row per Groq model held for hitting
 * its free-tier requests-per-day quota) — the Groq counterpart to
 * GoogleRateLimitHold. No enum value migration needed here:
 * 'rateLimitedDaily' already exists on strategy_run_status_enum from
 * 1777000000000-add-google-rate-limit-hold.ts and is reused as-is. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class AddGroqRateLimitHold1782000000000 implements MigrationInterface {
  name = "AddGroqRateLimitHold1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GroqRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_GroqRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_GroqRateLimitHold_resetAt"
       ON "GroqRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GroqRateLimitHold"`);
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts backend/src/modules/strategy/groq-rate-limit-hold.service.ts backend/src/modules/strategy/groq-rate-limit-hold.service.spec.ts backend/src/migrations/1782000000000-add-groq-rate-limit-hold.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GroqRateLimitHold entity and service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Backend — wire Groq into `LlmStrategyRunner`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `LLM_GROQ` and `llmGroqRateLimitFallbackSeconds`/`llmGroqDailyHoldFallbackSeconds` (Task 4), `GroqRateLimitHoldService` (Task 5), `SolveAssistFailure.dailyResetSeconds` (Task 3).
- Produces: no new exports — this task changes `runLlmStrategy`'s internal behavior only, verified via the same public method it already exposes.

- [ ] **Step 1: Write the failing tests**

First, find this spec file's test-module setup for `GoogleRateLimitHoldService` (the mock named `mockRpdHold` per the grep earlier in this plan's research) and add a sibling mock `mockGroqRpdHold` with the same shape (`{ isHeld: jest.Mock; hold: jest.Mock; heldModels: jest.Mock }` or whatever the existing mock's exact shape is — read the file's `beforeEach` to copy it precisely), provided via `{ provide: GroqRateLimitHoldService, useValue: mockGroqRpdHold }` in the `Test.createTestingModule` call alongside the existing `GoogleRateLimitHoldService` provider.

Add these tests, mirroring the existing `rate_limited_daily`/google block (found via this plan's earlier research at lines ~1194-1273 of the file) but for `llm-groq`:

```ts
    it("parks a held groq run at RATE_LIMITED_DAILY without calling the orchestrator", async () => {
      mockGroqRpdHold.isHeld.mockResolvedValue(true);
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);

      const result = await runner.runLlmStrategy(100, "llm-groq", 0, "openai/gpt-oss-20b");

      expect(mockOrchestratorService.solveAssist).not.toHaveBeenCalled();
      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockGroqRpdHold.hold).not.toHaveBeenCalled();
    });

    it("records a Groq hold using dailyResetSeconds and parks the run, touching no failure counter", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "Groq daily quota exhausted", code: "rate_limited_daily", dailyResetSeconds: 3600 },
      });

      const result = await runner.runLlmStrategy(100, "llm-groq", 0, "openai/gpt-oss-20b");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockGroqRpdHold.hold).toHaveBeenCalledWith("llm-groq", "openai/gpt-oss-20b", 3600);
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(1);
    });

    it("falls back to the configured constant when a Groq daily hit carries no dailyResetSeconds", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      await runner.runLlmStrategy(100, "llm-groq", 0, "openai/gpt-oss-20b");

      expect(mockGroqRpdHold.hold).toHaveBeenCalledWith(
        "llm-groq",
        "openai/gpt-oss-20b",
        DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
      );
    });

    it("never ends a Groq run in ERROR on a rate_limited_daily hit", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: { error: "quota", code: "rate_limited_daily" },
      });

      const result = await runner.runLlmStrategy(100, "llm-groq", 0, "openai/gpt-oss-20b");

      expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(1);
    });

    it("waits the Groq-specific fallback (not Google's) on a per-minute rate_limited hit with no retryAfterSeconds", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValue(
        makeRun({ strategyName: "llm-groq", modelName: "openai/gpt-oss-20b" }),
      );
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
      mockGuessRepo.find.mockResolvedValue([]);
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce({ ok: false, error: { error: "rate limited", code: "rate_limited" } })
        .mockResolvedValue(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]));
      jest.spyOn(global, "setTimeout");

      await runner.runLlmStrategy(100, "llm-groq", 0, "openai/gpt-oss-20b");

      expect(setTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS * 1000,
      );
    });
```

(Import `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS` and `DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS` from `"../../strategies"` at the top of the spec file. For the last test, check the file first for how it already stubs/observes the runner's `delay` — if it mocks a private `delay` method or spies on `setTimeout` differently for the existing Google fallback test, mirror that exact mechanism instead of inventing a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts -t "groq"`
Expected: FAIL — `GroqRateLimitHoldService` isn't injected/used yet, `llm-groq` isn't routed to any provider branch.

- [ ] **Step 3: Implement in `llm-strategy-runner.service.ts`**

Update imports:

```ts
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmGoogleRateLimitFallbackSeconds,
  llmGroqRateLimitFallbackSeconds,
  llmGroqDailyHoldFallbackSeconds,
  llmTemperature,
} from "../../strategies";
```

```ts
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
```

Add the constructor param, alongside `rpdHold`:

```ts
    @Inject(GoogleRateLimitHoldService) private readonly rpdHold: GoogleRateLimitHoldService,
    @Inject(GroqRateLimitHoldService) private readonly groqRpdHold: GroqRateLimitHoldService,
```

Update the provider resolution:

```ts
    const provider =
      strategyName === LLM_OLLAMA
        ? "ollama"
        : strategyName === LLM_GOOGLE
          ? "google"
          : strategyName === LLM_GROQ
            ? "groq"
            : "openai";
```

Update the top gate — replace:

```ts
    if (
      strategyName === LLM_GOOGLE &&
      model &&
      (await this.rpdHold.isHeld(strategyName, model))
    ) {
```

with:

```ts
    const rpdHoldService =
      strategyName === LLM_GOOGLE ? this.rpdHold : strategyName === LLM_GROQ ? this.groqRpdHold : null;

    if (rpdHoldService && model && (await rpdHoldService.isHeld(strategyName, model))) {
```

(the block's body — setting `RATE_LIMITED_DAILY`, saving, returning — is unchanged).

Before the run loop starts (where `provider` is already resolved — the same place is fine), compute the per-provider rate-limit fallback once:

```ts
    const rateLimitFallbackSeconds =
      strategyName === LLM_GROQ ? llmGroqRateLimitFallbackSeconds() : llmGoogleRateLimitFallbackSeconds();
```

Update the `classifyFailedCall` call site to pass it:

```ts
        this.classifyFailedCall(
          outcome.error.code,
          run,
          state,
          maxModelErrors,
          maxDuplicates,
          maxMalformed,
          rateLimitFallbackSeconds,
          outcome.error.retryAfterSeconds,
        );

        if (outcome.error.code === "rate_limited_daily" && model) {
          if (strategyName === LLM_GOOGLE) {
            await this.rpdHold.hold(strategyName, model);
          } else if (strategyName === LLM_GROQ) {
            await this.groqRpdHold.hold(
              strategyName,
              model,
              outcome.error.dailyResetSeconds ?? llmGroqDailyHoldFallbackSeconds(),
            );
          }
        }
```

Update `classifyFailedCall`'s signature and its `rate_limited` branch:

```ts
  private classifyFailedCall(
    code: SolveErrorCode,
    run: StrategyRun,
    state: LlmRunLoopState,
    maxModelErrors: number,
    maxDuplicates: number,
    maxMalformed: number,
    rateLimitFallbackSeconds: number,
    retryAfterSeconds?: number,
  ): void {
    if (code === "rate_limited_daily") {
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
    } else if (code === "rate_limited") {
      state.rateLimitWaitMs = (retryAfterSeconds ?? rateLimitFallbackSeconds) * 1000;
    } else if (code === "model_error") {
```

(the rest of the method — `duplicate_group`, the final `else` for malformed — is unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS (the full file — this confirms the existing Google-path tests still pass unchanged with the new `rateLimitFallbackSeconds` parameter threaded through)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-groq runs through the RPD-hold top gate and park-on-daily-hit logic

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Backend — Groq's own BullMQ queue and `queueForStrategy`

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/strategy.queue.spec.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`

**Interfaces:**
- Produces: `llmGroqQueue: Queue` (name `"llm-groq-runs"`). `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, groqQueue, strategyName): Queue`. `LLM_GROQ_QUEUE` DI token, exported from `QueueModule`.

- [ ] **Step 1: Write the failing test**

Update `backend/src/modules/queue/strategy.queue.spec.ts`:

```ts
import { LLM_GOOGLE, LLM_GROQ, LLM_OLLAMA, LLM_OPENAI } from "../../strategies";
import {
  categoryEvalJobId,
  queueForJudgeProvider,
  queueForStrategy,
} from "./strategy.queue";

const openai = { name: "openai" } as never;
const ollama = { name: "ollama" } as never;
const google = { name: "google" } as never;
const groq = { name: "groq" } as never;
const shared = { name: "shared" } as never;

describe("queueForStrategy", () => {
  it("routes each LLM strategy to its own queue and everything else to the shared queue", () => {
    expect(queueForStrategy(shared, openai, ollama, google, groq, LLM_OPENAI)).toBe(openai);
    expect(queueForStrategy(shared, openai, ollama, google, groq, LLM_OLLAMA)).toBe(ollama);
    expect(queueForStrategy(shared, openai, ollama, google, groq, LLM_GOOGLE)).toBe(google);
    expect(queueForStrategy(shared, openai, ollama, google, groq, LLM_GROQ)).toBe(groq);
    expect(queueForStrategy(shared, openai, ollama, google, groq, "alphabetical")).toBe(shared);
  });
});
```

(Leave `queueForJudgeProvider`/`categoryEvalJobId` describe blocks unchanged — Groq is not a judge provider.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: FAIL — TypeScript arity mismatch (`queueForStrategy` only takes 5 args today, this calls it with 6).

- [ ] **Step 3: Implement**

In `backend/src/modules/queue/strategy.queue.ts`:

```ts
import { LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE, LLM_GROQ } from "../../strategies";
```

```ts
export const llmGroqQueue = new Queue("llm-groq-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

Update `queueForStrategy`:

```ts
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  groqQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  if (strategyName === LLM_GROQ) return groqQueue;
  return defaultQueue;
}
```

(`queueForJudgeProvider` is unchanged — Groq isn't a judge provider.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest strategy.queue.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire the new queue token into `queue.module.ts`**

In `backend/src/modules/queue/queue.module.ts`:

```ts
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue, llmGoogleQueue, llmGroqQueue } from "./strategy.queue";
```

```ts
export const LLM_GROQ_QUEUE = "LLM_GROQ_QUEUE";
```

Add `{ provide: LLM_GROQ_QUEUE, useValue: llmGroqQueue }` to `providers` and `LLM_GROQ_QUEUE` to `exports`.

There's no dedicated spec for `queue.module.ts` today (verified by the modules that consume its exports) — this will be exercised by Task 8's `strategy.service.spec.ts` update.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/strategy.queue.spec.ts backend/src/modules/queue/queue.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the llm-groq-runs queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Backend — wire Groq's queue into `StrategyService` and `StrategyModule`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`

**Interfaces:**
- Consumes: `LLM_GROQ_QUEUE` (Task 7), `GroqRateLimitHold`/`GroqRateLimitHoldService` (Task 5).
- Produces: `StrategyService.triggerStrategyRuns`/`triggerRun`/`countInFlightByModel`/`countTodayDispatchByModel`/`findUnrunPuzzleDatesForModel` (all pre-existing, generic over `strategyName`) now correctly route `llm-groq` to its own queue — used by Task 9 (`GroqFreeDispatchService`).

- [ ] **Step 1: Write the failing test**

Find `strategy.service.spec.ts`'s `TestingModule` setup (it will have a `{ provide: LLM_GOOGLE_QUEUE, useValue: mockLlmGoogleQueue }`-shaped entry) and add a sibling `mockLlmGroqQueue` (same mock shape) provided via `LLM_GROQ_QUEUE`. Add a test to whatever `describe("triggerRun"` or similar block already exercises `queueFor`'s Google routing:

```ts
  it("routes llm-groq runs to the llm-groq-runs queue", async () => {
    mockSupportedModelService.assertSupported.mockResolvedValue(undefined);

    await service.triggerRun(1, "llm-groq", "2024-01-01", 0, "openai/gpt-oss-20b");

    expect(mockLlmGroqQueue.add).toHaveBeenCalledWith(
      "run-strategy",
      expect.objectContaining({ strategyName: "llm-groq", model: "openai/gpt-oss-20b" }),
      expect.anything(),
    );
    expect(mockQueue.add).not.toHaveBeenCalled();
  });
```

(Read the existing Google-routing test in this file first and match its exact mock names/assertion style — `mockSupportedModelService`/`mockQueue`/`mockLlmGoogleQueue` above are placeholders for whatever this spec file actually calls them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest strategy.service.spec.ts -t "llm-groq"`
Expected: FAIL — `LLM_GROQ_QUEUE` isn't a recognized provider token in the test module yet, and `queueFor` doesn't route `llm-groq` anywhere but the shared queue.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/strategy.service.ts`, add the import and constructor param:

```ts
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE, LLM_GROQ_QUEUE } from "../queue/queue.module";
```

```ts
    @Inject(LLM_GROQ_QUEUE) private readonly llmGroqQueue: Queue,
```

(placed right after the existing `@Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,` line)

Update `queueFor`:

```ts
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      this.llmGroqQueue,
      strategyName,
    );
  }
```

Update `queuedCountsByKey`:

```ts
    const queues = [this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, this.llmGoogleQueue, this.llmGroqQueue];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest strategy.service.spec.ts`
Expected: PASS (full file — confirms every pre-existing test still passes with the new constructor param)

- [ ] **Step 5: Register `GroqRateLimitHold`/`GroqRateLimitHoldService` in `StrategyModule`**

In `backend/src/modules/strategy/strategy.module.ts`:

```ts
import { GroqRateLimitHold } from "./entities/groq-rate-limit-hold.entity";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
```

Add `GroqRateLimitHold` to the `TypeOrmModule.forFeature([...])` array (alongside `GoogleRateLimitHold`), add `GroqRateLimitHoldService` to `providers`, and add it to `exports` too (Task 9's `GroqFreeDispatchModule` and Task 10's `GroqRpdResumeService` both need it — same reason `GoogleRateLimitHoldService` is already exported).

There's no dedicated `strategy.module.spec.ts` — this is exercised transitively by any e2e/integration test that boots the module, and directly by Task 6/9/10's specs already covering the service's usage.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): route llm-groq dispatch through its own queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Backend — `GroqFreeDispatchService`

**Files:**
- Create: `backend/src/modules/groq-free-dispatch/entities/groq-dispatch-state.entity.ts`
- Create: `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts`
- Create: `backend/src/modules/groq-free-dispatch/groq-free-dispatch.module.ts`
- Create: `backend/src/modules/queue/groq-free-dispatch.queue.ts`
- Create: `backend/src/migrations/1783000000000-add-groq-dispatch-state.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Test: `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `StrategyService.findUnrunPuzzleDatesForModel`/`triggerStrategyRuns`/`countInFlightByModel`/`countTodayDispatchByModel` (pre-existing), `SupportedModelService.findModelNamesByStrategy` (pre-existing), `GroqRateLimitHoldService.heldModels` (Task 5).
- Produces: `GroqFreeDispatchService.start(): Promise<{ status, outcome: "started" | "alreadyExhausted" }>`, `.stop(): Promise<GroqDispatchStatusDto>`, `.getStatus(): Promise<GroqDispatchStatusDto>`, `.runTick(): Promise<void>` — used by Task 11 (worker) and Task 14 (daily automation).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.spec.ts` — a direct copy of `backend/src/modules/google-free-dispatch/google-free-dispatch.service.spec.ts` with these substitutions throughout: `GoogleFreeDispatchService` → `GroqFreeDispatchService`, `GoogleDispatchState` → `GroqDispatchState`, `GOOGLE_FREE_DISPATCH_QUEUE` → `GROQ_FREE_DISPATCH_QUEUE`, `GoogleRateLimitHoldService` → `GroqRateLimitHoldService` (imported from `"../strategy/groq-rate-limit-hold.service"`), `"google"` id literal → `"groq"`, `GOOGLE_MODELS` → `GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]`, `"gemini-2.5-flash"`/`"gemini-2.5-pro"` → `"openai/gpt-oss-120b"`/`"openai/gpt-oss-20b"`, `"llm-google"` → `"llm-groq"`, `"google-free-dispatch-"` job-id substring → `"groq-free-dispatch-"`. Every test case's shape (start/stop/getStatus/runTick describe blocks and their assertions) stays identical — only the names change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest groq-free-dispatch.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the entity**

Create `backend/src/modules/groq-free-dispatch/entities/groq-dispatch-state.entity.ts`:

```ts
import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "groq") tracking whether the Groq
 * free-daily-quota dispatch cycle (GroqFreeDispatchService) is currently
 * running — the Groq counterpart to GoogleDispatchState.
 */
@Entity("GroqDispatchState")
export class GroqDispatchState {
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

- [ ] **Step 4: Create the queue**

Create `backend/src/modules/queue/groq-free-dispatch.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Manages the Groq free-daily-quota dispatch cycle (see
// GroqFreeDispatchService) — the Groq counterpart to
// google-free-dispatch.queue.ts. Each job is one "tick": it checks which
// Groq models are currently RPD-held, queues the next batch of trials
// against whichever models are free, and (unless the cycle is done)
// schedules its own successor tick.
export const groqFreeDispatchQueue = new Queue("groq-free-dispatch", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});
```

Wire it into `backend/src/modules/queue/queue.module.ts`: import `groqFreeDispatchQueue`, add `export const GROQ_FREE_DISPATCH_QUEUE = "GROQ_FREE_DISPATCH_QUEUE";`, and add its provider/export entries.

- [ ] **Step 5: Create the service**

Create `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts`:

```ts
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GROQ_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { GroqDispatchState } from "./entities/groq-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { GroqRateLimitHoldService } from "../strategy/groq-rate-limit-hold.service";
import { LLM_GROQ, freeTierDispatchMaxBatch, freeTierDispatchMaxInFlight, freeTierDispatchTickMs } from "../../strategies";

const TICK_JOB_NAME = "tick";
const GROQ_DISPATCH_STATE_ID = "groq";

export interface GroqDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
}

/**
 * The Groq counterpart to GoogleFreeDispatchService: a self-rescheduling
 * tick chain that dispatches llm-groq trials against unrun puzzles until
 * every configured Groq model is RPD-held (see GroqRateLimitHoldService) or
 * out of unrun puzzles. Like Google, there is no per-token free budget to
 * burn toward a threshold — Groq enforces a per-day request cap of its own,
 * so "keep dispatching until held" is the whole stop condition. Reuses the
 * OpenAI tiers' FREE_TIER_DISPATCH_* pacing knobs rather than introducing a
 * parallel env family, same as Google. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqFreeDispatchService {
  private readonly logger = new Logger(GroqFreeDispatchService.name);

  constructor(
    @InjectRepository(GroqDispatchState)
    private readonly stateRepo: Repository<GroqDispatchState>,
    @Inject(GROQ_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(GroqRateLimitHoldService) private readonly holdService: GroqRateLimitHoldService,
  ) {}

  /**
   * Starts the cycle. Rejects if it's already running. If every configured
   * Groq model is already RPD-held, this is a clean no-op (no tick is
   * queued) rather than spinning up a cycle that would immediately find
   * nothing to do — the caller learns this via the returned `outcome`
   * rather than a thrown error, since it isn't a failure.
   */
  async start(): Promise<{ status: GroqDispatchStatusDto; outcome: "started" | "alreadyExhausted" }> {
    const existing = await this.stateRepo.findOne({ where: { id: GROQ_DISPATCH_STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "Groq free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GROQ);
    const held = new Set(await this.holdService.heldModels(LLM_GROQ));
    const allExhausted = models.length === 0 || models.every((model) => held.has(model));

    if (allExhausted) {
      await this.stateRepo.save({ id: GROQ_DISPATCH_STATE_ID, active: false, startedAt: null });
      this.logger.log("groq free-tier dispatch: every model is already RPD-held — not starting a cycle");
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: GROQ_DISPATCH_STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });

    this.logger.log("groq free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<GroqDispatchStatusDto> {
    await this.stateRepo.update({ id: GROQ_DISPATCH_STATE_ID }, { active: false });
    this.logger.log("groq free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<GroqDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: GROQ_DISPATCH_STATE_ID } });
    return { active: state?.active ?? false, startedAt: state?.startedAt ?? null };
  }

  /**
   * One tick: stops if the cycle was deactivated, no Groq models are
   * configured, or every configured model is currently RPD-held. Otherwise
   * paces itself against the in-flight cap (same knob the OpenAI tiers use)
   * and dispatches a budget-safe batch spread across whichever eligible
   * (non-held) models are currently behind.
   */
  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: GROQ_DISPATCH_STATE_ID } });
    if (!state?.active) {
      this.logger.log("groq free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GROQ);
    if (models.length === 0) {
      await this.stateRepo.update({ id: GROQ_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("groq free-tier dispatch: no Groq models configured — stopping");
      return;
    }

    const held = new Set(await this.holdService.heldModels(LLM_GROQ));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.stateRepo.update({ id: GROQ_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("groq free-tier dispatch: every model is RPD-held — stopping");
      return;
    }

    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_GROQ, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `groq free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick();
      return;
    }

    const maxNewTrials = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);
    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_GROQ, eligibleModels);
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < eligibleModels.length) {
      const model = GroqFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_GROQ, model, 1);
      } catch (err) {
        this.logger.warn(
          `groq free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyService.triggerStrategyRuns(target.puzzleId, LLM_GROQ, target.date, model);
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `groq free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`groq free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === eligibleModels.length) {
      await this.stateRepo.update({ id: GROQ_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("groq free-tier dispatch: ran out of unrun puzzles for every eligible model — stopping");
      return;
    }

    await this.scheduleNextTick();
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(TICK_JOB_NAME, {}, { delay: freeTierDispatchTickMs(), jobId: this.freshTickJobId() });
  }

  private freshTickJobId(): string {
    return `groq-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

- [ ] **Step 6: Create the module**

Create `backend/src/modules/groq-free-dispatch/groq-free-dispatch.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { GroqDispatchState } from "./entities/groq-dispatch-state.entity";
import { GroqFreeDispatchService } from "./groq-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([GroqDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [GroqFreeDispatchService],
  exports: [GroqFreeDispatchService],
})
export class GroqFreeDispatchModule {}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && npx jest groq-free-dispatch.service.spec.ts`
Expected: PASS

- [ ] **Step 8: Create the migration**

Create `backend/src/migrations/1783000000000-add-groq-dispatch-state.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the Groq free-daily-quota dispatch
 * cycle (GroqFreeDispatchService) is currently running — the Groq
 * counterpart to GoogleDispatchState.
 */
export class AddGroqDispatchState1783000000000 implements MigrationInterface {
  name = "AddGroqDispatchState1783000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GroqDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GroqDispatchState"`);
  }
}
```

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/groq-free-dispatch backend/src/modules/queue/groq-free-dispatch.queue.ts backend/src/modules/queue/queue.module.ts backend/src/migrations/1783000000000-add-groq-dispatch-state.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GroqFreeDispatchService

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Backend — `GroqRpdResumeService` and bootstrap

**Files:**
- Create: `backend/src/modules/strategy/groq-rpd-resume.service.ts`
- Create: `backend/src/modules/strategy/groq-rpd-resume.bootstrap.ts`
- Create: `backend/src/modules/queue/groq-rpd-resume.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`
- Test: `backend/src/modules/strategy/groq-rpd-resume.service.spec.ts`
- Test: `backend/src/modules/strategy/groq-rpd-resume.bootstrap.spec.ts`

**Interfaces:**
- Consumes: `GroqRateLimitHoldService` (Task 5), `LLM_GROQ_QUEUE` (Task 7).
- Produces: `GroqRpdResumeService.runResume(): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }>` — used by Task 11 (worker).

- [ ] **Step 1: Write the failing test for the service**

Create `backend/src/modules/strategy/groq-rpd-resume.service.spec.ts` — adapted from `google-rpd-resume.service.spec.ts` with these changes: no `FROZEN_NOW`/`PACIFIC_STAMP`/fake-timers setup (Groq's resume job ids use a per-call stamp, not a Pacific date stamp — see Step 3), `GoogleRpdResumeService` → `GroqRpdResumeService`, `GoogleRateLimitHoldService` → `GroqRateLimitHoldService`, `GOOGLE_RPD_RESUME_QUEUE`/`LLM_GOOGLE_QUEUE` → `GROQ_RPD_RESUME_QUEUE`/`LLM_GROQ_QUEUE`, `"llm-google"` → `"llm-groq"`, `"gemini-3.6-flash"`/`"gemini-3.6-flash-lite"` → `"openai/gpt-oss-20b"`/`"openai/gpt-oss-120b"`, `"resume-google-rpd"` → `"resume-groq-rpd"`. The job-id assertion changes shape since there's no Pacific stamp:

```ts
  it("revives parked runs whose model is no longer held and re-enqueues them", async () => {
    holdService.clearExpired.mockResolvedValue(["openai/gpt-oss-20b"]);
    holdService.heldModels.mockResolvedValue(["openai/gpt-oss-120b"]);
    holdService.nextResetAt.mockResolvedValue(new Date(Date.now() + 5 * 60_000));
    strategyRunRepo.find.mockResolvedValue([
      parkedRun({ id: 1, puzzleId: 10, trialNumber: 0, modelName: "openai/gpt-oss-20b", puzzle: { date: "2026-01-01" } }),
      parkedRun({ id: 2, puzzleId: 11, trialNumber: 1, modelName: "openai/gpt-oss-120b", puzzle: { date: "2026-01-02" } }),
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
        strategyName: "llm-groq",
        date: "2026-01-01",
        trialNumber: 0,
        model: "openai/gpt-oss-20b",
      },
      { jobId: expect.stringMatching(new RegExp(`^${runStrategyJobId(10, "llm-groq", 0)}-resume-`)) },
    );
    expect(result).toMatchObject({ cleared: ["openai/gpt-oss-20b"], redispatched: 1 });
  });
```

Keep the remaining tests from the Google file — "re-enqueues under an id distinct from the run's original deterministic job id", "uses the same id for every run within one sweep", "leaves a run parked ... when the enqueue fails", "skips a parked run with no modelName", "re-arms a delayed sweep ... capped at 15 minutes", "caps the re-arm delay when the soonest reset is far away", "does not re-arm when every parked run was revived", "does nothing when there are no parked runs" — same shape, same substitutions, minus any Pacific-stamp-specific assertion (the "uses the same id for every run within one sweep" test's assertion — `expect(second).toBe(first)` — needs no change at all, since it's comparing two calls' ids to each other regardless of what the stamp actually is).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest groq-rpd-resume.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `backend/src/modules/strategy/groq-rpd-resume.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GROQ_RPD_RESUME_QUEUE, LLM_GROQ_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_GROQ } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";

/** Longest a re-armed sweep ever waits before looking again. */
const REARM_MAX_DELAY_MS = 15 * 60_000;

/**
 * The Groq counterpart to GoogleRpdResumeService. Clears every
 * GroqRateLimitHold row whose resetAt has passed, then flips each
 * llm-groq run parked at RATE_LIMITED_DAILY (whose model is no longer
 * held) back to RUNNING and re-dispatches it. Unlike Google, there is no
 * fixed daily cron driving this — GroqRpdResumeBootstrap only enqueues one
 * startup catch-up run; rearm() below (self-scheduling at the soonest live
 * hold's resetAt) is the sole ongoing scheduling mechanism, since Groq
 * holds don't share one daily reset clock the way Google's Pacific-midnight
 * holds do. See docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRpdResumeService {
  private readonly logger = new Logger(GroqRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(GroqRateLimitHoldService) private readonly holdService: GroqRateLimitHoldService,
    @Inject(LLM_GROQ_QUEUE) private readonly llmGroqQueue: Queue,
    @Inject(GROQ_RPD_RESUME_QUEUE) private readonly resumeQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }> {
    const cleared = await this.holdService.clearExpired();
    const stillHeld = new Set(await this.holdService.heldModels(LLM_GROQ));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_GROQ },
      relations: { puzzle: true },
    });

    // One stamp for the whole sweep — see runStrategyJobId's callers below:
    // the same reasoning as Google's pacificDateStamp (a fresh id relative
    // to the run's original completed job, but stable across a retried
    // sweep so duplicate enqueues collapse) without the calendar-day
    // semantics, since Groq's resume sweeps aren't tied to a shared daily
    // clock the way Google's are.
    const stamp = Date.now().toString(36);

    let redispatched = 0;
    let skipped = 0;
    for (const run of parked) {
      if (!run.modelName) {
        this.logger.warn(`Skipping parked run ${run.id}: no modelName to check the hold against`);
        skipped++;
        continue;
      }
      if (stillHeld.has(run.modelName)) {
        skipped++;
        continue;
      }

      await this.llmGroqQueue.add(
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
    }

    const rearmedInMs = skipped > 0 ? await this.rearm() : undefined;

    this.logger.log(
      `groq-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined ? "" : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  private async rearm(): Promise<number> {
    const soonest = await this.holdService.nextResetAt(LLM_GROQ);
    const untilReset = soonest ? soonest.getTime() - Date.now() : REARM_MAX_DELAY_MS;
    const delay = Math.min(Math.max(untilReset, 0), REARM_MAX_DELAY_MS);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await this.resumeQueue.add(
      "resume-groq-rpd",
      {},
      {
        jobId: `groq-rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest groq-rpd-resume.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Create the queue**

Create `backend/src/modules/queue/groq-rpd-resume.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

// Drives the Groq requests-per-day hold resume (see GroqRpdResumeService /
// GroqRpdResumeBootstrap). Unlike google-rpd-resume.queue.ts, no fixed
// daily schedule is registered against this queue — GroqRpdResumeBootstrap
// only enqueues one startup catch-up job; every job after that is a
// self-scheduled "rearm" from GroqRpdResumeService.runResume() targeting
// the soonest live hold's own resetAt.
export const groqRpdResumeQueue = new Queue("groq-rpd-resume", {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 5,
    backoff: { type: "exponential", delay: 30000 },
  },
});
```

Wire it into `queue.module.ts`: import `groqRpdResumeQueue`, add `export const GROQ_RPD_RESUME_QUEUE = "GROQ_RPD_RESUME_QUEUE";`, and its provider/export entries.

- [ ] **Step 6: Write the failing test for the bootstrap**

Create `backend/src/modules/strategy/groq-rpd-resume.bootstrap.spec.ts`:

```ts
import { Queue } from "bullmq";
import { GroqRpdResumeBootstrap } from "./groq-rpd-resume.bootstrap";

describe("GroqRpdResumeBootstrap", () => {
  const realNodeEnv = process.env.NODE_ENV;
  let queue: { add: jest.Mock };

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
  });

  it("enqueues one date-stamped startup catch-up sweep and nothing else", async () => {
    process.env.NODE_ENV = "development";
    const bootstrap = new GroqRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe("resume-groq-rpd");
    expect(data).toEqual({});
    expect((opts as { jobId: string }).jobId).toBe(
      `groq-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
    );
  });

  it("skips scheduling under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const bootstrap = new GroqRpdResumeBootstrap(queue as unknown as Queue);

    await bootstrap.onApplicationBootstrap();

    expect(queue.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd backend && npx jest groq-rpd-resume.bootstrap.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the bootstrap**

Create `backend/src/modules/strategy/groq-rpd-resume.bootstrap.ts`:

```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Queue } from "bullmq";
import { GROQ_RPD_RESUME_QUEUE } from "../queue/queue.module";

/**
 * Unlike GoogleRpdResumeBootstrap, this registers no fixed cron —
 * GroqRateLimitHold rows don't share one daily reset clock, so there's no
 * meaningful fixed time to align a sweep to. This only enqueues one
 * startup catch-up sweep (to revive anything that expired while the
 * process was down); GroqRpdResumeService.runResume()'s own rearm() call
 * keeps the chain alive afterward, self-scheduling at whichever live
 * hold's resetAt comes soonest. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRpdResumeBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(GroqRpdResumeBootstrap.name);

  constructor(@Inject(GROQ_RPD_RESUME_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping groq-rpd-resume scheduling (NODE_ENV=test)");
      return;
    }

    await this.queue.add(
      "resume-groq-rpd",
      {},
      {
        jobId: `groq-rpd-resume-startup-catch-up-${new Date().toISOString().slice(0, 10)}`,
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 5,
        backoff: { type: "exponential", delay: 30000 },
      },
    );

    this.logger.log("groq-rpd-resume: enqueued startup catch-up sweep (no fixed schedule — see rearm())");
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend && npx jest groq-rpd-resume.bootstrap.spec.ts`
Expected: PASS

- [ ] **Step 10: Wire both into `StrategyModule`**

In `backend/src/modules/strategy/strategy.module.ts`, import `GroqRpdResumeService` and `GroqRpdResumeBootstrap`, add both to `providers`, and add `GroqRpdResumeService` to `exports` (Task 11's worker needs it via `appContext.get`).

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/strategy/groq-rpd-resume.service.ts backend/src/modules/strategy/groq-rpd-resume.service.spec.ts backend/src/modules/strategy/groq-rpd-resume.bootstrap.ts backend/src/modules/strategy/groq-rpd-resume.bootstrap.spec.ts backend/src/modules/queue/groq-rpd-resume.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GroqRpdResumeService with self-rescheduling resume (no fixed cron)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Backend — wire the three new workers into `worker.ts`

**Files:**
- Modify: `backend/src/worker.ts`

**Interfaces:**
- Consumes: `GroqFreeDispatchService` (Task 9), `GroqRpdResumeService` (Task 10), `llmGroqConcurrency` (Task 4).
- Produces: nothing new exported — `worker.ts` is the process entrypoint, verified by running it, not unit-tested (matches the existing file's own lack of a spec).

- [ ] **Step 1: Implement**

In `backend/src/worker.ts`, add imports:

```ts
import { GroqFreeDispatchService } from "./modules/groq-free-dispatch/groq-free-dispatch.service";
import { GroqRpdResumeService } from "./modules/strategy/groq-rpd-resume.service";
```

```ts
import {
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmGoogleConcurrency,
  llmGroqConcurrency,
  STRATEGY_SET,
  workerRole,
} from "./strategies";
```

In `bootstrap()`, alongside the other `appContext.get(...)` calls:

```ts
  const groqFreeDispatchService = appContext.get(GroqFreeDispatchService);
  const groqRpdResumeService = appContext.get(GroqRpdResumeService);
```

Update `createLlmWorker`'s `queueName` parameter type to include the new literal:

```ts
    queueName: "llm-openai-runs" | "llm-ollama-runs" | "llm-google-runs" | "llm-groq-runs",
```

In the `if (role !== "ollama")` block, right after the existing `llmGoogleWorker` push:

```ts
    const llmGroqWorker = createLlmWorker(
      "llm-groq-runs",
      LLM_GROQ,
      llmGroqConcurrency(),
    );
    activeWorkers.push(llmGroqWorker);
    activeQueueNames.push("llm-groq-runs");
```

Right after the existing `googleFreeDispatchWorker` block:

```ts
    // Each job is one tick of the Groq free-daily-quota dispatch cycle
    // (see GroqFreeDispatchService) — same self-chaining shape as the
    // Google/OpenAI dispatch workers above.
    const groqFreeDispatchWorker = new Worker(
      "groq-free-dispatch",
      async (job: Job) => {
        logger.log(`starting groq free-tier dispatch tick ${job.id}`);
        await groqFreeDispatchService.runTick();
        logger.log(`finished groq free-tier dispatch tick ${job.id}`);
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    groqFreeDispatchWorker.on("failed", (job, err) => {
      logger.error(`groq free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(groqFreeDispatchWorker);
    activeQueueNames.push("groq-free-dispatch");
```

Right after the existing `googleRpdResumeWorker` block:

```ts
    const groqRpdResumeWorker = new Worker(
      "groq-rpd-resume",
      async (job) => {
        logger.log(`starting groq-rpd resume sweep ${job.id}`);
        const result = await groqRpdResumeService.runResume();
        logger.log(`finished groq-rpd resume sweep ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      {
        connection: redisConnection,
        concurrency: 1,
      },
    );

    groqRpdResumeWorker.on("failed", (job, err) => {
      logger.error(`groq-rpd resume sweep ${job?.id} failed`, err?.stack || err);
    });

    activeWorkers.push(groqRpdResumeWorker);
    activeQueueNames.push("groq-rpd-resume");
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (no type errors — this file has no unit test, so a clean typecheck plus Task 12/13's e2e-adjacent coverage is the verification here)

- [ ] **Step 3: Commit**

```bash
git add backend/src/worker.ts
git commit -m "$(cat <<'EOF'
feat(backend): run the three new Groq queues in the worker process

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Backend — seed the four Groq models

**Files:**
- Create: `backend/src/migrations/1781000000000-add-groq-models.ts`

**Interfaces:**
- Consumes: nothing (raw SQL migration).
- Produces: four `SupportedModel` rows for `strategyName = 'llm-groq'`.

- [ ] **Step 1: Create the migration**

Create `backend/src/migrations/1781000000000-add-groq-models.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the four Groq free-tier chat models this pass supports —
 * openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.6-27b, and
 * qwen/qwen3.8-27b — for the llm-groq strategy. Deliberately excludes
 * Groq's audio (whisper-*), TTS (canopylabs/orpheus-*), classifier
 * (meta-llama/llama-prompt-guard-2-*, openai/gpt-oss-safeguard-20b), and
 * tool-calling agent (groq/compound*) models, none of which fit this
 * repo's structured-JSON solve prompts — and minimax-m2.7, which has no
 * confirmed free-tier rate-limit row. openRouterSlug is left NULL per this
 * repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts and
 * 1774000000000-add-google-models.ts) — each slug must be confirmed live
 * via GET https://openrouter.ai/api/v1/models/{slug}/endpoints before being
 * set by hand, since OpenRouter may not list a Groq-hosted model under a
 * "groq/" prefix. Trigger POST /dispatch/refresh-model-metadata once slugs
 * are set, so contextWindow/pricing aren't left blank until the next daily
 * cron tick. See docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class AddGroqModels1781000000000 implements MigrationInterface {
  name = "AddGroqModels1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-groq', 'openai/gpt-oss-120b', true, NULL),
        ('llm-groq', 'openai/gpt-oss-20b', true, NULL),
        ('llm-groq', 'qwen/qwen3.6-27b', true, NULL),
        ('llm-groq', 'qwen/qwen3.8-27b', true, NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN ('openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b')
    `);
  }
}
```

Per repo convention (noted on every prior seed migration in this plan), migrations are not unit-tested — the up/down/up round-trip against a real database is a manual verification pass once the branch has the dev DB to itself (see the plan's final verification task).

- [ ] **Step 2: Commit**

```bash
git add backend/src/migrations/1781000000000-add-groq-models.ts
git commit -m "$(cat <<'EOF'
feat(backend): seed the four Groq free-tier chat models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Backend — `/dispatch/groq` status/stop endpoints

**Files:**
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `backend/src/modules/dispatch/dispatch.module.ts`

**Interfaces:**
- Consumes: `GroqFreeDispatchService` (Task 9).
- Produces: `GET /dispatch/groq`, `DELETE /dispatch/groq`.

- [ ] **Step 1: Write the failing test**

Read `backend/src/modules/dispatch/dispatch.controller.spec.ts` (if one exists — check first) for its Google-route test shape and add mirrors for `/dispatch/groq`. If no spec file covers `dispatch.controller.ts` today (the Google routes may only be covered by the `GoogleFreeDispatchService` spec itself, per this plan's research showing no dedicated controller spec was found), skip straight to Step 3 and verify via Step 4's typecheck plus a manual `curl` smoke test noted there — do not invent a new spec file the codebase doesn't already have this pattern for.

- [ ] **Step 2: (conditional on Step 1 finding a spec file)**

If a spec file exists, add:

```ts
  it("GET /dispatch/groq returns the Groq dispatch status", async () => {
    mockGroqFreeDispatchService.getStatus.mockResolvedValue({ active: true, startedAt: new Date() });

    const result = await controller.getGroqDispatchStatus();

    expect(result.active).toBe(true);
  });

  it("DELETE /dispatch/groq stops the Groq dispatch cycle", async () => {
    mockGroqFreeDispatchService.stop.mockResolvedValue({ active: false, startedAt: null });

    const result = await controller.stopGroqDispatch();

    expect(mockGroqFreeDispatchService.stop).toHaveBeenCalled();
    expect(result.active).toBe(false);
  });
```

matching whatever mock-injection pattern the file's existing Google tests use for `mockGoogleFreeDispatchService`.

- [ ] **Step 3: Implement**

In `backend/src/modules/dispatch/dispatch.controller.ts`:

```ts
import { GroqFreeDispatchService } from "../groq-free-dispatch/groq-free-dispatch.service";
```

```ts
    @Inject(GroqFreeDispatchService) private readonly groqFreeDispatchService: GroqFreeDispatchService,
```

Right after the existing `stopGoogleDispatch` method:

```ts
  // Read-only Groq free-daily-quota dispatch status — see
  // GroqFreeDispatchService. Same shape as the Google route: no token
  // threshold, active/startedAt only.
  @Get("groq")
  async getGroqDispatchStatus() {
    return this.groqFreeDispatchService.getStatus();
  }

  // Deactivates the Groq free-daily-quota dispatch cycle so it stops
  // scheduling further ticks — a no-op (not an error) if it wasn't running.
  @Delete("groq")
  async stopGroqDispatch() {
    return this.groqFreeDispatchService.stop();
  }
```

In `backend/src/modules/dispatch/dispatch.module.ts`, import `GroqFreeDispatchModule` (`"../groq-free-dispatch/groq-free-dispatch.module"`) and add it to the `@Module({ imports: [...] })` array alongside the existing `GoogleFreeDispatchModule`.

- [ ] **Step 4: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

If a spec file was updated in Step 2, also run: `cd backend && npx jest dispatch.controller.spec.ts` and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/dispatch/dispatch.controller.ts backend/src/modules/dispatch/dispatch.module.ts
git commit -m "$(cat <<'EOF'
feat(backend): add GET/DELETE /dispatch/groq

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Backend — `groqBurn` leg in the daily-automation chain

**Files:**
- Modify: `backend/src/modules/automation/daily-automation.service.ts`
- Modify: `backend/src/modules/automation/daily-automation.service.spec.ts`
- Modify: `backend/src/modules/automation/entities/automation-run-log.entity.ts`
- Modify: `backend/src/modules/automation/automation.controller.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`
- Create: `backend/src/migrations/1784000000000-add-automation-groq-leg.ts`

**Interfaces:**
- Consumes: `GroqFreeDispatchService` (Task 9).
- Produces: `DailyAutomationService.run()` now also fires a `groqBurn` leg; `GET /automation/status` includes a `groqBurn` field.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/automation/daily-automation.service.spec.ts`, import `GroqFreeDispatchService` and add a mock alongside `mockGoogleFreeDispatchService`:

```ts
  let mockGroqFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };
```

```ts
    mockGroqFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest.fn().mockResolvedValue({ status: { active: true, startedAt: new Date() }, outcome: "started" }),
    };
```

Add it to the `TestingModule`'s `providers`: `{ provide: GroqFreeDispatchService, useValue: mockGroqFreeDispatchService }`.

Add these tests inside `describe("run", ...)`, mirroring the existing `googleBurn` tests exactly:

```ts
    it("starts the Groq burn when no cycle is already running", async () => {
      await service.run();

      expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "started", groqBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the Groq leg from start()'s own outcome", async () => {
      mockGroqFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "alreadyExhausted", groqBurnMessage: "every Groq model is currently RPD-held" },
      );
    });

    it("records alreadyActive for the Groq leg without calling start, when a cycle is already running", async () => {
      mockGroqFreeDispatchService.getStatus.mockResolvedValueOnce({ active: true, startedAt: new Date() });

      await service.run();

      expect(mockGroqFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "alreadyActive", groqBurnMessage: "already running" },
      );
    });

    it("records a Groq leg failure without throwing, and still lets the other legs run", async () => {
      mockGroqFreeDispatchService.start.mockRejectedValueOnce(new Error("groq down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "error", groqBurnMessage: "groq down" },
      );
    });
```

Also update the pre-existing "records a judge leg failure ... and still runs the other legs" test to add `expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();` alongside its existing `mockFreeTierDispatchService`/`mockGoogleFreeDispatchService` assertions, since a fourth leg now runs too.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: FAIL — `GroqFreeDispatchService` isn't a recognized provider, `runGroqBurnLeg` doesn't exist, `groqBurnOutcome`/`groqBurnMessage` are never written.

- [ ] **Step 3: Implement in `daily-automation.service.ts`**

Add the import and constructor param:

```ts
import { GroqFreeDispatchService } from "../groq-free-dispatch/groq-free-dispatch.service";
```

```ts
    @Inject(GroqFreeDispatchService)
    private readonly groqFreeDispatchService: GroqFreeDispatchService,
```

Update `run()`:

```ts
    await this.runJudgeLeg(date);
    await this.runMiniBurnLeg(date);
    await this.runGoogleBurnLeg(date);
    await this.runGroqBurnLeg(date);
```

Add the method, right after `runGoogleBurnLeg`:

```ts
  private async runGroqBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.groqFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { groqBurnOutcome: "alreadyActive", groqBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.groqFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted" ? "every Groq model is currently RPD-held" : "started";
      await this.runLogRepo.update({ date }, { groqBurnOutcome: result.outcome, groqBurnMessage: message });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Groq burn";
      this.logger.error(`daily automation groq-burn leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { groqBurnOutcome: "error", groqBurnMessage: message });
    }
  }
```

Update the class-level doc comment's leg list to mention the new fourth leg (optional but keeps the comment accurate — add a `groqBurn` bullet mirroring the `googleBurn` one).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the entity columns**

In `backend/src/modules/automation/entities/automation-run-log.entity.ts`, after `googleBurnMessage`:

```ts
  @Column({ type: "varchar", nullable: true })
  groqBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  groqBurnMessage: string | null;
```

- [ ] **Step 6: Create the migration**

Create `backend/src/migrations/1784000000000-add-automation-groq-leg.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the groqBurn leg's outcome/message columns to AutomationRunLog —
 * the Groq counterpart to the existing googleBurnOutcome/googleBurnMessage
 * columns from 1778000000000-add-automation-run-log.ts. */
export class AddAutomationGroqLeg1784000000000 implements MigrationInterface {
  name = "AddAutomationGroqLeg1784000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "groqBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "groqBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "groqBurnOutcome",
        DROP COLUMN IF EXISTS "groqBurnMessage"
    `);
  }
}
```

- [ ] **Step 7: Update `AutomationController`**

In `backend/src/modules/automation/automation.controller.ts`, add to the returned object:

```ts
      groqBurn: {
        outcome: log?.groqBurnOutcome ?? null,
        message: log?.groqBurnMessage ?? null,
      },
```

(right after the existing `googleBurn` field)

- [ ] **Step 8: Update `AutomationModule`**

In `backend/src/modules/automation/automation.module.ts`, import `GroqFreeDispatchModule` (`"../groq-free-dispatch/groq-free-dispatch.module"`) and add it to `imports` alongside `GoogleFreeDispatchModule`.

- [ ] **Step 9: Verify**

Run: `cd backend && npx tsc --noEmit && npx jest daily-automation.service.spec.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/automation backend/src/migrations/1784000000000-add-automation-groq-leg.ts
git commit -m "$(cat <<'EOF'
feat(backend): add the groqBurn leg to the daily-automation chain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Frontend — `GroqDispatchWidget` and Activity page wiring

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Create: `frontend/src/components/benchmark/GroqDispatchWidget.tsx`
- Create: `frontend/src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx`
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`

**Interfaces:**
- Consumes: `GET /automation/status` (now includes `groqBurn`, Task 14), `GET`/`DELETE /dispatch/groq` (Task 13).
- Produces: `GroqDispatchWidget` component, rendered on the Activity page.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx` — a direct copy of `GoogleDispatchWidget.test.tsx` with these substitutions: `GoogleDispatchWidget` → `GroqDispatchWidget`, `GoogleDispatchStatus` → `GroqDispatchStatus`, `/dispatch/google` → `/dispatch/groq`, `"Google daily quota"` → `"Groq daily quota"`, `"Couldn't load Google dispatch status: boom"` → `"Couldn't load Groq dispatch status: boom"`. Every test case and assertion shape is otherwise identical.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the types**

In `frontend/src/data/benchmark/types.ts`, after `GoogleDispatchStatus`:

```ts
/** GET /dispatch/groq — whether the Groq free-daily-quota dispatch cycle
 * (see the backend's GroqFreeDispatchService) is currently running. Same
 * shape as GoogleDispatchStatus — no token threshold, Groq's constraint is
 * a per-model per-day request cap enforced by Groq itself. */
export interface GroqDispatchStatus {
  active: boolean;
  startedAt: string | null;
}
```

Add `groqBurn: AutomationBurnLeg;` to `AutomationStatus`, right after `googleBurn: AutomationBurnLeg;`.

- [ ] **Step 4: Add the API client functions**

In `frontend/src/data/benchmark/api.ts`, add `GroqDispatchStatus` to the type-only import list, and after `stopGoogleDispatch`:

```ts
/** Whether the Groq free-daily-quota dispatch cycle is currently running —
 * see GroqDispatchStatus. Backs GroqDispatchWidget's active/inactive
 * indicator, polled the same way fetchGoogleDispatchStatus is. */
export function fetchGroqDispatchStatus(signal?: AbortSignal): Promise<GroqDispatchStatus> {
  return fetchJson("/dispatch/groq", signal);
}

/** Stops the Groq dispatch cycle — a no-op (not an error) if it wasn't
 * running. No password body, same as stopGoogleDispatch. */
export function stopGroqDispatch(signal?: AbortSignal): Promise<GroqDispatchStatus> {
  return fetchJson("/dispatch/groq", signal, { method: "DELETE" });
}
```

- [ ] **Step 5: Create the widget**

Create `frontend/src/components/benchmark/GroqDispatchWidget.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchGroqDispatchStatus, stopGroqDispatch } from "../../data/benchmark/api";
import type { AutomationLegDisplay, GroqDispatchStatus } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "Groq daily quota";

export interface GroqDispatchWidgetProps {
  /** The daily-automation Groq-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the Groq free-daily-quota dispatch cycle
 * (GroqFreeDispatchService) is currently running, plus (via `automation`)
 * when the daily-automation chain last tried to start it and when it will
 * try again. Unlike the OpenAI tiers there's no token budget to show a
 * progress bar against — Groq's constraint is a per-model per-day request
 * cap enforced by Groq itself, so this only ever shows active/inactive. */
export function GroqDispatchWidget({ automation }: GroqDispatchWidgetProps = {}) {
  const [status, setStatus] = useState<GroqDispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchGroqDispatchStatus(controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Groq dispatch status");
        });
    };

    poll();
    const intervalId = setInterval(poll, DISPATCH_STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopGroqDispatch()
      .then(() => fetchGroqDispatchStatus())
      .then(setStatus)
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load Groq dispatch status: {error}</p>
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
    <div className="bench-free-tier" role="status" aria-label="Groq daily quota dispatch">
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{TITLE}</span>
        {status.active ? (
          <>
            <StatusPill label="Auto-dispatch active" tone="active" />
            <button
              type="button"
              className="bench-sort-btn"
              onClick={handleDisable}
              disabled={isDisabling}
            >
              {isDisabling ? "Disabling…" : "Disable"}
            </button>
          </>
        ) : null}
      </div>
      <span className="bench-muted">
        {status.active ? "Dispatching trials against unrun puzzles." : "Not currently dispatching."}
      </span>
      {disableError ? <p className="bench-error">{disableError}</p> : null}
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx`
Expected: PASS

- [ ] **Step 7: Wire it into `ActivityPage.tsx`**

In `frontend/src/pages/benchmark/ActivityPage.tsx`:

```ts
import { GroqDispatchWidget } from "../../components/benchmark/GroqDispatchWidget";
```

After the `googleBurnAutomation` block:

```tsx
  const groqBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.groqBurn.outcome === "error"
            ? `failed: ${automationStatus.groqBurn.message}`
            : automationStatus.groqBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.groqBurn.outcome === "error",
      }
    : null;
```

In the JSX, right after `<GoogleDispatchWidget automation={googleBurnAutomation} />`:

```tsx
          <GroqDispatchWidget automation={groqBurnAutomation} />
```

- [ ] **Step 8: Run the full frontend test suite**

Run: `cd frontend && npm test -- --run`
Expected: PASS (including `ActivityPage.test.tsx` and `App.test.tsx`, both of which reference `GoogleDispatchWidget`/`AutomationStatus` per this plan's research — confirm neither breaks on the new `groqBurn` field or extra rendered widget; if either asserts an exact widget count or exact `bench-free-tiers` child list, update that assertion to include the new widget)

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/components/benchmark/GroqDispatchWidget.tsx frontend/src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx frontend/src/pages/benchmark/ActivityPage.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add GroqDispatchWidget to the Activity page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Full-repo verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full orchestrator suite**

Run: `cd orchestrator && npm test`
Expected: PASS

- [ ] **Step 2: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && npm test -- --run`
Expected: PASS

- [ ] **Step 4: Typecheck everything**

Run: `cd orchestrator && npm run typecheck && cd ../backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Manual migration round-trip against a real dev database**

Per repo convention, migrations aren't unit-tested. With the branch's own Postgres instance (e.g. `docker compose up -d db` against a throwaway volume, or the shared dev DB if nothing else is using it), run:

```bash
cd backend && npm run typeorm -- migration:run -d src/data-source.ts
npm run typeorm -- migration:revert -d src/data-source.ts
npm run typeorm -- migration:revert -d src/data-source.ts
npm run typeorm -- migration:revert -d src/data-source.ts
npm run typeorm -- migration:revert -d src/data-source.ts
npm run typeorm -- migration:run -d src/data-source.ts
```

(four reverts for the four new migrations: `add-automation-groq-leg`, `add-groq-dispatch-state`, `add-groq-rate-limit-hold`, `add-groq-models`, in that reverse order — adjust the exact `npm run typeorm` invocation to match whatever script this repo's `package.json` actually defines, e.g. it may already wrap `-d src/data-source.ts` for you.)

Expected: every migration applies and reverts cleanly, and the four `SupportedModel` rows exist after the final `run`.

- [ ] **Step 6: Boot the stack and smoke-test one Groq dispatch**

```bash
docker compose up -d --build
```

With `GROQ_API_KEY` set in `.env`, hit `GET /dispatch/groq` (expect `{ "active": false, "startedAt": null }` before automation ever fires) and confirm the worker log shows `llm-groq-runs`, `groq-free-dispatch`, and `groq-rpd-resume` in its "listening for jobs on" line. This is a manual smoke test, not an automated one — record the result in the PR description rather than adding a new automated test for it.

- [ ] **Step 7: Report results**

Summarize pass/fail for Steps 1–4 and the outcome of Steps 5–6 back to the user before considering the plan complete. Do not proceed to `finishing-a-development-branch` until every automated suite passes.
