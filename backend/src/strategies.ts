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
  "llm-groq",
  "llm-openrouter",
  "llm-mistral",
  "llm-sambanova",
] as const;

export type SupportedStrategy = (typeof SUPPORTED_STRATEGIES)[number];

export const STRATEGY_SET = new Set<string>(SUPPORTED_STRATEGIES);

export const SHUFFLE_SMART = "shuffle-smart" as const;
export const SHUFFLE_FOOLISH = "shuffle-foolish" as const;
export const LLM_OPENAI = "llm-openai" as const;
export const LLM_OLLAMA = "llm-ollama" as const;
export const LLM_GOOGLE = "llm-google" as const;
export const LLM_GROQ = "llm-groq" as const;
export const LLM_OPENROUTER = "llm-openrouter" as const;
export const LLM_MISTRAL = "llm-mistral" as const;
export const LLM_SAMBANOVA = "llm-sambanova" as const;

export const LLM_STRATEGIES = [
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_OPENROUTER,
  LLM_MISTRAL,
  LLM_SAMBANOVA,
] as const;

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
