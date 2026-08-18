export const SUPPORTED_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
  "shuffle-smart",
  "shuffle-foolish",
  "llm-openai",
  "llm-ollama",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

export const SHUFFLE_SMART = "shuffle-smart" as const;
export const SHUFFLE_FOOLISH = "shuffle-foolish" as const;
export const LLM_OPENAI = "llm-openai" as const;
export const LLM_OLLAMA = "llm-ollama" as const;

export const LLM_STRATEGIES = [LLM_OPENAI, LLM_OLLAMA] as const;

export function isLlmStrategy(strategyName: string): boolean {
  return (LLM_STRATEGIES as readonly string[]).includes(strategyName);
}

/**
 * Strategies queued by the bulk 'all' queue endpoint. Deliberately excludes
 * the LLM strategies — the bulk endpoint keeps LLM runs (which cost real
 * tokens) behind an explicit /strategy/queue/:name/:date trigger. Puzzle
 * ingestion dispatches the full SUPPORTED_STRATEGIES list, including both
 * LLM strategies.
 */
export const AUTOMATIC_STRATEGIES: readonly string[] = SUPPORTED_STRATEGIES.filter(
  (strategyName) => !isLlmStrategy(strategyName),
);

export const DEFAULT_SHUFFLE_SMART_TRIALS = 3;
export const DEFAULT_SHUFFLE_FOOLISH_TRIALS = 3;
export const DEFAULT_LLM_TRIALS_PER_MODEL = 3;
export const DEFAULT_LLM_MAX_DUPLICATE_GUESSES = 10;
export const DEFAULT_LLM_MAX_MALFORMED_RESPONSES = 3;
export const DEFAULT_LLM_MAX_MODEL_ERRORS = 5;
export const DEFAULT_LLM_MAX_FAILED_GUESSES = 4;
export const DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT = 3;

// Starting candidate count per LLM solve step: the model is tasked with
// producing a single answer. When every candidate repeats a previous guess,
// the orchestrator re-prompts requesting one more distinct candidate (see
// LLM_MAX_PROMPTS below) until a fresh candidate appears. The count resets to
// this base value at the start of every step. Cap guards against oversized
// model outputs.
export const DEFAULT_LLM_NUM_RESPONSES = 1;
export const MAX_LLM_NUM_RESPONSES = 10;

// How many LLM strategy runs of each provider the worker may process at once.
// Each provider has its own BullMQ queue (llm-openai-runs / llm-ollama-runs),
// so the two providers never block each other; within a provider the worker
// starts at most this many jobs concurrently (default 1 = fully serialized).
export const DEFAULT_LLM_OPENAI_CONCURRENCY = 1;
export const DEFAULT_LLM_OLLAMA_CONCURRENCY = 1;

// How many prompts a single solve step may make before the orchestrator
// gives up on a fresh candidate and reports a duplicate/invalid failure.
// Each re-prompt asks for one more distinct candidate.
export const DEFAULT_LLM_MAX_PROMPTS = 19;

// Fixed sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
// The temperature never changes while the orchestrator re-prompts — only the
// requested candidate count escalates — so this single value applies to every
// model call of every step in a run.
export const DEFAULT_LLM_TEMPERATURE = 0.2;

function positiveTrialCount(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Number of shuffle-smart trials to run per puzzle, from SHUFFLE_SMART_TRIALS.
 * Falls back to DEFAULT_SHUFFLE_SMART_TRIALS for missing/invalid values.
 */
export function shuffleSmartTrialCount(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SHUFFLE_SMART_TRIALS, DEFAULT_SHUFFLE_SMART_TRIALS);
}

/**
 * Number of shuffle-foolish trials to run per puzzle, from SHUFFLE_FOOLISH_TRIALS.
 * Falls back to DEFAULT_SHUFFLE_FOOLISH_TRIALS for missing/invalid values.
 */
export function shuffleFoolishTrialCount(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.SHUFFLE_FOOLISH_TRIALS, DEFAULT_SHUFFLE_FOOLISH_TRIALS);
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
 * Maximum duplicate guesses before a shuffle-foolish trial is terminated
 * with a 'duplicate' status, from SHUFFLE_FOOLISH_DUPLICATE_LIMIT.
 */
export function shuffleFoolishDuplicateLimit(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.SHUFFLE_FOOLISH_DUPLICATE_LIMIT,
    DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT,
  );
}

/**
 * Trial numbers to create for a strategy in one bulk dispatch. Deterministic
 * strategies run a single trial (0); shuffle strategies run their configured
 * trial count (1..N) so the runs can be compared against each other.
 *
 * For LLM strategies this bulk-creates 1..llmMaxTrialsPerModel() trials for a
 * single model in one shot — the shape puzzle ingestion needs, since it
 * dispatches every strategy against one default model per provider with no
 * human caller to ask. It's the per-model cap in full, not a partial slice,
 * so it's only correct for a single model at a time; the /strategy/queue
 * endpoint, where callers can name a different model per request, instead
 * dispatches one trial per call and tracks each model's count separately
 * (see StrategyService.triggerStrategyRuns).
 */
export function strategyTrialNumbers(
  strategyName: string,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const count =
    strategyName === SHUFFLE_SMART
      ? shuffleSmartTrialCount(env)
      : strategyName === SHUFFLE_FOOLISH
        ? shuffleFoolishTrialCount(env)
        : isLlmStrategy(strategyName)
          ? llmMaxTrialsPerModel(env)
          : 0;

  if (count === 0) return [0];
  return Array.from({ length: count }, (_, i) => i + 1);
}

/**
 * Whether puzzle ingestion enqueues strategy-run jobs for each puzzle it
 * inserts, from PUZZLE_INGESTION_DISPATCH_STRATEGY_JOBS (default: true).
 * Set to "false" (or "0"/"off"/"no", case-insensitive) to insert puzzles into
 * the database without dispatching any solution runs — e.g. for a bulk
 * backfill where the LLM strategies should not burn tokens, or when runs are
 * triggered separately via the /strategy/queue endpoints.
 */
export function dispatchStrategyJobsOnIngestion(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PUZZLE_INGESTION_DISPATCH_STRATEGY_JOBS ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(value);
}
