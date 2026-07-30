import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Pool } from "pg";
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
  providers: [
    {
      provide: "PG",
      useFactory: async () => {
        const pool = new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        });

        return pool;
      },
    },
    StrategyService,
  ],
  exports: [StrategyService],
})
export class StrategyModule {}
