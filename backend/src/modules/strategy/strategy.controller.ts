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
import { AUTOMATIC_STRATEGIES, LLM_STRATEGIES, STRATEGY_SET } from "../../strategies";

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
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', 'llm-ollama', or 'all' (excludes the LLM strategies — queue 'llm-openai'/'llm-ollama' explicitly to spend tokens)",
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
        message: `Jobs queued for all automatic strategies on puzzle date ${date} (LLM strategies are excluded — queue them explicitly)`,
        puzzleId,
        date,
        strategiesQueued: [...AUTOMATIC_STRATEGIES],
        excluded: [...LLM_STRATEGIES],
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
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', or 'llm-ollama'",
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
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', or 'llm-ollama'",
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
    description:
      "Run trial number (0 for deterministic strategies, 1..N for shuffle and LLM strategies)",
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

  @Get(":strategyName/puzzle/:date/run/:trialNumber/guess/:sequenceNumber")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', or 'llm-ollama'",
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
    description:
      "Run trial number (0 for deterministic strategies, 1..N for shuffle and LLM strategies)",
    example: 0,
  })
  @ApiParam({
    name: "sequenceNumber",
    type: Number,
    description: "The guess's 1-based sequence number within the run",
    example: 1,
  })
  async getGuessDetail(
    @Param("strategyName") strategyName: string,
    @Param("date") date: string,
    @Param("trialNumber", ParseIntPipe) trialNumber: number,
    @Param("sequenceNumber", ParseIntPipe) sequenceNumber: number,
  ) {
    if (!STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    return this.strategyService.getGuessDetail(date, strategyName, trialNumber, sequenceNumber);
  }
}
