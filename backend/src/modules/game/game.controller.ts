import { Controller, Get, Header, Inject, Param, ParseIntPipe, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiParam } from "@nestjs/swagger";
import { GameService } from "./game.service";

@Controller("game")
export class GameController {
  constructor(@Inject(GameService) private readonly gameService: GameService) {}

  @Get("data/latest_date")
  getLatestDate() {
    return this.gameService.getLatestDate();
  }

  // Puzzles are immutable once ingested, so their date never changes —
  // cacheable indefinitely, same as puzzle/:date below.
  @Get("puzzle-id/:id")
  @Header("Cache-Control", "public, max-age=86400, immutable")
  @ApiParam({
    name: "id",
    type: Number,
    description: "The puzzle's numeric id (as opposed to its date)",
    example: 42,
  })
  async getPuzzleDateById(@Param("id", ParseIntPipe) id: number) {
    const date = await this.gameService.puzzleIdToDate(id);
    return { id, date };
  }

  // Puzzles are immutable once ingested, so a short browser cache here
  // (5 min) covers midnight rollover without serving stale boards for long.
  @Get("puzzle/today")
  @Header("Cache-Control", "public, max-age=300")
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
  async getPuzzleByDate(@Param("date") date: string, @Res({ passthrough: true }) res: Response) {
    const puzzle = await this.gameService.getDatesPuzzle(date);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return puzzle;
  }
}
