import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { QueueModule } from "../queue/queue.module";
import { Guess } from "./entities/guess.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";
import { StrategyRun } from "./entities/strategy-run.entity";
import { RateLimitHold } from "./entities/rate-limit-hold.entity";
import { StrategyController } from "./strategy.controller";
import { StrategyService } from "./strategy.service";
import { DeterministicSolver } from "./deterministic-solver.service";
import { StrategyDispatch } from "./strategy-dispatch.service";
import { LlmStrategyRunner } from "./llm-strategy-runner.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { OrchestratorService } from "./orchestrator.service";
import { CategoryEvaluatorService } from "./category-evaluator.service";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { RateLimitHoldService } from "./rate-limit-hold.service";
import { RpdResumeService } from "../provider-pool/rpd-resume.service";
import { RpdResumeBootstrap } from "../provider-pool/rpd-resume.bootstrap";
import { GameModule } from "../game/game.module";
import { SupportedModelModule } from "../supported-model/supported-model.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Puzzle,
      StrategyRun,
      Guess,
      LlmProposal,
      SolvePrompt,
      CategoryEvaluation,
      RateLimitHold,
    ]),
    QueueModule,
    GameModule,
    SupportedModelModule,
  ],
  controllers: [StrategyController],
  providers: [
    StrategyService,
    DeterministicSolver,
    StrategyDispatch,
    StrategyRunStore,
    LlmStrategyRunner,
    OrchestratorService,
    CategoryEvaluatorService,
    FreeTierUsageService,
    RateLimitHoldService,
    RpdResumeService,
    RpdResumeBootstrap,
  ],
  exports: [
    StrategyService,
    StrategyDispatch,
    LlmStrategyRunner,
    CategoryEvaluatorService,
    FreeTierUsageService,
    RateLimitHoldService,
    RpdResumeService,
  ],
})
export class StrategyModule {}
