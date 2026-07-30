import { Module } from "@nestjs/common";
import { Pool } from "pg";
import { QueueModule } from "../queue/queue.module";
import { GameController } from "./game.controller";
import { GameService } from "./game.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AnswerGroup } from "./entities/answer-group.entity";
import { GroupMember } from "./entities/group-member.entity";
import { Puzzle } from "./entities/puzzle.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([Puzzle, AnswerGroup, GroupMember]),
    QueueModule,
  ],
  controllers: [GameController],
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
    GameService,
  ],
  exports: [GameService],
})
export class GameModule {}
