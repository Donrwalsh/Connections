import { Controller, Get, Inject, Param } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { GameService } from "./game.service";

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
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  getPuzzleByDate(@Param("date") date: string) {
    return this.gameService.getDatesPuzzle(date);
  }
}
