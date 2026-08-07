import {
  Controller,
  Inject,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  DefaultValuePipe,
  BadRequestException,
} from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { StrategyService } from "./strategy.service";
import { GameService } from "../game/game.service";
import { AUTOMATIC_STRATEGIES, LLM, STRATEGY_SET } from "../../strategies";

@Controller("strategy")
export class StrategyController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(GameService) private readonly gameService: GameService,
  ) {}

  // Dedicated LLM queue endpoint. Declared before the generic
  // queue/:strategyName/:date route so the more specific pattern wins.
  @Post("queue/llm/:date")
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  async queueLlmStrategy(@Param("date") date: string) {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    await this.strategyService.triggerStrategyRuns(puzzleId, LLM, date);

    return {
      message: `LLM job queued for puzzle date ${date}`,
      puzzleId,
      date,
      strategyName: LLM,
      trialNumber: 0,
    };
  }

  @Post("queue/:strategyName/:date")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', or 'all' (excludes 'llm' — use POST /strategy/queue/llm/:date for that)",
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

    if (!isAll && !STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected 'all' or one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    if (isAll) {
      await Promise.all(
        AUTOMATIC_STRATEGIES.map((strat) =>
          this.strategyService.triggerStrategyRuns(puzzleId, strat, date),
        ),
      );

      return {
        message: `Jobs queued for all automatic strategies on puzzle date ${date} (llm is excluded — queue it explicitly)`,
        puzzleId,
        date,
        strategiesQueued: [...AUTOMATIC_STRATEGIES],
        excluded: [LLM],
      };
    }

    await this.strategyService.triggerStrategyRuns(puzzleId, strategyName, date);

    return {
      message: `Jobs queued for strategy '${strategyName}' on puzzle date ${date}`,
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
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', or 'llm'",
    example: "alphabetical",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  async getRunsForPuzzle(@Param("strategyName") strategyName: string, @Param("date") date: string) {
    if (!STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    return this.strategyService.getRunsForPuzzle(date, strategyName);
  }

  @Get(":strategyName/puzzle/:date/run/:trialNumber")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', or 'llm'",
    example: "alphabetical",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  @ApiParam({
    name: "trialNumber",
    type: Number,
    description: "Run trial number (0 for deterministic strategies, 1..N for shuffle strategies)",
    example: 0,
  })
  async getRunDetail(
    @Param("strategyName") strategyName: string,
    @Param("date") date: string,
    @Param("trialNumber", ParseIntPipe) trialNumber: number,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ) {
    if (!STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    return this.strategyService.getRunDetail(date, strategyName, trialNumber, page, limit);
  }
}
