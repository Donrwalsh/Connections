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
    const startDateStr = "2023-06-12";
    const todayStr = new Date().toISOString().split("T")[0];
    const strategyName = "alphabetical";

    // 1. Fetch all matching puzzles in a SINGLE database query
    const puzzlesToRun = await this.strategyService.getUnfinishedPuzzles(
      startDateStr,
      todayStr,
      strategyName,
    );

    // 2. Dispatch all jobs in parallel
    await Promise.all(
      puzzlesToRun.map((puzzle) =>
        this.strategyService.triggerRun(puzzle.id, strategyName),
      ),
    );

    const queuedDates = puzzlesToRun.map((p) => p.date);

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
