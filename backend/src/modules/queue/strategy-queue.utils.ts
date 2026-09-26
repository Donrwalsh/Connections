import type { Queue } from "bullmq";
import { providerPool, type ProviderPoolId } from "../provider-pool/provider-pool.config";

/**
 * Pure helpers for routing/naming strategy-run jobs, split out of
 * `strategy.queue.ts` so importing them doesn't also construct that file's
 * real `Queue` instances (which eagerly open a live ioredis connection on
 * import). Safe for any production or test code to import.
 */

/**
 * Routes a strategy run to the queue that processes it: a provider-pool
 * strategy gets its pool's per-provider queue (looked up in
 * `runsQueueByPool`), everything else stays on the shared strategy-runs
 * `defaultQueue`. The strategy->queue mapping now lives entirely in
 * `PROVIDER_POOLS`; this just indexes the caller's queue map by the resolved
 * pool id.
 */
export function queueForStrategy(
  runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
  defaultQueue: Queue,
  strategyName: string,
): Queue {
  const pool = providerPool(strategyName);
  if (!pool) return defaultQueue;
  return runsQueueByPool.get(pool.id) ?? defaultQueue;
}

/**
 * The LLM queue a judge job rides — the judge provider's own queue, so
 * category-evaluation jobs share that provider's worker concurrency and
 * rate budget with its solve runs (see the design doc). Any provider pool
 * can judge, not just openai/ollama/google — JUDGE_PROVIDER is validated at
 * boot (see env.ts) and JUDGE_MODEL x JUDGE_PROVIDER consistency at dispatch
 * time (see CategoryEvaluatorService.enqueuePending), so a pool missing from
 * `runsQueueByPool` here means the provider-pool config itself is broken,
 * not a bad env value — fail loud rather than silently default.
 */
export function queueForJudgeProvider(
  provider: ProviderPoolId,
  runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
): Queue {
  const queue = runsQueueByPool.get(provider);
  if (!queue) {
    throw new Error(`No run queue registered for provider pool "${provider}"`);
  }
  return queue;
}

/** Deterministic job id so a re-enqueue of a still-pending evaluation collapses. */
export function categoryEvalJobId(llmProposalId: number): string {
  return `cat-eval-${llmProposalId}`;
}

/**
 * Deterministic job id for a strategy run so that duplicate enqueues of the
 * same (puzzle, strategy, model, trial) collapse to a single BullMQ job.
 * Model is part of the id (fixed "none" placeholder when there isn't one) so
 * that two different models never collide on the same id — see issue #43.
 *
 * Colons are stripped from the model first: BullMQ's Job.validateOptions
 * rejects any custom jobId containing ":" unless it splits into exactly 3
 * parts (the legacy repeatable-job id shape), and colon-tagged model names
 * are common (Ollama's "qwen2.5:14b", OpenRouter's "z-ai/glm-5.2:free") — an
 * unstripped one throws "Custom Id cannot contain :" out of queue.add().
 */
export function runStrategyJobId(
  puzzleId: number | string,
  strategyName: string,
  model: string | null,
  trialNumber: number,
): string {
  const modelSegment = (model ?? "none").replace(/:/g, "_");
  return `run-${puzzleId}-${strategyName}-${modelSegment}-${trialNumber}`;
}
