import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { DispatchState } from "./entities/dispatch-state.entity";
import { FreeDispatchService } from "./free-dispatch.service";

/**
 * The unified free-tier dispatch service — both of its consumers
 * (DispatchModule's `/dispatch/pool/:poolId` route, AutomationModule's daily
 * burn legs) import this module directly and call `start`/`stop`/`getStatus`
 * with an explicit poolId. The five per-provider `<p>-free-dispatch` shim
 * modules this replaced are deleted (see docs/architecture/10).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DispatchState]),
    QueueModule,
    StrategyModule,
    SupportedModelModule,
  ],
  providers: [FreeDispatchService],
  exports: [FreeDispatchService],
})
export class FreeDispatchModule {}
