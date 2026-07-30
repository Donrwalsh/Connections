import { Controller, Get, Param } from "@nestjs/common";
import { GameService } from "./game.service";

@Controller("game")
export class GameController {
  constructor(private readonly gameService: GameService) {}

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
}
