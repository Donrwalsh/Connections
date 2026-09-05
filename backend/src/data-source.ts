import "reflect-metadata";
import { DataSource } from "typeorm";
import { AnswerGroup } from "./modules/game/entities/answer-group.entity";
import { GroupMember } from "./modules/game/entities/group-member.entity";
import { Puzzle } from "./modules/game/entities/puzzle.entity";
import { Guess } from "./modules/strategy/entities/guess.entity";
import { LlmProposal } from "./modules/strategy/entities/llm-proposal.entity";
import { SolvePrompt } from "./modules/strategy/entities/solve-prompt.entity";
import { CategoryEvaluation } from "./modules/strategy/entities/category-evaluation.entity";
import { GoogleRateLimitHold } from "./modules/strategy/entities/google-rate-limit-hold.entity";
import { GroqRateLimitHold } from "./modules/strategy/entities/groq-rate-limit-hold.entity";
import { StrategyRun } from "./modules/strategy/entities/strategy-run.entity";
import { SupportedModel } from "./modules/supported-model/entities/supported-model.entity";
import { ModelPrice } from "./modules/supported-model/entities/model-price.entity";
import { FreeTierDispatchState } from "./modules/free-tier-dispatch/entities/free-tier-dispatch-state.entity";
import { AutomationRunLog } from "./modules/automation/entities/automation-run-log.entity";
import { GoogleDispatchState } from "./modules/google-free-dispatch/entities/google-dispatch-state.entity";
import { GroqDispatchState } from "./modules/groq-free-dispatch/entities/groq-dispatch-state.entity";

/**
 * Standalone DataSource used by the TypeORM CLI (migration:generate/run/
 * revert). The NestJS app configures its own connection in AppModule with the
 * same entities and migrations.
 */
export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: process.env.DB_NAME ?? "mydb",
  entities: [
    Puzzle,
    AnswerGroup,
    GroupMember,
    StrategyRun,
    Guess,
    LlmProposal,
    SolvePrompt,
    CategoryEvaluation,
    GoogleRateLimitHold,
    GroqRateLimitHold,
    SupportedModel,
    ModelPrice,
    FreeTierDispatchState,
    AutomationRunLog,
    GoogleDispatchState,
    GroqDispatchState,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  synchronize: false,
});
