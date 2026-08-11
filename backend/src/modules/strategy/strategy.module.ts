import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { QueueModule } from "../queue/queue.module";
import { Guess } from "./entities/guess.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { StrategyRun } from "./entities/strategy-run.entity";
import { StrategyController } from "./strategy.controller";
import { StrategyService } from "./strategy.service";
import { OrchestratorService } from "./orchestrator.service";
import { GameModule } from "../game/game.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Puzzle, StrategyRun, Guess, LlmProposal]),
    QueueModule,
    GameModule,
  ],
  controllers: [StrategyController],
  providers: [StrategyService, OrchestratorService],
  exports: [StrategyService],
})
export class StrategyModule {}
