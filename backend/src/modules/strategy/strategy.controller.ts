import { Controller, Inject, Get, Param } from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { StrategyService } from "./strategy.service";
import { GameService } from "../game/game.service";

@Controller("strategy")
export class StrategyController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(GameService) private readonly gameService: GameService,
  ) {}

  @Get("queue")
  async queue() {
    const startDate = new Date("2023-06-12T00:00:00Z");
    const today = new Date();

    today.setUTCHours(0, 0, 0, 0);

    const queuedDates: string[] = [];
    const currentDate = new Date(startDate);

    while (currentDate <= today) {
      const dateStr = currentDate.toISOString().split("T")[0];

      try {
        const puzzleId = await this.gameService.puzzleDateToId(dateStr);
        await this.strategyService.triggerRun(puzzleId, "alphabetical");
        queuedDates.push(dateStr);
      } catch (error) {
        console.warn(`Skipping date ${dateStr}: Puzzle not found.`);
      }

      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return {
      message: `Jobs added to queue for ${queuedDates.length} puzzles`,
      queuedDates,
    };
  }

  @Get(":strategyName/puzzle/:date")
  @ApiParam({
    name: "strategyName",
    type: String,
    description: "Strategy identifier, e.g. 'alphabetical'",
    example: "alphabetical",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  async getRunForPuzzle(
    @Param("strategyName") strategyName: string,
    @Param("date") date: string,
  ) {
    return this.strategyService.getRunDetail(date, strategyName);
  }
}
