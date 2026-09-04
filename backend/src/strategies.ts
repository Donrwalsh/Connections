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

export function isLlmStrategy(strategyName: string): boolean {
  return (LLM_STRATEGIES as readonly string[]).includes(strategyName);
}

/**
 * Strategies queued by the bulk 'all' dispatch endpoint and by puzzle
 * ingestion. Deliberately excludes the LLM strategies, which cost real
 * tokens and are not dispatched by /dispatch/strategy/:name/:date.
 */
export const AUTOMATIC_STRATEGIES: readonly string[] = SUPPORTED_STRATEGIES.filter(
  (strategyName) => !isLlmStrategy(strategyName),
);

export const DEFAULT_SHUFFLE_TRIALS = 3;
export const DEFAULT_LLM_TRIALS_PER_MODEL = 3;
export const DEFAULT_LLM_MAX_DUPLICATE_GUESSES = 10;
export const DEFAULT_LLM_MAX_MALFORMED_RESPONSES = 3;
export const DEFAULT_LLM_MAX_MODEL_ERRORS = 5;
export const DEFAULT_LLM_MAX_FAILED_GUESSES = 4;

// Starting candidate count per LLM solve step: the model is tasked with
// producing a single answer. When every candidate repeats a previous guess,
// the orchestrator re-prompts requesting one more distinct candidate (see
// LLM_MAX_PROMPTS below) until a fresh candidate appears. The count resets to
// this base value at the start of every step. Cap guards against oversized
// model outputs.
export const DEFAULT_LLM_NUM_RESPONSES = 1;
export const MAX_LLM_NUM_RESPONSES = 10;

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

// How many prompts a single solve step may make before the orchestrator
// gives up on a fresh candidate and reports a duplicate/invalid failure.
// Each re-prompt asks for one more distinct candidate.
export const DEFAULT_LLM_MAX_PROMPTS = 19;

// Fixed sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
// The temperature never changes while the orchestrator re-prompts — only the
// requested candidate count escalates — so this single value applies to every
// model call of every step in a run.
export const DEFAULT_LLM_TEMPERATURE = 0.2;

export type WorkerRole = "all" | "cloud" | "ollama";

/**
 * Which BullMQ queues a worker process should consume, from WORKER_ROLE.
 * 'all' (default) runs every queue — the original single-process behavior,
 * used by local dev (docker-compose.yml) where Ollama runs alongside
 * everything else. 'cloud' runs everything except llm-ollama-runs, for a
 * deployment with no local Ollama reachable. 'ollama' runs only
 * llm-ollama-runs, for a worker run on the machine hosting Ollama — it
 * connects outbound to the deployed Redis/Postgres to pull just that queue,
 * so Ollama itself never needs to be exposed to the internet.
 */
export function workerRole(env: NodeJS.ProcessEnv = process.env): WorkerRole {
  const raw = env.WORKER_ROLE?.toLowerCase();
  return raw === "cloud" || raw === "ollama" ? raw : "all";
}

function positiveTrialCount(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Number of trials to run per puzzle for each shuffle strategy
 * (shuffle-smart and shuffle-foolish share this one value), from
 * SHUFFLE_TRIALS. Falls back to DEFAULT_SHUFFLE_TRIALS for missing/invalid
 * values.
 */
export function shuffleTrialCount(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SHUFFLE_TRIALS, DEFAULT_SHUFFLE_TRIALS);
}

/**
 * Maximum number of independent trials a single LLM model may accumulate for
 * a strategy on one puzzle, from LLM_TRIALS_PER_MODEL. Each trial is a
 * separate strategy run of that model, so the runs can be compared against
 * each other (like shuffle-smart/foolish) — the limit applies per model, not
 * per strategy run as a whole, so e.g. 'llm-openai' can accumulate this many
 * trials of 'gpt-4.1-nano' *and* this many of a second model, independently.
 * Falls back to DEFAULT_LLM_TRIALS_PER_MODEL for missing/invalid values.
 */
export function llmMaxTrialsPerModel(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_TRIALS_PER_MODEL, DEFAULT_LLM_TRIALS_PER_MODEL);
}

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
 * Maximum duplicate guesses before an LLM run is terminated with a
 * 'duplicate' status, from LLM_MAX_DUPLICATE_GUESSES. Guards against a
 * cooperative-but-confused model that keeps re-proposing the same group.
 */
export function llmMaxDuplicateGuesses(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_DUPLICATE_GUESSES, DEFAULT_LLM_MAX_DUPLICATE_GUESSES);
}

/**
 * Maximum malformed responses (unusable/non-parseable model output) before
 * an LLM run is terminated with a 'malformedResponse' status, from
 * LLM_MAX_MALFORMED_RESPONSES.
 */
export function llmMaxMalformedResponses(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_MALFORMED_RESPONSES, DEFAULT_LLM_MAX_MALFORMED_RESPONSES);
}

/**
 * Maximum consecutive transient model failures (e.g. the Ollama model still
 * loading, or the orchestrator warming up) an LLM run tolerates before it is
 * terminated with an 'error' status, from LLM_MAX_MODEL_ERRORS. Each failure
 * is retried with an exponential backoff instead of killing the run outright,
 * so a cold-started model has time to load.
 */
export function llmMaxModelErrors(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_MODEL_ERRORS, DEFAULT_LLM_MAX_MODEL_ERRORS);
}

/**
 * Maximum failed guesses (wrong groups and one-aways) before an LLM run is
 * terminated with a 'failed' status, from LLM_MAX_FAILED_GUESSES. A one-away
 * still counts as a mistake, mirroring NYT's four-mistake rule.
 */
export function llmMaxFailedGuesses(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_FAILED_GUESSES, DEFAULT_LLM_MAX_FAILED_GUESSES);
}

/**
 * Starting number of candidate groups the model proposes per solve step, from
 * LLM_NUM_RESPONSES (clamped to [1, MAX_LLM_NUM_RESPONSES]). Each step begins
 * by asking the model to produce this many candidates; when they all repeat a
 * previous guess, the orchestrator re-prompts and may request up to
 * MAX_LLM_NUM_RESPONSES distinct candidates. The count resets to this base
 * value at the start of every step.
 */
export function llmNumResponses(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(
    MAX_LLM_NUM_RESPONSES,
    positiveTrialCount(env.LLM_NUM_RESPONSES, DEFAULT_LLM_NUM_RESPONSES),
  );
}

/**
 * Maximum number of prompts a single solve step may make before giving up on
 * a fresh candidate, from LLM_MAX_PROMPTS. The orchestrator re-prompts —
 * requesting one more distinct candidate on each attempt — until it finds a
 * candidate that does not repeat a prior guess.
 */
export function llmMaxPrompts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_PROMPTS, DEFAULT_LLM_MAX_PROMPTS);
}

/**
 * Fixed sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
 * The orchestrator uses this single value for every model call — escalation
 * on duplicate re-prompts changes only the requested candidate count, never
 * the temperature — so the value echoed back is always this one.
 */
export function llmTemperature(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeFloat(env.LLM_TEMPERATURE_BASE, DEFAULT_LLM_TEMPERATURE);
}

/**
 * Start of the current UTC calendar day — shared by FreeTierUsageService and
 * StrategyService.countTodayDispatchByModel so "today" means the same thing
 * (the provider's own usage-window reset) everywhere daily token/dispatch
 * accounting is done.
 */
export function startOfTodayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The cron pattern DailyAutomationBootstrap schedules its BullMQ job
 * scheduler with — 00:15 UTC, a quarter-hour after the OpenAI mini/nano
 * tier's UTC-midnight usage window resets. Shared source of truth for the
 * schedule's instant: nextDailyAutomationRunAt below hardcodes the same
 * 00:15 UTC via its own date math (not derived from this string, since a
 * cron pattern isn't trivially convertible to "next instant" logic), so
 * changing one without the other would silently desync the bootstrap's
 * actual schedule from what the UI reports as "next run".
 */
export const DAILY_AUTOMATION_CRON = "15 0 * * *";

/**
 * The next 00:15 UTC instant at or after `now` — when DailyAutomationBootstrap's
 * cron next fires (or just fired, if called exactly at that instant, in
 * which case this returns tomorrow's). Used by AutomationController to tell
 * the UI when the next daily-automation run is expected. Keep this in sync
 * with DAILY_AUTOMATION_CRON above if the schedule ever changes.
 */
export function nextDailyAutomationRunAt(now: Date = new Date()): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 15, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

export const DEFAULT_FREE_TIER_DISPATCH_TICK_MS = 60_000;
export const DEFAULT_FREE_TIER_DISPATCH_MAX_BATCH = 5;
// Conservative per-trial token estimate used to size a dispatch batch
// without overshooting a free-tier threshold. Deliberately on the high side
// (real mini/nano trials are often cheaper) — see
// FreeTierDispatchService.runTick for how it's used as a safety margin, not
// a precise prediction; actual usage is re-checked every tick regardless.
export const DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE = 4000;
// Trials can take anywhere from seconds to several minutes, and the worker
// only processes so many of an LLM provider's queue at once
// (LLM_OPENAI_CONCURRENCY) — so a deep backlog just sits waiting while its
// estimated token cost is already reserved against the budget on every tick
// in the meantime. Capping total queued+running trials keeps the backlog
// shallow, so real usage (which only updates once a trial actually
// finishes) stays a close, frequently-refreshed approximation of what's
// committed instead of drifting further out of sync the longer a large
// backlog takes to drain. Loosely sized above LLM_OPENAI_CONCURRENCY's
// default of 1 (enough to keep the worker fed without a gap between runs);
// raise both together for a worker configured with more concurrency.
export const DEFAULT_FREE_TIER_DISPATCH_MAX_IN_FLIGHT = 5;

/**
 * Delay between free-tier dispatch ticks, from FREE_TIER_DISPATCH_TICK_MS.
 */
export function freeTierDispatchTickMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.FREE_TIER_DISPATCH_TICK_MS, DEFAULT_FREE_TIER_DISPATCH_TICK_MS);
}

/**
 * Maximum number of new trials a single free-tier dispatch tick may queue,
 * from FREE_TIER_DISPATCH_MAX_BATCH. Caps how much a single (necessarily
 * imprecise) budget estimate can commit to before the next tick re-checks
 * real usage.
 */
export function freeTierDispatchMaxBatch(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.FREE_TIER_DISPATCH_MAX_BATCH, DEFAULT_FREE_TIER_DISPATCH_MAX_BATCH);
}

/**
 * Maximum trials allowed queued/running at once for a free-tier dispatch
 * cycle, from FREE_TIER_DISPATCH_MAX_IN_FLIGHT. Once this many are already
 * in flight, a tick dispatches nothing new — it just waits for the backlog
 * to drain — regardless of how much token budget looks available, since
 * that budget estimate only gets less reliable the deeper the backlog gets.
 */
export function freeTierDispatchMaxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.FREE_TIER_DISPATCH_MAX_IN_FLIGHT,
    DEFAULT_FREE_TIER_DISPATCH_MAX_IN_FLIGHT,
  );
}

/**
 * Conservative tokens-per-trial estimate for free-tier dispatch batch
 * sizing, from FREE_TIER_DISPATCH_TOKEN_ESTIMATE.
 */
export function freeTierDispatchTokenEstimate(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.FREE_TIER_DISPATCH_TOKEN_ESTIMATE,
    DEFAULT_FREE_TIER_DISPATCH_TOKEN_ESTIMATE,
  );
}

/**
 * Trial numbers to create for a strategy in one bulk dispatch. Deterministic
 * strategies run a single trial (0); shuffle strategies run their configured
 * trial count (1..N) so the runs can be compared against each other. Puzzle
 * ingestion (see PuzzleIngestionService) only ever calls this for the
 * automatic (deterministic/shuffle) strategies — LLM runs are dispatched by
 * hand, never automatically.
 *
 * For LLM strategies this would bulk-create 1..llmMaxTrialsPerModel() trials
 * for a single model in one shot — the per-model cap in full, not a partial
 * slice, so it's only correct for a single model at a time. LLM dispatch
 * instead goes through StrategyService.triggerStrategyRuns one call per
 * trial, naming a model each time and tracking each model's count
 * separately.
 */
export function strategyTrialNumbers(
  strategyName: string,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const count =
    strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH
      ? shuffleTrialCount(env)
      : isLlmStrategy(strategyName)
        ? llmMaxTrialsPerModel(env)
        : 0;

  if (count === 0) return [0];
  return Array.from({ length: count }, (_, i) => i + 1);
}
