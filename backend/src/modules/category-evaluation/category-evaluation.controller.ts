import { Controller, Inject, Post, Get, Delete, Param, Query, UseGuards, ParseIntPipe } from "@nestjs/common";
import { ApiBody, ApiParam, ApiQuery } from "@nestjs/swagger";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { DispatchAuthGuard } from "../dispatch/dispatch-auth.guard";
import { DispatchAuthDto } from "../dispatch/dto/dispatch-auth.dto";

/**
 * The LLM category-accuracy judge's own routes, split off from
 * DispatchController: enqueue a judging batch, read backlog coverage, and
 * wipe one run's verdicts so it can be re-judged. The paid-call routes are
 * password-gated by the same DispatchAuthGuard as the dispatch routes.
 */
@Controller("category-evaluation")
export class CategoryEvaluationController {
  constructor(
    @Inject(CategoryEvaluatorService)
    private readonly categoryEvaluatorService: CategoryEvaluatorService,
  ) {}

  // Enqueues one LLM-judge job per most-recent successful LLM guess that has
  // no CategoryEvaluation yet — one job per proposal, onto the judge
  // provider's LLM queue (see CategoryEvaluatorService). Password-gated like
  // the other paid-call routes.
  @Post("dispatch")
  @UseGuards(DispatchAuthGuard)
  @ApiQuery({
    name: "limit",
    type: Number,
    required: false,
    description: "How many un-evaluated proposals to enqueue (default 50, max 500).",
    example: 50,
  })
  @ApiBody({ type: DispatchAuthDto })
  async dispatch(@Query("limit", new ParseIntPipe({ optional: true })) limit?: number) {
    const result = await this.categoryEvaluatorService.enqueuePending({ limit });
    return {
      message: `Enqueued ${result.enqueued} category-evaluation job(s)`,
      ...result,
    };
  }

  // Read-only judge-coverage totals for the Activity page's "Category
  // judging" widget: how many successful LLM guesses are judge-eligible,
  // how many have been judged, and how many still need a dispatch. Not
  // password-gated — it enqueues nothing.
  @Get("coverage")
  async coverage() {
    return this.categoryEvaluatorService.getCoverage();
  }

  // How many CategoryEvaluation rows are failed judge calls (status
  // 'callError'). Read-only, un-gated — backs the maintenance panel's
  // "delete failed judge calls" button (the figure it would remove).
  @Get("failed")
  async failedCount() {
    return this.categoryEvaluatorService.countFailedEvaluations();
  }

  // Bulk-deletes every failed judge call (CategoryEvaluation with status
  // 'callError') across all runs. Each removed row leaves its proposal
  // un-evaluated again, so the next un-forced /category-evaluation/dispatch
  // re-enqueues it — for requeueing judge calls that failed on a
  // since-fixed problem. Password-gated like the other mutating routes.
  @Delete("failed")
  @UseGuards(DispatchAuthGuard)
  @ApiBody({ type: DispatchAuthDto })
  async deleteFailedEvaluations() {
    const result = await this.categoryEvaluatorService.deleteFailedEvaluations();
    return {
      message: `Deleted ${result.deleted} failed judge call(s); the next dispatch will re-judge them`,
      ...result,
    };
  }

  // Wipes every CategoryEvaluation row for one strategy run so it can be
  // re-judged from scratch. Modelled on DELETE /dispatch/run/:runId:
  // password-gated, 404s on an unknown run id.
  @Delete("run/:runId")
  @UseGuards(DispatchAuthGuard)
  @ApiParam({
    name: "runId",
    type: Number,
    description: "The strategy run's numeric id",
    example: 12292,
  })
  @ApiBody({ type: DispatchAuthDto })
  async deleteRunEvaluations(@Param("runId", ParseIntPipe) runId: number) {
    const result = await this.categoryEvaluatorService.deleteRunEvaluations(runId);
    return {
      message: `Deleted ${result.deleted} category evaluation(s) for run ${runId}`,
      runId,
      ...result,
    };
  }
}
