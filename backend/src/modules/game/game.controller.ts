import { Controller, Get, Inject, Param } from "@nestjs/common";
import { GameService } from "./game.service";
import { strategyQueue } from "../queue/strategy.queue";

@Controller("game")
export class GameController {
  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  @Get("data/latest_date")
  getLatestDate() {
    return this.gameService.getLatestDate();
  }

  @Get("puzzle/today")
  getTodaysPuzzle() {
    return this.gameService.getTodaysPuzzle();
  }

  @Get("puzzle/:date")
  getPuzzleByDate(@Param("date") date: string) {
    return this.gameService.getDatesPuzzle(date);
  }

  @Get("queue")
  async queue() {
    await this.gameService.triggerRun("2023-08-01", "random");
    return { message: "Job added to the queue" };
  }
}
