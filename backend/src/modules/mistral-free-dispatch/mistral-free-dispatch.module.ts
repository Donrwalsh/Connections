import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { MistralDispatchState } from "./entities/mistral-dispatch-state.entity";
import { MistralFreeDispatchService } from "./mistral-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([MistralDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [MistralFreeDispatchService],
  exports: [MistralFreeDispatchService],
})
export class MistralFreeDispatchModule {}
