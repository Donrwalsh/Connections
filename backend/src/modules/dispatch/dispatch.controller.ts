import {
  Controller,
  Inject,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  BadRequestException,
} from "@nestjs/common";
import { ApiBody, ApiParam, ApiQuery } from "@nestjs/swagger";
import { StrategyService } from "../strategy/strategy.service";
import { GameService } from "../game/game.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import {
  FreeTierDispatchService,
  FreeTierDispatchStatusDto,
} from "../free-tier-dispatch/free-tier-dispatch.service";
import { FreeTierId } from "../strategy/free-tier-usage.service";
import { AUTOMATIC_STRATEGIES, LLM_STRATEGIES, STRATEGY_SET, isLlmStrategy } from "../../strategies";
import { DispatchAuthGuard } from "./dispatch-auth.guard";
import { DispatchAuthDto } from "./dto/dispatch-auth.dto";

const DEFAULT_FREE_TIER_DISPATCH_THRESHOLD_PERCENT = 90;

// The only two real programs — see FreeTierId — that "both" fans out to.
const BOTH_FREE_TIERS: readonly FreeTierId[] = ["flagship", "mini"];

// A per-tier outcome when "both" is requested — start() can reject for one
// tier (e.g. already running) without that stopping the other from
// starting, so each tier's own result (success or failure) is reported
// independently rather than the whole request failing on the first error.
interface FreeTierDispatchOutcome {
  tier: FreeTierId;
  status: FreeTierDispatchStatusDto | null;
  error: string | null;
}

@Controller("dispatch")
export class DispatchController {
  constructor(
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(FreeTierDispatchService) private readonly freeTierDispatchService: FreeTierDispatchService,
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
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "modelName",
    type: String,
    description:
      "A model name from the SupportedModel table. Its strategyName column determines which" +
      " strategy queue the run is dispatched on — the caller does not name the strategy directly." +
      " Rejected if the model is unknown or not currently marked supported.",
    example: "gpt-4.1-nano",
  })
  @ApiParam({
    name: "date",
    type: String,
    description: "Puzzle date in YYYY-MM-DD format",
    example: "2023-08-01",
  })
  @ApiBody({ type: DispatchAuthDto })
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
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "modelName",
    type: String,
    description:
      "A model name from the SupportedModel table. Its strategyName column determines which" +
      " strategy queue the runs are dispatched on. Rejected if the model is unknown or not" +
      " currently marked supported.",
    example: "gpt-4.1-nano",
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
  @ApiBody({ type: DispatchAuthDto })
  async queueModelRuns(@Param("modelName") modelName: string, @Param("n", ParseIntPipe) n: number) {
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

  // Starts (or, if already running, rejects) a continuous background
  // dispatch cycle: queues llm-openai trials for `tier`'s models — evenly
  // spread across them — until today's usage reaches `threshold`% of the
  // tier's daily free-token budget. See FreeTierDispatchService for how the
  // cycle paces itself and stays under the threshold. `tier` also accepts
  // 'both', which starts flagship and mini independently under the same
  // threshold and reports each one's own outcome (see startBothFreeTiers).
  @Post("free-tier/:tier")
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "tier",
    type: String,
    description:
      "Free-tier program id (see GET /strategy/free-tier-usage/:tier): 'flagship', 'mini', or" +
      " 'both' (starts both under the same threshold, independently).",
    example: "mini",
  })
  @ApiQuery({
    name: "threshold",
    type: Number,
    required: false,
    description: "Stop once usage reaches this percent of the tier's daily token budget (default 90).",
    example: 90,
  })
  @ApiBody({ type: DispatchAuthDto })
  async startFreeTierDispatch(@Param("tier") tier: string, @Query("threshold") thresholdRaw?: string) {
    const thresholdPercent =
      thresholdRaw === undefined
        ? DEFAULT_FREE_TIER_DISPATCH_THRESHOLD_PERCENT
        : Number(thresholdRaw);

    if (tier === "both") {
      return this.startBothFreeTiers(thresholdPercent);
    }

    return this.freeTierDispatchService.start(tier as FreeTierId, thresholdPercent);
  }

  // Deactivates `tier`'s dispatch cycle so it stops scheduling further
  // ticks — a no-op (not an error) if it wasn't running. `tier` also accepts
  // 'both', stopping flagship and mini together.
  @Delete("free-tier/:tier")
  @ApiParam({
    name: "tier",
    type: String,
    description: "Free-tier program id: 'flagship', 'mini', or 'both' (stops both).",
    example: "mini",
  })
  async stopFreeTierDispatch(@Param("tier") tier: string) {
    if (tier === "both") {
      const [flagship, mini] = await Promise.all(
        BOTH_FREE_TIERS.map((t) => this.freeTierDispatchService.stop(t)),
      );
      return { flagship, mini };
    }

    return this.freeTierDispatchService.stop(tier as FreeTierId);
  }

  // Starts flagship and mini concurrently under the same threshold. stop()
  // can't fail, but start() rejects a tier that's already running — so
  // unlike the DELETE fan-out above, each tier's start is caught
  // independently: one tier already being active (or otherwise rejecting)
  // doesn't prevent the other from starting, and the response reports both
  // outcomes rather than a single opaque 400 that would hide a partial
  // success.
  private async startBothFreeTiers(
    thresholdPercent: number,
  ): Promise<{ flagship: FreeTierDispatchOutcome; mini: FreeTierDispatchOutcome }> {
    const startOne = async (t: FreeTierId): Promise<FreeTierDispatchOutcome> => {
      try {
        const status = await this.freeTierDispatchService.start(t, thresholdPercent);
        return { tier: t, status, error: null };
      } catch (err) {
        return {
          tier: t,
          status: null,
          error: err instanceof Error ? err.message : "Failed to start free-tier dispatch",
        };
      }
    };

    const [flagship, mini] = await Promise.all(BOTH_FREE_TIERS.map(startOne));
    return { flagship, mini };
  }

  // Backs the leaderboard page's "is free-tier dispatch running, and at
  // what threshold" indicator.
  @Get("free-tier/:tier")
  @ApiParam({ name: "tier", type: String, example: "mini" })
  async getFreeTierDispatchStatus(@Param("tier") tier: string) {
    return this.freeTierDispatchService.getStatus(tier as FreeTierId);
  }

  // Permanently deletes a strategy run and every row that belongs to it —
  // for scrubbing a run that errored out after the underlying bug is fixed
  // in code, so a rerun doesn't leave the broken attempt cluttering its
  // history. Guarded like the other mutating dispatch routes: rejects a
  // still-'running' run (see StrategyRunStore.deleteRun) rather than racing
  // whatever worker is still writing to it.
  @Delete("run/:runId")
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "runId",
    type: Number,
    description: "The strategy run's numeric id",
    example: 12292,
  })
  @ApiBody({ type: DispatchAuthDto })
  async deleteRun(@Param("runId", ParseIntPipe) runId: number) {
    const result = await this.strategyService.deleteRun(runId);
    return {
      message: `Deleted strategy run ${runId} and all related data`,
      runId,
      ...result,
    };
  }
}
