// The single source of truth for what varies between LLM provider "pools".
//
// A pool is exactly a dispatching strategy (`llm-<id>`) plus — for the five
// free-tier providers — the small, closed set of axes along which their
// otherwise-identical free-tier machinery differs: how a rate-limit hold is
// scoped, how the daily quota resets, and how the background dispatcher paces
// itself and decides to stop.
//
// This is the backend twin of `frontend/src/data/benchmark/providerPools.ts`,
// which already established "adding a provider = adding one row". The frontend
// row stays minimal (it is a UI filter list); this row carries behaviour. A
// parity test keeps the shared `id` / `strategyName` columns from drifting.
//
// Step 2 of docs/architecture/specs/01-provider-pool-module.md: this file is a
// pure addition. Nothing reads it yet — step 3 onward replaces the per-provider
// `strategyName` ternaries with `providerPool()` lookups.

import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
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

/** Pool ids — identical to the orchestrator's `ModelProvider` union and to the
 * frontend `ProviderPoolId`. Kept in sync by the parity tests. */
export type ProviderPoolId =
  | "openai"
  | "google"
  | "groq"
  | "openrouter"
  | "mistral"
  | "sambanova"
  | "ollama";

/** Reads an env-backed knob at call time. Config rows hold the accessor, not a
 * snapshotted number, so a runtime env override keeps working. */
type NumberThunk = () => number;

/** Where a rate-limit hold applies. `"model"` pools hold one model at a time
 * (google, groq, mistral, sambanova); `"account"` pools hold the whole strategy
 * at once (openrouter). */
export type HoldScope = "model" | "account";

/** How the daily quota reset is timed. `fixed-cron` pools recompute the next
 * reset from the cron; `self-rearm` pools re-schedule the resume sweep from the
 * soonest live hold's `resetAt`, capped at `maxDelayMs`. */
export type ResetSchedule =
  | { kind: "fixed-cron"; pattern: string; tz: string }
  | { kind: "self-rearm"; maxDelayMs: number };

/** Background-dispatch pacing. `"shared"` reuses the `FREE_TIER_DISPATCH_*`
 * knobs (google, groq, mistral); an object carries the pool's dedicated
 * accessors (sambanova). */
export type DispatchPacing =
  | "shared"
  | { tickMs: NumberThunk; maxBatch: NumberThunk; maxInFlight: NumberThunk };

/** What makes the background dispatcher stop for the day.
 * - `until-held`: stop once every configured model has a live hold (or no
 *   unrun puzzles remain). google, groq, mistral, sambanova.
 * - `account-budget`: stop once self-counted calls today (+ estimated
 *   in-flight) reach the daily budget. openrouter only. */
export type DispatchSpec =
  | { stop: "until-held"; pacing: DispatchPacing }
  | {
      stop: "account-budget";
      budget: NumberThunk;
      callsPerTrial: NumberThunk;
      rpmCooldownSeconds: NumberThunk;
      tickMs: NumberThunk;
      maxBatch: NumberThunk;
      maxInFlight: NumberThunk;
    };

export interface FreeTierConfig {
  holdScope: HoldScope;
  resetSchedule: ResetSchedule;
  dispatch: DispatchSpec;
  /** Seconds to hold on a per-minute `rate_limited` outcome with no usable
   * reset hint from the provider. */
  rateLimitFallbackSeconds: NumberThunk;
  /** Seconds to hold on a `rate_limited_daily` outcome with no usable reset
   * hint. Present only for `self-rearm` pools — `fixed-cron` pools derive the
   * daily reset from their cron instead. */
  dailyHoldFallbackSeconds?: NumberThunk;
  /** Mistral only: it sends no rate-limit headers, so a persistent streak of
   * per-minute 429s (>= `attempts` outcomes, or spanning >= `elapsedMs`) is
   * escalated into a daily park. */
  persistentRateLimitPark?: { attempts: NumberThunk; elapsedMs: NumberThunk };
}

export interface ProviderPool {
  id: ProviderPoolId;
  /** Short provider name for badges/logs. */
  label: string;
  /** The dispatching strategy, `llm-<id>`. */
  strategyName: string;
  /** The provider string `orchestrator/src/solver.ts` expects. Same 7 values
   * as the orchestrator's `ModelProvider`. */
  orchestratorProvider: ProviderPoolId;
  /** Existing BullMQ queue names, verbatim — never renamed (renaming orphans
   * in-flight jobs). `freeDispatch` / `rpdResume` are present iff `freeTier`. */
  queues: { runs: string; freeDispatch?: string; rpdResume?: string };
  /** `null` for providers with no free-tier machinery (openai — paid;
   * ollama — local). */
  freeTier: FreeTierConfig | null;
}

/** The 15-minute cap all three self-rearm resume services apply
 * (`REARM_MAX_DELAY_MS` in groq/mistral/sambanova `*-rpd-resume.service.ts`). */
const SELF_REARM_MAX_DELAY_MS = 15 * 60_000;

/**
 * Every pool, ordered google → groq → openrouter → mistral → sambanova (the
 * daily-automation burn order that step 6's loop must reproduce), then the two
 * non-free-tier pools. The UI renders pools in its own order — the parity test
 * compares as an unordered set.
 */
export const PROVIDER_POOLS: ProviderPool[] = [
  {
    id: "google",
    label: "Google",
    strategyName: LLM_GOOGLE,
    orchestratorProvider: "google",
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
      rateLimitFallbackSeconds: llmGoogleRateLimitFallbackSeconds,
    },
  },
  {
    id: "groq",
    label: "Groq",
    strategyName: LLM_GROQ,
    orchestratorProvider: "groq",
    queues: {
      runs: "llm-groq-runs",
      freeDispatch: "groq-free-dispatch",
      rpdResume: "groq-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: SELF_REARM_MAX_DELAY_MS },
      dispatch: { stop: "until-held", pacing: "shared" },
      rateLimitFallbackSeconds: llmGroqRateLimitFallbackSeconds,
      dailyHoldFallbackSeconds: llmGroqDailyHoldFallbackSeconds,
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    strategyName: LLM_OPENROUTER,
    orchestratorProvider: "openrouter",
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
        budget: openRouterFreeDailyBudget,
        callsPerTrial: openRouterCallsPerTrialEstimate,
        rpmCooldownSeconds: openRouterDispatchRpmCooldownSeconds,
        tickMs: openRouterDispatchTickMs,
        maxBatch: openRouterDispatchMaxBatch,
        maxInFlight: openRouterDispatchMaxInFlight,
      },
      rateLimitFallbackSeconds: llmOpenRouterRateLimitFallbackSeconds,
    },
  },
  {
    id: "mistral",
    label: "Mistral",
    strategyName: LLM_MISTRAL,
    orchestratorProvider: "mistral",
    queues: {
      runs: "llm-mistral-runs",
      freeDispatch: "mistral-free-dispatch",
      rpdResume: "mistral-rpd-resume",
    },
    freeTier: {
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: SELF_REARM_MAX_DELAY_MS },
      dispatch: { stop: "until-held", pacing: "shared" },
      rateLimitFallbackSeconds: llmMistralRateLimitFallbackSeconds,
      dailyHoldFallbackSeconds: mistralModelHoldFallbackSeconds,
      persistentRateLimitPark: {
        attempts: mistralPersistentRateLimitAttempts,
        elapsedMs: mistralPersistentRateLimitElapsedMs,
      },
    },
  },
  {
    id: "sambanova",
    label: "SambaNova",
    strategyName: LLM_SAMBANOVA,
    orchestratorProvider: "sambanova",
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
          tickMs: sambaNovaDispatchTickMs,
          maxBatch: sambaNovaDispatchMaxBatch,
          maxInFlight: sambaNovaDispatchMaxInFlight,
        },
      },
      rateLimitFallbackSeconds: llmSambaNovaRateLimitFallbackSeconds,
      dailyHoldFallbackSeconds: llmSambaNovaDailyHoldFallbackSeconds,
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    strategyName: LLM_OPENAI,
    orchestratorProvider: "openai",
    queues: { runs: "llm-openai-runs" },
    freeTier: null,
  },
  {
    id: "ollama",
    label: "Ollama",
    strategyName: LLM_OLLAMA,
    orchestratorProvider: "ollama",
    queues: { runs: "llm-ollama-runs" },
    freeTier: null,
  },
];

/** A pool row known to have free-tier machinery. */
export type FreeTierPool = ProviderPool & { freeTier: FreeTierConfig };

const POOL_BY_STRATEGY = new Map<string, ProviderPool>(
  PROVIDER_POOLS.map((pool) => [pool.strategyName, pool]),
);
const POOL_BY_ID = new Map<ProviderPoolId, ProviderPool>(
  PROVIDER_POOLS.map((pool) => [pool.id, pool]),
);

/**
 * The pool for a strategy name, or `null` for a strategy that is not a provider
 * pool (deterministic, shuffle, judge-only) or is unrecognised. Callers with a
 * default path keep it — this null case is the main regression risk of the
 * ternary-to-lookup swap and is covered explicitly in tests.
 */
export function providerPool(
  strategyName: string | null | undefined,
): ProviderPool | null {
  if (!strategyName) return null;
  return POOL_BY_STRATEGY.get(strategyName) ?? null;
}

/**
 * The pool for a strategy name, throwing if there is none. For call sites that
 * structurally always operate on a pool (worker registration, daily automation,
 * the dispatch controller) — a config gap should fail loud, not silently
 * default.
 */
export function providerPoolOrThrow(strategyName: string): ProviderPool {
  const pool = providerPool(strategyName);
  if (!pool) {
    throw new Error(`No provider pool registered for strategy "${strategyName}"`);
  }
  return pool;
}

/** The pool with the given id, throwing if there is none. */
export function providerPoolById(id: ProviderPoolId): ProviderPool {
  const pool = POOL_BY_ID.get(id);
  if (!pool) {
    throw new Error(`No provider pool with id "${id}"`);
  }
  return pool;
}

/** Pools with free-tier dispatch/resume machinery, in burn order. */
export const FREE_TIER_POOLS: readonly FreeTierPool[] = PROVIDER_POOLS.filter(
  (pool): pool is FreeTierPool => pool.freeTier !== null,
);
