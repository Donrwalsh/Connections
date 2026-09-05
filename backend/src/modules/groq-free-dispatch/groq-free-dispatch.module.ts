import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { GroqDispatchState } from "./entities/groq-dispatch-state.entity";
import { GroqFreeDispatchService } from "./groq-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([GroqDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [GroqFreeDispatchService],
  exports: [GroqFreeDispatchService],
})
export class GroqFreeDispatchModule {}
