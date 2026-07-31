import { Module } from "@nestjs/common";
import { strategyQueue } from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
  ],
  exports: [STRATEGY_QUEUE, PUZZLE_QUEUE],
})
export class QueueModule {}
