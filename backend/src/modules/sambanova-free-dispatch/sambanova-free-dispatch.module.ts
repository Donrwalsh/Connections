import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { SambaNovaDispatchState } from "./entities/sambanova-dispatch-state.entity";
import { SambaNovaFreeDispatchService } from "./sambanova-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([SambaNovaDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [SambaNovaFreeDispatchService],
  exports: [SambaNovaFreeDispatchService],
})
export class SambaNovaFreeDispatchModule {}
