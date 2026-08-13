import { Module } from "@nestjs/common";
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue } from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: LLM_OPENAI_QUEUE, useValue: llmOpenAIQueue },
    { provide: LLM_OLLAMA_QUEUE, useValue: llmOllamaQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
  ],
  exports: [STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, PUZZLE_QUEUE],
})
export class QueueModule {}
