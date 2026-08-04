import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { GameController } from "./game.controller";
import { GameService } from "./game.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AnswerGroup } from "./entities/answer-group.entity";
import { GroupMember } from "./entities/group-member.entity";
import { Puzzle } from "./entities/puzzle.entity";
import { PuzzleIngestionService } from "./puzzle-ingestion.service";
import { PuzzleQueueBootstrap } from "./puzzle-queue.bootstrap";

@Module({
  imports: [
    TypeOrmModule.forFeature([Puzzle, AnswerGroup, GroupMember]),
    QueueModule,
  ],
  controllers: [GameController],
  providers: [GameService, PuzzleIngestionService, PuzzleQueueBootstrap],
  exports: [GameService, PuzzleIngestionService],
})
export class GameModule {}
