import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { FreeTierDispatchService } from "./free-tier-dispatch.service";

@Module({
  imports: [TypeOrmModule.forFeature([FreeTierDispatchState]), QueueModule, StrategyModule],
  providers: [FreeTierDispatchService],
  exports: [FreeTierDispatchService],
})
export class FreeTierDispatchModule {}
