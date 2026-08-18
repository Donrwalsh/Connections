import "reflect-metadata";
import { DataSource } from "typeorm";
import { AnswerGroup } from "./modules/game/entities/answer-group.entity";
import { GroupMember } from "./modules/game/entities/group-member.entity";
import { Puzzle } from "./modules/game/entities/puzzle.entity";
import { Guess } from "./modules/strategy/entities/guess.entity";
import { LlmProposal } from "./modules/strategy/entities/llm-proposal.entity";
import { SolvePrompt } from "./modules/strategy/entities/solve-prompt.entity";
import { StrategyRun } from "./modules/strategy/entities/strategy-run.entity";
import { SupportedModel } from "./modules/supported-model/entities/supported-model.entity";

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
    SupportedModel,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  synchronize: false,
});
