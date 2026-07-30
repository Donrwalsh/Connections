import { Controller, Inject, Get } from "@nestjs/common";
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

    // Normalize today to start-of-day UTC for clean comparison
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
        // Handles missing puzzles for specific dates gracefully
        console.warn(`Skipping date ${dateStr}: Puzzle not found.`);
      }

      // Increment date by 1 day
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return {
      message: `Jobs added to queue for ${queuedDates.length} puzzles`,
      queuedDates,
    };
  }
}
