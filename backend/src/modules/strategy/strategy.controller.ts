import {
  Controller,
  Inject,
  Get,
  Param,
  ParseIntPipe,
  Query,
  DefaultValuePipe,
  BadRequestException,
} from "@nestjs/common";
import { ApiParam, ApiQuery } from "@nestjs/swagger";
import { StrategyService } from "./strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { STRATEGY_SET } from "../../strategies";

@Controller("strategy")
export class StrategyController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(FreeTierUsageService) private readonly freeTierUsageService: FreeTierUsageService,
  ) {}

  // Listed before the more specific :strategyName/... routes only for
  // readability — path shape ("models" as a literal first segment) already
  // makes it unambiguous with them regardless of registration order.
  @Get("models")
  async getSupportedModels() {
    return this.supportedModelService.findAll();
  }

  // Same reasoning as "models" above — "leaderboard" as a literal first
  // segment is unambiguous with :strategyName/... regardless of order.
  @Get("leaderboard")
  async getLeaderboard() {
    return this.strategyService.getLeaderboard();
  }

  // Same reasoning as "models"/"leaderboard" above. Two distinct routes
  // (not one route with a :tier param) so each free-tier program is a
  // fixed, self-documenting endpoint rather than an arbitrary string the
  // caller has to already know the valid values for.
  @Get("free-tier-usage/flagship")
  async getFlagshipFreeTierUsage() {
    return this.freeTierUsageService.getFlagshipUsage();
  }

  @Get("free-tier-usage/mini")
  async getMiniFreeTierUsage() {
    return this.freeTierUsageService.getMiniUsage();
  }

  // Same reasoning as "models"/"leaderboard" above. Backs the Activity
  // page's live feed — the most recent events across every strategy/model
  // (runs starting and category-judge verdicts landing), interleaved
  // newest-first, not scoped to one strategyName like the routes below.
  @Get("activity/recent")
  async getRecentActivity() {
    return this.strategyService.getRecentActivity();
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

  @Get(":strategyName/puzzle-id/:puzzleId")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', or 'llm-ollama'",
    example: "llm-openai",
  })
  @ApiParam({
    name: "puzzleId",
    type: Number,
    description: "The puzzle's numeric id (as opposed to its date)",
    example: 42,
  })
  async getRunsForPuzzleId(
    @Param("strategyName") strategyName: string,
    @Param("puzzleId", ParseIntPipe) puzzleId: number,
  ) {
    if (!STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    return this.strategyService.getRunsForPuzzleId(puzzleId, strategyName);
  }

  @Get(":strategyName/runs")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', 'llm-openai', or 'llm-ollama'",
    example: "alphabetical",
  })
  @ApiQuery({
    name: "model",
    type: String,
    required: false,
    description:
      "Narrows to one LLM model's runs (ignored for non-LLM strategies). Without it, an LLM" +
      " strategy's full run history (every model) is returned, each row still priced from its" +
      " own model's rate.",
    example: "gpt-4.1-nano-2025-04-14",
  })
  @ApiQuery({ name: "page", type: Number, required: false, example: 1 })
  @ApiQuery({
    name: "limit",
    type: Number,
    required: false,
    description: "Rows per page (default 100, max 500)",
    example: 100,
  })
  @ApiQuery({
    name: "sortBy",
    type: String,
    required: false,
    description: "'puzzleDate' (default) | 'startedAt' | 'guessCount' | 'duration' | 'tokenCost'",
    example: "puzzleDate",
  })
  @ApiQuery({
    name: "sortDir",
    type: String,
    required: false,
    description: "'asc' | 'desc' (default)",
    example: "desc",
  })
  @ApiQuery({
    name: "status",
    type: String,
    required: false,
    description:
      "Narrows to one run status: 'running' | 'completed' | 'failed' | 'duplicate' |" +
      " 'malformedResponse' | 'error' | 'rateLimitedDaily'. Omitted or unrecognized" +
      " values return every status.",
    example: "completed",
  })
  async getRunHistory(
    @Param("strategyName") strategyName: string,
    @Query("model") model: string | undefined,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query("sortBy") sortBy?: string,
    @Query("sortDir") sortDir?: string,
    @Query("status") status?: string,
  ) {
    if (!STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    return this.strategyService.getRunHistory(strategyName, {
      model,
      page,
      limit,
      sortBy,
      sortDir,
      status,
    });
  }

  // Looked up directly by the run's primary key rather than nested under
  // :strategyName/puzzle/:date/run/:trialNumber — the leaderboard's
  // individual-run page already has the runId (from getRunsForPuzzleId
  // above) and this way doesn't need to also carry the date/trialNumber
  // around just to re-derive it.
  @Get("run/:runId")
  @ApiParam({
    name: "runId",
    type: Number,
    description: "The strategy run's numeric id",
    example: 4200,
  })
  async getRunDetailByRunId(
    @Param("runId", ParseIntPipe) runId: number,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(200), ParseIntPipe) limit: number,
  ) {
    return this.strategyService.getRunDetailByRunId(runId, page, limit);
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
