import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { loadEnv } from "./config/env";
import { GameModule } from "./modules/game/game.module";
import { AnswerGroup } from "./modules/game/entities/answer-group.entity";
import { GroupMember } from "./modules/game/entities/group-member.entity";
import { Puzzle } from "./modules/game/entities/puzzle.entity";
import { StrategyModule } from "./modules/strategy/strategy.module";
import { Guess } from "./modules/strategy/entities/guess.entity";
import { LlmProposal } from "./modules/strategy/entities/llm-proposal.entity";
import { StrategyRun } from "./modules/strategy/entities/strategy-run.entity";

@Module({
  imports: [
    // Global configuration — validate fails fast on missing required secrets.
    ConfigModule.forRoot({
      isGlobal: true,
      validate: loadEnv,
    }),

    TypeOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [Puzzle, AnswerGroup, GroupMember, StrategyRun, Guess, LlmProposal],
      synchronize: false,
      migrations: [__dirname + "/migrations/*{.ts,.js}"],
      migrationsRun: true,
    }),

    // Sensible global default; the OpenAI-backed /api/solve route is
    // throttled much more aggressively in AppController.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Feature Modules
    GameModule,
    StrategyModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
