import { Module } from "@nestjs/common";
import { StrategyModule } from "../strategy/strategy.module";
import { GameModule } from "../game/game.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { FreeTierDispatchModule } from "../free-tier-dispatch/free-tier-dispatch.module";
import { GoogleFreeDispatchModule } from "../google-free-dispatch/google-free-dispatch.module";
import { DispatchController } from "./dispatch.controller";

@Module({
  imports: [
    StrategyModule,
    GameModule,
    SupportedModelModule,
    FreeTierDispatchModule,
    GoogleFreeDispatchModule,
  ],
  controllers: [DispatchController],
})
export class DispatchModule {}
