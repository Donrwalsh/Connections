export const SUPPORTED_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
  "shuffle-smart",
  "shuffle-foolish",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

export const SHUFFLE_SMART = "shuffle-smart" as const;
export const SHUFFLE_FOOLISH = "shuffle-foolish" as const;

export const DEFAULT_SHUFFLE_SMART_TRIALS = 3;
export const DEFAULT_SHUFFLE_FOOLISH_TRIALS = 3;

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
