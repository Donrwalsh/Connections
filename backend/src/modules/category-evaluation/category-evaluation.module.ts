import { Module } from "@nestjs/common";
import { StrategyModule } from "../strategy/strategy.module";
import { CategoryEvaluationController } from "./category-evaluation.controller";

/**
 * HTTP surface for the LLM category-accuracy judge. CategoryEvaluatorService
 * itself lives in StrategyModule (getRunHistory / getLeaderboard read
 * CategoryEvaluation too); this module only wires up the controller, the
 * same way DispatchModule does for its routes.
 */
@Module({
  imports: [StrategyModule],
  controllers: [CategoryEvaluationController],
})
export class CategoryEvaluationModule {}
