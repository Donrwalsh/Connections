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

// Candidate count per LLM solve step: the model proposes this many groups in
// one response and the backend submits the first one that isn't a repeat of
// a previous guess. Cap guards against oversized model outputs.
export const DEFAULT_LLM_NUM_RESPONSES = 5;
export const MAX_LLM_NUM_RESPONSES = 10;

// Temperature ramp: each duplicate guess nudges the model's sampling
// temperature up by LLM_TEMPERATURE_STEP, starting from LLM_TEMPERATURE_BASE,
// capped at MAX_LLM_TEMPERATURE (the OpenAI API's ceiling).
export const DEFAULT_LLM_TEMPERATURE_BASE = 1.0;
export const DEFAULT_LLM_TEMPERATURE_STEP = 0.1;
export const MAX_LLM_TEMPERATURE = 2;

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
 * Number of candidate groups the model proposes per solve step, from
 * LLM_NUM_RESPONSES (clamped to [1, MAX_LLM_NUM_RESPONSES]). The backend
 * submits the first candidate that is not a repeat of a previous guess.
 */
export function llmNumResponses(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(
    MAX_LLM_NUM_RESPONSES,
    positiveTrialCount(env.LLM_NUM_RESPONSES, DEFAULT_LLM_NUM_RESPONSES),
  );
}

/**
 * Base sampling temperature for LLM solve steps, from LLM_TEMPERATURE_BASE.
 * Every duplicate guess the model proposes raises the temperature (see
 * llmTemperatureFor) to push it out of its current rut.
 */
export function llmTemperatureBase(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeFloat(env.LLM_TEMPERATURE_BASE, DEFAULT_LLM_TEMPERATURE_BASE);
}

/**
 * Per-duplicate temperature increment, from LLM_TEMPERATURE_STEP.
 */
export function llmTemperatureStep(env: NodeJS.ProcessEnv = process.env): number {
  return positiveFloat(env.LLM_TEMPERATURE_STEP, DEFAULT_LLM_TEMPERATURE_STEP);
}

/**
 * Sampling temperature for a solve step given the number of duplicate groups
 * proposed so far: base + step * duplicates, clamped to [0, MAX_LLM_TEMPERATURE].
 */
export function llmTemperatureFor(
  duplicateCount: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const base = llmTemperatureBase(env);
  const step = llmTemperatureStep(env);
  return Math.min(base + step * Math.max(0, duplicateCount), MAX_LLM_TEMPERATURE);
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
