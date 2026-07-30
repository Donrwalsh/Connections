import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule } from "@nestjs/config";
import { GameModule } from "./modules/game/game.module";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AnswerGroup } from "./modules/game/entities/answer-group.entity";
import { GroupMember } from "./modules/game/entities/group-member.entity";
import { Puzzle } from "./modules/game/entities/puzzle.entity";
import { StrategyModule } from "./modules/strategy/strategy.module";
import { Guess } from "./modules/strategy/entities/guess.entity";
import { StrategyRun } from "./modules/strategy/entities/strategy-run.entity";

@Module({
  imports: [
    // Global configurations (optional but recommended)
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [Puzzle, AnswerGroup, GroupMember, StrategyRun, Guess],
      synchronize: false,
    }),

    // Feature Modules
    GameModule,
    StrategyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
