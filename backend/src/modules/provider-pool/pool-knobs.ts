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
