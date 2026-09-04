import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { GoogleFreeDispatchService } from "./google-free-dispatch.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([GoogleDispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [GoogleFreeDispatchService],
  exports: [GoogleFreeDispatchService],
})
export class GoogleFreeDispatchModule {}
