import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AppEnv, loadEnv } from "./config/env";
import { GameModule } from "./modules/game/game.module";
import { AnswerGroup } from "./modules/game/entities/answer-group.entity";
import { GroupMember } from "./modules/game/entities/group-member.entity";
import { Puzzle } from "./modules/game/entities/puzzle.entity";
import { StrategyModule } from "./modules/strategy/strategy.module";
import { DispatchModule } from "./modules/dispatch/dispatch.module";
import { Guess } from "./modules/strategy/entities/guess.entity";
import { LlmProposal } from "./modules/strategy/entities/llm-proposal.entity";
import { SolvePrompt } from "./modules/strategy/entities/solve-prompt.entity";
import { StrategyRun } from "./modules/strategy/entities/strategy-run.entity";
import { SupportedModel } from "./modules/supported-model/entities/supported-model.entity";
import { ModelPrice } from "./modules/supported-model/entities/model-price.entity";
import { FreeTierDispatchState } from "./modules/free-tier-dispatch/entities/free-tier-dispatch-state.entity";

@Module({
  imports: [
    // Global configuration — validate fails fast on missing required secrets.
    ConfigModule.forRoot({
      isGlobal: true,
      validate: loadEnv,
    }),

    // forRootAsync + ConfigService (not forRoot reading process.env
    // directly) so the DB connection uses the same validated/defaulted
    // values as everywhere else — loadEnv above is the one place those
    // defaults (e.g. DB_HOST ?? "localhost") are defined.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        type: "postgres",
        host: config.get("DB_HOST", { infer: true }),
        port: config.get("DB_PORT", { infer: true }),
        username: config.get("DB_USER", { infer: true }),
        password: config.get("DB_PASSWORD", { infer: true }),
        database: config.get("DB_NAME", { infer: true }),
        entities: [
          Puzzle,
          AnswerGroup,
          GroupMember,
          StrategyRun,
          Guess,
          LlmProposal,
          SolvePrompt,
          SupportedModel,
          ModelPrice,
          FreeTierDispatchState,
        ],
        synchronize: false,
        migrations: [__dirname + "/migrations/*{.ts,.js}"],
        migrationsRun: true,
      }),
    }),

    // Sensible global default; the OpenAI-backed /api/diagnose route is
    // throttled much more aggressively in AppController.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Feature Modules
    GameModule,
    StrategyModule,
    DispatchModule,
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
