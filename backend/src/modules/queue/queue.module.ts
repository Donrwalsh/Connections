import { Module } from "@nestjs/common";
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue, llmGoogleQueue } from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";
import { freeTierDispatchQueue } from "./free-tier-dispatch.queue";
import { modelMetadataQueue } from "./model-metadata.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";
export const FREE_TIER_DISPATCH_QUEUE = "FREE_TIER_DISPATCH_QUEUE";
export const MODEL_METADATA_QUEUE = "MODEL_METADATA_QUEUE";

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: LLM_OPENAI_QUEUE, useValue: llmOpenAIQueue },
    { provide: LLM_OLLAMA_QUEUE, useValue: llmOllamaQueue },
    { provide: LLM_GOOGLE_QUEUE, useValue: llmGoogleQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
    { provide: FREE_TIER_DISPATCH_QUEUE, useValue: freeTierDispatchQueue },
    { provide: MODEL_METADATA_QUEUE, useValue: modelMetadataQueue },
  ],
  exports: [
    STRATEGY_QUEUE,
    LLM_OPENAI_QUEUE,
    LLM_OLLAMA_QUEUE,
    LLM_GOOGLE_QUEUE,
    PUZZLE_QUEUE,
    FREE_TIER_DISPATCH_QUEUE,
    MODEL_METADATA_QUEUE,
  ],
})
export class QueueModule {}
