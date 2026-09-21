import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
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
    @InjectDataSource() private readonly dataSource: DataSource,
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
        jobId: runStrategyJobId(puzzleId, strategyName, model ?? null, trialNumber),
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
        opts: { jobId: runStrategyJobId(puzzleId, strategyName, model ?? null, trialNumber) },
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
   * rows tied to each — see StrategyRunStore.deleteErroredRuns. `strategyName`,
   * when given, scopes the sweep to one strategy; `modelName` narrows it
   * further to one model within that strategy. Both are needed for an LLM
   * strategy — one strategyName (e.g. "llm-google") backs every model on
   * that provider, so strategyName alone would sweep every model's errored
   * runs, not just one.
   */
  async deleteErroredRuns(strategyName?: string, modelName?: string) {
    return this.store.deleteErroredRuns(strategyName, modelName);
  }

  /**
   * How many strategy runs are currently in the 'error' status — the figure
   * the maintenance panel's "delete errored runs" button acts on.
   * `strategyName`/`modelName`, when given, scope the count the same way as
   * deleteErroredRuns — the figure StrategyPuzzlePage's bulk-action buttons
   * act on instead.
   */
  async countErroredRuns(strategyName?: string, modelName?: string): Promise<{ erroredRuns: number }> {
    const erroredRuns = await this.strategyRunRepo.count({
      where: {
        status: StrategyRunStatus.ERROR,
        ...(strategyName ? { strategyName } : {}),
        ...(modelName ? { modelName } : {}),
      },
    });
    return { erroredRuns };
  }

  /**
   * Resumes a run stuck in the 'error' status — the same flip-status-and-
   * re-enqueue mechanism RpdResumeService uses for a parked
   * RATE_LIMITED_DAILY run, triggered manually instead of by a cron sweep.
   * The status flip is required: runLlmStrategy's TERMINAL_STATUSES gate
   * (see llm-strategy-runner.service.ts) returns immediately without doing
   * anything for a run still in 'error', so simply re-enqueueing the job
   * alone would be a no-op. loadOrCreateRun then finds the existing row by
   * (puzzleId, strategyName, trialNumber) and the solve loop resumes from
   * the last successful guess, since its conversation state is rebuilt from
   * persisted Guess rows on every call regardless of why the run stopped.
   * The jobId gets a fresh timestamp suffix — the original job's id is
   * still occupied by its failed BullMQ job record (removeOnFail keeps up
   * to 5000), so reusing it would collide.
   */
  async retryRun(runId: number): Promise<{ status: StrategyRunStatus }> {
    const run = await this.strategyRunRepo.findOne({
      where: { id: runId },
      relations: { puzzle: true },
    });

    if (!run) {
      throw new NotFoundException(`No strategy run with id: ${runId}`);
    }

    if (run.status !== StrategyRunStatus.ERROR) {
      throw new ConflictException(
        `Strategy run ${runId} is in status '${run.status}', not 'error' — only an errored run can be manually retried.`,
      );
    }

    run.status = StrategyRunStatus.RUNNING;
    run.finishedAt = null;
    await this.strategyRunRepo.save(run);

    await this.queueFor(run.strategyName).add(
      "run-strategy",
      {
        puzzleId: run.puzzleId,
        strategyName: run.strategyName,
        date: run.puzzle.date,
        trialNumber: run.trialNumber,
        model: run.modelName,
        manualRetry: true,
      },
      {
        jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.modelName, run.trialNumber)}-manual-retry-${Date.now()}`,
      },
    );

    return { status: run.status };
  }

  /**
   * Bulk version of retryRun, scoped to one strategy — retries every run
   * currently in the 'error' status for strategyName through the exact same
   * retryRun path, so each inherits its per-run status check, job-id
   * collision avoidance, and (for LLM runs) conversation-history
   * reconstruction. `modelName`, when given, narrows the sweep to one model
   * within the strategy — needed for an LLM strategy, where one strategyName
   * (e.g. "llm-google") backs every model on that provider. Unlike
   * deleteErroredRuns this is not one transaction: each retryRun call
   * independently flips one row and enqueues one job, so one run's failure
   * can't roll back another's, and a run whose status changed out from under
   * us between listing and retrying (e.g. another operator already retried
   * it, or it self-resumed from RATE_LIMITED_DAILY) is counted as 'skipped',
   * not 'failed'.
   */
  async retryErroredRuns(
    strategyName: string,
    modelName?: string,
  ): Promise<{
    retried: number;
    skipped: number;
    failed: number;
    failures: { runId: number; reason: string }[];
  }> {
    const erroredRuns = await this.strategyRunRepo.find({
      where: {
        strategyName,
        ...(modelName ? { modelName } : {}),
        status: StrategyRunStatus.ERROR,
      },
      select: { id: true },
    });

    let retried = 0;
    let skipped = 0;
    const failures: { runId: number; reason: string }[] = [];

    for (const { id } of erroredRuns) {
      try {
        await this.retryRun(id);
        retried += 1;
      } catch (err) {
        if (err instanceof ConflictException) {
          skipped += 1;
        } else {
          failures.push({ runId: id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { retried, skipped, failed: failures.length, failures };
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
   *
   * The read-check-reserve sequence runs inside a transaction holding a
   * Postgres advisory lock scoped to (puzzleId, strategyName), so two
   * concurrent calls for different models on the same puzzle can never
   * compute the same trial number — without the lock, both would race to
   * read the same "next" number and, now that the job id includes the model
   * (see runStrategyJobId), both jobs would get queued and collide on the
   * same StrategyRun row when processed. See issue #43.
   */
  private async triggerNextLlmTrial(
    puzzleId: number,
    strategyName: string,
    date: string,
    model: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // hashtext() gives a stable int4 from strategyName; pg_advisory_xact_lock
      // takes two int4 keys rather than one bigint so puzzleId doesn't need to
      // be packed into a wider key by hand. Released automatically at the end
      // of this transaction.
      await manager.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        puzzleId,
        strategyName,
      ]);

      const existingRuns = await manager.find(StrategyRun, {
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
        { jobId: runStrategyJobId(puzzleId, strategyName, model, nextTrialNumber) },
      );
    });
  }
}
