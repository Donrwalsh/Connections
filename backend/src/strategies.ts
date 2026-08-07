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
 * Strategies queued automatically when a puzzle is ingested or when the bulk
 * 'all' queue endpoint is used. Deliberately excludes 'llm' — LLM runs cost
 * real tokens and are only triggered explicitly via /strategy/queue/llm/:date
 * until the strategy has been evaluated.
 */
export const AUTOMATIC_STRATEGIES: readonly string[] = SUPPORTED_STRATEGIES.filter(
  (strategyName) => strategyName !== LLM,
);

export const DEFAULT_SHUFFLE_SMART_TRIALS = 3;
export const DEFAULT_SHUFFLE_FOOLISH_TRIALS = 3;
export const DEFAULT_LLM_MAX_DUPLICATE_GUESSES = 3;
export const DEFAULT_LLM_MAX_MALFORMED_RESPONSES = 3;
export const DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT = 3;

function positiveTrialCount(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
