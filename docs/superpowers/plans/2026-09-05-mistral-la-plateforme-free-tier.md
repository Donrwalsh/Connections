# Mistral (La Plateforme) Free-Tier Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth LLM strategy, `llm-mistral`, dispatched and rate-limit-managed the way `llm-groq` is today — per-model holds, dispatch-until-every-model-held, shared `FREE_TIER_DISPATCH_*` pacing, self-rescheduling resume — adapted for the fact that Mistral's free tier exposes **no rate-limit headers** and enforces its binding cap **monthly**, not daily.

**Architecture:** Mistral's La Plateforme free ("Experiment") tier gives the classifier almost nothing: no `X-RateLimit-*` headers, only an intermittent `Retry-After`, and a per-minute blip is indistinguishable on the wire from the month-long monthly-cap wall. So classification is split in two: (1) the orchestrator first tries to read the **429 body message** for a monthly/quota signal, mirroring `groqPerDayRateLimitDimension` added in `0f37cc6`; (2) when the body says nothing usable, every Mistral 429 comes back as `rate_limited`, and a new runner-side **consecutive-429 heuristic** escalates a persistent streak into a per-model park. There is **no** proactive token/call budget (Mistral exposes no usage counter). A parked model gets a short fixed **6h** fallback hold that the self-rescheduling resume sweep re-checks; a real monthly wall simply re-parks each cycle until the calendar month rolls. Per-model `MistralRateLimitHold` rows (identical shape to `GroqRateLimitHold`) keep one model's pool wall from freezing models in other Mistral free-tier pools. The orchestrator reaches Mistral through `@ai-sdk/mistral`.

**Tech Stack:** NestJS + TypeORM + BullMQ (backend/worker), Hono + Vercel AI SDK (`@ai-sdk/mistral`) (orchestrator), React + TanStack Query (frontend). Jest (backend), Vitest (orchestrator, frontend).

**Spec:** [docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md](../specs/2026-09-05-mistral-la-plateforme-free-tier-design.md)

## Global Constraints

- **Branch:** all work on `feature/mistral-la-plateforme-free-tier` (already created off `origin/master` `1cc2cd2`). Never commit to `master`.
- **TDD:** every code change is test-first — write the failing test, run it, see it fail for the right reason, implement, see it pass, commit. Migrations are the only exception (not unit-tested; verified by a manual up/down/up round-trip in Task 15).
- **DI:** this backend's worker runtime (`tsx`/`esbuild`) silently resolves a bare typed constructor parameter to `undefined`. Every class-to-class injection **must** use an explicit `@Inject(Token)` — copy the pattern from the surrounding constructor exactly.
- **Strategy id:** the literal string is `llm-mistral` everywhere (queue names use `mistral-…`, not `llm-mistral-…`, except the runs queue which is `llm-mistral-runs`).
- **Never guess a model id or an OpenRouter slug.** The seed migration's `modelName` values (Mistral La Plateforme ids) and `openRouterSlug` values are confirmed live in Task 14 before Task 15 seeds them. Until then the migration file carries the best-known values from the spec table and a comment saying "confirm before running".
- **Provider name:** the `ModelProvider` / union-type literal is `"mistral"` (lowercase) in both the orchestrator and the backend.
- **Reset cadence:** a parked model's `resetAt` is `heldAt + MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` (default `21600`, 6h). There is **no** monthly cron and **no** `secondsUntilNextUtcMonth` helper — that was Approach B, rejected.
- **No budget accounting:** do not add a `MISTRAL_FREE_MONTHLY_TOKEN_BUDGET` knob, a month-to-date `SolvePrompt.totalTokens` query, or a `callsToday`-style field. The dispatch stop condition is "every model held or backlog empty", exactly Groq's.

---

## File Structure

**Orchestrator (`orchestrator/src/`)**
- `provider.ts` — MODIFY: add `"mistral"` to `ModelProvider`, `DEFAULT_MISTRAL_MODEL`, `getModel`/`getModelName`/`defaultProvider` branches.
- `provider.test.ts` — MODIFY: Mistral resolution cases.
- `solver.ts` — MODIFY: `mistralMonthlyRateLimitFromBody` helper + a `provider === "mistral"` 429 branch in `classifyModelCallError`.
- `solver.test.ts` — MODIFY: Mistral 429 classification cases.
- `package.json` — MODIFY: add `@ai-sdk/mistral` dependency.

**Backend (`backend/src/`)**
- `strategies.ts` — MODIFY: `LLM_MISTRAL`, array membership, 5 `DEFAULT_*` consts + 5 accessors.
- `strategies.spec.ts` — MODIFY: accessor tests.
- `config`/`.env.sample`/`docker-compose.yml`/`README.md` — MODIFY: config surface.
- `modules/strategy/entities/mistral-rate-limit-hold.entity.ts` — CREATE (clone of `groq-rate-limit-hold.entity.ts`).
- `modules/strategy/mistral-rate-limit-hold.service.ts` — CREATE (clone of `groq-rate-limit-hold.service.ts`).
- `modules/strategy/mistral-rate-limit-hold.service.spec.ts` — CREATE (clone of the Groq spec).
- `modules/strategy/mistral-rpd-resume.service.ts` — CREATE (clone of `groq-rpd-resume.service.ts`).
- `modules/strategy/mistral-rpd-resume.service.spec.ts` — CREATE (clone).
- `modules/strategy/mistral-rpd-resume.bootstrap.ts` — CREATE (clone of `groq-rpd-resume.bootstrap.ts`).
- `modules/strategy/mistral-rpd-resume.bootstrap.spec.ts` — CREATE (clone).
- `modules/strategy/llm-strategy-runner.service.ts` — MODIFY: provider ternary, inject hold service, top gate, fallback-seconds ternary, `classifyFailedCall` `provider` param + Mistral streak logic, caller hold write, streak reset on success.
- `modules/strategy/llm-strategy-runner.service.spec.ts` — MODIFY: heuristic cases.
- `modules/strategy/orchestrator.service.ts` — MODIFY: widen two provider unions with `"mistral"`.
- `modules/strategy/strategy.module.ts` — MODIFY: register entity + 4 services/bootstrap.
- `modules/strategy/strategy.service.ts` — MODIFY: inject `LLM_MISTRAL_QUEUE`, pass to both `queueForStrategy` calls.
- `modules/mistral-free-dispatch/entities/mistral-dispatch-state.entity.ts` — CREATE (clone of `groq-dispatch-state.entity.ts`).
- `modules/mistral-free-dispatch/mistral-free-dispatch.service.ts` — CREATE (clone of `groq-free-dispatch.service.ts`).
- `modules/mistral-free-dispatch/mistral-free-dispatch.service.spec.ts` — CREATE (clone).
- `modules/mistral-free-dispatch/mistral-free-dispatch.module.ts` — CREATE (clone of `groq-free-dispatch.module.ts`).
- `modules/queue/strategy.queue.ts` — MODIFY: `llmMistralQueue`, `queueForStrategy` param.
- `modules/queue/strategy.queue.spec.ts` — MODIFY: routing case.
- `modules/queue/mistral-free-dispatch.queue.ts` — CREATE (clone of `groq-free-dispatch.queue.ts`).
- `modules/queue/mistral-rpd-resume.queue.ts` — CREATE (clone of `groq-rpd-resume.queue.ts`).
- `modules/queue/queue.module.ts` — MODIFY: 3 tokens + providers/exports.
- `modules/automation/entities/automation-run-log.entity.ts` — MODIFY: `mistralBurnOutcome`/`mistralBurnMessage`.
- `modules/automation/daily-automation.service.ts` — MODIFY: `runMistralBurnLeg`, inject service, call in `run()`, doc comment.
- `modules/automation/daily-automation.service.spec.ts` — MODIFY: leg-independence case.
- `modules/automation/automation.controller.ts` — MODIFY: `mistralBurn` in status assembly.
- `modules/automation/automation.module.ts` — MODIFY: import `MistralFreeDispatchModule`.
- `modules/dispatch/dispatch.controller.ts` — MODIFY: `GET`/`DELETE /dispatch/mistral`.
- `modules/dispatch/dispatch.module.ts` — MODIFY: import `MistralFreeDispatchModule`.
- `worker.ts` — MODIFY: `llm-mistral-runs` worker, `mistral-free-dispatch` + `mistral-rpd-resume` workers.
- `app.module.ts` — MODIFY: register `MistralRateLimitHold` + `MistralDispatchState` entities.
- `data-source.ts` — MODIFY: same two entities.
- `app.setup.ts` (Bull Board) — MODIFY: add `llm-mistral-runs` + the two new queues to the board.
- `migrations/1792000000000-add-mistral-rate-limit-hold.ts` — CREATE.
- `migrations/1793000000000-add-mistral-dispatch-state.ts` — CREATE.
- `migrations/1794000000000-add-automation-mistral-leg.ts` — CREATE.
- `migrations/1795000000000-add-mistral-models.ts` — CREATE.

**Frontend (`frontend/src/`)**
- `data/benchmark/types.ts` — MODIFY: `MistralDispatchStatus`, `AutomationStatus.mistralBurn`.
- `data/benchmark/api.ts` — MODIFY: `fetchMistralDispatchStatus`/`stopMistralDispatch`.
- `components/benchmark/MistralDispatchWidget.tsx` — CREATE (clone of `GroqDispatchWidget.tsx`).
- `components/benchmark/__tests__/MistralDispatchWidget.test.tsx` — CREATE (clone).
- `pages/benchmark/ActivityPage.tsx` — MODIFY: `mistralBurnAutomation` + render `<MistralDispatchWidget>`.
- `pages/benchmark/__tests__/ActivityPage.test.tsx` — MODIFY: mock `mistralBurn`.

---

## Task 1: Orchestrator — Mistral model resolution

**Files:**
- Modify: `orchestrator/src/provider.ts`
- Modify: `orchestrator/src/package.json`
- Test: `orchestrator/src/provider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ModelProvider` now includes `"mistral"`; `getModel("mistral", override?, ctx?)` → `LanguageModel`; `getModelName("mistral", override?)` → `string`; `defaultProvider()` returns `"mistral"` when `MODEL_PROVIDER=mistral`; `DEFAULT_MISTRAL_MODEL = "mistral-small-latest"`.

- [ ] **Step 1: Add the dependency**

In `orchestrator/src/package.json`, add to `dependencies` (alphabetical, next to `@ai-sdk/groq`):

```json
"@ai-sdk/mistral": "^4.0.0",
```

Run: `cd orchestrator && npm install`
Expected: `@ai-sdk/mistral` resolves and installs. If `^4.0.0` does not exist, run `npm view @ai-sdk/mistral version` and pin the current major that matches the `ai` v7 / `@ai-sdk/provider` line the other `@ai-sdk/*` packages use; note the exact version chosen in the commit message.

- [ ] **Step 2: Write the failing tests**

In `orchestrator/src/provider.test.ts`, mirroring the existing `groq` blocks:

```ts
describe("mistral provider", () => {
  it("getModelName returns the override when given", () => {
    expect(getModelName("mistral", "ministral-8b-latest")).toBe("ministral-8b-latest");
  });

  it("getModelName falls back to MISTRAL_MODEL then DEFAULT_MISTRAL_MODEL", () => {
    const prev = process.env.MISTRAL_MODEL;
    process.env.MISTRAL_MODEL = "mistral-medium-latest";
    expect(getModelName("mistral")).toBe("mistral-medium-latest");
    delete process.env.MISTRAL_MODEL;
    expect(getModelName("mistral")).toBe(DEFAULT_MISTRAL_MODEL);
    if (prev !== undefined) process.env.MISTRAL_MODEL = prev;
  });

  it("getModel returns a LanguageModel for mistral without throwing", () => {
    const prev = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = "test-key";
    expect(() => getModel("mistral", "mistral-small-latest")).not.toThrow();
    if (prev === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = prev;
  });

  it("defaultProvider() honours MODEL_PROVIDER=mistral", () => {
    const prev = process.env.MODEL_PROVIDER;
    process.env.MODEL_PROVIDER = "mistral";
    expect(defaultProvider()).toBe("mistral");
    if (prev === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = prev;
  });
});
```

Ensure `DEFAULT_MISTRAL_MODEL` is added to the test file's import from `./provider`.

- [ ] **Step 3: Run the tests, verify they fail**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: FAIL — `DEFAULT_MISTRAL_MODEL` is undefined / `"mistral"` not assignable to `ModelProvider`.

- [ ] **Step 4: Implement**

In `orchestrator/src/provider.ts`:

At the top, next to the other `@ai-sdk` imports:

```ts
import { createMistral } from "@ai-sdk/mistral";
```

> Confirm the factory export name and call shape against the installed package's types (`node_modules/@ai-sdk/mistral/dist/index.d.ts`). If the provider instance is not directly callable and needs `.chat(id)` / `.languageModel(id)`, use that form — match whatever `@ai-sdk/groq` and `@openrouter/ai-sdk-provider` do in this same file.

Add the default constant next to `DEFAULT_GROQ_MODEL`:

```ts
export const DEFAULT_MISTRAL_MODEL = "mistral-small-latest";
```

Extend the union:

```ts
export type ModelProvider = "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral";
```

In `defaultProvider()`, before `return "openai";`:

```ts
  if (provider === "mistral") return "mistral";
```

In `getModel()`, after the `openrouter` branch and before the final `return openai(...)`:

```ts
  if (provider === "mistral") {
    const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY });
    return mistral(modelOverride ?? process.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL);
  }
```

In `getModelName()`, before the final `return`:

```ts
  if (provider === "mistral") {
    return modelOverride ?? process.env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL;
  }
```

`effectiveContextWindow()` needs no change — `provider !== "ollama"` already covers Mistral.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd orchestrator && npx vitest run src/provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/provider.ts orchestrator/src/provider.test.ts orchestrator/package.json orchestrator/package-lock.json
git commit -m "feat(orchestrator): add Mistral as a model provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Orchestrator — Mistral 429 classification

**Files:**
- Modify: `orchestrator/src/solver.ts`
- Test: `orchestrator/src/solver.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` includes `"mistral"` (Task 1); existing `parseSecondsHeader` helper; existing `SolveError`, `SolveErrorDetails`, `APICallError`.
- Produces: `classifyModelCallError(err, "mistral", details)` returns `SolveError` with code `"rate_limited_daily"` (body says monthly, `dailyResetSeconds` unset) or `"rate_limited"` (`retryAfterSeconds` from `retry-after` or `undefined`) for any 429; `model_error` unchanged for non-429. New module-private helper `mistralMonthlyRateLimitFromBody(responseBody: unknown, fallbackMessage: string): boolean`.

- [ ] **Step 1: Write the failing tests**

In `orchestrator/src/solver.test.ts`, next to the Groq 429 describe block. Match the existing tests' construction of an `APICallError` (search the file for `new APICallError(` to copy the exact option shape).

```ts
describe("classifyModelCallError — mistral 429", () => {
  const details = { requestBody: undefined, statusCode: undefined };

  function mistral429(body: string, headers: Record<string, string> = {}) {
    return new APICallError({
      message: "Rate limit exceeded",
      url: "https://api.mistral.ai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: headers,
      responseBody: body,
      isRetryable: true,
    });
  }

  it("classifies a monthly/quota body as rate_limited_daily with no dailyResetSeconds", () => {
    const err = mistral429(
      JSON.stringify({ error: { message: "Service tier capacity exceeded for this model. Monthly token quota reached.", type: "quota_exceeded" } }),
    );
    const out = classifyModelCallError(err, "mistral", details);
    expect(out.code).toBe("rate_limited_daily");
    expect(out.details.dailyResetSeconds).toBeUndefined();
  });

  it("classifies a plain rate-limit body with Retry-After as rate_limited", () => {
    const err = mistral429(
      JSON.stringify({ error: { message: "Requests rate limit exceeded", type: "rate_limit_exceeded" } }),
      { "retry-after": "30" },
    );
    const out = classifyModelCallError(err, "mistral", details);
    expect(out.code).toBe("rate_limited");
    expect(out.details.retryAfterSeconds).toBe(30);
  });

  it("classifies an unreadable 429 body with no Retry-After as rate_limited with undefined wait", () => {
    const err = mistral429("<html>502 bad gateway</html>");
    const out = classifyModelCallError(err, "mistral", details);
    expect(out.code).toBe("rate_limited");
    expect(out.details.retryAfterSeconds).toBeUndefined();
  });

  it("does not affect a non-mistral provider's 429", () => {
    const err = mistral429(JSON.stringify({ error: { message: "Monthly token quota reached" } }));
    const out = classifyModelCallError(err, "openai", details);
    expect(out.code).toBe("model_error");
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd orchestrator && npx vitest run src/solver.test.ts -t "mistral 429"`
Expected: FAIL — Mistral 429s currently fall through to `model_error`.

- [ ] **Step 3: Implement the helper**

In `orchestrator/src/solver.ts`, immediately after `groqPerDayRateLimitDimension`:

```ts
/**
 * Mistral's La Plateforme free tier attaches no X-RateLimit-* headers, so a
 * transient per-minute (1 RPS / TPM) 429 and the month-long monthly-token-cap
 * wall look identical on the wire. Where the 429 body names a monthly / quota
 * exhaustion we can still tell them apart — mirroring
 * groqPerDayRateLimitDimension's body-message read (added in 0f37cc6). Returns
 * true only when the body clearly indicates the monthly/quota wall (which must
 * park the model, not be retried in place); false for a plain rate-limit
 * message or an absent/unreadable body — the runner's consecutive-429
 * heuristic is the fallback for a monthly wall the body failed to announce.
 * Never throws.
 */
function mistralMonthlyRateLimitFromBody(
  responseBody: unknown,
  fallbackMessage: string,
): boolean {
  const texts = [fallbackMessage];
  if (typeof responseBody === "string") {
    texts.push(responseBody);
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { message?: unknown; type?: unknown; code?: unknown };
        message?: unknown;
        type?: unknown;
      };
      for (const v of [
        parsed?.error?.message,
        parsed?.error?.type,
        parsed?.error?.code,
        parsed?.message,
        parsed?.type,
      ]) {
        if (typeof v === "string") texts.push(v);
      }
    } catch {
      // Not JSON — the raw string is already in `texts`.
    }
  }
  const text = texts.join("\n");
  // Monthly / quota wording. Deliberately does NOT match a bare "rate limit"
  // (that is the per-minute case). Confirm/extend against a real captured
  // Mistral monthly-cap 429 body in Task 14.
  return (
    /\bmonthly\b/i.test(text) ||
    /\bquota\b/i.test(text) ||
    /\bcapacity exceeded\b/i.test(text) ||
    /\bper month\b/i.test(text) ||
    /\bmonth(ly)?\s+(token|request)/i.test(text)
  );
}
```

- [ ] **Step 4: Implement the branch**

In `classifyModelCallError`, immediately after the `provider === "openrouter"` block and before the final `return new SolveError("model_error", ...)`:

```ts
  if (provider === "mistral" && APICallError.isInstance(err) && err.statusCode === 429) {
    if (mistralMonthlyRateLimitFromBody(err.responseBody, message)) {
      // Monthly / quota wall — park the model. dailyResetSeconds is left
      // unset (Mistral gives no reset countdown); the backend falls back to
      // MISTRAL_MODEL_HOLD_FALLBACK_SECONDS.
      return new SolveError("rate_limited_daily", `Mistral monthly quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
      });
    }
    const headers = err.responseHeaders ?? {};
    const retryAfterSeconds = parseSecondsHeader(headers["retry-after"]);
    // A bare 429 is unambiguously a rate limit even when nothing else about
    // it is legible — return rate_limited (not model_error). The runner's
    // consecutive-429 heuristic is the safety net for a monthly wall the
    // body did not announce.
    return new SolveError("rate_limited", `Mistral rate limit hit: ${message}`, {
      ...details,
      ...apiDetails,
      errorName: err.name,
      retryAfterSeconds,
    });
  }
```

> Header keys: the Groq branch reads `headers["retry-after"]` directly. If a captured Mistral response shows a differently-cased key, normalise with the same approach the Groq/OpenRouter branches use (lowercase the keys first). Note this for Task 14.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd orchestrator && npx vitest run src/solver.test.ts`
Expected: PASS (whole file — confirm no regression in the Groq/OpenRouter/Google blocks).

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts
git commit -m "feat(orchestrator): classify Mistral 429s (body-message monthly check, else rate_limited)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Backend — widen `OrchestratorService` provider unions

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts:106` and `:138`

**Interfaces:**
- Consumes: nothing.
- Produces: `solveAssist` / the judge method accept `provider?: "…" | "mistral"`.

- [ ] **Step 1: Write the failing test**

There is no dedicated unit test for these signatures; the type change is exercised by Task 5's runner spec (which passes `"mistral"`). Instead, add a compile check now: in `backend/src/modules/strategy/orchestrator.service.spec.ts` (search for an existing `solveAssist` test), add a case that calls `solveAssist` with `provider: "mistral"` and asserts it forwards `provider` in the request body (copy the nearest existing "forwards provider" test and change the literal). If no such test exists, add:

```ts
it("forwards provider: 'mistral' to the orchestrator", async () => {
  httpPost.mockResolvedValue({ data: { ok: true, groups: [] } });
  await service.solveAssist([], "mistral-small-latest", "mistral");
  expect(httpPost).toHaveBeenCalledWith(
    expect.stringContaining("/solve-assist"),
    expect.objectContaining({ provider: "mistral" }),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd backend && npx jest src/modules/strategy/orchestrator.service.spec.ts`
Expected: FAIL — TypeScript rejects `"mistral"` as not assignable to the `provider` param.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/orchestrator.service.ts`, both occurrences (lines ~106 and ~138):

```ts
    provider?: "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral",
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd backend && npx jest src/modules/strategy/orchestrator.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat(backend): accept mistral as an OrchestratorService provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Backend — `strategies.ts` constants and accessors

**Files:**
- Modify: `backend/src/strategies.ts`
- Test: `backend/src/strategies.spec.ts`

**Interfaces:**
- Consumes: existing `positiveTrialCount`, `SUPPORTED_STRATEGIES`, `LLM_STRATEGIES`.
- Produces:
  - `LLM_MISTRAL = "llm-mistral"` (const), added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`.
  - `DEFAULT_LLM_MISTRAL_CONCURRENCY = 1`
  - `DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS = 60`
  - `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS = 4`
  - `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS = 300`
  - `DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS = 21600`
  - `llmMistralConcurrency(env?) → number`
  - `llmMistralRateLimitFallbackSeconds(env?) → number`
  - `mistralPersistentRateLimitAttempts(env?) → number`
  - `mistralPersistentRateLimitElapsedMs(env?) → number` (reads `MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS`, returns `seconds * 1000`)
  - `mistralModelHoldFallbackSeconds(env?) → number`

- [ ] **Step 1: Write the failing tests**

In `backend/src/strategies.spec.ts`, next to the `llmGroqConcurrency` / `llmGroqRateLimitFallbackSeconds` blocks:

```ts
describe("llmMistralConcurrency", () => {
  it("defaults when unset", () => {
    expect(llmMistralConcurrency({})).toBe(DEFAULT_LLM_MISTRAL_CONCURRENCY);
  });
  it("falls back on non-positive / non-integer", () => {
    expect(llmMistralConcurrency({ LLM_MISTRAL_CONCURRENCY: "abc" })).toBe(DEFAULT_LLM_MISTRAL_CONCURRENCY);
    expect(llmMistralConcurrency({ LLM_MISTRAL_CONCURRENCY: "0" })).toBe(DEFAULT_LLM_MISTRAL_CONCURRENCY);
  });
  it("reads a valid override", () => {
    expect(llmMistralConcurrency({ LLM_MISTRAL_CONCURRENCY: "2" })).toBe(2);
  });
});

describe("llmMistralRateLimitFallbackSeconds", () => {
  it("defaults when unset", () => {
    expect(llmMistralRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS);
  });
  it("reads a valid override", () => {
    expect(llmMistralRateLimitFallbackSeconds({ LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
  });
});

describe("mistralPersistentRateLimitAttempts", () => {
  it("defaults when unset", () => {
    expect(mistralPersistentRateLimitAttempts({})).toBe(DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS);
  });
  it("reads a valid override", () => {
    expect(mistralPersistentRateLimitAttempts({ MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS: "6" })).toBe(6);
  });
});

describe("mistralPersistentRateLimitElapsedMs", () => {
  it("defaults to the seconds constant times 1000", () => {
    expect(mistralPersistentRateLimitElapsedMs({})).toBe(DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS * 1000);
  });
  it("reads an override in seconds and returns ms", () => {
    expect(mistralPersistentRateLimitElapsedMs({ MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS: "120" })).toBe(120000);
  });
});

describe("mistralModelHoldFallbackSeconds", () => {
  it("defaults when unset", () => {
    expect(mistralModelHoldFallbackSeconds({})).toBe(DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS);
  });
  it("reads a valid override", () => {
    expect(mistralModelHoldFallbackSeconds({ MISTRAL_MODEL_HOLD_FALLBACK_SECONDS: "3600" })).toBe(3600);
  });
});

describe("LLM_MISTRAL membership", () => {
  it("is a supported LLM strategy", () => {
    expect(SUPPORTED_STRATEGIES).toContain("llm-mistral");
    expect(isLlmStrategy("llm-mistral")).toBe(true);
  });
});
```

Add the new identifiers to the file's import from `./strategies`.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && npx jest src/strategies.spec.ts`
Expected: FAIL — new symbols undefined.

- [ ] **Step 3: Implement**

In `backend/src/strategies.ts`:

`SUPPORTED_STRATEGIES` array — add `"llm-mistral",` after `"llm-openrouter",`.

After `export const LLM_OPENROUTER = "llm-openrouter" as const;`:

```ts
export const LLM_MISTRAL = "llm-mistral" as const;
```

`LLM_STRATEGIES` array — add `LLM_MISTRAL,` after `LLM_OPENROUTER,`.

After the OpenRouter `DEFAULT_*` block:

```ts
export const DEFAULT_LLM_MISTRAL_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying a Mistral per-minute (1 RPS / TPM)
// rate-limit hit — used only when the 429 carried no parseable retry-after
// header. A per-minute hit is never a run failure; it waits and retries.
export const DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS = 60;

// Mistral's free tier sends no X-RateLimit-* headers, so a monthly-cap 429
// and a transient per-minute 429 are indistinguishable when the 429 body
// carries no monthly wording. The runner escalates a *persistent* streak of
// per-minute 'rate_limited' outcomes on one run into a per-model park: after
// this many consecutive hits...
export const DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS = 4;
// ...or once the streak has spanned this many wall-clock seconds, whichever
// trips first.
export const DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS = 300;

// How long a Mistral model stays parked once the heuristic (or an
// orchestrator body-classified monthly 429) trips. Short and fixed: the
// resume sweep re-checks after it expires, so a real monthly wall just
// re-parks each cycle until the calendar month rolls, while a misclassified
// multi-minute TPM starvation episode recovers within 6h. (default: 6h)
export const DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS = 21600;
```

After the OpenRouter accessors:

```ts
/**
 * How many llm-mistral runs the worker may process at once, from
 * LLM_MISTRAL_CONCURRENCY. Keep at 1 — this is the guard for Mistral's
 * global 1-request-per-second ceiling. Falls back to
 * DEFAULT_LLM_MISTRAL_CONCURRENCY for missing/invalid values.
 */
export function llmMistralConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MISTRAL_CONCURRENCY, DEFAULT_LLM_MISTRAL_CONCURRENCY);
}

/**
 * Fallback wait (seconds) before retrying a Mistral per-minute rate-limit
 * hit, from LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS. Only used when the 429
 * carried no parseable retry-after header. Falls back to
 * DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmMistralRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

/**
 * Consecutive per-minute 'rate_limited' outcomes on one llm-mistral run
 * before the runner heuristic parks the model, from
 * MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS. Falls back to
 * DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS for missing/invalid values.
 */
export function mistralPersistentRateLimitAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS,
    DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS,
  );
}

/**
 * Wall-clock span (milliseconds) of a per-minute 'rate_limited' streak on
 * one llm-mistral run before the runner heuristic parks the model,
 * whichever trips first alongside the attempt count. Reads
 * MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS (a *seconds* knob) and
 * returns it in milliseconds. Falls back to
 * DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS * 1000.
 */
export function mistralPersistentRateLimitElapsedMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    positiveTrialCount(
      env.MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS,
      DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS,
    ) * 1000
  );
}

/**
 * How long (seconds) a parked Mistral model stays held before the resume
 * sweep re-checks it, from MISTRAL_MODEL_HOLD_FALLBACK_SECONDS. Falls back
 * to DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS for missing/invalid values.
 */
export function mistralModelHoldFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
    DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
  );
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd backend && npx jest src/strategies.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts
git commit -m "feat(backend): register the llm-mistral strategy and its config knobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Backend — `MistralRateLimitHold` entity and service

**Files:**
- Create: `backend/src/modules/strategy/entities/mistral-rate-limit-hold.entity.ts`
- Create: `backend/src/modules/strategy/mistral-rate-limit-hold.service.ts`
- Create: `backend/src/modules/strategy/mistral-rate-limit-hold.service.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`, `backend/src/app.module.ts`, `backend/src/data-source.ts`

**Interfaces:**
- Consumes: TypeORM `Repository`.
- Produces: entity `MistralRateLimitHold` (`id`, `strategyName: text`, `modelName: text`, `heldAt: timestamptz`, `resetAt: timestamptz`, unique `(strategyName, modelName)`). Service `MistralRateLimitHoldService`:
  - `hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void>`
  - `isHeld(strategyName: string, modelName: string): Promise<boolean>`
  - `heldModels(strategyName: string): Promise<string[]>`
  - `nextResetAt(strategyName: string): Promise<Date | null>`
  - `clearExpired(): Promise<string[]>`

- [ ] **Step 1: Create the entity**

Copy `backend/src/modules/strategy/entities/groq-rate-limit-hold.entity.ts` to `mistral-rate-limit-hold.entity.ts` and apply these exact substitutions:
- class `GroqRateLimitHold` → `MistralRateLimitHold`
- `@Entity("GroqRateLimitHold")` → `@Entity("MistralRateLimitHold")`
- `@Unique("UQ_GroqRateLimitHold_strategyName_modelName", …)` → `@Unique("UQ_MistralRateLimitHold_strategyName_modelName", …)`
- Update the doc comment: replace the Groq-header-countdown rationale with: "resetAt is `heldAt + MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` — Mistral's free tier sends no rate-limit headers, so there is no per-hit reset duration to honour; a short fixed park that the resume sweep re-checks is the design (see docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §3)."

- [ ] **Step 2: Register the entity**

- `backend/src/app.module.ts`: add `import { MistralRateLimitHold } from "./modules/strategy/entities/mistral-rate-limit-hold.entity";` and add `MistralRateLimitHold,` to the `entities: [...]` array (next to `OpenRouterRateLimitHold`).
- `backend/src/data-source.ts`: same import + same array addition.
- `backend/src/modules/strategy/strategy.module.ts`: add the import and add `MistralRateLimitHold,` to `TypeOrmModule.forFeature([...])`.

- [ ] **Step 3: Write the failing spec**

Copy `backend/src/modules/strategy/groq-rate-limit-hold.service.spec.ts` to `mistral-rate-limit-hold.service.spec.ts`. Substitute `Groq` → `Mistral` in all identifiers, the imports, and the `provide:`/`useClass:` wiring; substitute the test strategy string to `"llm-mistral"` and the sample model names to `"mistral-small-latest"` / `"ministral-8b-latest"`. The behavioural assertions carry over verbatim (`hold` upserts `resetAt = heldAt + resetInSeconds`, refreshes on re-hold; `isHeld` true only while `resetAt > now`; `heldModels` returns live model names; `nextResetAt` returns the soonest future `resetAt` or null; `clearExpired` removes elapsed rows and returns their model names). There is no timezone case to port.

- [ ] **Step 4: Run the spec, verify it fails**

Run: `cd backend && npx jest src/modules/strategy/mistral-rate-limit-hold.service.spec.ts`
Expected: FAIL — `MistralRateLimitHoldService` not found.

- [ ] **Step 5: Implement the service**

Copy `backend/src/modules/strategy/groq-rate-limit-hold.service.ts` to `mistral-rate-limit-hold.service.ts`. Substitutions:
- `GroqRateLimitHold` → `MistralRateLimitHold` (import + `@InjectRepository` generic + `Repository<…>` type)
- class `GroqRateLimitHoldService` → `MistralRateLimitHoldService`
- log message prefixes `RPD hold` → `hold` (Mistral's cap is monthly, not RPD; keep the wording generic)
- doc comment: "source of truth for which Mistral models are currently held for a rate-limit/quota hit. Identical in shape to GroqRateLimitHoldService; resetAt is a short fixed fallback (MISTRAL_MODEL_HOLD_FALLBACK_SECONDS), not a per-hit header duration. See docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §3."
- The method bodies are unchanged.

- [ ] **Step 6: Register the service**

In `backend/src/modules/strategy/strategy.module.ts`: add `import { MistralRateLimitHoldService } from "./mistral-rate-limit-hold.service";` and add `MistralRateLimitHoldService,` to both `providers: [...]` and `exports: [...]` (next to `OpenRouterRateLimitHoldService`).

- [ ] **Step 7: Run the spec, verify it passes**

Run: `cd backend && npx jest src/modules/strategy/mistral-rate-limit-hold.service.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/strategy/entities/mistral-rate-limit-hold.entity.ts backend/src/modules/strategy/mistral-rate-limit-hold.service.ts backend/src/modules/strategy/mistral-rate-limit-hold.service.spec.ts backend/src/modules/strategy/strategy.module.ts backend/src/app.module.ts backend/src/data-source.ts
git commit -m "feat(backend): add MistralRateLimitHold entity and service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Backend — migration for the two Mistral tables

**Files:**
- Create: `backend/src/migrations/1792000000000-add-mistral-rate-limit-hold.ts`
- Create: `backend/src/migrations/1793000000000-add-mistral-dispatch-state.ts`

(The `MistralDispatchState` entity itself lands in Task 9; its table migration is grouped here so all schema DDL for the feature is reviewable together and Task 15's round-trip covers a contiguous block.)

- [ ] **Step 1: Create the rate-limit-hold migration**

Copy `backend/src/migrations/1782000000000-add-groq-rate-limit-hold.ts` to `1792000000000-add-mistral-rate-limit-hold.ts`:
- class `AddGroqRateLimitHold1782000000000` → `AddMistralRateLimitHold1792000000000`
- `name = "AddMistralRateLimitHold1792000000000";`
- table name `"GroqRateLimitHold"` → `"MistralRateLimitHold"` (both `up` CREATE and `down` DROP)
- constraint `"UQ_GroqRateLimitHold_strategyName_modelName"` → `"UQ_MistralRateLimitHold_strategyName_modelName"`
- index `"IDX_GroqRateLimitHold_resetAt"` → `"IDX_MistralRateLimitHold_resetAt"`
- doc comment: note `rateLimitedDaily` already exists on `strategy_run_status_enum` (from `1777000000000`) and is reused; reference the Mistral spec.

- [ ] **Step 2: Create the dispatch-state migration**

Copy `backend/src/migrations/1783000000000-add-groq-dispatch-state.ts` to `1793000000000-add-mistral-dispatch-state.ts`:
- class `AddGroqDispatchState1783000000000` → `AddMistralDispatchState1793000000000`
- `name = "AddMistralDispatchState1793000000000";`
- table name `"GroqDispatchState"` → `"MistralDispatchState"` (both `up` and `down`)
- doc comment: "the Mistral counterpart to GroqDispatchState."

- [ ] **Step 3: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (no schema execution here; round-trip is Task 15).

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/1792000000000-add-mistral-rate-limit-hold.ts backend/src/migrations/1793000000000-add-mistral-dispatch-state.ts
git commit -m "feat(backend): add MistralRateLimitHold and MistralDispatchState migrations

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Backend — Mistral's BullMQ queues and `queueForStrategy`

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/strategy.queue.spec.ts`
- Create: `backend/src/modules/queue/mistral-free-dispatch.queue.ts`
- Create: `backend/src/modules/queue/mistral-rpd-resume.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`

**Interfaces:**
- Consumes: `LLM_MISTRAL` (Task 4).
- Produces:
  - `llmMistralQueue` (BullMQ `Queue("llm-mistral-runs")`), exported from `strategy.queue.ts`.
  - `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, groqQueue, openRouterQueue, mistralQueue, strategyName)` — **new 7th queue param before `strategyName`**.
  - `mistralFreeDispatchQueue` (`Queue("mistral-free-dispatch")`), `mistralRpdResumeQueue` (`Queue("mistral-rpd-resume")`).
  - Tokens `LLM_MISTRAL_QUEUE`, `MISTRAL_FREE_DISPATCH_QUEUE`, `MISTRAL_RPD_RESUME_QUEUE` in `queue.module.ts`, wired into `providers` and `exports`.

- [ ] **Step 1: Write the failing test**

In `backend/src/modules/queue/strategy.queue.spec.ts` (search for the `queueForStrategy` describe):

```ts
it("routes llm-mistral to the mistral queue", () => {
  const picked = queueForStrategy(
    defaultQ, openAIQ, ollamaQ, googleQ, groqQ, openRouterQ, mistralQ, "llm-mistral",
  );
  expect(picked).toBe(mistralQ);
});
```

Add a `const mistralQ = {} as unknown as Queue;` alongside the other fake queues in that describe's setup, and add `mistralQ` to every existing `queueForStrategy(...)` call in the file (they gain the 7th positional arg before the strategy name).

- [ ] **Step 2: Run it, verify it fails**

Run: `cd backend && npx jest src/modules/queue/strategy.queue.spec.ts`
Expected: FAIL — arity mismatch / `mistralQ` undefined.

- [ ] **Step 3: Implement `strategy.queue.ts`**

Add the import literal: `import { …, LLM_MISTRAL } from "../../strategies";`

After `llmOpenRouterQueue`:

```ts
export const llmMistralQueue = new Queue("llm-mistral-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
```

`queueForStrategy` — add the parameter and the branch:

```ts
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  groqQueue: Queue,
  openRouterQueue: Queue,
  mistralQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  if (strategyName === LLM_GROQ) return groqQueue;
  if (strategyName === LLM_OPENROUTER) return openRouterQueue;
  if (strategyName === LLM_MISTRAL) return mistralQueue;
  return defaultQueue;
}
```

- [ ] **Step 4: Create the two dispatch/resume queues**

Copy `backend/src/modules/queue/groq-free-dispatch.queue.ts` to `mistral-free-dispatch.queue.ts`: rename the export `groqFreeDispatchQueue` → `mistralFreeDispatchQueue`, the queue name `"groq-free-dispatch"` → `"mistral-free-dispatch"`, and adjust the comment (`Groq` → `Mistral`).

Copy `backend/src/modules/queue/groq-rpd-resume.queue.ts` to `mistral-rpd-resume.queue.ts`: rename `groqRpdResumeQueue` → `mistralRpdResumeQueue`, `"groq-rpd-resume"` → `"mistral-rpd-resume"`, adjust the comment (keep the "no fixed schedule — rearm() self-schedules" note; it applies identically).

- [ ] **Step 5: Wire `queue.module.ts`**

- Import `llmMistralQueue` from `./strategy.queue`; import `mistralFreeDispatchQueue` from `./mistral-free-dispatch.queue`; import `mistralRpdResumeQueue` from `./mistral-rpd-resume.queue`.
- Add tokens: `export const LLM_MISTRAL_QUEUE = "LLM_MISTRAL_QUEUE";`, `export const MISTRAL_FREE_DISPATCH_QUEUE = "MISTRAL_FREE_DISPATCH_QUEUE";`, `export const MISTRAL_RPD_RESUME_QUEUE = "MISTRAL_RPD_RESUME_QUEUE";` (next to their Groq/OpenRouter siblings).
- Add `{ provide: LLM_MISTRAL_QUEUE, useValue: llmMistralQueue }`, `{ provide: MISTRAL_FREE_DISPATCH_QUEUE, useValue: mistralFreeDispatchQueue }`, `{ provide: MISTRAL_RPD_RESUME_QUEUE, useValue: mistralRpdResumeQueue }` to `providers`.
- Add all three tokens to `exports`.

- [ ] **Step 6: Fix the other `queueForStrategy` caller**

`backend/src/modules/strategy/strategy.service.ts` uses `queueForStrategy` via its private `queueFor` (line ~224) and once more at line ~834. Both must gain the new arg — but that needs the injected queue, done in Task 8. For now, `npx tsc --noEmit` will flag these two call sites; leave them failing until Task 8 (they are the same commit boundary conceptually, but Task 8 is where the injection is added). To keep this task's commit green, add a temporary 7th arg of `this.llmOpenRouterQueue` at both sites with a `// TODO(Task 8): replace with llmMistralQueue` comment — Task 8 replaces it.

> Reviewer note: this stub is load-bearing for exactly one task. Task 8's diff must remove both TODOs.

- [ ] **Step 7: Run the tests**

Run: `cd backend && npx jest src/modules/queue/strategy.queue.spec.ts && npx tsc --noEmit`
Expected: spec PASS; `tsc` PASS (with the temporary stubs in place).

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/queue/ backend/src/modules/strategy/strategy.service.ts
git commit -m "feat(backend): add the llm-mistral-runs, mistral-free-dispatch, mistral-rpd-resume queues

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Backend — inject `LLM_MISTRAL_QUEUE` into `StrategyService`

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts` (whichever spec constructs `StrategyService` with faked queues)

**Interfaces:**
- Consumes: `LLM_MISTRAL_QUEUE` token (Task 7).
- Produces: `StrategyService` routes `llm-mistral` runs to `llm-mistral-runs`.

- [ ] **Step 1: Write / adjust the failing test**

In the `StrategyService` spec, find where the provider queues are provided (search `LLM_OPENROUTER_QUEUE`). Add a fake `mistralQueue = { add: jest.fn() }` and a `{ provide: LLM_MISTRAL_QUEUE, useValue: mistralQueue }` provider. Add a test:

```ts
it("dispatches an llm-mistral run to the mistral queue", async () => {
  // arrange a supported llm-mistral model + an unrun puzzle exactly as the
  // existing "dispatches an llm-openrouter run" test does
  await service.triggerStrategyRuns(puzzleId, "llm-mistral", date, "mistral-small-latest");
  expect(mistralQueue.add).toHaveBeenCalled();
});
```

Model it on the nearest existing per-provider dispatch test.

- [ ] **Step 2: Run it, verify it fails**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts -t mistral`
Expected: FAIL — no `LLM_MISTRAL_QUEUE` provider / run not routed.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/strategy.service.ts`:
- Import `LLM_MISTRAL_QUEUE` from `../queue/queue.module`.
- Constructor: add `@Inject(LLM_MISTRAL_QUEUE) private readonly llmMistralQueue: Queue,` after `llmOpenRouterQueue`.
- `queueFor` (line ~224) and the second call site (line ~834): replace the temporary `this.llmOpenRouterQueue` 7th arg (the Task 7 TODO) with `this.llmMistralQueue`, positioned after `this.llmOpenRouterQueue`:

```ts
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      this.llmGroqQueue,
      this.llmOpenRouterQueue,
      this.llmMistralQueue,
      strategyName,
    );
```

Remove both `// TODO(Task 8)` comments.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd backend && npx jest src/modules/strategy/strategy.service.spec.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "feat(backend): route llm-mistral dispatch through its own queue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Backend — wire Mistral into `LlmStrategyRunner` (the heuristic)

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `LLM_MISTRAL`, `llmMistralRateLimitFallbackSeconds`, `mistralPersistentRateLimitAttempts`, `mistralPersistentRateLimitElapsedMs`, `mistralModelHoldFallbackSeconds` (Task 4); `MistralRateLimitHoldService` (Task 5).
- Produces: an `llm-mistral` run parks (`StrategyRunStatus.RATE_LIMITED_DAILY`) + writes a `MistralRateLimitHold` row when either (a) the orchestrator returns `rate_limited_daily` (body-classified monthly), or (b) `mistralPersistentRateLimitAttempts()` consecutive `rate_limited` outcomes occur, or (c) the streak's wall-clock span reaches `mistralPersistentRateLimitElapsedMs()`. Fewer than the threshold → the existing wait-and-retry, no failure recorded. A held model parks at the top gate with zero orchestrator calls. Streak resets on any successful call.

- [ ] **Step 1: Write the failing tests**

In `llm-strategy-runner.service.spec.ts`, find the existing Groq/OpenRouter `rate_limited_daily` describe block and add an `llm-mistral` sibling block. Use the same harness the neighbouring tests use (mocked `orchestratorService.solveAssist`, `store`, hold services). Add a mock `mistralRpdHold = { isHeld: jest.fn().mockResolvedValue(false), hold: jest.fn().mockResolvedValue(undefined) }` to the providers, mirroring `groqRpdHold`.

```ts
describe("llm-mistral persistent rate-limit heuristic", () => {
  const MODEL = "mistral-small-latest";

  it("below the attempt threshold: waits and retries, no failure, no hold", async () => {
    // solveAssist returns a rate_limited outcome twice, then a normal solved reply
    orchestratorService.solveAssist
      .mockResolvedValueOnce(rateLimitedOutcome())      // helper: { error: { code: "rate_limited", retryAfterSeconds: 5 } }
      .mockResolvedValueOnce(rateLimitedOutcome())
      .mockResolvedValue(solvedOutcome());              // helper the file already has for a good reply
    // MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS default is 4, so 2 hits stay under it
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(mistralRpdHold.hold).not.toHaveBeenCalled();
    expect(res.status).not.toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
  });

  it("reaching the attempt threshold parks the model and writes a hold", async () => {
    orchestratorService.solveAssist.mockResolvedValue(rateLimitedOutcome());
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(res.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
    expect(mistralRpdHold.hold).toHaveBeenCalledWith(
      "llm-mistral", MODEL, DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
    );
  });

  it("an orchestrator rate_limited_daily parks on the first hit, no streak needed", async () => {
    orchestratorService.solveAssist.mockResolvedValue(
      { error: { code: "rate_limited_daily" } },  // shape used by the existing groq daily test
    );
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(res.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
    expect(mistralRpdHold.hold).toHaveBeenCalledTimes(1);
  });

  it("a successful call resets the streak", async () => {
    orchestratorService.solveAssist
      .mockResolvedValueOnce(rateLimitedOutcome())
      .mockResolvedValueOnce(rateLimitedOutcome())
      .mockResolvedValueOnce(rateLimitedOutcome())
      .mockResolvedValueOnce(solvedOutcome())        // resets streak to 0
      .mockResolvedValue(rateLimitedOutcome());      // a lone later hit — must NOT trip
    // give the run enough successful steps to finish; assert no park + no hold
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(mistralRpdHold.hold).not.toHaveBeenCalled();
  });

  it("top gate: a held model parks with zero orchestrator calls", async () => {
    mistralRpdHold.isHeld.mockResolvedValue(true);
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(res.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);
    expect(orchestratorService.solveAssist).not.toHaveBeenCalled();
  });

  it("never ends as ERROR no matter how many 429s", async () => {
    orchestratorService.solveAssist.mockResolvedValue(rateLimitedOutcome());
    const res = await runner.runLlmStrategy(puzzleId, "llm-mistral", 0, MODEL);
    expect(res.status).not.toBe(StrategyRunStatus.ERROR);
  });
});
```

If `rateLimitedOutcome()` / `solvedOutcome()` helpers do not already exist in the spec, add small local factory functions matching the outcome shape the file's other tests build inline.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts -t mistral`
Expected: FAIL — no `mistralRpdHold` injected / no Mistral branch.

- [ ] **Step 3: Implement — imports and constructor**

Imports block:

```ts
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_OPENROUTER,
  LLM_MISTRAL,
  // …existing…
  llmOpenRouterRateLimitFallbackSeconds,
  llmMistralRateLimitFallbackSeconds,
  mistralPersistentRateLimitAttempts,
  mistralPersistentRateLimitElapsedMs,
  mistralModelHoldFallbackSeconds,
  openRouterDispatchRpmCooldownSeconds,
  llmTemperature,
} from "../../strategies";
```

```ts
import { MistralRateLimitHoldService } from "./mistral-rate-limit-hold.service";
```

Constructor — add after `openRouterHold`:

```ts
    @Inject(MistralRateLimitHoldService)
    private readonly mistralRpdHold: MistralRateLimitHoldService,
```

- [ ] **Step 4: Implement — provider ternary + state + fallback-seconds**

Provider resolution (line ~187):

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
              : strategyName === LLM_MISTRAL
                ? "mistral"
                : "openai";
```

`LlmRunLoopState` interface — add two fields (next to `rateLimitWaitMs`):

```ts
  // Mistral only: consecutive "rate_limited" outcomes for this run and the
  // wall-clock instant the streak began. classifyFailedCall escalates a
  // persistent streak into a per-model park (Mistral sends no rate-limit
  // headers, so a monthly-cap 429 and a per-minute blip are otherwise
  // indistinguishable). Reset to 0 / null on any successful call.
  rateLimitStreak: number;
  rateLimitStreakStartedAt: number | null;
```

`state` object literal (line ~271) — add:

```ts
      rateLimitStreak: 0,
      rateLimitStreakStartedAt: null,
```

`rateLimitFallbackSeconds` resolution (line ~290):

```ts
    const rateLimitFallbackSeconds =
      strategyName === LLM_GROQ
        ? llmGroqRateLimitFallbackSeconds()
        : strategyName === LLM_OPENROUTER
          ? llmOpenRouterRateLimitFallbackSeconds()
          : strategyName === LLM_MISTRAL
            ? llmMistralRateLimitFallbackSeconds()
            : llmGoogleRateLimitFallbackSeconds();
```

- [ ] **Step 5: Implement — top gate**

The per-model `rpdHoldService` ternary (line ~222):

```ts
    const rpdHoldService =
      strategyName === LLM_GOOGLE
        ? this.rpdHold
        : strategyName === LLM_GROQ
          ? this.groqRpdHold
          : strategyName === LLM_MISTRAL
            ? this.mistralRpdHold
            : null;
```

(The existing `if (rpdHoldService && model && (await rpdHoldService.isHeld(strategyName, model)))` block then covers Mistral unchanged, as does the "past the gate with a parked status → normalise to RUNNING" block.)

- [ ] **Step 6: Implement — `classifyFailedCall` gains `provider`, Mistral streak logic**

Change the signature and call site.

Call site (line ~433):

```ts
        this.classifyFailedCall(
          outcome.error.code,
          provider,
          run,
          state,
          maxModelErrors,
          maxDuplicates,
          maxMalformed,
          rateLimitFallbackSeconds,
          outcome.error.retryAfterSeconds,
        );
```

Signature + body (line ~717) — add `provider` as the 2nd param and extend the `rate_limited` branch:

```ts
  private classifyFailedCall(
    code: SolveErrorCode,
    provider: "openai" | "ollama" | "google" | "groq" | "openrouter" | "mistral",
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
      if (provider === "mistral") {
        // Mistral sends no rate-limit headers: escalate a *persistent* streak
        // of per-minute 429s into a park (it is very likely the monthly wall,
        // which retrying in place cannot clear). Below the threshold, it's the
        // ordinary wait-and-retry.
        state.rateLimitStreak += 1;
        if (state.rateLimitStreakStartedAt === null) {
          state.rateLimitStreakStartedAt = Date.now();
        }
        const spanMs = Date.now() - state.rateLimitStreakStartedAt;
        if (
          state.rateLimitStreak >= mistralPersistentRateLimitAttempts() ||
          spanMs >= mistralPersistentRateLimitElapsedMs()
        ) {
          run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
          run.finishedAt = new Date();
          return;
        }
      }
      state.rateLimitWaitMs = (retryAfterSeconds ?? rateLimitFallbackSeconds) * 1000;
    } else if (code === "model_error") {
      // …unchanged…
```

> Do not reset the streak in the `model_error` / `duplicate_group` / malformed branches — a 429 streak interleaved with unrelated transient errors is still a 429 streak.

- [ ] **Step 7: Implement — reset the streak on a successful call**

Find where a successful `solveAssist` reply is handled (the branch that calls `this.evaluateProposals(...)`, around line ~400). Immediately before `evaluateProposals` is invoked, add:

```ts
        // A good reply clears any Mistral rate-limit streak so a later lone
        // 429 does not inherit an old count and trip the park early.
        state.rateLimitStreak = 0;
        state.rateLimitStreakStartedAt = null;
```

- [ ] **Step 8: Implement — write the hold**

In `runLlmStrategy`'s failed-call block (line ~444), after the existing Google/Groq/OpenRouter `rate_limited_daily` handling and the OpenRouter `rate_limited` cooldown block, add:

```ts
        // Mistral: the park may come from the orchestrator (body said monthly)
        // *or* from classifyFailedCall's streak heuristic converting a
        // rate_limited — both leave run.status === RATE_LIMITED_DAILY, so one
        // check covers both. A short fixed fallback hold (the resume sweep
        // re-checks it).
        if (
          strategyName === LLM_MISTRAL &&
          run.status === StrategyRunStatus.RATE_LIMITED_DAILY &&
          model
        ) {
          await this.mistralRpdHold.hold(strategyName, model, mistralModelHoldFallbackSeconds());
        }
```

> Order matters: this must run *after* `classifyFailedCall` (so the heuristic has already flipped `run.status`) and its `await` is fine here — the block is already `async`.

- [ ] **Step 9: Run the tests, verify they pass**

Run: `cd backend && npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts`
Expected: PASS (full file — confirm no Google/Groq/OpenRouter regression).

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat(backend): park llm-mistral runs on a persistent 429 streak or a body-classified monthly 429

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Backend — `MistralDispatchState` entity and `MistralFreeDispatchService`

**Files:**
- Create: `backend/src/modules/mistral-free-dispatch/entities/mistral-dispatch-state.entity.ts`
- Create: `backend/src/modules/mistral-free-dispatch/mistral-free-dispatch.service.ts`
- Create: `backend/src/modules/mistral-free-dispatch/mistral-free-dispatch.service.spec.ts`
- Create: `backend/src/modules/mistral-free-dispatch/mistral-free-dispatch.module.ts`
- Modify: `backend/src/app.module.ts`, `backend/src/data-source.ts`

**Interfaces:**
- Consumes: `LLM_MISTRAL`, `freeTierDispatchMaxBatch`, `freeTierDispatchMaxInFlight`, `freeTierDispatchTickMs` (existing); `MISTRAL_FREE_DISPATCH_QUEUE` (Task 7); `MistralRateLimitHoldService` (Task 5); `StrategyService`, `SupportedModelService` (existing).
- Produces: `MistralFreeDispatchService` with `start(): Promise<{ status: MistralDispatchStatusDto; outcome: "started" | "alreadyExhausted" }>`, `stop(): Promise<MistralDispatchStatusDto>`, `getStatus(): Promise<MistralDispatchStatusDto>` (`{ active: boolean; startedAt: Date | null }`), `runTick(): Promise<void>`. Entity `MistralDispatchState` (`id: varchar` PK always `"mistral"`, `active: boolean`, `startedAt: timestamptz | null`, `updatedAt`).

- [ ] **Step 1: Create the entity**

Copy `backend/src/modules/groq-free-dispatch/entities/groq-dispatch-state.entity.ts` to `mistral-free-dispatch/entities/mistral-dispatch-state.entity.ts`: class `GroqDispatchState` → `MistralDispatchState`, `@Entity("GroqDispatchState")` → `@Entity("MistralDispatchState")`, comment `Groq` → `Mistral`.

Register it: `app.module.ts` and `data-source.ts` — import and add `MistralDispatchState` to the `entities: [...]` arrays (next to `OpenRouterDispatchState`).

- [ ] **Step 2: Write the failing spec**

Copy `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.spec.ts` to `mistral-free-dispatch/mistral-free-dispatch.service.spec.ts`. Substitute across the file: `Groq` → `Mistral`, `groq` → `mistral`, `GROQ_FREE_DISPATCH_QUEUE` → `MISTRAL_FREE_DISPATCH_QUEUE`, `LLM_GROQ` → `LLM_MISTRAL`, `"groq"` state id → `"mistral"`, sample model names → `"mistral-small-latest"` / `"ministral-8b-latest"` / `"mistral-medium-latest"`. Behavioural cases carry over verbatim: already-exhausted no-op when no models or every model held; the dispatch loop dispatches up to the batch cap across least-allocated eligible models; stops when every eligible model runs out of unrun puzzles; honours `FREE_TIER_DISPATCH_MAX_IN_FLIGHT`.

- [ ] **Step 3: Run the spec, verify it fails**

Run: `cd backend && npx jest src/modules/mistral-free-dispatch/mistral-free-dispatch.service.spec.ts`
Expected: FAIL — service not found.

- [ ] **Step 4: Implement the service**

Copy `backend/src/modules/groq-free-dispatch/groq-free-dispatch.service.ts` to `mistral-free-dispatch/mistral-free-dispatch.service.ts`. Substitutions:
- `GROQ_FREE_DISPATCH_QUEUE` → `MISTRAL_FREE_DISPATCH_QUEUE` (import + `@Inject`)
- `GroqDispatchState` → `MistralDispatchState` (import + `@InjectRepository` + `Repository<…>`)
- `GroqRateLimitHoldService` → `MistralRateLimitHoldService` (import + `@Inject` + field type)
- `LLM_GROQ` → `LLM_MISTRAL`
- class `GroqFreeDispatchService` → `MistralFreeDispatchService`; interface `GroqDispatchStatusDto` → `MistralDispatchStatusDto`
- `const GROQ_DISPATCH_STATE_ID = "groq";` → `const MISTRAL_DISPATCH_STATE_ID = "mistral";` (and every use)
- `freshTickJobId()` prefix `groq-free-dispatch-` → `mistral-free-dispatch-`
- log message prefixes `groq free-tier dispatch` → `mistral free-tier dispatch`
- the static `leastAllocatedModel` and all `FREE_TIER_DISPATCH_*` usage: unchanged
- doc comment: "The Mistral counterpart to GroqFreeDispatchService — identical shape. Mistral's free tier exposes no usage counter, so like Groq the stop condition is simply 'every configured model held or out of unrun puzzles'; there is no token/call budget. Concurrency=1 (LLM_MISTRAL_CONCURRENCY) plus the shared FREE_TIER_DISPATCH_* pacing keeps request volume under Mistral's global 1 req/sec ceiling. See docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §5."

- [ ] **Step 5: Create the module**

Copy `backend/src/modules/groq-free-dispatch/groq-free-dispatch.module.ts` to `mistral-free-dispatch/mistral-free-dispatch.module.ts`: `GroqDispatchState` → `MistralDispatchState`, `GroqFreeDispatchService` → `MistralFreeDispatchService`, class `GroqFreeDispatchModule` → `MistralFreeDispatchModule`.

- [ ] **Step 6: Run the spec, verify it passes**

Run: `cd backend && npx jest src/modules/mistral-free-dispatch/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/mistral-free-dispatch/ backend/src/app.module.ts backend/src/data-source.ts
git commit -m "feat(backend): add MistralFreeDispatchService (dispatch until every model held)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 11: Backend — `MistralRpdResumeService` and bootstrap

**Files:**
- Create: `backend/src/modules/strategy/mistral-rpd-resume.service.ts`
- Create: `backend/src/modules/strategy/mistral-rpd-resume.service.spec.ts`
- Create: `backend/src/modules/strategy/mistral-rpd-resume.bootstrap.ts`
- Create: `backend/src/modules/strategy/mistral-rpd-resume.bootstrap.spec.ts`
- Modify: `backend/src/modules/strategy/strategy.module.ts`

**Interfaces:**
- Consumes: `MISTRAL_RPD_RESUME_QUEUE`, `LLM_MISTRAL_QUEUE` (Task 7); `LLM_MISTRAL` (Task 4); `MistralRateLimitHoldService` (Task 5); `runStrategyJobId` (existing).
- Produces: `MistralRpdResumeService.runResume(triggerJobId: string): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }>`. `MistralRpdResumeBootstrap` (`OnApplicationBootstrap`) — enqueues one startup catch-up `resume-mistral-rpd` job (skipped under `NODE_ENV=test`); no fixed cron.

- [ ] **Step 1: Write the failing spec**

Copy `backend/src/modules/strategy/groq-rpd-resume.service.spec.ts` to `mistral-rpd-resume.service.spec.ts`. Substitute: `Groq` → `Mistral`, `GROQ_RPD_RESUME_QUEUE` → `MISTRAL_RPD_RESUME_QUEUE`, `LLM_GROQ_QUEUE` → `LLM_MISTRAL_QUEUE`, `LLM_GROQ` → `LLM_MISTRAL`, sample models → `"mistral-small-latest"` / `"ministral-8b-latest"`. The behavioural cases carry over verbatim: only runs whose model's hold has expired are re-dispatched; a still-held model's runs are skipped; `rearm()` schedules the next sweep at the soonest live `resetAt` (clamped to `REARM_MAX_DELAY_MS`); a retried sweep reuses the trigger job id as the re-dispatch stamp so enqueues collapse; distinct triggering jobs produce distinct stamps.

Also copy `groq-rpd-resume.bootstrap.spec.ts` to `mistral-rpd-resume.bootstrap.spec.ts` with the same substitutions (asserts: under `NODE_ENV=test` nothing is enqueued; otherwise exactly one `resume-mistral-rpd` job with a `mistral-rpd-resume-startup-catch-up-<date>` job id).

- [ ] **Step 2: Run the specs, verify they fail**

Run: `cd backend && npx jest src/modules/strategy/mistral-rpd-resume`
Expected: FAIL — service/bootstrap not found.

- [ ] **Step 3: Implement the service**

Copy `backend/src/modules/strategy/groq-rpd-resume.service.ts` to `mistral-rpd-resume.service.ts`. Substitutions:
- `GROQ_RPD_RESUME_QUEUE` → `MISTRAL_RPD_RESUME_QUEUE`; `LLM_GROQ_QUEUE` → `LLM_MISTRAL_QUEUE` (imports + `@Inject` + field names `llmGroqQueue` → `llmMistralQueue`, `resumeQueue` unchanged)
- `GroqRateLimitHoldService` → `MistralRateLimitHoldService`
- `LLM_GROQ` → `LLM_MISTRAL`
- class `GroqRpdResumeService` → `MistralRpdResumeService`
- BullMQ job names: `"resume-groq-rpd"` → `"resume-mistral-rpd"`; rearm job id prefix `groq-rpd-resume-rearm-` → `mistral-rpd-resume-rearm-`
- `REARM_MAX_DELAY_MS` constant: keep `15 * 60_000`
- doc comment: "The Mistral counterpart to GroqRpdResumeService — identical shape. A Mistral hold has a short fixed resetAt (MISTRAL_MODEL_HOLD_FALLBACK_SECONDS), no shared clock boundary, so — like Groq — rearm() self-scheduling at the soonest live resetAt is the sole ongoing mechanism; MistralRpdResumeBootstrap only enqueues one startup catch-up. See docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §6."
- method bodies unchanged.

- [ ] **Step 4: Implement the bootstrap**

Copy `backend/src/modules/strategy/groq-rpd-resume.bootstrap.ts` to `mistral-rpd-resume.bootstrap.ts`. Substitutions:
- `GROQ_RPD_RESUME_QUEUE` → `MISTRAL_RPD_RESUME_QUEUE`
- class `GroqRpdResumeBootstrap` → `MistralRpdResumeBootstrap`
- job name `"resume-groq-rpd"` → `"resume-mistral-rpd"`; job id prefix `groq-rpd-resume-startup-catch-up-` → `mistral-rpd-resume-startup-catch-up-`
- log message `groq-rpd-resume` → `mistral-rpd-resume`
- doc comment `Groq` → `Mistral`.

- [ ] **Step 5: Register both**

`backend/src/modules/strategy/strategy.module.ts`: import `MistralRpdResumeService` and `MistralRpdResumeBootstrap`; add both to `providers`; add `MistralRpdResumeService` to `exports` (the bootstrap is not exported, matching Groq).

- [ ] **Step 6: Run the specs, verify they pass**

Run: `cd backend && npx jest src/modules/strategy/mistral-rpd-resume`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/mistral-rpd-resume.service.ts backend/src/modules/strategy/mistral-rpd-resume.service.spec.ts backend/src/modules/strategy/mistral-rpd-resume.bootstrap.ts backend/src/modules/strategy/mistral-rpd-resume.bootstrap.spec.ts backend/src/modules/strategy/strategy.module.ts
git commit -m "feat(backend): add MistralRpdResumeService with a self-rescheduling rearm chain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 12: Backend — run the three new Mistral queues in the worker

**Files:**
- Modify: `backend/src/worker.ts`
- Modify: `backend/src/app.setup.ts` (Bull Board registration)

**Interfaces:**
- Consumes: `MistralFreeDispatchService` (Task 10), `MistralRpdResumeService` (Task 11), `LLM_MISTRAL`, `llmMistralConcurrency` (Task 4).
- Produces: the worker process consumes `llm-mistral-runs`, `mistral-free-dispatch`, `mistral-rpd-resume` when `role !== "ollama"` (and `llm-mistral-runs` also excluded from `role === "ollama"`, same as the other cloud providers). Bull Board shows all three.

- [ ] **Step 1: Manual verification setup (no unit test)**

`worker.ts` has no unit test. Verification is: `npx tsc --noEmit` passes, and the boot log line lists the three new queues. Add the code, then run the checks in Step 4.

- [ ] **Step 2: Implement `worker.ts`**

Imports:

```ts
import { MistralFreeDispatchService } from "./modules/mistral-free-dispatch/mistral-free-dispatch.service";
import { MistralRpdResumeService } from "./modules/strategy/mistral-rpd-resume.service";
```

Add to the `strategies` import list: `LLM_MISTRAL,`, `llmMistralConcurrency,`.

After `const groqRpdResumeService = appContext.get(GroqRpdResumeService);` (and the OpenRouter siblings):

```ts
  const mistralFreeDispatchService = appContext.get(MistralFreeDispatchService);
  const mistralRpdResumeService = appContext.get(MistralRpdResumeService);
```

`createLlmWorker`'s `queueName` union — add `| "llm-mistral-runs"`.

In the `if (role !== "ollama")` block, after the `llmOpenRouterWorker` block:

```ts
    const llmMistralWorker = createLlmWorker(
      "llm-mistral-runs",
      LLM_MISTRAL,
      llmMistralConcurrency(),
    );
    activeWorkers.push(llmMistralWorker);
    activeQueueNames.push("llm-mistral-runs");
```

After the `openRouterFreeDispatchWorker` block:

```ts
    // Each job is one tick of the Mistral free-dispatch cycle (see
    // MistralFreeDispatchService) — same self-chaining shape as the
    // Groq/Google/OpenRouter dispatch workers above.
    const mistralFreeDispatchWorker = new Worker(
      "mistral-free-dispatch",
      async (job: Job) => {
        logger.log(`starting mistral free-tier dispatch tick ${job.id}`);
        await mistralFreeDispatchService.runTick();
        logger.log(`finished mistral free-tier dispatch tick ${job.id}`);
      },
      { connection: redisConnection, concurrency: 1 },
    );
    mistralFreeDispatchWorker.on("failed", (job, err) => {
      logger.error(`mistral free-tier dispatch tick ${job?.id} failed`, err?.stack || err);
    });
    activeWorkers.push(mistralFreeDispatchWorker);
    activeQueueNames.push("mistral-free-dispatch");
```

After the `openRouterRpdResumeWorker` block:

```ts
    const mistralRpdResumeWorker = new Worker(
      "mistral-rpd-resume",
      async (job) => {
        logger.log(`starting mistral-rpd resume sweep ${job.id}`);
        const result = await mistralRpdResumeService.runResume(job.id ?? String(job.timestamp));
        logger.log(`finished mistral-rpd resume sweep ${job.id}: ${JSON.stringify(result)}`);
        return result;
      },
      { connection: redisConnection, concurrency: 1 },
    );
    mistralRpdResumeWorker.on("failed", (job, err) => {
      logger.error(`mistral-rpd resume sweep ${job?.id} failed`, err?.stack || err);
    });
    activeWorkers.push(mistralRpdResumeWorker);
    activeQueueNames.push("mistral-rpd-resume");
```

- [ ] **Step 3: Implement Bull Board registration**

In `backend/src/app.setup.ts` (search for `groq-free-dispatch` / `llm-groq-runs` / `BullMQAdapter`), add `llm-mistral-runs`, `mistral-free-dispatch`, and `mistral-rpd-resume` to the board's queue list in the same pattern as the Groq/OpenRouter entries (import the three queue instances from their queue files, wrap each in `new BullMQAdapter(...)`).

- [ ] **Step 4: Verify**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

Run: `cd backend && npx jest` (full suite — confirms nothing regressed from the runner/queue/module wiring).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/worker.ts backend/src/app.setup.ts
git commit -m "feat(backend): run the three Mistral queues in the worker process

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 13: Backend — `mistralBurn` leg in the daily-automation chain

**Files:**
- Modify: `backend/src/modules/automation/entities/automation-run-log.entity.ts`
- Create: `backend/src/migrations/1794000000000-add-automation-mistral-leg.ts`
- Modify: `backend/src/modules/automation/daily-automation.service.ts`
- Modify: `backend/src/modules/automation/daily-automation.service.spec.ts`
- Modify: `backend/src/modules/automation/automation.controller.ts`
- Modify: `backend/src/modules/automation/automation.module.ts`

**Interfaces:**
- Consumes: `MistralFreeDispatchService` (Task 10), `MistralFreeDispatchModule` (Task 10).
- Produces: `AutomationRunLog` gains `mistralBurnOutcome: AutomationLegOutcome | null` + `mistralBurnMessage: string | null`. `DailyAutomationService.run()` fires `runMistralBurnLeg` after `runOpenRouterBurnLeg`. `GET /automation/status` returns a `mistralBurn: { outcome, message }` block.

- [ ] **Step 1: Entity columns**

In `automation-run-log.entity.ts`, after `openRouterBurnMessage`:

```ts
  @Column({ type: "varchar", nullable: true })
  mistralBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  mistralBurnMessage: string | null;
```

- [ ] **Step 2: Migration**

Copy `backend/src/migrations/1784000000000-add-automation-groq-leg.ts` to `1794000000000-add-automation-mistral-leg.ts`: class `AddAutomationGroqLeg1784000000000` → `AddAutomationMistralLeg1794000000000`, `name` likewise, columns `groqBurnOutcome`/`groqBurnMessage` → `mistralBurnOutcome`/`mistralBurnMessage` in both `up` and `down`, comment `Groq` → `Mistral`.

- [ ] **Step 3: Write the failing test**

In `daily-automation.service.spec.ts`, find the leg-independence test (search `groqBurn`). Add a mocked `MistralFreeDispatchService` provider (`{ getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }), start: jest.fn().mockResolvedValue({ outcome: "started" }) }`) and extend the assertions:

```ts
it("records the mistralBurn leg outcome and it does not block the other legs", async () => {
  mistralFreeDispatchService.start.mockResolvedValue({ outcome: "started" });
  await service.run({ skipJudgeLeg: false });
  expect(runLogRepo.update).toHaveBeenCalledWith(
    { date: expect.any(String) },
    expect.objectContaining({ mistralBurnOutcome: "started", mistralBurnMessage: "started" }),
  );
});

it("a mistralBurn failure is caught and recorded, other legs still run", async () => {
  mistralFreeDispatchService.start.mockRejectedValue(new Error("boom"));
  await service.run({ skipJudgeLeg: false });
  expect(runLogRepo.update).toHaveBeenCalledWith(
    { date: expect.any(String) },
    expect.objectContaining({ mistralBurnOutcome: "error", mistralBurnMessage: "boom" }),
  );
  // an assertion that openRouterBurn / groqBurn still recorded — copy the neighbouring test's shape
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `cd backend && npx jest src/modules/automation/daily-automation.service.spec.ts -t mistral`
Expected: FAIL — no `mistralBurn` handling.

- [ ] **Step 5: Implement the service**

`daily-automation.service.ts`:
- Import `MistralFreeDispatchService`.
- Constructor: `@Inject(MistralFreeDispatchService) private readonly mistralFreeDispatchService: MistralFreeDispatchService,` after `openRouterFreeDispatchService`.
- In `run()`, after `await this.runOpenRouterBurnLeg(date);`: `await this.runMistralBurnLeg(date);`
- Add the method (copy `runGroqBurnLeg` verbatim, substituting `groq`→`mistral`, `Groq`→`Mistral`, `groqBurnOutcome`→`mistralBurnOutcome`, `groqBurnMessage`→`mistralBurnMessage`, and the `alreadyExhausted` message to `"every Mistral model is currently held"`):

```ts
  private async runMistralBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.mistralFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { mistralBurnOutcome: "alreadyActive", mistralBurnMessage: "already running" },
        );
        return;
      }
      const result = await this.mistralFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted"
          ? "every Mistral model is currently held"
          : "started";
      await this.runLogRepo.update(
        { date },
        { mistralBurnOutcome: result.outcome, mistralBurnMessage: message },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Mistral burn";
      this.logger.error(`daily automation mistral-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { mistralBurnOutcome: "error", mistralBurnMessage: message },
      );
    }
  }
```
- Update the class doc comment's leg list: "Runs seven legs" and add "- mistralBurn: starts MistralFreeDispatchService's cycle, which runs until every Mistral model is held."

- [ ] **Step 6: Implement the controller**

`automation.controller.ts` `getStatus()` — after the `openRouterBurn` block:

```ts
      mistralBurn: {
        outcome: log?.mistralBurnOutcome ?? null,
        message: log?.mistralBurnMessage ?? null,
      },
```

- [ ] **Step 7: Wire the module**

`automation.module.ts`: import `MistralFreeDispatchModule` from `../mistral-free-dispatch/mistral-free-dispatch.module` and add it to `imports` (next to `OpenRouterFreeDispatchModule`).

- [ ] **Step 8: Run the tests, verify they pass**

Run: `cd backend && npx jest src/modules/automation/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/automation/ backend/src/migrations/1794000000000-add-automation-mistral-leg.ts
git commit -m "feat(backend): add the mistralBurn leg to the daily-automation chain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 14: Backend — `/dispatch/mistral` status/stop endpoints + confirm model ids/slugs

**Files:**
- Modify: `backend/src/modules/dispatch/dispatch.controller.ts`
- Modify: `backend/src/modules/dispatch/dispatch.module.ts`
- Modify (if present): `backend/src/modules/dispatch/dispatch.controller.spec.ts`
- Research output feeds Task 15's seed migration.

**Interfaces:**
- Consumes: `MistralFreeDispatchService` (Task 10).
- Produces: `GET /dispatch/mistral` → `MistralDispatchStatusDto`; `DELETE /dispatch/mistral` → `MistralDispatchStatusDto`. No `POST`.

- [ ] **Step 1: Confirm the `@ai-sdk/mistral` API**

Read `orchestrator/node_modules/@ai-sdk/mistral/dist/index.d.ts`. Confirm: the factory export name (`createMistral`), whether the returned provider is directly callable with a model id or needs `.chat(id)` / `.languageModel(id)`, and the `apiKey` option name. If Task 1's `getModel` branch guessed wrong, fix it now in `orchestrator/src/provider.ts` and re-run `npx vitest run src/provider.test.ts`. Commit any fix as `fix(orchestrator): correct @ai-sdk/mistral factory call`.

- [ ] **Step 2: Confirm the Mistral La Plateforme model ids**

`curl -s https://api.mistral.ai/v1/models -H "Authorization: Bearer $MISTRAL_API_KEY" | jq '.data[].id'` (or read the current models page at `https://docs.mistral.ai/getting-started/models/models_overview/`). Confirm the exact ids for: a small general model, ministral 8B, ministral 3B, and a mid model. Prefer `-latest` aliases if they exist; otherwise use the current dated ids. Record the four chosen ids.

- [ ] **Step 3: Confirm the OpenRouter slugs**

For each chosen model, find the matching OpenRouter catalog row:
`curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select(.id|startswith("mistralai/")) | "\(.id)\t\(.context_length)\t\(.supported_parameters|join(","))"'`
Pick the slug whose `supported_parameters` includes `response_format` (and ideally `structured_outputs`). The spec's starting table:

| Mistral id (confirm) | OpenRouter slug (confirm) |
|---|---|
| `mistral-small-latest` | `mistralai/mistral-small-3.2-24b-instruct` |
| `ministral-8b-latest` | `mistralai/ministral-8b-2512` |
| `ministral-3b-latest` | `mistralai/ministral-3b-2512` |
| `mistral-medium-latest` | `mistralai/mistral-medium-3.1` |

If a slug's row shows no `response_format`, pick the nearest Mistral slug that has it, or mark that model `supported = false` in Task 15 (note it in the migration comment). Record the final four `(modelName, openRouterSlug)` pairs for Task 15.

- [ ] **Step 4: Capture real 429 bodies (best effort)**

If the dev Mistral account can be driven to a 429 (hammer 1 RPS), capture the response body + headers for a per-minute hit. A monthly-cap 429 is unlikely to be reproducible on demand — note that `mistralMonthlyRateLimitFromBody`'s wording list (Task 2) is a best guess to be tuned when a real monthly 429 is first observed in production. If the captured per-minute body uses a differently-cased `Retry-After` header key, adjust the Task 2 branch to lowercase header keys first. Commit any adjustment as `fix(orchestrator): match Mistral 429 header casing`.

- [ ] **Step 5: Write the failing test (endpoints)**

If `dispatch.controller.spec.ts` exists, add (mirroring the `groq` cases):

```ts
it("GET /dispatch/mistral returns the dispatch status", async () => {
  mistralFreeDispatchService.getStatus.mockResolvedValue({ active: true, startedAt: new Date() });
  expect(await controller.getMistralDispatchStatus()).toEqual(
    expect.objectContaining({ active: true }),
  );
});

it("DELETE /dispatch/mistral stops the cycle", async () => {
  await controller.stopMistralDispatch();
  expect(mistralFreeDispatchService.stop).toHaveBeenCalled();
});
```

Add the mocked `MistralFreeDispatchService` provider to the test module. If there is no controller spec, skip to Step 7 and verify via `tsc` + the e2e/full suite.

- [ ] **Step 6: Run it, verify it fails**

Run: `cd backend && npx jest src/modules/dispatch/`
Expected: FAIL — methods not defined.

- [ ] **Step 7: Implement**

`dispatch.controller.ts`:
- Import `MistralFreeDispatchService`.
- Constructor: `@Inject(MistralFreeDispatchService) private readonly mistralFreeDispatchService: MistralFreeDispatchService,` after `openRouterFreeDispatchService`.
- After the `@Delete("openrouter")` handler:

```ts
  // Read-only Mistral free-dispatch status — see MistralFreeDispatchService.
  // Same shape as the Groq route: no token threshold, Mistral's constraints
  // (1 req/sec, per-pool TPM, per-pool monthly tokens) are enforced by
  // Mistral itself and surfaced only as 429s.
  @Get("mistral")
  async getMistralDispatchStatus() {
    return this.mistralFreeDispatchService.getStatus();
  }

  // Deactivates the Mistral free-dispatch cycle so it stops scheduling ticks.
  @Delete("mistral")
  async stopMistralDispatch() {
    return this.mistralFreeDispatchService.stop();
  }
```

`dispatch.module.ts`: import `MistralFreeDispatchModule` and add it to `imports`.

- [ ] **Step 8: Run the tests, verify they pass**

Run: `cd backend && npx jest src/modules/dispatch/ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/dispatch/
git commit -m "feat(backend): add GET/DELETE /dispatch/mistral

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 15: Backend — seed the Mistral models + migration round-trip

**Files:**
- Create: `backend/src/migrations/1795000000000-add-mistral-models.ts`

**Interfaces:**
- Consumes: the four confirmed `(modelName, openRouterSlug)` pairs from Task 14.
- Produces: four `SupportedModel` rows for `strategyName = 'llm-mistral'`.

- [ ] **Step 1: Create the seed migration**

Copy `backend/src/migrations/1781000000000-add-groq-models.ts` to `1795000000000-add-mistral-models.ts`. Class `AddMistralModels1795000000000`, `name` likewise. Use the Task 14 pairs (this example shows the spec's starting values — replace with the confirmed ones):

```ts
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-mistral', 'mistral-small-latest',  true, 'mistralai/mistral-small-3.2-24b-instruct'),
        ('llm-mistral', 'ministral-8b-latest',   true, 'mistralai/ministral-8b-2512'),
        ('llm-mistral', 'ministral-3b-latest',   true, 'mistralai/ministral-3b-2512'),
        ('llm-mistral', 'mistral-medium-latest', true, 'mistralai/mistral-medium-3.1')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-mistral'
        AND "modelName" IN ('mistral-small-latest', 'ministral-8b-latest', 'ministral-3b-latest', 'mistral-medium-latest')
    `);
  }
```

Doc comment: unlike Groq (where `openRouterSlug` was left NULL), the slugs here are set because they were confirmed live in Task 14 against `GET https://openrouter.ai/api/v1/models`; `modelName` is Mistral's own La Plateforme id, `openRouterSlug` is the separate OpenRouter-catalog mapping `ModelMetadataRefreshService` uses to backfill `contextWindow` / pricing / `releaseDate`. Note that `mistral-medium-latest` likely sits in a different Mistral free-tier pool than the small models — irrelevant to code because there is no budget accounting. Trigger `POST /dispatch/refresh-model-metadata` once applied so metadata is not blank until the next daily cron.

- [ ] **Step 2: Type-check**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Migration round-trip (manual, needs the dev DB)**

With the local stack up (`docker compose -p connections-dev up -d db`), from `backend/`:

```bash
npx typeorm migration:run -d dist/data-source.js      # or the project's documented migration command
# verify: psql -> \d "MistralRateLimitHold"  \d "MistralDispatchState"
#         SELECT * FROM "SupportedModel" WHERE "strategyName"='llm-mistral';   -> 4 rows
#         \d "AutomationRunLog"   -> mistralBurnOutcome / mistralBurnMessage present
npx typeorm migration:revert -d dist/data-source.js   # x4 — reverts 1795,1794,1793,1792 newest-first
# verify the four objects are gone
npx typeorm migration:run -d dist/data-source.js      # re-apply, confirm clean
```

Use whatever migration invocation the repo documents (check `backend/package.json` scripts / README). Expected: all three up/revert/up passes clean, no error.

- [ ] **Step 4: Commit**

```bash
git add backend/src/migrations/1795000000000-add-mistral-models.ts
git commit -m "feat(backend): seed four Mistral free-tier models for llm-mistral

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 16: Backend — config surface (`.env.sample`, `docker-compose.yml`, `README.md`)

**Files:**
- Modify: `.env.sample`
- Modify: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: `.env.sample`**

Next to `GROQ_API_KEY` / `OPENROUTER_API_KEY`:

```
# Mistral La Plateforme API key (used by @ai-sdk/mistral in the orchestrator)
MISTRAL_API_KEY=
```

In the `MODEL_PROVIDER` comment, add `'llm-mistral' Mistral La Plateforme` to the provider list and bump "All five providers" → "All six providers".

Next to `GROQ_MODEL` / `OPENROUTER_MODEL`:

```
# Mistral model id (used when MODEL_PROVIDER=mistral)
MISTRAL_MODEL=mistral-small-latest
```

After the OpenRouter `LLM_*` / dispatch block, a new section:

```
# --- Mistral (llm-mistral strategy) ---

# Worker concurrency for llm-mistral-runs (own queue; never blocks the other
# providers). Keep at 1 — this is the guard for Mistral's global 1 req/sec
# ceiling. (default: 1)
LLM_MISTRAL_CONCURRENCY=1

# Fallback wait (seconds) before retrying a Mistral per-minute (1 RPS / TPM)
# rate-limit hit — only used when the 429 carried no parseable retry-after
# header. A per-minute hit is never a run failure; it waits and retries.
# (default: 60)
LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS=60

# Mistral sends no rate-limit headers, so a monthly-cap 429 and a transient
# per-minute 429 look identical when the 429 body carries no monthly wording.
# The runner parks a model after this many consecutive per-minute 429s on one
# run... (default: 4)
MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS=4

# ...or once that streak has spanned this many wall-clock seconds, whichever
# trips first. (default: 300)
MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS=300

# How long a parked Mistral model stays held before the resume sweep
# re-checks it. Short and fixed: a real monthly wall just re-parks each cycle
# until the calendar month rolls; a misclassified TPM blip recovers within
# this window. (default: 21600 = 6h)
MISTRAL_MODEL_HOLD_FALLBACK_SECONDS=21600
```

- [ ] **Step 2: `docker-compose.yml`**

In the `orchestrator` service `environment:` block, next to `GROQ_API_KEY` / `GROQ_MODEL`:

```yaml
      MISTRAL_API_KEY: ${MISTRAL_API_KEY}
      MISTRAL_MODEL: ${MISTRAL_MODEL:-mistral-small-latest}
```

(The backend/worker services do not currently receive the per-provider `LLM_*` knobs in compose — they read defaults — so no backend/worker compose change is needed, matching Groq/OpenRouter.)

- [ ] **Step 3: `README.md`**

Find where Groq / OpenRouter are documented as providers (search `llm-groq`) and add an `llm-mistral` entry in the same style: the strategy name, that it uses `@ai-sdk/mistral`, its free-tier shape (1 req/sec global, per-pool TPM + monthly token caps, no rate-limit headers), and the env vars from Step 1.

- [ ] **Step 4: Verify**

Run: `cd backend && npx jest src/strategies.spec.ts` (env accessors already covered in Task 4 — this just confirms nothing drifted).
Expected: PASS. No other automated check for docs; eyeball the three files.

- [ ] **Step 5: Commit**

```bash
git add .env.sample docker-compose.yml README.md
git commit -m "docs(config): document the Mistral provider env surface

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 17: Frontend — `MistralDispatchWidget` and Activity page wiring

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Create: `frontend/src/components/benchmark/MistralDispatchWidget.tsx`
- Create: `frontend/src/components/benchmark/__tests__/MistralDispatchWidget.test.tsx`
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`
- Modify: `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`

**Interfaces:**
- Consumes: `GET /dispatch/mistral`, `DELETE /dispatch/mistral` (Task 14); `GET /automation/status` now returns `mistralBurn` (Task 13).
- Produces: `MistralDispatchStatus { active: boolean; startedAt: string | null }`; `AutomationStatus.mistralBurn: AutomationBurnLeg`; `fetchMistralDispatchStatus(signal?) → Promise<MistralDispatchStatus>`; `stopMistralDispatch(signal?) → Promise<MistralDispatchStatus>`; `<MistralDispatchWidget automation={…} />` on the Activity page.

- [ ] **Step 1: Write the failing widget test**

Copy `frontend/src/components/benchmark/__tests__/GroqDispatchWidget.test.tsx` to `MistralDispatchWidget.test.tsx`. Substitute `Groq` → `Mistral`, `groq` → `mistral`, `fetchGroqDispatchStatus` → `fetchMistralDispatchStatus`, `stopGroqDispatch` → `stopMistralDispatch`, title text `"Groq daily quota"` → `"Mistral free tier"`. Keep every behavioural assertion (loading state, active pill + Disable button, inactive text, error state, automation line render).

- [ ] **Step 2: Run it, verify it fails**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/MistralDispatchWidget.test.tsx`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement types**

`frontend/src/data/benchmark/types.ts`:
- After `GroqDispatchStatus`:

```ts
/** GET /dispatch/mistral — whether the Mistral free-dispatch cycle (see the
 * backend's MistralFreeDispatchService) is currently running. Same shape as
 * GroqDispatchStatus — no token threshold; Mistral's constraints (1 req/sec,
 * per-pool TPM, per-pool monthly tokens) are enforced by Mistral itself. */
export interface MistralDispatchStatus {
  active: boolean;
  startedAt: string | null;
}
```

- In `AutomationStatus`, add `mistralBurn: AutomationBurnLeg;` after `openRouterBurn`.
- Update the `AutomationBurnLeg` doc comment's provider list and the `AutomationStatus` doc comment's leg list to mention the Mistral burn leg.

- [ ] **Step 4: Implement api.ts**

After `stopGroqDispatch` (and the OpenRouter pair), add:

```ts
/** Whether the Mistral free-dispatch cycle is currently running — see
 * MistralDispatchStatus. Polled the same way fetchGroqDispatchStatus is. */
export function fetchMistralDispatchStatus(signal?: AbortSignal): Promise<MistralDispatchStatus> {
  return fetchJson("/dispatch/mistral", signal);
}

/** Stops the Mistral dispatch cycle — a no-op (not an error) if it wasn't
 * running. */
export function stopMistralDispatch(signal?: AbortSignal): Promise<MistralDispatchStatus> {
  return fetchJson("/dispatch/mistral", signal, { method: "DELETE" });
}
```

Add `MistralDispatchStatus` to the `types` import at the top of `api.ts`.

- [ ] **Step 5: Implement the widget**

Copy `frontend/src/components/benchmark/GroqDispatchWidget.tsx` to `MistralDispatchWidget.tsx`. Substitutions:
- `GroqDispatchStatus` → `MistralDispatchStatus`, `fetchGroqDispatchStatus` → `fetchMistralDispatchStatus`, `stopGroqDispatch` → `stopMistralDispatch`
- `GroqDispatchWidget` / `GroqDispatchWidgetProps` → `Mistral…`
- `const TITLE = "Groq daily quota";` → `const TITLE = "Mistral free tier";`
- every user-facing "Groq" string → "Mistral"
- `aria-label="Groq daily quota dispatch"` → `aria-label="Mistral free tier dispatch"`
- Keep the "no token budget → active/inactive only" doc comment, reworded for Mistral (per-pool TPM + monthly caps, enforced by Mistral).

- [ ] **Step 6: Wire the Activity page**

`frontend/src/pages/benchmark/ActivityPage.tsx`:
- Import `MistralDispatchWidget`.
- After the `openRouterBurnAutomation` block, add a `mistralBurnAutomation` block (copy `openRouterBurnAutomation` verbatim, `openRouterBurn` → `mistralBurn`).
- After `<OpenRouterDispatchWidget automation={openRouterBurnAutomation} />`, add `<MistralDispatchWidget automation={mistralBurnAutomation} />`.

- [ ] **Step 7: Update the ActivityPage test mock**

`frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`: in every `AutomationStatus` mock object (search `openRouterBurn:`), add `mistralBurn: { outcome: null, message: null },` (and in the one populated-status test around line 400, add a realistic `mistralBurn: { outcome: "alreadyExhausted", message: "every Mistral model is currently held" }`). Add any `fetchMistralDispatchStatus` mock alongside the existing `fetchGroqDispatchStatus` / `fetchOpenRouterDispatchStatus` mocks so the new widget's poll resolves.

- [ ] **Step 8: Run the tests, verify they pass**

Run: `cd frontend && npx vitest run src/components/benchmark/__tests__/MistralDispatchWidget.test.tsx src/pages/benchmark/__tests__/ActivityPage.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/data/benchmark/api.ts frontend/src/components/benchmark/MistralDispatchWidget.tsx frontend/src/components/benchmark/__tests__/MistralDispatchWidget.test.tsx frontend/src/pages/benchmark/ActivityPage.tsx frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx
git commit -m "feat(frontend): add MistralDispatchWidget to the Activity page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 18: Full-repo verification pass

**Files:** none (verification only).

- [ ] **Step 1: Backend**

Run: `cd backend && npx tsc --noEmit && npx jest && npx eslint "src/**/*.ts"`
Expected: all PASS.

- [ ] **Step 2: Orchestrator**

Run: `cd orchestrator && npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 3: Frontend**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 4: Boot the worker (smoke)**

With the local stack up, start the worker and confirm the log line lists `'llm-mistral-runs'`, `'mistral-free-dispatch'`, `'mistral-rpd-resume'` among its queues, and that `MistralRpdResumeBootstrap` logs the startup catch-up enqueue.

- [ ] **Step 5: End-to-end smoke (optional, needs a real MISTRAL_API_KEY)**

`POST` a single `llm-mistral` trial for one seeded model against a recent puzzle via the dispatch route the other providers use; confirm a `StrategyRun` completes (or, if the account is at its monthly cap, that it parks `RATE_LIMITED_DAILY` and a `MistralRateLimitHold` row appears rather than looping).

- [ ] **Step 6: Final commit (if any lint/type fixups were needed)**

```bash
git add -A
git commit -m "chore(mistral): verification-pass fixups

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §1 Provider (orchestrator) | 1 |
| §2a solver body-message check | 2 |
| §2b runner consecutive-429 heuristic | 9 |
| §3 `MistralRateLimitHold` entity + service | 5, 6 |
| §4 runner wiring (provider ternary, inject, top gate, fallback secs) | 9 |
| §5 `MistralFreeDispatchService` (+ state entity, no budget) | 10, 6 |
| §6 `MistralRpdResumeService` + bootstrap (self-rescheduling, no cron) | 11 |
| §7 config (`.env.sample`, `strategies.ts`, `docker-compose`, `README`) | 4, 16 |
| §7 queues + worker routing | 7, 8, 12 |
| §8 model seeding (+ URL audit note) | 14, 15 |
| §9 `mistralBurn` automation leg (+ entity col, migration, controller) | 13 |
| §10 frontend widget + Activity page + automation types | 17 |
| Testing §Orchestrator | 1, 2 |
| Testing §Backend | 4, 5, 9, 10, 11, 13 |
| Testing §Frontend | 17 |
| Testing §Migration round-trip | 15 |
| Testing §Entity registration on root connection | 5, 10 |
| Open Q: `@ai-sdk/mistral` API | 14 (Step 1) |
| Open Q: default 429 path vs full branch | 2 (Step 4 builds the full branch — no dependency on the default path) |
| Open Q: confirm model ids / slugs | 14 (Steps 2–3) |
| Open Q: `retry-after` presence / header casing | 14 (Step 4) |
| Open Q: heuristic default values | 4 (defaults set; tuning is post-merge ops) |
| Open Q: streak reset site | 9 (Step 7) |
| Open Q: gate the park to automated runs only | **Not implemented** — see note below |
| Open Q: `mistral-medium` `supported=false`? | 14 (Step 3 decides) / 15 (seed reflects it) |

**Note on "gate the park to automated runs only":** the spec flags this as an open question, not a requirement. This plan implements the un-gated version (any `llm-mistral` run's persistent 429 streak can write a 6h hold), matching how Groq/OpenRouter currently behave. If the reviewer wants it gated, that is a follow-up: thread an `isAutomated` flag from the dispatch path into `runLlmStrategy` and guard the Task 9 Step 8 hold write. Left out to keep parity with the existing providers and because manual `llm-mistral` trials are rare.

**2. Placeholder scan:** no "TBD"/"implement later". The two migration bodies that depend on Task 14's research (seed slugs) carry explicit confirmed-example values plus a "replace with confirmed" instruction — not placeholders, but flagged. `app.setup.ts` Bull Board edit (Task 12 Step 3) is described by pattern-match rather than exact line because that file was not read during planning; the executor should open it and follow the Groq/OpenRouter precedent there.

**3. Type consistency:**
- `mistralRpdHold` — the injected field name, used identically in Task 9 (runner) and the Task 9 spec.
- `MistralRateLimitHoldService` methods (`hold`/`isHeld`/`heldModels`/`nextResetAt`/`clearExpired`) — signatures fixed in Task 5, consumed unchanged in Tasks 9, 10, 11.
- `MistralDispatchStatusDto` = `{ active: boolean; startedAt: Date | null }` (Task 10) ↔ frontend `MistralDispatchStatus` = `{ active: boolean; startedAt: string | null }` (Task 17) — the `Date`→`string` shift is the normal JSON-serialisation boundary, same as every other provider.
- `queueForStrategy` 7-arg signature (Task 7) ↔ both `StrategyService` call sites updated (Task 8).
- `classifyFailedCall(code, provider, run, state, …)` — new 2nd param added in Task 9, call site in the same task.
- `mistralPersistentRateLimitElapsedMs()` returns **milliseconds** (Task 4) and is compared against `spanMs` (Task 9) — units match.
- Migration timestamps `1792`–`1795` are sequential and above the current max `1791`.
