import {
  Controller,
  Inject,
  Post,
  Param,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { ApiParam } from "@nestjs/swagger";
import { StrategyService } from "../strategy/strategy.service";
import { GameService } from "../game/game.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { AUTOMATIC_STRATEGIES, LLM_STRATEGIES, STRATEGY_SET, isLlmStrategy } from "../../strategies";

@Controller("dispatch")
export class DispatchController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
  ) {}

  @Post("strategy/:strategyName/:date")
  @ApiParam({
    name: "strategyName",
    type: String,
    description:
      "Strategy identifier: 'alphabetical', 'reverse-alphabetical', 'order', 'reverse-order', 'shuffle-smart', 'shuffle-foolish', or 'all'. The LLM strategies ('llm-openai', 'llm-ollama') are not accepted by this endpoint.",
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

    if (!isAll && isLlmStrategy(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. This endpoint does not accept the LLM strategies (${LLM_STRATEGIES.join(", ")}).`,
      );
    }

    if (!isAll && !STRATEGY_SET.has(strategyName)) {
      throw new BadRequestException(
        `Invalid strategy: '${strategyName}'. Expected 'all' or one of: ${[...STRATEGY_SET].join(", ")}.`,
      );
    }

    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    if (isAll) {
      // AUTOMATIC_STRATEGIES excludes both LLM strategies, so no model is
      // ever needed on this branch.
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

  @Post("model/:modelName/:date")
  @ApiParam({
    name: "modelName",
    type: String,
    description:
      "A model name from the SupportedModel table. Its strategyName column determines which" +
      " strategy queue the run is dispatched on — the caller does not name the strategy directly." +
      " Rejected if the model is unknown or not currently marked supported.",
    example: "gpt-4.1-nano-2025-04-14",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  async queueModel(@Param("modelName") modelName: string, @Param("date") date: string) {
    const strategyName = await this.supportedModelService.resolveSupportedStrategy(modelName);
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    await this.strategyService.triggerStrategyRuns(puzzleId, strategyName, date, modelName);

    return {
      message: `Jobs queued for model '${modelName}' (strategy '${strategyName}') on puzzle date ${date}`,
      puzzleId,
      date,
      strategyName,
      modelName,
    };
  }

  @Post("model/:modelName/runs/:n")
  @ApiParam({
    name: "modelName",
    type: String,
    description:
      "A model name from the SupportedModel table. Its strategyName column determines which" +
      " strategy queue the runs are dispatched on. Rejected if the model is unknown or not" +
      " currently marked supported.",
    example: "gpt-4.1-nano-2025-04-14",
  })
  @ApiParam({
    name: "n",
    type: Number,
    description:
      "Number of puzzle dates to queue this model against. The endpoint randomly picks `n`" +
      " puzzle dates this model has never been run on and queues one trial for each — it does" +
      " not accept explicit dates. Rejected (queuing nothing) if fewer than `n` such dates exist.",
    example: 5,
  })
  async queueModelRuns(
    @Param("modelName") modelName: string,
    @Param("n", ParseIntPipe) n: number,
  ) {
    if (n < 1) {
      throw new BadRequestException(`'n' must be a positive integer, got ${n}.`);
    }

    const strategyName = await this.supportedModelService.resolveSupportedStrategy(modelName);
    const targets = await this.strategyService.findUnrunPuzzleDatesForModel(
      strategyName,
      modelName,
      n,
    );

    if (targets.length < n) {
      throw new BadRequestException(
        `Only ${targets.length} puzzle date(s) exist that model '${modelName}' has not already` +
          ` been run on (requested ${n}).`,
      );
    }

    await Promise.all(
      targets.map((target) =>
        this.strategyService.triggerStrategyRuns(target.puzzleId, strategyName, target.date, modelName),
      ),
    );

    return {
      message: `Jobs queued for model '${modelName}' (strategy '${strategyName}') on ${n} puzzle date(s)`,
      strategyName,
      modelName,
      dates: targets.map((target) => target.date),
    };
  }
}
