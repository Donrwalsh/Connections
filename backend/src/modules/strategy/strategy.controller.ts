import {
  Controller,
  Inject,
  Get,
  Param,
  Post,
  BadRequestException,
} from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { StrategyService } from "./strategy.service";
import { GameService } from "../game/game.service";

const VALID_STRATEGIES = [
  "alphabetical",
  "reverse-alphabetical",
  "order",
  "reverse-order",
] as const;

@Controller("strategy")
export class StrategyController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(GameService) private readonly gameService: GameService,
  ) {}

  @Post("queue/:strategyName/:date")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', or 'all'",
    example: "all",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  async queueSingleStrategy(
    @Param("strategyName") strategyName: string,
    @Param("date") date: string,
  ) {
    const isAll = strategyName.toLowerCase() === "all";

    if (!isAll && !VALID_STRATEGIES.includes(strategyName as any)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected 'all' or one of: ${VALID_STRATEGIES.join(", ")}.`,
      );
    }

    if (!this.gameService.isValidYYYYMMDD(date)) {
      throw new BadRequestException(
        `Invalid date format: '${date}'. Expected YYYY-MM-DD.`,
      );
    }

    const puzzleId = await this.gameService.puzzleDateToId(date);

    if (isAll) {
      await Promise.all(
        VALID_STRATEGIES.map((strat) =>
          this.strategyService.triggerRun(puzzleId, strat, date),
        ),
      );

      return {
        message: `Jobs queued for all strategies on puzzle date ${date}`,
        puzzleId,
        date,
        strategiesQueued: VALID_STRATEGIES,
      };
    }

    await this.strategyService.triggerRun(puzzleId, strategyName, date);

    return {
      message: `Job queued for strategy '${strategyName}' on puzzle date ${date}`,
      puzzleId,
      date,
      strategyName,
    };
  }

  @Get(":strategyName/puzzle/:date")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', or 'reverse-order'",
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
    if (!VALID_STRATEGIES.includes(strategyName as any)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${VALID_STRATEGIES.join(", ")}.`,
      );
    }

    return this.strategyService.getRunDetail(date, strategyName);
  }
}
