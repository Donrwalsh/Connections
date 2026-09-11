import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import {
  STRATEGY_QUEUE,
  LLM_OPENAI_QUEUE,
  LLM_OLLAMA_QUEUE,
  LLM_GOOGLE_QUEUE,
  LLM_GROQ_QUEUE,
  LLM_OPENROUTER_QUEUE,
  LLM_MISTRAL_QUEUE,
  LLM_SAMBANOVA_QUEUE,
} from "../queue/queue.module";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import {
  isLlmStrategy,
  llmMaxTrialsPerModel,
  strategyTrialNumbers,
  startOfTodayUtc,
} from "../../strategies";
import { runStrategyJobId, queueForStrategy } from "../queue/strategy.queue";
import type { ProviderPoolId } from "../provider-pool/provider-pool.config";
import { StrategyRunStore } from "./strategy-run-store.service";
import { SupportedModelService } from "../supported-model/supported-model.service";

// How many waiting/delayed BullMQ jobs to fetch per page when tallying
// queued counts — see queuedCountsByModel.
const QUEUE_PAGE_SIZE = 1000;

/**
 * Dispatch support: queueing runs, routing a strategy to its provider-pool
 * queue, and the in-flight/today-count queries the free-tier dispatch cycles
 * pace against, plus run maintenance (delete/count errored). Split out of
 * the former StrategyService (see
 * docs/architecture/specs/05-split-strategy-service.md) — consumed by
 * dispatch.controller.ts and the provider-pool/free-tier-dispatch services.
 */
@Injectable()
export class StrategyDispatch {
  constructor(
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
    @Inject(LLM_GROQ_QUEUE) private readonly llmGroqQueue: Queue,
    @Inject(LLM_OPENROUTER_QUEUE) private readonly llmOpenRouterQueue: Queue,
    @Inject(LLM_MISTRAL_QUEUE) private readonly llmMistralQueue: Queue,
    @Inject(LLM_SAMBANOVA_QUEUE) private readonly llmSambaNovaQueue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(SolvePrompt) private readonly solvePromptRepo: Repository<SolvePrompt>,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
  ) {}

  /** The injected per-provider runs queues, keyed by provider-pool id — built
   * once so `queueFor` is a single map lookup with no provider branching. */
  private runsQueueByPool?: ReadonlyMap<ProviderPoolId, Queue>;

  /**
   * The queue a strategy's runs are dispatched to: a provider-pool strategy
   * gets its pool's per-provider queue, everything else the shared
   * strategy-runs queue.
   */
  private queueFor(strategyName: string): Queue {
    this.runsQueueByPool ??= new Map<ProviderPoolId, Queue>([
      ["openai", this.llmOpenAIQueue],
      ["ollama", this.llmOllamaQueue],
      ["google", this.llmGoogleQueue],
      ["groq", this.llmGroqQueue],
      ["openrouter", this.llmOpenRouterQueue],
      ["mistral", this.llmMistralQueue],
      ["sambanova", this.llmSambaNovaQueue],
    ]);
    return queueForStrategy(this.runsQueueByPool, this.queue, strategyName);
  }

  async triggerRun(
    puzzleId: number,
    strategyName: string,
    date?: string,
    trialNumber = 0,
    model?: string,
  ) {
    // LLM strategies must dispatch against an allowed, supported model — no
    // job gets queued at all if the check fails.
    if (isLlmStrategy(strategyName)) {
      await this.supportedModelService.assertSupported(strategyName, model);
    }

    await this.queueFor(strategyName).add(
      "run-strategy",
      {
        puzzleId,
        strategyName,
        date,
        trialNumber,
        model: model ?? null,
      },
      {
        // Deterministic id so duplicate enqueues of the same run collapse to a
        // single job instead of racing to create two runs.
        jobId: runStrategyJobId(puzzleId, strategyName, trialNumber),
      },
    );
  }

  /**
   * Queues run(s) for the strategy on a puzzle. Deterministic strategies get
   * a single trial (0); shuffle-smart/shuffle-foolish get one job per
   * configured trial (1..N), all at once. LLM strategies are different: each
   * call queues exactly one new trial for the given `model` (which must name
   * a currently-supported model — see SupportedModelService — or nothing is
   * queued at all), and repeated calls advance the trial number until that
   * model hits its cap (see triggerNextLlmTrial).
   */
  async triggerStrategyRuns(puzzleId: number, strategyName: string, date: string, model?: string) {
    if (isLlmStrategy(strategyName)) {
      await this.supportedModelService.assertSupported(strategyName, model);
      await this.triggerNextLlmTrial(puzzleId, strategyName, date, model as string);
      return;
    }

    const trialNumbers = strategyTrialNumbers(strategyName);
    await this.queueFor(strategyName).addBulk(
      trialNumbers.map((trialNumber) => ({
        name: "run-strategy",
        data: { puzzleId, strategyName, date, trialNumber, model: model ?? null },
        opts: { jobId: runStrategyJobId(puzzleId, strategyName, trialNumber) },
      })),
    );
  }

  /**
   * `limit` randomly chosen puzzle dates that have no StrategyRun row at all
   * for (strategyName, modelName) — i.e. this model has never been
   * dispatched against them. Backs the bulk /dispatch/model/:modelName/runs/:n
   * endpoint, which needs to pick fresh puzzles for a model without the
   * caller naming dates by hand. Random rather than oldest/newest-first so
   * repeated bulk-dispatch calls sample coverage across the whole puzzle
   * history instead of always advancing through it in the same order.
   *
   * A puzzle with only a *queued* (not yet started) job for this model still
   * counts as unrun here, since no StrategyRun row exists for it yet — two
   * bulk-dispatch calls made before a worker drains the queue can therefore
   * both select the same puzzle. That mirrors the existing race in
   * triggerNextLlmTrial/triggerStrategyRuns and isn't specific to this query.
   */
  async findUnrunPuzzleDatesForModel(
    strategyName: string,
    modelName: string,
    limit: number,
  ): Promise<{ puzzleId: number; date: string }[]> {
    const rows = await this.puzzleRepo
      .createQueryBuilder("puzzle")
      .select("puzzle.id", "puzzleId")
      // Cast to text — see the identical cast in getRunHistory: getRawMany()
      // bypasses Puzzle.date's entity-level string transformer.
      .addSelect("puzzle.date::text", "date")
      .where(
        `NOT EXISTS (
          SELECT 1 FROM "StrategyRun" run
          WHERE run."puzzleId" = puzzle.id
            AND run."strategyName" = :strategyName
            AND run."modelName" = :modelName
        )`,
        { strategyName, modelName },
      )
      .orderBy("RANDOM()")
      .limit(limit)
      .getRawMany<{ puzzleId: number; date: string }>();

    return rows.map((row) => ({ puzzleId: Number(row.puzzleId), date: row.date }));
  }

  /**
   * Today's (UTC) dispatch count per model for an LLM strategy, combining
   * StrategyRun rows already started today with jobs still waiting/delayed
   * on that strategy's queue (not yet started, so no StrategyRun row exists
   * for them yet — same reasoning as RunHistoryReadModel.queuedCountsByKey).
   * Every model in `models` is present in the returned map, 0 if it has no
   * activity today. Used by FreeTierDispatchService to keep a dispatch
   * cycle's new trials spread evenly across a tier's models rather than
   * favoring whichever model happened to be picked first.
   */
  async countTodayDispatchByModel(
    strategyName: string,
    models: readonly string[],
  ): Promise<Map<string, number>> {
    if (models.length === 0) return new Map();

    const counts = await this.queuedCountsByModel(strategyName, models);

    const dbRows = await this.strategyRunRepo
      .createQueryBuilder("run")
      .select("run.modelName", "modelName")
      .addSelect("COUNT(*)", "count")
      .where("run.strategyName = :strategyName", { strategyName })
      .andWhere("run.modelName IN (:...models)", { models })
      .andWhere("run.startedAt >= :startOfTodayUtc", { startOfTodayUtc: startOfTodayUtc() })
      .groupBy("run.modelName")
      .getRawMany<{ modelName: string; count: string }>();

    for (const row of dbRows) {
      counts.set(row.modelName, (counts.get(row.modelName) ?? 0) + Number(row.count));
    }

    return counts;
  }

  /**
   * How many model API calls this LLM strategy has made so far in the
   * current UTC day — one row per call in SolvePrompt (initial prompt,
   * re-prompt, and backend retries all count). Used by
   * OpenRouterFreeDispatchService as the account-wide daily-budget counter,
   * since OpenRouter's free tier caps *total* requests (and counts failed
   * ones), not per-model requests. "Today" is the same UTC window
   * startOfTodayUtc defines everywhere else.
   */
  async countTodayLlmCalls(strategyName: string): Promise<number> {
    return this.solvePromptRepo
      .createQueryBuilder("sp")
      .innerJoin("sp.strategyRun", "run")
      .where("run.strategyName = :strategyName", { strategyName })
      .andWhere("sp.createdAt >= :startOfTodayUtc", { startOfTodayUtc: startOfTodayUtc() })
      .getCount();
  }

  /**
   * Trials per model not yet reflected in FreeTierUsageService's token
   * totals: still RUNNING (started, not yet finished) StrategyRun rows plus
   * jobs still waiting/delayed on the queue. Unlike countTodayDispatchByModel
   * above (which counts *all* of today's activity, completed included — the
   * right basis for fair-share ranking), this deliberately excludes
   * completed/failed/etc. runs, since those are already counted in real
   * token usage and including them here would double-reserve budget for
   * tokens already spent. Used by FreeTierDispatchService to avoid
   * overcommitting a dispatch batch past a tier's threshold.
   */
  async countInFlightByModel(
    strategyName: string,
    models: readonly string[],
  ): Promise<Map<string, number>> {
    if (models.length === 0) return new Map();

    const counts = await this.queuedCountsByModel(strategyName, models);

    const runningRows = await this.strategyRunRepo
      .createQueryBuilder("run")
      .select("run.modelName", "modelName")
      .addSelect("COUNT(*)", "count")
      .where("run.strategyName = :strategyName", { strategyName })
      .andWhere("run.modelName IN (:...models)", { models })
      .andWhere("run.status = :status", { status: StrategyRunStatus.RUNNING })
      .groupBy("run.modelName")
      .getRawMany<{ modelName: string; count: string }>();

    for (const row of runningRows) {
      counts.set(row.modelName, (counts.get(row.modelName) ?? 0) + Number(row.count));
    }

    return counts;
  }

  /**
   * Permanently deletes a strategy run and every row that belongs to it —
   * see StrategyRunStore.deleteRun for what that covers and why a plain
   * cascade delete isn't enough on its own.
   */
  async deleteRun(runId: number) {
    return this.store.deleteRun(runId);
  }

  /**
   * Bulk-deletes every strategy run whose status is 'error', along with all
   * rows tied to each — see StrategyRunStore.deleteErroredRuns.
   */
  async deleteErroredRuns() {
    return this.store.deleteErroredRuns();
  }

  /**
   * How many strategy runs are currently in the 'error' status — the figure
   * the maintenance panel's "delete errored runs" button acts on.
   */
  async countErroredRuns(): Promise<{ erroredRuns: number }> {
    const erroredRuns = await this.strategyRunRepo.count({
      where: { status: StrategyRunStatus.ERROR },
    });
    return { erroredRuns };
  }

  /**
   * Waiting/delayed job counts per model on `strategyName`'s queue — the
   * "queued but not started yet" baseline shared by countTodayDispatchByModel
   * and countInFlightByModel (each then adds its own DB-side count on top).
   * Every model in `models` is present in the returned map, 0 if it has no
   * queued jobs.
   */
  private async queuedCountsByModel(
    strategyName: string,
    models: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>(models.map((model) => [model, 0]));
    const modelSet = new Set(models);
    const queue = this.queueFor(strategyName);

    for (let start = 0; ; start += QUEUE_PAGE_SIZE) {
      const jobs = await queue.getJobs(["waiting", "delayed"], start, start + QUEUE_PAGE_SIZE - 1);

      for (const job of jobs) {
        const data = job.data as { model?: string | null };
        if (data.model && modelSet.has(data.model)) {
          counts.set(data.model, (counts.get(data.model) ?? 0) + 1);
        }
      }

      if (jobs.length < QUEUE_PAGE_SIZE) break;
    }

    return counts;
  }

  /**
   * Queues a single new trial for an LLM strategy + model. The
   * LLM_TRIALS_PER_MODEL cap (llmMaxTrialsPerModel) applies per model, not
   * per strategy run as a whole — so 'llm-openai' can accumulate up to the
   * cap of 'gpt-4.1-nano' trials *and*, independently, up to the cap of a
   * second model's trials, on the same puzzle. Throws (queuing nothing) once
   * the model has already reached its cap.
   *
   * Trial numbers themselves stay a single increasing sequence across every
   * model for the (puzzle, strategy) pair — not restarted per model — so they
   * stay unique against the existing DB constraint (puzzleId, strategyName,
   * trialNumber) without a schema change; only the per-model *count* used for
   * the cap check is filtered by model.
   */
  private async triggerNextLlmTrial(
    puzzleId: number,
    strategyName: string,
    date: string,
    model: string,
  ): Promise<void> {
    const existingRuns = await this.strategyRunRepo.find({
      where: { puzzleId, strategyName },
      select: { trialNumber: true, modelName: true },
    });

    const limit = llmMaxTrialsPerModel();
    const modelRunCount = existingRuns.filter((run) => run.modelName === model).length;

    if (modelRunCount >= limit) {
      throw new BadRequestException(
        `Model '${model}' has already reached its limit of ${limit} trial(s) for strategy` +
          ` '${strategyName}' on this puzzle (see LLM_TRIALS_PER_MODEL).`,
      );
    }

    const nextTrialNumber =
      existingRuns.reduce((max, run) => Math.max(max, run.trialNumber), 0) + 1;

    await this.queueFor(strategyName).add(
      "run-strategy",
      { puzzleId, strategyName, date, trialNumber: nextTrialNumber, model },
      { jobId: runStrategyJobId(puzzleId, strategyName, nextTrialNumber) },
    );
  }
}
