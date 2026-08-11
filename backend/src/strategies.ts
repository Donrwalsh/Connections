export const SUPPORTED_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
  "shuffle-smart",
  "shuffle-foolish",
  "llm",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

export const SHUFFLE_SMART = "shuffle-smart" as const;
export const SHUFFLE_FOOLISH = "shuffle-foolish" as const;
export const LLM = "llm" as const;

/**
 * Strategies queued by the bulk 'all' queue endpoint. Deliberately excludes
 * 'llm' — the bulk endpoint keeps LLM runs (which cost real tokens) behind an
 * explicit /strategy/queue/llm/:date trigger. Puzzle ingestion dispatches the
 * full SUPPORTED_STRATEGIES list, including 'llm'.
 */
export const AUTOMATIC_STRATEGIES: readonly string[] = SUPPORTED_STRATEGIES.filter(
  (strategyName) => strategyName !== LLM,
);

export const DEFAULT_SHUFFLE_SMART_TRIALS = 3;
export const DEFAULT_SHUFFLE_FOOLISH_TRIALS = 3;
export const DEFAULT_LLM_MAX_DUPLICATE_GUESSES = 10;
export const DEFAULT_LLM_MAX_MALFORMED_RESPONSES = 3;
export const DEFAULT_LLM_MAX_MODEL_ERRORS = 5;
export const DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT = 3;

// Starting candidate count per LLM solve step: the model is tasked with
// producing a single answer. When every candidate repeats a previous guess,
// the orchestrator re-prompts with changed parameters (see LLM_MAX_PROMPTS
// below), requesting more distinct candidates and a higher temperature on
// each re-prompt. The count resets to this base value at the start of every
// step. Cap guards against oversized model outputs.
export const DEFAULT_LLM_NUM_RESPONSES = 1;
export const MAX_LLM_NUM_RESPONSES = 10;

// How many prompts a single solve step may make before the orchestrator
// gives up on a fresh candidate and reports a duplicate/invalid failure.
// Each re-prompt raises the sampling temperature and asks for one more
// distinct candidate.
export const DEFAULT_LLM_MAX_PROMPTS = 19;

// Temperature ramp: the sampling temperature starts at LLM_TEMPERATURE_BASE
// and, on each re-prompt, is nudged up by a computed step (see
// llmTemperatureStep) sized so that LLM_TEMPERATURE_RAMP_STEPS increments land
// exactly on LLM_TEMPERATURE_MAX. Defaults suit Mistral via Ollama
// (0 -> 3.2, step 0.032). The value that produced a usable candidate is echoed
// back to the backend, which holds onto it for subsequent solve steps.
export const DEFAULT_LLM_TEMPERATURE_BASE = 0.0;
export const DEFAULT_LLM_TEMPERATURE_MAX = 3.2;
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
 * Base sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
 * The orchestrator raises it (by llmTemperatureStep per re-prompt) when the
 * model keeps repeating prior guesses; the escalated value is echoed back and
 * held onto for subsequent solve steps.
 */
export function llmTemperatureBase(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeFloat(env.LLM_TEMPERATURE_BASE, DEFAULT_LLM_TEMPERATURE_BASE);
}

/**
 * Ceiling for the sampling temperature, from LLM_TEMPERATURE_MAX. The ramp
 * reaches exactly this value after LLM_TEMPERATURE_RAMP_STEPS increments.
 */
export function llmTemperatureMax(env: NodeJS.ProcessEnv = process.env): number {
  return positiveFloat(env.LLM_TEMPERATURE_MAX, DEFAULT_LLM_TEMPERATURE_MAX);
}

/**
 * Per-re-prompt temperature increment. Derived from the configured base and
 * ceiling so that LLM_TEMPERATURE_RAMP_STEPS increments take the temperature
 * from the base to the ceiling.
 */
export function llmTemperatureStep(env: NodeJS.ProcessEnv = process.env): number {
  return (llmTemperatureMax(env) - llmTemperatureBase(env)) / LLM_TEMPERATURE_RAMP_STEPS;
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
 * single trial (0); shuffle strategies run their configured trial count (1..N).
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
        : 0;

  if (count === 0) return [0];
  return Array.from({ length: count }, (_, i) => i + 1);
}
