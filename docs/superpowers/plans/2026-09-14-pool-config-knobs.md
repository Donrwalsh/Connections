# Pool Config Knobs (Architecture Candidate 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the ~26 hand-written per-provider env-accessor functions (and their ~26 `DEFAULT_*` constants) out of `backend/src/strategies.ts` into one small set of generic, tested env readers that `provider-pool.config.ts` calls inline — closing architecture candidate 4, the last item blocking GitHub issue #45's AI-guidance-docs audit.

**Architecture:** Add `backend/src/modules/provider-pool/pool-knobs.ts`, a tiny module of generic `intEnv` / `msEnvAsSeconds` / `secondsEnvAsMs` readers plus the handful of defaults that are genuinely per-shape rather than per-provider (most are shared, e.g. every rate-limit fallback defaults to 60s). `provider-pool.config.ts`'s `PROVIDER_POOLS` array calls these inline with each knob's literal env-var name instead of importing a named wrapper function per knob per provider. The `ProviderPool` / `FreeTierConfig` types and every other consumer of a pool row are untouched — only how each row's `NumberThunk` fields are constructed changes.

**Tech Stack:** NestJS/TypeScript backend, Jest.

**Spec:** `docs/architecture/04-pool-config-knobs.html` (the original proposal). This plan deviates from it in one place: the doc's ideal shape derives each env-var name by template (`` `LLM_${ID}_CONCURRENCY` ``); this plan keeps every env-var name as a literal string argument at its pool's row instead, because the real names are not uniformly templatable (e.g. `MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` has no `LLM_` prefix and isn't `DAILY_HOLD`-shaped; `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` has no per-ID pattern either). Literal names also sidestep the doc's own "hurts greppability" risk note.

## Global Constraints

- Every `NumberThunk` (`() => number`) field on `ProviderPool` / `FreeTierConfig` keeps its exact current call signature — zero arguments, reads live `process.env` internally. No call site outside `provider-pool.config.ts` changes.
- No BullMQ queue name, cron pattern, or env-var name changes. This is a pure internal-implementation refactor; behavior must be identical before and after.
- Run `cd backend && npx jest strategies.spec.ts provider-pool.config.spec.ts pool-knobs.spec.ts llm-strategy-runner.service.spec.ts` after every task; run the full backend suite (`cd backend && npm test`) at the end.

---

### Task 1: Add the generic `pool-knobs.ts` reader module

**Files:**
- Create: `backend/src/modules/provider-pool/pool-knobs.ts`
- Test: `backend/src/modules/provider-pool/pool-knobs.spec.ts`

**Interfaces:**
- Produces: `intEnv(name: string, fallback: number, env?: NodeJS.ProcessEnv): number`, `msEnvAsSeconds(name: string, fallbackMs: number, env?: NodeJS.ProcessEnv): number`, `secondsEnvAsMs(name: string, fallbackSeconds: number, env?: NodeJS.ProcessEnv): number`, and the constants `DEFAULT_CONCURRENCY`, `DEFAULT_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS`, `DEFAULT_OPENROUTER_FREE_DAILY_BUDGET`, `DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE`, `DEFAULT_OPENROUTER_DISPATCH_TICK_MS`, `DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH`, `DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT`, `DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS`, `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS`, `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS`, `DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`, `DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS`, `DEFAULT_SAMBANOVA_DISPATCH_TICK_MS`, `DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH`, `DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT`. Task 2 imports all of these from `./pool-knobs`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/provider-pool/pool-knobs.spec.ts`:

```ts
import { intEnv, msEnvAsSeconds, secondsEnvAsMs } from "./pool-knobs";

describe("intEnv", () => {
  it("returns the fallback when the var is missing", () => {
    expect(intEnv("NOPE_VAR", 7, {})).toBe(7);
  });

  it("returns the fallback when the var is non-numeric, zero, or negative", () => {
    expect(intEnv("X", 7, { X: "abc" })).toBe(7);
    expect(intEnv("X", 7, { X: "0" })).toBe(7);
    expect(intEnv("X", 7, { X: "-3" })).toBe(7);
  });

  it("returns the parsed value when it is a positive integer", () => {
    expect(intEnv("X", 7, { X: "42" })).toBe(42);
  });

  it("defaults to process.env when no env object is passed", () => {
    const prior = process.env.POOL_KNOBS_TEST_VAR;
    process.env.POOL_KNOBS_TEST_VAR = "9";
    try {
      expect(intEnv("POOL_KNOBS_TEST_VAR", 1)).toBe(9);
    } finally {
      if (prior === undefined) delete process.env.POOL_KNOBS_TEST_VAR;
      else process.env.POOL_KNOBS_TEST_VAR = prior;
    }
  });
});

describe("msEnvAsSeconds", () => {
  it("reads a milliseconds env var and rounds up to whole seconds", () => {
    expect(msEnvAsSeconds("X", 60_000, { X: "1500" })).toBe(2);
    expect(msEnvAsSeconds("X", 60_000, { X: "2000" })).toBe(2);
  });

  it("falls back to the millisecond default, converted to seconds", () => {
    expect(msEnvAsSeconds("X", 60_000, {})).toBe(60);
  });
});

describe("secondsEnvAsMs", () => {
  it("reads a seconds env var and returns milliseconds", () => {
    expect(secondsEnvAsMs("X", 300, { X: "42" })).toBe(42_000);
  });

  it("falls back to the seconds default, converted to milliseconds", () => {
    expect(secondsEnvAsMs("X", 300, {})).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest pool-knobs.spec.ts`
Expected: FAIL — `Cannot find module './pool-knobs'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/modules/provider-pool/pool-knobs.ts`:

```ts
// Generic env-var readers for the small per-pool tuning knobs (worker
// concurrency, rate-limit fallback waits, free-tier dispatch pacing, ...).
//
// provider-pool.config.ts calls these inline at each pool's row with that
// knob's literal env-var name, instead of importing one hand-written
// wrapper function per knob per provider. See
// docs/architecture/04-pool-config-knobs.html.

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads a positive-integer env var, falling back to `fallback` when missing, non-numeric, zero, or negative. */
export function intEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveInt(env[name], fallback);
}

/** Reads a milliseconds env var and returns it rounded up to whole seconds. */
export function msEnvAsSeconds(
  name: string,
  fallbackMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Math.ceil(intEnv(name, fallbackMs, env) / 1000);
}

/** Reads a seconds env var and returns it in milliseconds. */
export function secondsEnvAsMs(
  name: string,
  fallbackSeconds: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intEnv(name, fallbackSeconds, env) * 1000;
}

// Shared across every pool: worker concurrency and per-minute rate-limit
// fallback waits all default the same way regardless of provider.
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_RATE_LIMIT_FALLBACK_SECONDS = 60;

// Genuinely provider-specific defaults (kept distinct — same names as the
// removed strategies.ts constants, so callers only need an import-path change).
export const DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS = 24 * 60 * 60;
export const DEFAULT_OPENROUTER_FREE_DAILY_BUDGET = 50;
export const DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE = 6;
export const DEFAULT_OPENROUTER_DISPATCH_TICK_MS = 15_000;
export const DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH = 3;
export const DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT = 3;
export const DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS = 60_000;
export const DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS = 4;
export const DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS = 300;
export const DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS = 21600;
export const DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS = 3600;
export const DEFAULT_SAMBANOVA_DISPATCH_TICK_MS = 15_000;
export const DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH = 2;
export const DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT = 2;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest pool-knobs.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/provider-pool/pool-knobs.ts backend/src/modules/provider-pool/pool-knobs.spec.ts
git commit -m "feat(provider-pool): add generic pool-knobs env readers"
```

---

### Task 2: Rewire `provider-pool.config.ts` to build knobs inline via `pool-knobs.ts`

**Files:**
- Modify: `backend/src/modules/provider-pool/provider-pool.config.ts`
- Modify: `backend/src/modules/provider-pool/provider-pool.config.spec.ts`

**Interfaces:**
- Consumes: `intEnv`, `msEnvAsSeconds`, `secondsEnvAsMs`, and the `DEFAULT_*` constants from Task 1's `./pool-knobs`.
- Produces: no change to `ProviderPool`, `FreeTierConfig`, `providerPool`, `providerPoolOrThrow`, `providerPoolById`, `PROVIDER_POOLS`, or `FREE_TIER_POOLS` — same names, same shapes, same exported values. Task 3 continues to import `providerPool` / `providerPoolById` from this file exactly as before.

- [ ] **Step 1: Replace the import block**

In `backend/src/modules/provider-pool/provider-pool.config.ts`, replace:

```ts
import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
  llmGoogleConcurrency,
  llmGroqConcurrency,
  llmMistralConcurrency,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmOpenRouterConcurrency,
  llmSambaNovaConcurrency,
  llmGoogleRateLimitFallbackSeconds,
  llmGroqDailyHoldFallbackSeconds,
  llmGroqRateLimitFallbackSeconds,
  llmMistralRateLimitFallbackSeconds,
  llmOpenRouterRateLimitFallbackSeconds,
  llmSambaNovaDailyHoldFallbackSeconds,
  llmSambaNovaRateLimitFallbackSeconds,
  mistralModelHoldFallbackSeconds,
  mistralPersistentRateLimitAttempts,
  mistralPersistentRateLimitElapsedMs,
  openRouterCallsPerTrialEstimate,
  openRouterDispatchMaxBatch,
  openRouterDispatchMaxInFlight,
  openRouterDispatchRpmCooldownSeconds,
  openRouterDispatchTickMs,
  openRouterFreeDailyBudget,
  sambaNovaDispatchMaxBatch,
  sambaNovaDispatchMaxInFlight,
  sambaNovaDispatchTickMs,
} from "../../strategies";
import { nextPacificMidnight, secondsUntilNextUtcMidnight } from "../strategy/rate-limit-reset-time";
```

with:

```ts
import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
} from "../../strategies";
import { nextPacificMidnight, secondsUntilNextUtcMidnight } from "../strategy/rate-limit-reset-time";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
  DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
  DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
  DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS,
  DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS,
  DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE,
  DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH,
  DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT,
  DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
  DEFAULT_OPENROUTER_DISPATCH_TICK_MS,
  DEFAULT_OPENROUTER_FREE_DAILY_BUDGET,
  DEFAULT_RATE_LIMIT_FALLBACK_SECONDS,
  DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH,
  DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT,
  DEFAULT_SAMBANOVA_DISPATCH_TICK_MS,
  intEnv,
  msEnvAsSeconds,
  secondsEnvAsMs,
} from "./pool-knobs";
```

- [ ] **Step 2: Replace the `PROVIDER_POOLS` array body**

Replace the entire `export const PROVIDER_POOLS: ProviderPool[] = [ ... ];` array (the google/groq/openrouter/mistral/sambanova/openai/ollama rows) with:

```ts
export const PROVIDER_POOLS: ProviderPool[] = [
  {
    id: "google",
    label: "Google",
    strategyName: LLM_GOOGLE,
    orchestratorProvider: "google",
    concurrency: () => intEnv("LLM_GOOGLE_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: {
      runs: "llm-google-runs",
      freeDispatch: "google-free-dispatch",
      rpdResume: "google-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      // 00:01 America/Los_Angeles — Google's free-tier RPD resets on Pacific midnight.
      resetSchedule: { kind: "fixed-cron", pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      dispatch: { stop: "until-held", pacing: "shared" },
      rateLimitFallbackSeconds: () =>
        intEnv("LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS", DEFAULT_RATE_LIMIT_FALLBACK_SECONDS),
      dailyHoldFallbackSeconds: () =>
        Math.max(0, Math.round((nextPacificMidnight().getTime() - Date.now()) / 1000)),
    },
  },
  {
    id: "groq",
    label: "Groq",
    strategyName: LLM_GROQ,
    orchestratorProvider: "groq",
    concurrency: () => intEnv("LLM_GROQ_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: {
      runs: "llm-groq-runs",
      freeDispatch: "groq-free-dispatch",
      rpdResume: "groq-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: SELF_REARM_MAX_DELAY_MS },
      dispatch: { stop: "until-held", pacing: "shared" },
      rateLimitFallbackSeconds: () =>
        intEnv("LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS", DEFAULT_RATE_LIMIT_FALLBACK_SECONDS),
      dailyHoldFallbackSeconds: () =>
        intEnv("LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS", DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS),
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    strategyName: LLM_OPENROUTER,
    orchestratorProvider: "openrouter",
    concurrency: () => intEnv("LLM_OPENROUTER_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: {
      runs: "llm-openrouter-runs",
      freeDispatch: "openrouter-free-dispatch",
      rpdResume: "openrouter-rpd-resume",
    },
    freeTier: {
      holdScope: "account",
      // 00:05 UTC — OpenRouter's free daily allowance resets on UTC midnight.
      resetSchedule: { kind: "fixed-cron", pattern: "5 0 * * *", tz: "UTC" },
      dispatch: {
        stop: "account-budget",
        budget: () => intEnv("OPENROUTER_FREE_DAILY_BUDGET", DEFAULT_OPENROUTER_FREE_DAILY_BUDGET),
        callsPerTrial: () =>
          intEnv("OPENROUTER_CALLS_PER_TRIAL_ESTIMATE", DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE),
        rpmCooldownSeconds: () =>
          msEnvAsSeconds("OPENROUTER_DISPATCH_RPM_COOLDOWN_MS", DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS),
        tickMs: () => intEnv("OPENROUTER_DISPATCH_TICK_MS", DEFAULT_OPENROUTER_DISPATCH_TICK_MS),
        maxBatch: () => intEnv("OPENROUTER_DISPATCH_MAX_BATCH", DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH),
        maxInFlight: () =>
          intEnv("OPENROUTER_DISPATCH_MAX_IN_FLIGHT", DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT),
      },
      rateLimitFallbackSeconds: () =>
        intEnv("LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS", DEFAULT_RATE_LIMIT_FALLBACK_SECONDS),
      // OpenRouter emits no dailyResetSeconds hint; its free allowance resets on UTC midnight.
      dailyHoldFallbackSeconds: secondsUntilNextUtcMidnight,
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    strategyName: LLM_MISTRAL,
    orchestratorProvider: "mistral",
    concurrency: () => intEnv("LLM_MISTRAL_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: {
      runs: "llm-mistral-runs",
      freeDispatch: "mistral-free-dispatch",
      rpdResume: "mistral-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: SELF_REARM_MAX_DELAY_MS },
      dispatch: { stop: "until-held", pacing: "shared" },
      rateLimitFallbackSeconds: () =>
        intEnv("LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS", DEFAULT_RATE_LIMIT_FALLBACK_SECONDS),
      dailyHoldFallbackSeconds: () =>
        intEnv("MISTRAL_MODEL_HOLD_FALLBACK_SECONDS", DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS),
      persistentRateLimitPark: {
        attempts: () =>
          intEnv("MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS", DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS),
        elapsedMs: () =>
          secondsEnvAsMs(
            "MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS",
            DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS,
          ),
      },
    },
  },
  {
    id: "sambanova",
    label: "SambaNova",
    strategyName: LLM_SAMBANOVA,
    orchestratorProvider: "sambanova",
    concurrency: () => intEnv("LLM_SAMBANOVA_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: {
      runs: "llm-sambanova-runs",
      freeDispatch: "sambanova-free-dispatch",
      rpdResume: "sambanova-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: SELF_REARM_MAX_DELAY_MS },
      dispatch: {
        stop: "until-held",
        pacing: {
          tickMs: () => intEnv("SAMBANOVA_DISPATCH_TICK_MS", DEFAULT_SAMBANOVA_DISPATCH_TICK_MS),
          maxBatch: () => intEnv("SAMBANOVA_DISPATCH_MAX_BATCH", DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH),
          maxInFlight: () =>
            intEnv("SAMBANOVA_DISPATCH_MAX_IN_FLIGHT", DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT),
        },
      },
      rateLimitFallbackSeconds: () =>
        intEnv("LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS", DEFAULT_RATE_LIMIT_FALLBACK_SECONDS),
      dailyHoldFallbackSeconds: () =>
        intEnv("LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS", DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS),
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    strategyName: LLM_OPENAI,
    orchestratorProvider: "openai",
    concurrency: () => intEnv("LLM_OPENAI_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: { runs: "llm-openai-runs" },
    freeTier: null,
  },
  {
    id: "ollama",
    label: "Ollama",
    strategyName: LLM_OLLAMA,
    orchestratorProvider: "ollama",
    concurrency: () => intEnv("LLM_OLLAMA_CONCURRENCY", DEFAULT_CONCURRENCY),
    queues: { runs: "llm-ollama-runs" },
    freeTier: null,
  },
];
```

(`SELF_REARM_MAX_DELAY_MS` is the existing constant a few lines above the array — do not touch it.)

- [ ] **Step 3: Run the pool-config test to see the reference-identity tests fail**

Run: `cd backend && npx jest provider-pool.config.spec.ts`
Expected: FAIL — the `"knob accessors are wired to the right provider"` block errors with `llmGoogleRateLimitFallbackSeconds is not defined` (its import was deleted) or the `toBe(fn)` assertions fail because the row now holds a fresh closure, not the old named function reference.

- [ ] **Step 4: Replace the reference-identity tests with env-var behavioral tests**

In `backend/src/modules/provider-pool/provider-pool.config.spec.ts`, delete the top import block:

```ts
import {
  llmGoogleRateLimitFallbackSeconds,
  llmGroqDailyHoldFallbackSeconds,
  llmGroqRateLimitFallbackSeconds,
  llmMistralRateLimitFallbackSeconds,
  llmOpenRouterRateLimitFallbackSeconds,
  llmSambaNovaDailyHoldFallbackSeconds,
  llmSambaNovaRateLimitFallbackSeconds,
  mistralModelHoldFallbackSeconds,
  mistralPersistentRateLimitAttempts,
  mistralPersistentRateLimitElapsedMs,
  openRouterCallsPerTrialEstimate,
  openRouterDispatchMaxBatch,
  openRouterDispatchMaxInFlight,
  openRouterDispatchRpmCooldownSeconds,
  openRouterDispatchTickMs,
  openRouterFreeDailyBudget,
  sambaNovaDispatchMaxBatch,
  sambaNovaDispatchMaxInFlight,
  sambaNovaDispatchTickMs,
} from "../../strategies";
```

(the second import, of `FREE_TIER_POOLS, PROVIDER_POOLS, providerPool, providerPoolById, providerPoolOrThrow, type ProviderPool` from `./provider-pool.config`, stays as-is).

Then replace the whole `describe("knob accessors are wired to the right provider", ...)` block (from `describe("knob accessors are wired to the right provider", () => {` through its closing `});`) with:

```ts
describe("knobs read the right env var", () => {
  // Guards against copy-paste errors like pointing groq's row at google's
  // env var, now that each knob is an inline closure rather than a named,
  // reference-comparable function.
  const withEnv = (name: string, value: string, fn: () => void) => {
    const prior = process.env[name];
    process.env[name] = value;
    try {
      fn();
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  };

  it.each([
    ["google", () => byId("google").freeTier!.rateLimitFallbackSeconds(), "LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS"],
    ["groq", () => byId("groq").freeTier!.rateLimitFallbackSeconds(), "LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS"],
    ["groq", () => byId("groq").freeTier!.dailyHoldFallbackSeconds(), "LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS"],
    [
      "openrouter",
      () => byId("openrouter").freeTier!.rateLimitFallbackSeconds(),
      "LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS",
    ],
    ["mistral", () => byId("mistral").freeTier!.rateLimitFallbackSeconds(), "LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS"],
    ["mistral", () => byId("mistral").freeTier!.dailyHoldFallbackSeconds(), "MISTRAL_MODEL_HOLD_FALLBACK_SECONDS"],
    [
      "sambanova",
      () => byId("sambanova").freeTier!.rateLimitFallbackSeconds(),
      "LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS",
    ],
    [
      "sambanova",
      () => byId("sambanova").freeTier!.dailyHoldFallbackSeconds(),
      "LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS",
    ],
  ] as const)("%s: reads its own env var, not a neighbor's", (_id, read, envVar) => {
    withEnv(envVar, "999999", () => {
      expect(read()).toBe(999999);
    });
  });

  it("mistral streak park reads MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS / _ELAPSED_SECONDS", () => {
    const park = byId("mistral").freeTier!.persistentRateLimitPark!;
    withEnv("MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS", "9", () => {
      expect(park.attempts()).toBe(9);
    });
    withEnv("MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS", "42", () => {
      expect(park.elapsedMs()).toBe(42_000);
    });
  });

  it("openrouter account-budget dispatch reads the OPENROUTER_* env vars", () => {
    const dispatch = byId("openrouter").freeTier!.dispatch;
    if (dispatch.stop !== "account-budget") throw new Error("expected account-budget");
    withEnv("OPENROUTER_FREE_DAILY_BUDGET", "777", () => expect(dispatch.budget()).toBe(777));
    withEnv("OPENROUTER_CALLS_PER_TRIAL_ESTIMATE", "8", () => expect(dispatch.callsPerTrial()).toBe(8));
    withEnv("OPENROUTER_DISPATCH_RPM_COOLDOWN_MS", "5000", () => expect(dispatch.rpmCooldownSeconds()).toBe(5));
    withEnv("OPENROUTER_DISPATCH_TICK_MS", "9999", () => expect(dispatch.tickMs()).toBe(9999));
    withEnv("OPENROUTER_DISPATCH_MAX_BATCH", "11", () => expect(dispatch.maxBatch()).toBe(11));
    withEnv("OPENROUTER_DISPATCH_MAX_IN_FLIGHT", "12", () => expect(dispatch.maxInFlight()).toBe(12));
  });

  it("sambanova dedicated pacing reads the SAMBANOVA_DISPATCH_* env vars", () => {
    const dispatch = byId("sambanova").freeTier!.dispatch;
    if (dispatch.stop !== "until-held" || dispatch.pacing === "shared") {
      throw new Error("expected dedicated pacing");
    }
    withEnv("SAMBANOVA_DISPATCH_TICK_MS", "2222", () => expect(dispatch.pacing.tickMs()).toBe(2222));
    withEnv("SAMBANOVA_DISPATCH_MAX_BATCH", "13", () => expect(dispatch.pacing.maxBatch()).toBe(13));
    withEnv("SAMBANOVA_DISPATCH_MAX_IN_FLIGHT", "14", () => expect(dispatch.pacing.maxInFlight()).toBe(14));
  });
});
```

Every other `describe` block in this file (`"PROVIDER_POOLS row shape"`, `"FreeTierConfig invariants"`, `"per-pool concrete configuration"`, `"lookups"`, `"frontend parity"`) is untouched — they already test behavior generically (the thunks resolve to positive numbers), not by reference identity.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx jest provider-pool.config.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/provider-pool/provider-pool.config.ts backend/src/modules/provider-pool/provider-pool.config.spec.ts
git commit -m "refactor(provider-pool): build pool knobs inline via pool-knobs readers"
```

---

### Task 3: Point `llm-strategy-runner.service.ts`'s one remaining accessor import at the pool config

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `providerPoolById` from `../provider-pool/provider-pool.config` (already exported, unchanged by Task 2); `DEFAULT_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS`, `DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS`, `DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`, `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS`, `DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS` from Task 1's `../provider-pool/pool-knobs`.

- [ ] **Step 1: Update the runner's import and its one call site**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, replace:

```ts
import {
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmGoogleRateLimitFallbackSeconds,
  llmTemperature,
} from "../../strategies";
import { providerPool, type FreeTierConfig } from "../provider-pool/provider-pool.config";
```

with:

```ts
import {
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmTemperature,
} from "../../strategies";
import {
  providerPool,
  providerPoolById,
  type FreeTierConfig,
} from "../provider-pool/provider-pool.config";
```

Then replace:

```ts
    // A pool uses its own configured fallback; non-pool strategies keep the
    // historical default (the old ternary's final branch was Google's).
    const rateLimitFallbackSeconds =
      freeTier?.rateLimitFallbackSeconds() ?? llmGoogleRateLimitFallbackSeconds();
```

with:

```ts
    // A pool uses its own configured fallback; non-pool strategies keep the
    // historical default (the old ternary's final branch was Google's).
    const rateLimitFallbackSeconds =
      freeTier?.rateLimitFallbackSeconds() ??
      providerPoolById("google").freeTier!.rateLimitFallbackSeconds();
```

- [ ] **Step 2: Run the runner spec to see the stale import fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — `llm-strategy-runner.service.spec.ts` still imports `DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS` etc. from `../../strategies`, which Task 4 will remove; for now it should still resolve (strategies.ts isn't touched yet), so this step should currently PASS. Skip ahead only if it already passes — otherwise fix per Step 3 below before proceeding.

- [ ] **Step 3: Update the runner spec's import to the constants' eventual home**

In `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, replace:

```ts
import {
  DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
  DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS,
  DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
  DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
  DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS,
  DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS,
  DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
  DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
} from "../../strategies";
```

with:

```ts
import {
  DEFAULT_RATE_LIMIT_FALLBACK_SECONDS,
  DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS,
  DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
  DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS,
  DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS,
  DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
} from "../provider-pool/pool-knobs";
```

Then update the three usages of the now-removed per-provider rate-limit-fallback constants (they were all `= 60`, folded into the one shared constant):
- Line with `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS * 1000);` → `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_RATE_LIMIT_FALLBACK_SECONDS * 1000);`
- Line with `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS * 1000);` → `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_RATE_LIMIT_FALLBACK_SECONDS * 1000);`
- Line with `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS * 1000);` → `expect(delaySpy).toHaveBeenCalledWith(DEFAULT_RATE_LIMIT_FALLBACK_SECONDS * 1000);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS (all cases, including the `"should fall back to llmGoogleRateLimitFallbackSeconds when retryAfterSeconds is absent"` test, which sets `process.env.LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` directly and is unaffected by this refactor)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "refactor(strategy): route the runner's rate-limit fallback through providerPoolById"
```

---

### Task 4: Delete the now-unused per-provider accessors and constants from `strategies.ts`

**Files:**
- Modify: `backend/src/strategies.ts`
- Modify: `backend/src/strategies.spec.ts`

**Interfaces:**
- Produces: `strategies.ts` keeps every export not tied to a single provider's knob: `SUPPORTED_STRATEGIES`, `SupportedStrategy`, `STRATEGY_SET`, `SHUFFLE_SMART`, `SHUFFLE_FOOLISH`, `LLM_OPENAI`, `LLM_OLLAMA`, `LLM_GOOGLE`, `LLM_GROQ`, `LLM_OPENROUTER`, `LLM_MISTRAL`, `LLM_SAMBANOVA`, `LLM_STRATEGIES`, `isLlmStrategy`, `AUTOMATIC_STRATEGIES`, `DEFAULT_SHUFFLE_TRIALS`, `DEFAULT_LLM_TRIALS_PER_MODEL`, `DEFAULT_LLM_MAX_DUPLICATE_GUESSES`, `DEFAULT_LLM_MAX_MALFORMED_RESPONSES`, `DEFAULT_LLM_MAX_MODEL_ERRORS`, `DEFAULT_LLM_MAX_FAILED_GUESSES`, `DEFAULT_LLM_NUM_RESPONSES`, `MAX_LLM_NUM_RESPONSES`, `DEFAULT_LLM_MAX_PROMPTS`, `DEFAULT_LLM_TEMPERATURE`, `WorkerRole`, `workerRole`, `shuffleTrialCount`, `llmMaxTrialsPerModel`, `llmMaxDuplicateGuesses`, `llmMaxMalformedResponses`, `llmMaxModelErrors`, `llmMaxFailedGuesses`, `llmNumResponses`, `llmMaxPrompts`, `llmTemperature`, `startOfTodayUtc`, `DAILY_AUTOMATION_CRON`, `nextDailyAutomationRunAt`, `DEFAULT_FREE_TIER_DISPATCH_TICK_MS`, `DEFAULT_FREE_TIER_DISPATCH_MAX_BATCH`, `DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE`, `DEFAULT_FREE_TIER_DISPATCH_MAX_IN_FLIGHT`, `freeTierDispatchTickMs`, `freeTierDispatchMaxBatch`, `freeTierDispatchMaxInFlight`, `freeTierDispatchTokenEstimate`, `strategyTrialNumbers`.

- [ ] **Step 1: Confirm nothing else still imports the functions being deleted**

Run: `cd backend && grep -rn "llmOpenAIConcurrency\|llmOllamaConcurrency\|llmGoogleConcurrency\|llmGoogleRateLimitFallbackSeconds\|llmGroqConcurrency\|llmGroqRateLimitFallbackSeconds\|llmGroqDailyHoldFallbackSeconds\|llmOpenRouterConcurrency\|llmOpenRouterRateLimitFallbackSeconds\|openRouterFreeDailyBudget\|openRouterCallsPerTrialEstimate\|openRouterDispatchTickMs\|openRouterDispatchMaxBatch\|openRouterDispatchMaxInFlight\|openRouterDispatchRpmCooldownSeconds\|llmMistralConcurrency\|llmMistralRateLimitFallbackSeconds\|mistralPersistentRateLimitAttempts\|mistralPersistentRateLimitElapsedMs\|mistralModelHoldFallbackSeconds\|llmSambaNovaConcurrency\|llmSambaNovaRateLimitFallbackSeconds\|llmSambaNovaDailyHoldFallbackSeconds\|sambaNovaDispatchTickMs\|sambaNovaDispatchMaxBatch\|sambaNovaDispatchMaxInFlight" src/ --include=*.ts`
Expected: only `strategies.ts` (the definitions, about to be deleted) and `strategies.spec.ts` (their tests, about to be deleted in Step 3). If anything else shows up, stop and re-check Tasks 2–3 first.

- [ ] **Step 2: Delete the two dead blocks from `strategies.ts`**

First, delete this whole block (the per-provider `DEFAULT_*` constants, between `MAX_LLM_NUM_RESPONSES` above and `DEFAULT_LLM_MAX_PROMPTS` below — leave both of those in place):

```ts
// How many LLM strategy runs of each provider the worker may process at once.
// Each provider has its own BullMQ queue (llm-openai-runs / llm-ollama-runs /
// llm-google-runs), so the three providers never block each other; within a
// provider the worker starts at most this many jobs concurrently (default 1
// = fully serialized).
export const DEFAULT_LLM_OPENAI_CONCURRENCY = 1;
export const DEFAULT_LLM_OLLAMA_CONCURRENCY = 1;
export const DEFAULT_LLM_GOOGLE_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying after a Google per-minute
// rate-limit hit, used only when Google's own RetryInfo.retryDelay is
// absent from the error — see llm-strategy-runner.service.ts.
export const DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS = 60;

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

export const DEFAULT_LLM_OPENROUTER_CONCURRENCY = 1;

// Fallback wait (seconds) before retrying an OpenRouter per-minute (20 RPM)
// rate-limit hit, used only when neither retry-after nor a short
// X-RateLimit-Reset parsed — see orchestrator/src/solver.ts.
export const DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS = 60;

// Account-wide requests-per-day budget the OpenRouter dispatch cycle counts
// toward (OpenRouter's free tier is 50/day until a one-time $10 credit
// purchase raises it to 1000/day — no API exposes which, so the operator
// sets this). Counted from SolvePrompt rows, not trials, and OpenRouter
// counts failed calls too. See
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

Second, delete this whole block (the per-provider accessor functions, between `llmMaxTrialsPerModel` above and the `/** * Maximum duplicate guesses...` doc comment for `llmMaxDuplicateGuesses` below — leave both of those in place):

```ts
/**
 * How many llm-openai runs the worker may process at once, from
 * LLM_OPENAI_CONCURRENCY. Falls back to DEFAULT_LLM_OPENAI_CONCURRENCY for
 * missing/invalid values.
 */
export function llmOpenAIConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_OPENAI_CONCURRENCY, DEFAULT_LLM_OPENAI_CONCURRENCY);
}

/**
 * How many llm-ollama runs the worker may process at once, from
 * LLM_OLLAMA_CONCURRENCY. Falls back to DEFAULT_LLM_OLLAMA_CONCURRENCY for
 * missing/invalid values.
 */
export function llmOllamaConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_OLLAMA_CONCURRENCY, DEFAULT_LLM_OLLAMA_CONCURRENCY);
}

/**
 * How many llm-google runs the worker may process at once, from
 * LLM_GOOGLE_CONCURRENCY. Falls back to DEFAULT_LLM_GOOGLE_CONCURRENCY for
 * missing/invalid values.
 */
export function llmGoogleConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_GOOGLE_CONCURRENCY, DEFAULT_LLM_GOOGLE_CONCURRENCY);
}

/**
 * Fallback wait (seconds) before retrying a Google per-minute rate-limit
 * hit, from LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS. Only used when Google's
 * own RetryInfo.retryDelay wasn't present on the error. Falls back to
 * DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmGoogleRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

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

/**
 * How many llm-openrouter runs the worker may process at once, from
 * LLM_OPENROUTER_CONCURRENCY. Falls back to
 * DEFAULT_LLM_OPENROUTER_CONCURRENCY for missing/invalid values.
 */
export function llmOpenRouterConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_OPENROUTER_CONCURRENCY, DEFAULT_LLM_OPENROUTER_CONCURRENCY);
}

/**
 * Fallback wait (seconds) before retrying an OpenRouter per-minute
 * rate-limit hit, from LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS. Only used
 * when the 429's own headers didn't yield a wait. Falls back to
 * DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid
 * values.
 */
export function llmOpenRouterRateLimitFallbackSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveTrialCount(
    env.LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

/**
 * The account-wide OpenRouter free-tier requests-per-day budget the
 * dispatch cycle counts today's logged calls against, from
 * OPENROUTER_FREE_DAILY_BUDGET. Falls back to
 * DEFAULT_OPENROUTER_FREE_DAILY_BUDGET for missing/invalid values.
 */
export function openRouterFreeDailyBudget(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.OPENROUTER_FREE_DAILY_BUDGET, DEFAULT_OPENROUTER_FREE_DAILY_BUDGET);
}

/**
 * Assumed API calls per solve trial, for the OpenRouter dispatch cycle's
 * in-flight budget estimate, from OPENROUTER_CALLS_PER_TRIAL_ESTIMATE.
 * Falls back to DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE.
 */
export function openRouterCallsPerTrialEstimate(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.OPENROUTER_CALLS_PER_TRIAL_ESTIMATE,
    DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE,
  );
}

/** Delay between OpenRouter dispatch ticks, from OPENROUTER_DISPATCH_TICK_MS. */
export function openRouterDispatchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.OPENROUTER_DISPATCH_TICK_MS, DEFAULT_OPENROUTER_DISPATCH_TICK_MS);
}

/** Max new trials a single OpenRouter dispatch tick may queue, from OPENROUTER_DISPATCH_MAX_BATCH. */
export function openRouterDispatchMaxBatch(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.OPENROUTER_DISPATCH_MAX_BATCH,
    DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH,
  );
}

/** Max trials queued/running at once for the OpenRouter cycle, from OPENROUTER_DISPATCH_MAX_IN_FLIGHT. */
export function openRouterDispatchMaxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.OPENROUTER_DISPATCH_MAX_IN_FLIGHT,
    DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT,
  );
}

/**
 * How long (seconds) the whole OpenRouter dispatch tick chain backs off
 * after a per-minute 429, from OPENROUTER_DISPATCH_RPM_COOLDOWN_MS (a
 * milliseconds knob, rounded up to whole seconds here). Falls back to
 * DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS for missing/invalid values.
 */
export function openRouterDispatchRpmCooldownSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const ms = positiveTrialCount(
    env.OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
    DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS,
  );
  return Math.ceil(ms / 1000);
}

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

/**
 * Worker concurrency for the llm-sambanova-runs queue, from
 * LLM_SAMBANOVA_CONCURRENCY. Falls back to DEFAULT_LLM_SAMBANOVA_CONCURRENCY
 * for missing/invalid values.
 */
export function llmSambaNovaConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_SAMBANOVA_CONCURRENCY, DEFAULT_LLM_SAMBANOVA_CONCURRENCY);
}

/**
 * Fallback wait (seconds) before retrying a SambaNova per-minute rate-limit
 * hit, from LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS. Only used when the
 * 429's own headers don't yield a wait. Falls back to
 * DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmSambaNovaRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS,
  );
}

/**
 * How long (seconds) a SambaNova model is held after a daily-quota 429 that
 * carried no parseable reset duration, from
 * LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS. Falls back to
 * DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmSambaNovaDailyHoldFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
    DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS,
  );
}

/**
 * Tick interval (ms) for the SambaNova free-tier dispatch cycle, from
 * SAMBANOVA_DISPATCH_TICK_MS. Falls back to
 * DEFAULT_SAMBANOVA_DISPATCH_TICK_MS for missing/invalid values.
 */
export function sambaNovaDispatchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SAMBANOVA_DISPATCH_TICK_MS, DEFAULT_SAMBANOVA_DISPATCH_TICK_MS);
}

/**
 * Maximum trials the SambaNova dispatch cycle queues per tick, from
 * SAMBANOVA_DISPATCH_MAX_BATCH. Falls back to
 * DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH for missing/invalid values.
 */
export function sambaNovaDispatchMaxBatch(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SAMBANOVA_DISPATCH_MAX_BATCH, DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH);
}

/**
 * Maximum SambaNova trials in flight before the dispatch cycle waits, from
 * SAMBANOVA_DISPATCH_MAX_IN_FLIGHT. Falls back to
 * DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT for missing/invalid values.
 */
export function sambaNovaDispatchMaxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.SAMBANOVA_DISPATCH_MAX_IN_FLIGHT,
    DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT,
  );
}

```

(Leave the trailing blank line before the `llmMaxDuplicateGuesses` doc comment as a single blank line — don't leave a double gap.)

- [ ] **Step 3: Delete the matching tests and imports from `strategies.spec.ts`**

In `backend/src/strategies.spec.ts`, remove these names from the top `import { ... } from "./strategies"` block: `DEFAULT_LLM_OPENAI_CONCURRENCY`, `DEFAULT_LLM_OLLAMA_CONCURRENCY`, `DEFAULT_LLM_GOOGLE_CONCURRENCY`, `DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_GROQ_CONCURRENCY`, `DEFAULT_LLM_GROQ_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS`, `DEFAULT_LLM_OPENROUTER_CONCURRENCY`, `DEFAULT_LLM_OPENROUTER_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_OPENROUTER_FREE_DAILY_BUDGET`, `DEFAULT_OPENROUTER_CALLS_PER_TRIAL_ESTIMATE`, `DEFAULT_OPENROUTER_DISPATCH_TICK_MS`, `DEFAULT_OPENROUTER_DISPATCH_MAX_BATCH`, `DEFAULT_OPENROUTER_DISPATCH_MAX_IN_FLIGHT`, `DEFAULT_OPENROUTER_DISPATCH_RPM_COOLDOWN_MS`, `DEFAULT_LLM_MISTRAL_CONCURRENCY`, `DEFAULT_LLM_MISTRAL_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ATTEMPTS`, `DEFAULT_MISTRAL_PERSISTENT_RATE_LIMIT_ELAPSED_SECONDS`, `DEFAULT_MISTRAL_MODEL_HOLD_FALLBACK_SECONDS`, `DEFAULT_LLM_SAMBANOVA_CONCURRENCY`, `DEFAULT_LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS`, `DEFAULT_LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS`, `DEFAULT_SAMBANOVA_DISPATCH_TICK_MS`, `DEFAULT_SAMBANOVA_DISPATCH_MAX_BATCH`, `DEFAULT_SAMBANOVA_DISPATCH_MAX_IN_FLIGHT`, `llmOllamaConcurrency`, `llmOpenAIConcurrency`, `llmGoogleConcurrency`, `llmGoogleRateLimitFallbackSeconds`, `llmGroqConcurrency`, `llmGroqRateLimitFallbackSeconds`, `llmGroqDailyHoldFallbackSeconds`, `llmOpenRouterConcurrency`, `llmOpenRouterRateLimitFallbackSeconds`, `openRouterFreeDailyBudget`, `openRouterCallsPerTrialEstimate`, `openRouterDispatchTickMs`, `openRouterDispatchMaxBatch`, `openRouterDispatchMaxInFlight`, `openRouterDispatchRpmCooldownSeconds`, `llmMistralConcurrency`, `llmMistralRateLimitFallbackSeconds`, `mistralPersistentRateLimitAttempts`, `mistralPersistentRateLimitElapsedMs`, `mistralModelHoldFallbackSeconds`, `llmSambaNovaConcurrency`, `llmSambaNovaRateLimitFallbackSeconds`, `llmSambaNovaDailyHoldFallbackSeconds`, `sambaNovaDispatchTickMs`, `sambaNovaDispatchMaxBatch`, `sambaNovaDispatchMaxInFlight`.

Then delete every `describe(...)` block from `describe("llmOpenAIConcurrency", ...)` through `describe("sambaNovaDispatch pacing knobs", ...)` (inclusive) — this spans from just after the `llmMaxTrialsPerModel` describe block down to just before `describe("LLM_SAMBANOVA membership", ...)`. **Keep** the `describe("LLM_MISTRAL membership", ...)` and `describe("LLM_SAMBANOVA membership", ...)` blocks — they test `SUPPORTED_STRATEGIES` / `isLlmStrategy` / `LLM_STRATEGIES`, not a knob, and don't reference anything being deleted.

- [ ] **Step 4: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS — no failures, no lingering references to the deleted names (a `Cannot find name` / `Cannot find module` TypeScript error here means a Step 3 import wasn't fully removed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts
git commit -m "refactor(strategies): remove per-provider knob accessors folded into provider-pool.config"
```

---

### Task 5: Record the completed candidate in `docs/architecture/specs/`

**Files:**
- Create: `docs/architecture/specs/04-pool-config-knobs.md`

Every other implemented architecture candidate (01, 02, 05, 06, 08, 09) has a matching file under `docs/architecture/specs/` documenting what actually shipped — candidate 4 is the one gap, and issue #45's whole point is to stop that kind of doc drift, so close it here rather than leaving it for the audit to flag.

- [ ] **Step 1: Write the spec file**

Create `docs/architecture/specs/04-pool-config-knobs.md`:

```markdown
# Candidate 4 — Pool config knobs

Implements `docs/architecture/04-pool-config-knobs.html`, with one deviation
from that doc's proposed shape (see below).

## What shipped

- `backend/src/modules/provider-pool/pool-knobs.ts`: three generic env
  readers (`intEnv`, `msEnvAsSeconds`, `secondsEnvAsMs`) plus the knob
  defaults — most shared across providers (`DEFAULT_CONCURRENCY = 1`,
  `DEFAULT_RATE_LIMIT_FALLBACK_SECONDS = 60`), a few genuinely
  provider-specific (Groq's 24h daily-hold fallback, OpenRouter's budget/
  pacing defaults, Mistral's streak-park thresholds, SambaNova's daily-hold
  and dedicated pacing defaults).
- `backend/src/modules/provider-pool/provider-pool.config.ts`: every pool
  row in `PROVIDER_POOLS` now builds its `NumberThunk` fields
  (`concurrency`, `rateLimitFallbackSeconds`, `dailyHoldFallbackSeconds`,
  the dispatch-pacing/account-budget knobs, Mistral's
  `persistentRateLimitPark`) with an inline closure over `intEnv` /
  `msEnvAsSeconds` / `secondsEnvAsMs` and that knob's literal env-var name,
  instead of importing a named wrapper function per knob per provider.
- `backend/src/strategies.ts`: lost the 26 removed per-provider accessor
  functions and their 26 `DEFAULT_*` constants. Everything else in the file
  (shuffle/LLM trial counts, prompt/duplicate/failure caps, the free-tier
  dispatch knobs shared across all pools, `workerRole`,
  `strategyTrialNumbers`, the daily-automation cron helpers) is unchanged —
  those aren't per-provider and were never in scope.
- `backend/src/modules/strategy/llm-strategy-runner.service.ts`'s one
  direct accessor call (the non-pool-strategy rate-limit fallback default)
  now reads `providerPoolById("google").freeTier!.rateLimitFallbackSeconds()`
  instead of importing `llmGoogleRateLimitFallbackSeconds` from
  `strategies.ts`.

## Deviation from the proposal doc

The doc's ideal shape derives each env-var name by template
(`` `LLM_${ID}_CONCURRENCY` ``). The real names aren't uniformly
templatable — `MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` has no `LLM_` prefix
and isn't `DAILY_HOLD`-shaped; `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` has no
per-ID pattern either — so this implementation keeps every env-var name as
a literal string argument at its pool's row instead. This also sidesteps
the doc's own noted risk (derived names hurt greppability): every knob's
real env-var name is still a `grep`-able literal, just co-located with its
pool row instead of living in a dedicated wrapper function.

## Tests

- `pool-knobs.spec.ts`: the coercion edge cases (missing / non-numeric /
  zero / negative / valid; ms→s rounding; s→ms conversion) tested once on
  the generic readers, replacing ~26 near-identical per-accessor spec
  blocks that used to live in `strategies.spec.ts`.
- `provider-pool.config.spec.ts`'s `"knobs read the right env var"` block
  replaces the old `"knob accessors are wired to the right provider"`
  block: since each knob is now an inline closure rather than a named,
  reference-comparable function, the copy-paste guard (e.g. groq's row
  reading google's env var) is now a behavioral env-override assertion
  instead of a `toBe(fn)` identity check.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/specs/04-pool-config-knobs.md
git commit -m "docs(architecture): record candidate 4 (pool config knobs) as implemented"
```

---

## Self-Review Notes

- **Spec coverage:** doc 04's "deepened shape" (one generic reader, defaults live with the knob, tests collapse to one parametrised spec) is implemented in Tasks 1–2; the "risks" section's greppability concern is addressed by the literal-env-var-name deviation, called out explicitly in Task 5's spec doc; the unit-conversion risk (ms↔s) is handled by `msEnvAsSeconds` / `secondsEnvAsMs` in Task 1.
- **Type consistency:** `ProviderPool` / `FreeTierConfig` types in `provider-pool.config.ts` are never edited by this plan — only the values assigned to their `NumberThunk` fields change, so no signature drifts across tasks.
- **Only remaining external consumer:** `llm-strategy-runner.service.ts`'s single direct import (`llmGoogleRateLimitFallbackSeconds`) is handled in Task 3, confirmed by the Task 4 Step 1 grep before any deletion happens.
