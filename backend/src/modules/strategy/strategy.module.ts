import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { QueueModule } from "../queue/queue.module";
import { Guess } from "./entities/guess.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";
import { StrategyRun } from "./entities/strategy-run.entity";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";
import { GroqRateLimitHold } from "./entities/groq-rate-limit-hold.entity";
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";
import { MistralRateLimitHold } from "./entities/mistral-rate-limit-hold.entity";
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";
import { StrategyController } from "./strategy.controller";
import { StrategyService } from "./strategy.service";
import { LlmStrategyRunner } from "./llm-strategy-runner.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { OrchestratorService } from "./orchestrator.service";
import { CategoryEvaluatorService } from "./category-evaluator.service";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";
import { OpenRouterRateLimitHoldService } from "./openrouter-rate-limit-hold.service";
import { MistralRateLimitHoldService } from "./mistral-rate-limit-hold.service";
import { MistralRpdResumeService } from "./mistral-rpd-resume.service";
import { MistralRpdResumeBootstrap } from "./mistral-rpd-resume.bootstrap";
import { SambaNovaRateLimitHoldService } from "./sambanova-rate-limit-hold.service";
import { OpenRouterRpdResumeService } from "./openrouter-rpd-resume.service";
import { OpenRouterRpdResumeBootstrap } from "./openrouter-rpd-resume.bootstrap";
import { GoogleRpdResumeService } from "./google-rpd-resume.service";
import { GoogleRpdResumeBootstrap } from "./google-rpd-resume.bootstrap";
import { GroqRpdResumeService } from "./groq-rpd-resume.service";
import { GroqRpdResumeBootstrap } from "./groq-rpd-resume.bootstrap";
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
      GoogleRateLimitHold,
      GroqRateLimitHold,
      OpenRouterRateLimitHold,
      MistralRateLimitHold,
      SambaNovaRateLimitHold,
    ]),
    QueueModule,
    GameModule,
    SupportedModelModule,
  ],
  controllers: [StrategyController],
  providers: [
    StrategyService,
    StrategyRunStore,
    LlmStrategyRunner,
    OrchestratorService,
    CategoryEvaluatorService,
    FreeTierUsageService,
    GoogleRateLimitHoldService,
    GoogleRpdResumeService,
    GoogleRpdResumeBootstrap,
    GroqRateLimitHoldService,
    GroqRpdResumeService,
    GroqRpdResumeBootstrap,
    OpenRouterRateLimitHoldService,
    OpenRouterRpdResumeService,
    OpenRouterRpdResumeBootstrap,
    MistralRateLimitHoldService,
    MistralRpdResumeService,
    MistralRpdResumeBootstrap,
    SambaNovaRateLimitHoldService,
  ],
  exports: [
    StrategyService,
    LlmStrategyRunner,
    CategoryEvaluatorService,
    FreeTierUsageService,
    GoogleRateLimitHoldService,
    GoogleRpdResumeService,
    GroqRateLimitHoldService,
    GroqRpdResumeService,
    OpenRouterRateLimitHoldService,
    OpenRouterRpdResumeService,
    MistralRateLimitHoldService,
    MistralRpdResumeService,
    SambaNovaRateLimitHoldService,
  ],
})
export class StrategyModule {}
