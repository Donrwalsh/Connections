import { Module } from "@nestjs/common";
import { strategyQueue } from "./strategy.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";

@Module({
  providers: [{ provide: STRATEGY_QUEUE, useValue: strategyQueue }],
  exports: [STRATEGY_QUEUE],
})
export class QueueModule {}
