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
export const DEFAULT_LLM_TRIALS = 3;
export const DEFAULT_LLM_MAX_DUPLICATE_GUESSES = 10;
export const DEFAULT_LLM_MAX_MALFORMED_RESPONSES = 3;
export const DEFAULT_LLM_MAX_MODEL_ERRORS = 5;
export const DEFAULT_LLM_MAX_FAILED_GUESSES = 4;
export const DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT = 3;

// Starting candidate count per LLM solve step: the model is tasked with
// producing a single answer. When every candidate repeats a previous guess,
// the orchestrator re-prompts with changed parameters (see LLM_MAX_PROMPTS
// below), requesting more distinct candidates and a higher temperature on
// each re-prompt. The count resets to this base value at the start of every
// step. Cap guards against oversized model outputs.
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
// Each re-prompt raises the sampling temperature and asks for one more
// distinct candidate.
export const DEFAULT_LLM_MAX_PROMPTS = 19;

// Temperature ramp: the sampling temperature starts at LLM_TEMPERATURE_BASE
// and, on each re-prompt, is nudged up by a computed step (see
// llmTemperatureStep) sized so that LLM_TEMPERATURE_RAMP_STEPS increments land
// exactly on the provider's ceiling. The two providers use different
// temperature scales: OpenAI ranges 0.2 -> DEFAULT_LLM_TEMPERATURE_MAX_OPENAI
// (0.4, step 0.002), while Ollama models like Mistral go up to
// DEFAULT_LLM_TEMPERATURE_MAX_OLLAMA (0.8, step 0.006). The value that
// produced a usable candidate is echoed back to the backend, which holds onto
// it for subsequent solve steps.
export const DEFAULT_LLM_TEMPERATURE_BASE = 0.2;
export const DEFAULT_LLM_TEMPERATURE_MAX_OPENAI = 0.4;
export const DEFAULT_LLM_TEMPERATURE_MAX_OLLAMA = 0.8;
// Back-compat alias: llmTemperatureMax/llmTemperatureStep default to the
// Ollama ceiling when no provider is given.
export const DEFAULT_LLM_TEMPERATURE_MAX = DEFAULT_LLM_TEMPERATURE_MAX_OLLAMA;
export const LLM_TEMPERATURE_RAMP_STEPS = 100;

function positiveTrialCount(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveFloat(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
 * Number of independent LLM trials to run per puzzle, from LLM_TRIALS. Each
 * trial is a separate strategy run of the same configured model, so the
 * runs can be compared against each other (like shuffle-smart/foolish).
 * Falls back to DEFAULT_LLM_TRIALS for missing/invalid values.
 */
export function llmTrialCount(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_TRIALS, DEFAULT_LLM_TRIALS);
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
 * raising the temperature and requesting more distinct candidates together —
 * until it finds a candidate that does not repeat a prior guess.
 */
export function llmMaxPrompts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(env.LLM_MAX_PROMPTS, DEFAULT_LLM_MAX_PROMPTS);
}

/**
 * The LLM provider to resolve the temperature ceiling for. OpenAI uses a
 * smaller temperature scale than Ollama, so the ramp ceiling (and therefore
 * the per-re-prompt step) differs between the two.
 */
export type LlmTemperatureProvider = "openai" | "ollama";

/**
 * Base sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
 * The orchestrator raises it (by llmTemperatureStep per re-prompt) when the
 * model keeps repeating prior guesses; the escalated value is echoed back and
 * held onto for subsequent solve steps.
 */
export function llmTemperatureBase(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeFloat(env.LLM_TEMPERATURE_BASE, DEFAULT_LLM_TEMPERATURE_BASE);
}

/**
 * Ceiling for the sampling temperature, from LLM_TEMPERATURE_MAX_OPENAI /
 * LLM_TEMPERATURE_MAX_OLLAMA. The legacy LLM_TEMPERATURE_MAX still overrides
 * both providers when the per-provider variable is unset. The ramp reaches
 * exactly this value after LLM_TEMPERATURE_RAMP_STEPS increments. Defaults
 * are provider-specific because the two backends use different temperature
 * scales: OpenAI tops out at 0.4, Ollama at 0.8.
 */
export function llmTemperatureMax(
  env: NodeJS.ProcessEnv = process.env,
  provider: LlmTemperatureProvider = "ollama",
): number {
  const override =
    provider === "openai"
      ? (env.LLM_TEMPERATURE_MAX_OPENAI ?? env.LLM_TEMPERATURE_MAX)
      : (env.LLM_TEMPERATURE_MAX_OLLAMA ?? env.LLM_TEMPERATURE_MAX);
  const fallback =
    provider === "openai" ? DEFAULT_LLM_TEMPERATURE_MAX_OPENAI : DEFAULT_LLM_TEMPERATURE_MAX_OLLAMA;
  return positiveFloat(override, fallback);
}

/**
 * Per-re-prompt temperature increment. Derived from the configured base and
 * the provider's ceiling so that LLM_TEMPERATURE_RAMP_STEPS increments take
 * the temperature from the base to the ceiling.
 */
export function llmTemperatureStep(
  env: NodeJS.ProcessEnv = process.env,
  provider: LlmTemperatureProvider = "ollama",
): number {
  return (llmTemperatureMax(env, provider) - llmTemperatureBase(env)) / LLM_TEMPERATURE_RAMP_STEPS;
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
 * Trial numbers to create for a strategy. Deterministic strategies run a
 * single trial (0); shuffle and LLM strategies run their configured trial
 * count (1..N) so the runs can be compared against each other.
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
          ? llmTrialCount(env)
          : 0;

  if (count === 0) return [0];
  return Array.from({ length: count }, (_, i) => i + 1);
}
