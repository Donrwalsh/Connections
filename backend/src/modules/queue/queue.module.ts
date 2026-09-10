import { Module } from "@nestjs/common";
import { Queue } from "bullmq";
import type { ProviderPoolId } from "../provider-pool/provider-pool.config";
import {
  strategyQueue,
  llmOpenAIQueue,
  llmOllamaQueue,
  llmGoogleQueue,
  llmGroqQueue,
  llmOpenRouterQueue,
  llmMistralQueue,
  llmSambaNovaQueue,
} from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";
import { freeTierDispatchQueue } from "./free-tier-dispatch.queue";
import { modelMetadataQueue } from "./model-metadata.queue";
import { googleRpdResumeQueue } from "./google-rpd-resume.queue";
import { groqRpdResumeQueue } from "./groq-rpd-resume.queue";
import { openRouterRpdResumeQueue } from "./openrouter-rpd-resume.queue";
import { mistralRpdResumeQueue } from "./mistral-rpd-resume.queue";
import { sambaNovaRpdResumeQueue } from "./sambanova-rpd-resume.queue";
import { googleFreeDispatchQueue } from "./google-free-dispatch.queue";
import { groqFreeDispatchQueue } from "./groq-free-dispatch.queue";
import { openRouterFreeDispatchQueue } from "./openrouter-free-dispatch.queue";
import { mistralFreeDispatchQueue } from "./mistral-free-dispatch.queue";
import { sambaNovaFreeDispatchQueue } from "./sambanova-free-dispatch.queue";
import { dailyAutomationQueue } from "./daily-automation.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE";
export const LLM_GROQ_QUEUE = "LLM_GROQ_QUEUE";
export const LLM_OPENROUTER_QUEUE = "LLM_OPENROUTER_QUEUE";
export const LLM_MISTRAL_QUEUE = "LLM_MISTRAL_QUEUE";
export const LLM_SAMBANOVA_QUEUE = "LLM_SAMBANOVA_QUEUE";
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

const runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue> = new Map([
  ["openai", llmOpenAIQueue],
  ["ollama", llmOllamaQueue],
  ["google", llmGoogleQueue],
  ["groq", llmGroqQueue],
  ["openrouter", llmOpenRouterQueue],
  ["mistral", llmMistralQueue],
  ["sambanova", llmSambaNovaQueue],
]);

const rpdResumeQueueByPool: ReadonlyMap<ProviderPoolId, Queue> = new Map([
  ["google", googleRpdResumeQueue],
  ["groq", groqRpdResumeQueue],
  ["openrouter", openRouterRpdResumeQueue],
  ["mistral", mistralRpdResumeQueue],
  ["sambanova", sambaNovaRpdResumeQueue],
]);

const freeDispatchQueueByPool: ReadonlyMap<ProviderPoolId, Queue> = new Map([
  ["google", googleFreeDispatchQueue],
  ["groq", groqFreeDispatchQueue],
  ["openrouter", openRouterFreeDispatchQueue],
  ["mistral", mistralFreeDispatchQueue],
  ["sambanova", sambaNovaFreeDispatchQueue],
]);

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: LLM_OPENAI_QUEUE, useValue: llmOpenAIQueue },
    { provide: LLM_OLLAMA_QUEUE, useValue: llmOllamaQueue },
    { provide: LLM_GOOGLE_QUEUE, useValue: llmGoogleQueue },
    { provide: LLM_GROQ_QUEUE, useValue: llmGroqQueue },
    { provide: LLM_OPENROUTER_QUEUE, useValue: llmOpenRouterQueue },
    { provide: LLM_MISTRAL_QUEUE, useValue: llmMistralQueue },
    { provide: LLM_SAMBANOVA_QUEUE, useValue: llmSambaNovaQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
    { provide: FREE_TIER_DISPATCH_QUEUE, useValue: freeTierDispatchQueue },
    { provide: MODEL_METADATA_QUEUE, useValue: modelMetadataQueue },
    { provide: GOOGLE_RPD_RESUME_QUEUE, useValue: googleRpdResumeQueue },
    { provide: GROQ_RPD_RESUME_QUEUE, useValue: groqRpdResumeQueue },
    { provide: OPENROUTER_RPD_RESUME_QUEUE, useValue: openRouterRpdResumeQueue },
    { provide: MISTRAL_RPD_RESUME_QUEUE, useValue: mistralRpdResumeQueue },
    { provide: SAMBANOVA_RPD_RESUME_QUEUE, useValue: sambaNovaRpdResumeQueue },
    { provide: GOOGLE_FREE_DISPATCH_QUEUE, useValue: googleFreeDispatchQueue },
    { provide: GROQ_FREE_DISPATCH_QUEUE, useValue: groqFreeDispatchQueue },
    { provide: OPENROUTER_FREE_DISPATCH_QUEUE, useValue: openRouterFreeDispatchQueue },
    { provide: MISTRAL_FREE_DISPATCH_QUEUE, useValue: mistralFreeDispatchQueue },
    { provide: SAMBANOVA_FREE_DISPATCH_QUEUE, useValue: sambaNovaFreeDispatchQueue },
    { provide: DAILY_AUTOMATION_QUEUE, useValue: dailyAutomationQueue },
    { provide: RUNS_QUEUE_BY_POOL, useValue: runsQueueByPool },
    { provide: RPD_RESUME_QUEUE_BY_POOL, useValue: rpdResumeQueueByPool },
    { provide: FREE_DISPATCH_QUEUE_BY_POOL, useValue: freeDispatchQueueByPool },
  ],
  exports: [
    STRATEGY_QUEUE,
    LLM_OPENAI_QUEUE,
    LLM_OLLAMA_QUEUE,
    LLM_GOOGLE_QUEUE,
    LLM_GROQ_QUEUE,
    LLM_OPENROUTER_QUEUE,
    LLM_MISTRAL_QUEUE,
    LLM_SAMBANOVA_QUEUE,
    PUZZLE_QUEUE,
    FREE_TIER_DISPATCH_QUEUE,
    MODEL_METADATA_QUEUE,
    GOOGLE_RPD_RESUME_QUEUE,
    GROQ_RPD_RESUME_QUEUE,
    OPENROUTER_RPD_RESUME_QUEUE,
    MISTRAL_RPD_RESUME_QUEUE,
    SAMBANOVA_RPD_RESUME_QUEUE,
    GOOGLE_FREE_DISPATCH_QUEUE,
    GROQ_FREE_DISPATCH_QUEUE,
    OPENROUTER_FREE_DISPATCH_QUEUE,
    MISTRAL_FREE_DISPATCH_QUEUE,
    SAMBANOVA_FREE_DISPATCH_QUEUE,
    DAILY_AUTOMATION_QUEUE,
    RUNS_QUEUE_BY_POOL,
    RPD_RESUME_QUEUE_BY_POOL,
    FREE_DISPATCH_QUEUE_BY_POOL,
  ],
})
export class QueueModule {}
