/**
 * DI token constants for every BullMQ queue, kept in their own side-effect-free
 * file. Anything that only needs a token string — a production `@Inject(TOKEN)`
 * or a test's `{ provide: TOKEN, useValue: mock }` — should import it from
 * here, not from `queue.module.ts`. `queue.module.ts` imports the real
 * `*.queue.ts` files, each of which eagerly opens a live ioredis connection on
 * import (BullMQ's `Queue` constructor calls `waitUntilReady()` immediately);
 * pulling a token in from there drags those connections in as a side effect,
 * which is what was leaving Jest unit tests unable to exit without
 * --forceExit.
 */
export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE";
export const LLM_GROQ_QUEUE = "LLM_GROQ_QUEUE";
export const LLM_OPENROUTER_QUEUE = "LLM_OPENROUTER_QUEUE";
export const LLM_MISTRAL_QUEUE = "LLM_MISTRAL_QUEUE";
export const LLM_SAMBANOVA_QUEUE = "LLM_SAMBANOVA_QUEUE";
export const LLM_NVIDIA_QUEUE = "LLM_NVIDIA_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";
export const FREE_TIER_DISPATCH_QUEUE = "FREE_TIER_DISPATCH_QUEUE";
export const MODEL_METADATA_QUEUE = "MODEL_METADATA_QUEUE";
export const GOOGLE_RPD_RESUME_QUEUE = "GOOGLE_RPD_RESUME_QUEUE";
export const GROQ_RPD_RESUME_QUEUE = "GROQ_RPD_RESUME_QUEUE";
export const OPENROUTER_RPD_RESUME_QUEUE = "OPENROUTER_RPD_RESUME_QUEUE";
export const MISTRAL_RPD_RESUME_QUEUE = "MISTRAL_RPD_RESUME_QUEUE";
export const SAMBANOVA_RPD_RESUME_QUEUE = "SAMBANOVA_RPD_RESUME_QUEUE";
export const GOOGLE_FREE_DISPATCH_QUEUE = "GOOGLE_FREE_DISPATCH_QUEUE";
export const GROQ_FREE_DISPATCH_QUEUE = "GROQ_FREE_DISPATCH_QUEUE";
export const OPENROUTER_FREE_DISPATCH_QUEUE = "OPENROUTER_FREE_DISPATCH_QUEUE";
export const MISTRAL_FREE_DISPATCH_QUEUE = "MISTRAL_FREE_DISPATCH_QUEUE";
export const SAMBANOVA_FREE_DISPATCH_QUEUE = "SAMBANOVA_FREE_DISPATCH_QUEUE";
export const DAILY_AUTOMATION_QUEUE = "DAILY_AUTOMATION_QUEUE";

/** The per-provider LLM runs queues, keyed by provider-pool id — for
 * provider-agnostic consumers that resolve the pool themselves. */
export const RUNS_QUEUE_BY_POOL = "RUNS_QUEUE_BY_POOL";
/** The per-provider RPD-resume queues, keyed by provider-pool id (free-tier
 * pools only). */
export const RPD_RESUME_QUEUE_BY_POOL = "RPD_RESUME_QUEUE_BY_POOL";
/** The per-provider free-dispatch tick queues, keyed by provider-pool id
 * (free-tier pools only). */
export const FREE_DISPATCH_QUEUE_BY_POOL = "FREE_DISPATCH_QUEUE_BY_POOL";
