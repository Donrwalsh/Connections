import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { OpenRouterDispatchState } from "./entities/openrouter-dispatch-state.entity";
import { OpenRouterFreeDispatchService } from "./openrouter-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([OpenRouterDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [OpenRouterFreeDispatchService],
  exports: [OpenRouterFreeDispatchService],
})
export class OpenRouterFreeDispatchModule {}
