import { Module } from "@nestjs/common";
import { StrategyModule } from "../strategy/strategy.module";
import { GameModule } from "../game/game.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";
import { DispatchController } from "./dispatch.controller";

@Module({
  imports: [StrategyModule, GameModule, SupportedModelModule],
  controllers: [DispatchController],
})
export class DispatchModule {}
