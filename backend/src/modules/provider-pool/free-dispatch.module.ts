import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { QueueModule } from "../queue/queue.module";
import { StrategyModule } from "../strategy/strategy.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { DispatchState } from "./entities/dispatch-state.entity";
import { FreeDispatchService } from "./free-dispatch.service";

/**
 * The unified free-tier dispatch service. The per-provider
 * `<p>-free-dispatch` modules import this and expose a thin shim so existing
 * consumers (the dispatch controller, daily automation) keep resolving
 * `<P>FreeDispatchService` unchanged until doc 10 collapses them.
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
