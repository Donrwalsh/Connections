import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { QueueModule } from "../queue/queue.module";
import { Guess } from "./entities/guess.entity";
import { StrategyRun } from "./entities/strategy-run.entity";
import { StrategyController } from "./strategy.controller";
import { StrategyService } from "./strategy.service";
import { GameModule } from "../game/game.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Puzzle, StrategyRun, Guess]),
    QueueModule,
    GameModule,
  ],
  controllers: [StrategyController],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class StrategyModule {}
