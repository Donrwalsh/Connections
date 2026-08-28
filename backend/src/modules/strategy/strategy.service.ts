import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import {
  STRATEGY_QUEUE,
  LLM_OPENAI_QUEUE,
  LLM_OLLAMA_QUEUE,
  LLM_GOOGLE_QUEUE,
} from "../queue/queue.module";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { combinationToWords, firstCombination, nextCombination } from "./combinatorics";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { SupportedModel } from "../supported-model/entities/supported-model.entity";
import { ModelPrice } from "../supported-model/entities/model-price.entity";
import { GameService } from "../game/game.service";
import {
  StrategyRunDetailDto,
  StrategyRunListItemDto,
  GuessDetailDto,
  LeaderboardDto,
  LeaderboardRowDto,
  RunHistoryDto,
  RunHistoryRowDto,
  RunHistorySortBy,
  RecentRunDto,
} from "./dto/strategy.dto";
import {
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  isLlmStrategy,
  llmMaxTrialsPerModel,
  strategyTrialNumbers,
  startOfTodayUtc,
} from "../../strategies";
import { runStrategyJobId, queueForStrategy } from "../queue/strategy.queue";
import { StrategyRunStore, computeInitialWordOrder } from "./strategy-run-store.service";
import { reconstructSolvePrompts } from "./prompt-reconstruction";
import {
  SupportedModelService,
  PriceHistoryEntry,
  SupportedModelWithRate,
} from "../supported-model/supported-model.service";

const GROUP_SIZE = 4;
const BATCH_SIZE = 50;

// How many waiting/delayed BullMQ jobs to fetch per page when tallying
// queued counts — see StrategyService.queuedCountsByKey.
const QUEUE_PAGE_SIZE = 1000;

const DEFAULT_RUN_HISTORY_LIMIT = 100;
const MAX_RUN_HISTORY_LIMIT = 500;

// Fixed-size rolling window for getRecentRuns — a live feed, not a paginated
// list, so there's no caller-adjustable limit/page like getRunHistory.
const RECENT_RUNS_LIMIT = 100;

// Raw ORDER BY expressions for getRunHistory, keyed by the sort the caller
// asked for. "puzzleDate" and "guessCount" order by their raw-query SELECT
// aliases (Postgres resolves an ORDER BY name against the SELECT list before
// falling back to a real column), so those must stay in sync with the
// aliases getRunHistory's query actually selects.
const RUN_HISTORY_SORT_EXPR: Record<RunHistorySortBy, string> = {
  puzzleDate: '"puzzleDate"',
  startedAt: 'run."startedAt"',
  guessCount: '"guessCount"',
  duration: '(run."finishedAt" - run."startedAt")',
  tokenCost: '"tokenCostUsd"',
};

/**
 * Groups a leaderboard row by strategy + model — the same pair a StrategyRun
 * row and a queued BullMQ job both carry, so DB aggregates and live queue
 * counts can be merged onto the same row. `modelName` is always null for
 * non-LLM strategies.
 */
function leaderboardKey(strategyName: string, modelName: string | null): string {
  return `${strategyName}::${modelName ?? ""}`;
}

// The two rate fields computeTokenCostUsd actually needs — narrower than
// SupportedModelWithRate so a caller must resolve the "no price row yet"
// null case (see hasPrice) before it can call this.
interface ModelRate {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}

/**
 * USD cost of one run's token usage, from a per-million-token rate
 * (ModelPrice) — the rate actually in effect when the run happened, not
 * necessarily the model's current rate; see priceAsOf. Shared by
 * getLeaderboard (cost across every run of a model) and getRunHistory (cost
 * of one page of runs) so the pricing formula lives in exactly one place.
 */
function computeTokenCostUsd(
  promptTokens: number,
  completionTokens: number,
  rate: ModelRate,
): number {
  return (
    (promptTokens / 1_000_000) * rate.inputCostPerMillionTokens +
    (completionTokens / 1_000_000) * rate.outputCostPerMillionTokens
  );
}

/**
 * The price in effect at `at` — the latest entry in `history` (assumed
 * sorted ascending by createdAt, which findPriceHistory guarantees) whose
 * createdAt is <= at. null when `at` predates the model's first price row —
 * that run has no known cost, same as a model with no price at all, rather
 * than borrowing a later price for it.
 */
function priceAsOf(history: PriceHistoryEntry[] | undefined, at: Date): ModelRate | null {
  if (!history) return null;
  let rate: ModelRate | null = null;
  for (const entry of history) {
    if (entry.createdAt.getTime() > at.getTime()) break;
    rate = entry;
  }
  return rate;
}

interface LeaderboardAccumulator {
  strategyName: string;
  modelName: string | null;
  puzzleIds: Set<number>;
  // Real StrategyRunStatus.COMPLETED count — the successRate numerator.
  completed: number;
  active: number;
  // Every non-completed, non-running run (FAILED, DUPLICATE,
  // MALFORMED_RESPONSE, ERROR) — the successRate denominator is
  // completed + failed, unchanged regardless of the LLM-specific display
  // adjustment below.
  failed: number;
  // Subset of `failed`: specifically FAILED (hit the mistake cap), never
  // DUPLICATE/MALFORMED_RESPONSE/ERROR. For LLM strategies this is folded
  // back into `completed` for progress/averaging display purposes — see
  // getLeaderboard — since a run that played out the whole puzzle and lost
  // is a normal complete attempt, not a broken one. successRate itself
  // still uses the real `completed`/`failed` counts above, so it keeps
  // distinguishing actual wins from actual losses.
  lostRuns: number;
  // Guess counts and durations of COMPLETED runs, plus — for LLM
  // strategies — FAILED runs too (see `lostRuns`): both represent a full
  // real playthrough with real guesses over real time, unlike a
  // duplicate-loop/malformed/error run which doesn't.
  guessCounts: number[];
  durationsMs: number[];
  // USD cost of every run with resolvable token usage and a resolvable
  // model rate — unlike guesses/duration this covers every run regardless
  // of outcome, since a failed or errored LLM run still spent tokens.
  costsUsd: number[];
  // Issue-tagged SolvePrompt count for every run with a model, regardless
  // of status or whether cost was priceable — unlike costsUsd, issue
  // count is always knowable (0 when clean), so this array's length always
  // equals the number of runs with a model, not a subset of them. Runs that
  // errored before their first LLM call have no SolvePrompt rows and so
  // contribute a hard 0, pulling an error-prone model's average downward —
  // a deliberate spec choice, noted here so a future reader doesn't
  // rediscover it as a bug.
  issueCounts: number[];
  // Raw CategoryEvaluation verdict counts summed across every run of this
  // (strategy, model) pair — see getLeaderboard. callError rows have a null
  // verdict and land in none of these three, so they never move
  // categoryAccuracy.
  catCorrect: number;
  catPartial: number;
  catLucky: number;
}

@Injectable()
export class StrategyService {
  // getLeaderboard aggregates the entire StrategyRun table in JS on every
  // call (see its doc comment); a short TTL cache turns the common case
  // (LeaderboardPage polled/reloaded repeatedly while dispatch cycles run in
  // the background) into a single DB round trip per window instead of one
  // per request, without needing explicit invalidation — a few seconds of
  // staleness is fine for a dashboard.
  private static readonly LEADERBOARD_CACHE_TTL_MS = 15_000;
  private leaderboardCache: { expiresAt: number; value: LeaderboardDto } | null = null;

  constructor(
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt) private readonly solvePromptRepo: Repository<SolvePrompt>,
    @InjectRepository(LlmProposal) private readonly llmProposalRepo: Repository<LlmProposal>,
    @InjectRepository(CategoryEvaluation)
    private readonly categoryEvaluationRepo: Repository<CategoryEvaluation>,
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
  ) {}

  /**
   * The queue a strategy's runs are dispatched to: llm-openai and llm-ollama
   * get their own per-provider queues, everything else the shared
   * strategy-runs queue.
   */
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      strategyName,
    );
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
   * for them yet — same reasoning as queuedCountsByKey). Every model in
   * `models` is present in the returned map, 0 if it has no activity today.
   * Used by FreeTierDispatchService to keep a dispatch cycle's new trials
   * spread evenly across a tier's models rather than favoring whichever
   * model happened to be picked first.
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

    const nextTrialNumber = existingRuns.reduce((max, run) => Math.max(max, run.trialNumber), 0) + 1;

    await this.queueFor(strategyName).add(
      "run-strategy",
      { puzzleId, strategyName, date, trialNumber: nextTrialNumber, model },
      { jobId: runStrategyJobId(puzzleId, strategyName, nextTrialNumber) },
    );
  }

  /**
   * Leaderboard rows, split deterministic/shuffle vs LLM (see LeaderboardDto).
   * The row set itself is entirely DB-driven — only a (strategyName, model)
   * pair with at least one real StrategyRun gets a row at all, never every
   * SUPPORTED_STRATEGIES entry or every SupportedModel — so a strategy or
   * model nobody has actually run yet simply doesn't appear.
   *
   * `progress.queued` is the one field that can't come from Postgres: a
   * queued BullMQ job has no StrategyRun row yet (that's only inserted once
   * a worker starts processing it — see StrategyRunStore.loadOrCreateRun), so
   * it's read live from the queues instead (queuedCountsByKey) and merged
   * onto whichever row already exists for that (strategyName, model) pair.
   * A pair with only queued jobs and zero started runs stays absent from the
   * response entirely, consistent with "DB-driven row set" above.
   *
   * Loads every StrategyRun row into memory to aggregate — fine at this
   * project's scale (a handful of strategies/models across a growing but
   * modest puzzle history); if that ever gets big enough to matter, this
   * should move to a grouped SQL aggregate instead.
   */
  async getLeaderboard(): Promise<LeaderboardDto> {
    const cached = this.leaderboardCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const [
      runs,
      guessCountRows,
      tokenRows,
      categoryRows,
      priceHistory,
      currentModels,
      queuedCounts,
      totalPuzzles,
    ] = await Promise.all([
      this.strategyRunRepo.find({
        select: {
          id: true,
          strategyName: true,
          modelName: true,
          status: true,
          puzzleId: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      this.guessRepo
        .createQueryBuilder("guess")
        .select("guess.strategyRunId", "strategyRunId")
        .addSelect("COUNT(guess.id)", "count")
        .groupBy("guess.strategyRunId")
        .getRawMany<{ strategyRunId: number; count: string }>(),
      // Only ever populated for LLM runs (SolvePrompt rows don't exist for
      // deterministic/shuffle strategies), so no strategy filter is needed
      // here — a deterministic run simply has no matching row.
      this.solvePromptRepo
        .createQueryBuilder("prompt")
        .select("prompt.strategyRunId", "strategyRunId")
        .addSelect("SUM(prompt.promptTokens)", "promptTokens")
        .addSelect("SUM(prompt.completionTokens)", "completionTokens")
        .addSelect(
          `COUNT(*) FILTER (WHERE array_length(prompt."issueTags", 1) > 0)`,
          "issueCount",
        )
        .groupBy("prompt.strategyRunId")
        .getRawMany<{
          strategyRunId: number;
          promptTokens: string | null;
          completionTokens: string | null;
          issueCount: string | null;
        }>(),
      // Per-run verdict tallies from the LLM category judge. Grouped in SQL
      // the same way the token/issue query above is — a run with no
      // CategoryEvaluation rows simply has no entry here. verdict is null on
      // a callError row, so none of the three FILTERed counts include it.
      this.categoryEvaluationRepo
        .createQueryBuilder("ce")
        .select("ce.strategyRunId", "strategyRunId")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'correct')", "correct")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'partial')", "partial")
        .addSelect("COUNT(*) FILTER (WHERE ce.verdict = 'lucky')", "lucky")
        .groupBy("ce.strategyRunId")
        .getRawMany<{ strategyRunId: number; correct: string; partial: string; lucky: string }>(),
      this.supportedModelService.findPriceHistory(),
      this.supportedModelService.findAll(),
      this.queuedCountsByKey(),
      this.puzzleRepo.count(),
    ]);

    const guessCountByRun = new Map<number, number>();
    for (const row of guessCountRows) {
      guessCountByRun.set(Number(row.strategyRunId), Number(row.count));
    }

    const tokensByRun = new Map<number, { promptTokens: number; completionTokens: number }>();
    const issueCountByRun = new Map<number, number>();
    for (const row of tokenRows) {
      tokensByRun.set(Number(row.strategyRunId), {
        promptTokens: Number(row.promptTokens ?? 0),
        completionTokens: Number(row.completionTokens ?? 0),
      });
      issueCountByRun.set(Number(row.strategyRunId), Number(row.issueCount ?? 0));
    }

    const categoryByRun = new Map<number, { correct: number; partial: number; lucky: number }>();
    for (const row of categoryRows) {
      categoryByRun.set(Number(row.strategyRunId), {
        correct: Number(row.correct ?? 0),
        partial: Number(row.partial ?? 0),
        lucky: Number(row.lucky ?? 0),
      });
    }

    const metadataByModel = new Map<string, SupportedModelWithRate>();
    for (const model of currentModels) {
      metadataByModel.set(leaderboardKey(model.strategyName, model.modelName), model);
    }

    const priceHistoryByModel = new Map<string, PriceHistoryEntry[]>();
    for (const entry of priceHistory) {
      const key = leaderboardKey(entry.strategyName, entry.modelName);
      const list = priceHistoryByModel.get(key);
      if (list) {
        list.push(entry);
      } else {
        priceHistoryByModel.set(key, [entry]);
      }
    }

    const aggregates = new Map<string, LeaderboardAccumulator>();
    for (const run of runs) {
      const key = leaderboardKey(run.strategyName, run.modelName);
      let acc = aggregates.get(key);
      if (!acc) {
        acc = {
          strategyName: run.strategyName,
          modelName: run.modelName,
          puzzleIds: new Set(),
          completed: 0,
          active: 0,
          failed: 0,
          lostRuns: 0,
          guessCounts: [],
          durationsMs: [],
          costsUsd: [],
          issueCounts: [],
          catCorrect: 0,
          catPartial: 0,
          catLucky: 0,
        };
        aggregates.set(key, acc);
      }

      acc.puzzleIds.add(run.puzzleId);

      // An evaluation belongs to its run regardless of that run's final
      // status, so this accumulates unconditionally (unlike the guess/
      // duration branches below).
      const cat = categoryByRun.get(run.id);
      if (cat) {
        acc.catCorrect += cat.correct;
        acc.catPartial += cat.partial;
        acc.catLucky += cat.lucky;
      }

      if (run.status === StrategyRunStatus.COMPLETED) {
        acc.completed++;
        acc.guessCounts.push(guessCountByRun.get(run.id) ?? 0);
        if (run.finishedAt) {
          acc.durationsMs.push(run.finishedAt.getTime() - run.startedAt.getTime());
        }
      } else if (run.status === StrategyRunStatus.RUNNING) {
        acc.active++;
      } else {
        acc.failed++;

        if (run.status === StrategyRunStatus.FAILED) {
          acc.lostRuns++;

          if (isLlmStrategy(run.strategyName)) {
            // Hit the mistake cap after a genuine full playthrough — still
            // real guesses over real time, so it counts toward these
            // averages the same as a solve (see LeaderboardAccumulator).
            acc.guessCounts.push(guessCountByRun.get(run.id) ?? 0);
            if (run.finishedAt) {
              acc.durationsMs.push(run.finishedAt.getTime() - run.startedAt.getTime());
            }
          }
        }
      }

      // Cost counts for every run regardless of outcome — a failed or
      // errored LLM run still spent tokens — so this sits outside the
      // status branches above. Issue count is pushed the same way, but
      // unconditionally (not gated on a resolvable rate) since it's always
      // knowable, not just when cost happens to be.
      if (run.modelName) {
        const tokens = tokensByRun.get(run.id);
        const history = priceHistoryByModel.get(leaderboardKey(run.strategyName, run.modelName));
        const rate = priceAsOf(history, run.startedAt);
        if (tokens && rate) {
          acc.costsUsd.push(computeTokenCostUsd(tokens.promptTokens, tokens.completionTokens, rate));
        }
        acc.issueCounts.push(issueCountByRun.get(run.id) ?? 0);
      }
    }

    const rows: LeaderboardRowDto[] = [...aggregates.values()].map((acc) => {
      // successRate keeps using the real completed/failed counts — a lost
      // run is still a loss for win-rate purposes, even though it's
      // "finished" for progress-display purposes below.
      const finished = acc.completed + acc.failed;
      const categoryEvaluated = acc.catCorrect + acc.catPartial + acc.catLucky;
      const sortedGuesses = [...acc.guessCounts].sort((a, b) => a - b);
      const totalCostUsd =
        acc.costsUsd.length === 0 ? null : acc.costsUsd.reduce((a, b) => a + b, 0);
      const isLlmRow = isLlmStrategy(acc.strategyName);
      // For LLM strategies, a run that hit the mistake cap (lostRuns) is a
      // normal complete attempt, not a broken one — fold it into the
      // "completed" bucket the Progress column displays instead of
      // flagging it as "Failed". Only genuinely broken outcomes (duplicate
      // loops, malformed responses, transient errors) still show as
      // Failed. Deterministic/shuffle strategies are unaffected.
      const displayCompleted = acc.completed + (isLlmRow ? acc.lostRuns : 0);
      const displayFailed = acc.failed - (isLlmRow ? acc.lostRuns : 0);
      const metadata = metadataByModel.get(leaderboardKey(acc.strategyName, acc.modelName));

      return {
        id: acc.modelName ?? acc.strategyName,
        strategyName: acc.strategyName,
        modelName: acc.modelName,
        kind: isLlmRow ? "llm" : "deterministic",
        puzzlesCovered: acc.puzzleIds.size,
        totalPuzzles,
        progress: {
          completed: displayCompleted,
          active: acc.active,
          failed: displayFailed,
          queued: queuedCounts.get(leaderboardKey(acc.strategyName, acc.modelName)) ?? 0,
        },
        successRate: finished === 0 ? null : (acc.completed / finished) * 100,
        avgGuessesToSolve:
          acc.guessCounts.length === 0
            ? null
            : acc.guessCounts.reduce((a, b) => a + b, 0) / acc.guessCounts.length,
        minGuesses: sortedGuesses[0] ?? null,
        maxGuesses: sortedGuesses[sortedGuesses.length - 1] ?? null,
        avgDurationMs:
          acc.durationsMs.length === 0
            ? null
            : acc.durationsMs.reduce((a, b) => a + b, 0) / acc.durationsMs.length,
        avgCostUsd: totalCostUsd === null ? null : totalCostUsd / acc.costsUsd.length,
        totalCostUsd,
        avgIssues:
          acc.issueCounts.length === 0
            ? null
            : acc.issueCounts.reduce((a, b) => a + b, 0) / acc.issueCounts.length,
        categoryCorrect: acc.catCorrect,
        categoryPartial: acc.catPartial,
        categoryLucky: acc.catLucky,
        categoryEvaluated,
        categoryAccuracy:
          categoryEvaluated === 0 ? null : (acc.catCorrect / categoryEvaluated) * 100,
        contextWindow: metadata?.contextWindow ?? null,
        paramCount: metadata?.paramCount ?? null,
        providerDescription: metadata?.providerDescription ?? null,
      };
    });

    rows.sort((a, b) => a.id.localeCompare(b.id));

    const result: LeaderboardDto = {
      deterministic: rows.filter((row) => row.kind === "deterministic"),
      llm: rows.filter((row) => row.kind === "llm"),
    };

    this.leaderboardCache = {
      expiresAt: Date.now() + StrategyService.LEADERBOARD_CACHE_TTL_MS,
      value: result,
    };

    return result;
  }

  /**
   * Tallies waiting/delayed BullMQ jobs across the strategy-runs and both
   * per-provider LLM queues, grouped by (strategyName, model) — the counts
   * getLeaderboard merges in as `progress.queued`. Deliberately excludes
   * 'active' jobs: by the time BullMQ marks a job active, the worker has
   * already inserted its StrategyRun row, so that job is already counted via
   * Postgres as 'running' — counting it here too would double it up.
   * Paginated since puzzle-ingestion can enqueue a large backlog in one shot.
   */
  private async queuedCountsByKey(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const queues = [this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, this.llmGoogleQueue];

    for (const queue of queues) {
      for (let start = 0; ; start += QUEUE_PAGE_SIZE) {
        const jobs = await queue.getJobs(["waiting", "delayed"], start, start + QUEUE_PAGE_SIZE - 1);

        for (const job of jobs) {
          const data = job.data as { strategyName?: string; model?: string | null };
          if (!data.strategyName) continue;
          const key = leaderboardKey(data.strategyName, data.model ?? null);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        if (jobs.length < QUEUE_PAGE_SIZE) break;
      }
    }

    return counts;
  }

  async getRunDetail(
    date: string,
    strategyName: string,
    trialNumber = 0,
    page = 1,
    limit = 200,
  ): Promise<StrategyRunDetailDto> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName, trialNumber },
    });

    if (!run) {
      throw new NotFoundException(
        `Strategy '${strategyName}' has not been run for the puzzle on${date}.`,
      );
    }

    return this.buildRunDetail(run, page, limit);
  }

  /**
   * Same detail payload as getRunDetail, looked up directly by the run's
   * primary key instead of (date, strategyName, trialNumber). The
   * leaderboard's individual-run page already knows the runId (from the runs
   * list below), so this skips the date->puzzleId resolution and the
   * strategyName/trialNumber round-trip entirely.
   */
  async getRunDetailByRunId(runId: number, page = 1, limit = 200): Promise<StrategyRunDetailDto> {
    const run = await this.strategyRunRepo.findOne({ where: { id: runId } });

    if (!run) {
      throw new NotFoundException(`No strategy run with id: ${runId}`);
    }

    return this.buildRunDetail(run, page, limit);
  }

  /**
   * Permanently deletes a strategy run and every row that belongs to it —
   * see StrategyRunStore.deleteRun for what that covers and why a plain
   * cascade delete isn't enough on its own.
   */
  async deleteRun(runId: number) {
    return this.store.deleteRun(runId);
  }

  private async buildRunDetail(
    run: StrategyRun,
    page: number,
    limit: number,
  ): Promise<StrategyRunDetailDto> {
    // A deterministic run can hold ~2,400 guesses, so detail is paginated.
    // Clamp inputs to keep a single response bounded.
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const total = await this.store.countGuesses(run.id);

    const guesses = await this.guessRepo.find({
      where: { strategyRunId: run.id },
      order: { sequenceNumber: "ASC" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      // Restrict to the columns the detail DTO uses so the query can be
      // served as an index-only scan off the covering index.
      select: {
        strategyRunId: true,
        sequenceNumber: true,
        words: true,
        result: true,
        guessedAt: true,
      },
    });

    // Proposals/prompts only ever exist for LLM strategies — skip the extra
    // queries entirely for everything else.
    const solvePrompts = isLlmStrategy(run.strategyName) ? await this.buildSolvePromptDtos(run) : [];

    return {
      ...this.mapRunDetail(run, guesses),
      solvePrompts,
      meta: { total, page: safePage, limit: safeLimit },
    };
  }

  /**
   * Assembles the reconstructed guess-chain-of-proposals for an LLM run: every
   * SolvePrompt (one per model call) alongside the candidate groups it parsed
   * out and the best-effort reconstructed prompt text (see
   * prompt-reconstruction.ts — prompt text itself isn't persisted). Guesses
   * are fetched unpaginated here (unlike the DTO's main `guesses` field)
   * because reconstruction needs the full sequence regardless of which page
   * of guesses was requested; LLM run guess counts are small (bounded by the
   * duplicate/failure/malformed limits), so this stays cheap.
   *
   * Includes CALL_ERROR rows (a call attempt that never produced usable
   * model text) so a failed step is visible alongside successful ones —
   * reconstructSolvePrompts knows to skip them when advancing conversation
   * state (see its own docblock). The attemptNumber tiebreak keeps a step's
   * own multiple rows in call order, since several can share one
   * promptNumber.
   */
  private async buildSolvePromptDtos(run: StrategyRun) {
    const [solvePrompts, proposals, allGuesses, puzzle] = await Promise.all([
      this.solvePromptRepo.find({
        where: { strategyRunId: run.id },
        order: { promptNumber: "ASC", attemptNumber: "ASC" },
      }),
      this.llmProposalRepo.find({ where: { strategyRunId: run.id } }),
      this.guessRepo.find({
        where: { strategyRunId: run.id },
        select: { id: true, sequenceNumber: true, words: true, result: true, guessedAt: true },
      }),
      this.puzzleRepo.findOne({
        where: { id: run.puzzleId },
        relations: { answerGroups: { members: true } },
      }),
    ]);

    if (solvePrompts.length === 0 || !puzzle) {
      return [];
    }

    const guessesById = new Map(allGuesses.map((guess) => [guess.id, guess]));
    const originalWords = computeInitialWordOrder(puzzle, run.strategyName);

    return reconstructSolvePrompts(originalWords, solvePrompts, proposals, guessesById);
  }

  /**
   * Full detail for a single guess. Fetched lazily per guess from the frontend.
   * Returns the guess record directly — no LLM-specific telemetry remains on
   * Guess (it now lives on SolvePrompt and LlmProposal).
   */
  async getGuessDetail(
    date: string,
    strategyName: string,
    trialNumber = 0,
    sequenceNumber: number,
  ): Promise<GuessDetailDto> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName, trialNumber },
    });

    if (!run) {
      throw new NotFoundException(
        `Strategy '${strategyName}' has not been run for the puzzle on ${date}.`,
      );
    }

    const guess = await this.guessRepo.findOne({
      where: { strategyRunId: run.id, sequenceNumber },
    });

    if (!guess) {
      throw new NotFoundException(
        `Guess #${sequenceNumber} not found for strategy '${strategyName}' on the puzzle dated ${date}.`,
      );
    }

    return {
      sequenceNumber: guess.sequenceNumber,
      words: guess.words,
      result: guess.result,
      guessedAt: guess.guessedAt,
    };
  }

  /**
   * Returns run metadata plus a guess count for every trial of a strategy on
   * a puzzle — deliberately WITHOUT the full guess arrays. The list drives
   * the strategy buttons in the UI; full guesses are fetched per-run via
   * getRunDetail, which keeps responses small (a deterministic run can hold
   * ~2,400 guesses).
   */
  async getRunsForPuzzle(date: string, strategyName: string): Promise<StrategyRunListItemDto[]> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);
    return this.getRunsForPuzzleId(puzzleId, strategyName);
  }

  /**
   * Same as getRunsForPuzzle, keyed directly by the puzzle's numeric id
   * instead of its date — the leaderboard's puzzle-run page routes on
   * puzzleId (matching how Guess/StrategyRun already key off it), so this
   * skips the date->puzzleId resolution.
   */
  async getRunsForPuzzleId(
    puzzleId: number,
    strategyName: string,
  ): Promise<StrategyRunListItemDto[]> {
    const runs = await this.strategyRunRepo.find({
      where: { puzzleId, strategyName },
      order: { trialNumber: "ASC" },
    });

    if (runs.length === 0) {
      return [];
    }

    // Single grouped-count query instead of one COUNT per run (and without
    // loading every guess row just to count them).
    const countRows = await this.guessRepo
      .createQueryBuilder("guess")
      .select("guess.strategyRunId", "strategyRunId")
      .addSelect("COUNT(guess.id)", "count")
      .where("guess.strategyRunId IN (:...ids)", {
        ids: runs.map((run) => run.id),
      })
      .groupBy("guess.strategyRunId")
      .getRawMany<{ strategyRunId: number; count: string }>();

    const countByRun = new Map<number, number>();
    for (const row of countRows) {
      countByRun.set(Number(row.strategyRunId), Number(row.count));
    }

    return runs.map((run) => ({
      id: run.id,
      strategyName: run.strategyName,
      trialNumber: run.trialNumber,
      status: run.status,
      modelName: run.modelName,
      contextWindow: run.contextWindow,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      guessCount: countByRun.get(run.id) ?? 0,
    }));
  }

  /**
   * Paginated, sortable, filterable history of every individual run for a
   * strategy — one row per StrategyRun across every puzzle, unlike
   * getRunsForPuzzleId (which scopes to a single puzzle) or getLeaderboard
   * (which aggregates across runs). Powers the /leaderboard/:strategyId
   * run-history table.
   *
   * `model` narrows to one LLM model's runs; it's ignored for non-LLM
   * strategies (which never set modelName). Even without it, each row still
   * resolves its own token cost from its own modelName, so a mixed-model
   * result set still gets a per-row cost. `status` narrows to one
   * StrategyRunStatus; anything else (missing, or a client-side-only value
   * like "queued", which the backend never actually sets on a StrategyRun
   * row) is ignored rather than rejected, same lenient handling as sortBy's
   * fallback below.
   *
   * Sorting/pagination happen in SQL (not fetch-then-sort in JS) because
   * `guessCount`, `duration`, and `tokenCost` aren't real StrategyRun
   * columns — see RUN_HISTORY_SORT_EXPR. `guessCount` is a correlated
   * scalar subquery rather than a JOIN+GROUP BY specifically to avoid a
   * Guess-row fan-out multiplying the page's row count; `tokenCostUsd` is
   * computed the same way (via a CASE over each row's own model's ModelPrice
   * as of that row's own startedAt, left-joined so a run whose model has no
   * price yet at that point stays NULL) so it's both priceable per-row *and*
   * sortable — an earlier version of
   * this priced rows in JS after pagination, which worked for display but
   * couldn't be sorted on.
   */
  async getRunHistory(
    strategyName: string,
    options: {
      model?: string;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortDir?: string;
      status?: string;
    },
  ): Promise<RunHistoryDto> {
    const safePage = Math.max(1, Math.floor(options.page ?? 1));
    const safeLimit = Math.min(
      MAX_RUN_HISTORY_LIMIT,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_RUN_HISTORY_LIMIT)),
    );
    const sortBy: RunHistorySortBy =
      options.sortBy && options.sortBy in RUN_HISTORY_SORT_EXPR
        ? (options.sortBy as RunHistorySortBy)
        : "puzzleDate";
    const sortDir = options.sortDir === "asc" ? "ASC" : "DESC";

    const baseQuery = this.strategyRunRepo
      .createQueryBuilder("run")
      .innerJoin(Puzzle, "puzzle", 'puzzle.id = run."puzzleId"')
      .where("run.strategyName = :strategyName", { strategyName });

    if (options.model) {
      baseQuery.andWhere("run.modelName = :model", { model: options.model });
    }

    if (options.status && (Object.values(StrategyRunStatus) as string[]).includes(options.status)) {
      baseQuery.andWhere("run.status = :status", { status: options.status });
    }

    const total = await baseQuery.clone().getCount();

    const rawRows = await baseQuery
      .clone()
      .select("run.id", "id")
      .addSelect("run.puzzleId", "puzzleId")
      // Cast to text: getRawMany() bypasses TypeORM's entity-level DATE
      // transformer (Puzzle.date is typed as a plain "YYYY-MM-DD" string via
      // that transformer), so left uncast this came back as a JS Date object
      // whose JSON serialization ("2024-01-01T00:00:00.000Z") broke
      // frontend's plain-date parsing.
      .addSelect("puzzle.date::text", "puzzleDate")
      .addSelect("run.trialNumber", "trialNumber")
      .addSelect("run.status", "status")
      .addSelect("run.modelName", "modelName")
      .addSelect("run.startedAt", "startedAt")
      .addSelect("run.finishedAt", "finishedAt")
      .addSelect(
        '(SELECT COUNT(*)::int FROM "Guess" g WHERE g."strategyRunId" = run.id)',
        "guessCount",
      )
      .addSelect(
        `(SELECT COUNT(*)::int FROM "SolvePrompt" sp
          WHERE sp."strategyRunId" = run.id AND array_length(sp."issueTags", 1) > 0)`,
        "issueCount",
      )
      // Each row's own model's rate as of that row's own startedAt (the
      // highest-id ModelPrice row for the model with createdAt <=
      // run.startedAt — see that entity's comment) via plain left joins, so
      // a mixed-model result set still prices each row from its own model,
      // and a price change doesn't retroactively re-price runs that
      // happened before it. Both joins are 1:1 (SupportedModel is unique on
      // (strategyName, modelName); the ModelPrice subquery picks exactly
      // one row), so neither can fan out a run into multiple result rows.
      .leftJoin(
        SupportedModel,
        "sm",
        'sm."strategyName" = :strategyName AND sm."modelName" = run."modelName"',
      )
      .leftJoin(
        ModelPrice,
        "mp",
        `mp.id = (
          SELECT id FROM "ModelPrice"
          WHERE "supportedModelId" = sm.id AND "createdAt" <= run."startedAt"
          ORDER BY id DESC LIMIT 1
        )`,
      )
      .addSelect(
        `CASE WHEN mp."inputCostPerMillionTokens" IS NULL THEN NULL ELSE
          (SELECT COALESCE(SUM(sp."promptTokens"), 0) FROM "SolvePrompt" sp WHERE sp."strategyRunId" = run.id)::float8
            / 1000000.0 * mp."inputCostPerMillionTokens"
          + (SELECT COALESCE(SUM(sp."completionTokens"), 0) FROM "SolvePrompt" sp WHERE sp."strategyRunId" = run.id)::float8
            / 1000000.0 * mp."outputCostPerMillionTokens"
        END`,
        "tokenCostUsd",
      )
      .orderBy(RUN_HISTORY_SORT_EXPR[sortBy], sortDir)
      // Stable tiebreaker: without one, ties on the chosen sort column can
      // shuffle rows between identical LIMIT/OFFSET pages.
      .addOrderBy("run.id", sortDir)
      // limit()/offset(), not skip()/take(): TypeORM's skip/take are meant
      // for getMany() and don't reliably translate to SQL LIMIT/OFFSET once
      // a JOIN is present (this query joins Puzzle) — they were silently
      // dropped entirely, so every page returned the full unpaginated result
      // set. limit()/offset() map straight to LIMIT/OFFSET regardless of
      // joins.
      .offset((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .getRawMany<{
        id: number;
        puzzleId: number;
        puzzleDate: string;
        trialNumber: number;
        status: StrategyRunStatus;
        modelName: string | null;
        startedAt: Date | string;
        finishedAt: Date | string | null;
        guessCount: number;
        issueCount: number;
        tokenCostUsd: string | number | null;
      }>();

    const rows: RunHistoryRowDto[] = rawRows.map((row) => ({
      id: row.id,
      puzzleId: row.puzzleId,
      puzzleDate: row.puzzleDate,
      strategyName,
      modelName: row.modelName,
      trialNumber: row.trialNumber,
      status: row.status,
      startedAt: new Date(row.startedAt),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
      guessCount: Number(row.guessCount),
      tokenCostUsd: row.tokenCostUsd === null ? null : Number(row.tokenCostUsd),
      issueCount: Number(row.issueCount),
    }));

    return { rows, meta: { total, page: safePage, limit: safeLimit } };
  }

  /**
   * The most recent StrategyRun rows across *every* strategy/model, newest
   * first — backs the Activity page's live feed (polled, so this is
   * deliberately cheap: no guessCount/tokenCostUsd correlated subqueries or
   * SupportedModel/ModelPrice joins like getRunHistory has, just the columns
   * the feed actually renders). Fixed at RECENT_RUNS_LIMIT rather than
   * paginated — a rolling window, not a list a caller pages through.
   */
  async getRecentRuns(): Promise<RecentRunDto[]> {
    const rawRows = await this.strategyRunRepo
      .createQueryBuilder("run")
      .innerJoin(Puzzle, "puzzle", 'puzzle.id = run."puzzleId"')
      .select("run.id", "id")
      .addSelect("run.puzzleId", "puzzleId")
      // Cast to text — see the identical cast in getRunHistory: getRawMany()
      // bypasses Puzzle.date's entity-level string transformer.
      .addSelect("puzzle.date::text", "puzzleDate")
      .addSelect("run.strategyName", "strategyName")
      .addSelect("run.modelName", "modelName")
      .addSelect("run.trialNumber", "trialNumber")
      .addSelect("run.status", "status")
      .addSelect("run.startedAt", "startedAt")
      .addSelect("run.finishedAt", "finishedAt")
      .orderBy("run.startedAt", "DESC")
      // Stable tiebreaker: without one, ties on startedAt (plausible under
      // concurrent dispatch) could reorder rows between polls even though
      // the underlying set hasn't changed.
      .addOrderBy("run.id", "DESC")
      .limit(RECENT_RUNS_LIMIT)
      .getRawMany<{
        id: number;
        puzzleId: number;
        puzzleDate: string;
        strategyName: string;
        modelName: string | null;
        trialNumber: number;
        status: StrategyRunStatus;
        startedAt: Date | string;
        finishedAt: Date | string | null;
      }>();

    return rawRows.map((row) => ({
      id: row.id,
      puzzleId: row.puzzleId,
      puzzleDate: row.puzzleDate,
      strategyName: row.strategyName,
      modelName: row.modelName,
      trialNumber: row.trialNumber,
      status: row.status,
      startedAt: new Date(row.startedAt),
      finishedAt: row.finishedAt ? new Date(row.finishedAt) : null,
    }));
  }

  private mapRunDetail(
    run: StrategyRun,
    guesses: Guess[],
  ): Omit<StrategyRunDetailDto, "meta" | "solvePrompts"> {
    return {
      id: run.id,
      strategyName: run.strategyName,
      trialNumber: run.trialNumber,
      status: run.status,
      modelName: run.modelName,
      contextWindow: run.contextWindow,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      guesses: guesses.map((g) => ({
        sequenceNumber: g.sequenceNumber,
        words: g.words,
        result: g.result,
        guessedAt: g.guessedAt,
      })),
    };
  }

  async runDeterministicStrategy(puzzleId: number, strategyName: string, trialNumber = 0) {
    // loadOrCreateRun loads the (immutable) puzzle alongside the run so the
    // loop below evaluates guesses in memory without a full DB reload per
    // guess (~2,400 queries per worst-case deterministic run).
    const { run, puzzle } = await this.store.loadOrCreateRun(puzzleId, strategyName, trialNumber);

    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        status: run.status,
        guessCount: await this.store.countGuesses(run.id),
      };
    }

    let guessCount: number;
    const triedGroups = new Set<string>();
    const tracksDuplicates = strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH;
    if (tracksDuplicates) {
      // Shuffle-smart re-rolls until it finds a group it hasn't already
      // proposed; shuffle-foolish records repeated groups as 'duplicate'
      // guesses but keeps sampling regardless — it has no duplicate limit, so
      // the only way it stops is by actually solving the puzzle. Both rebuild
      // their tried set from guesses flushed to the DB (e.g. after a worker
      // restart mid-run). The single query below doubles as the guess count.
      const priorGuesses = await this.loadGuessesForRun(run.id);
      guessCount = priorGuesses.length;
      for (const guess of priorGuesses) {
        triedGroups.add(this.groupKey(guess.words));
      }
    } else {
      guessCount = await this.store.countGuesses(run.id);
    }

    const pendingGuesses: Partial<Guess>[] = [];

    while (true) {
      let words: string[] = [];
      let noMoreGroups = false;
      let isDuplicate = false;

      switch (strategyName) {
        case "alphabetical":
        case "reverse-alphabetical":
        case "order":
        case "reverse-order":
          words = combinationToWords(run.currentCombination, run.availableWords);
          break;
        case SHUFFLE_SMART: {
          const picked = this.pickRandomGroup(run.availableWords, triedGroups);
          if (picked === null) {
            run.status = StrategyRunStatus.FAILED;
            run.finishedAt = new Date();
            noMoreGroups = true;
          } else {
            words = picked;
          }
          break;
        }
        case SHUFFLE_FOOLISH:
          // Pure random picks. Unlike shuffle-smart, repeats are NOT
          // re-rolled — they're recorded as 'duplicate' guesses, but there's
          // no limit on how many pile up; the run just keeps sampling until
          // it actually solves the puzzle.
          words = this.sampleRandom(run.availableWords, GROUP_SIZE);
          isDuplicate = triedGroups.has(this.groupKey(words));
          break;
        default:
          throw new BadRequestException(`Unsupported strategy name: '${strategyName}'`);
      }

      if (!noMoreGroups) {
        guessCount++;

        if (isDuplicate) {
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: GuessResult.DUPLICATE,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
          });
        } else {
          const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, words);

          if (strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH) {
            triedGroups.add(this.groupKey(words));
          }

          // Stage the guess in memory
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: evaluation.result,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
          });

          // Update in-memory state
          if (evaluation.result === GuessResult.SUCCESS) {
            run.availableWords = run.availableWords.filter((w) => !words.includes(w));
            run.currentCombination = firstCombination(GROUP_SIZE);

            if (run.availableWords.length === 0) {
              run.status = StrategyRunStatus.COMPLETED;
              run.finishedAt = new Date();
            }
          } else if (strategyName !== SHUFFLE_SMART && strategyName !== SHUFFLE_FOOLISH) {
            const next = nextCombination(run.currentCombination, run.availableWords.length);

            if (next === null) {
              run.status = StrategyRunStatus.FAILED;
              run.finishedAt = new Date();
            } else {
              run.currentCombination = next;
            }
          }
        }
      }

      const isFinished = run.status !== StrategyRunStatus.RUNNING;
      const reachedBatchLimit = pendingGuesses.length >= BATCH_SIZE;

      // Flush to DB if batch size reached or run completed/failed
      if (reachedBatchLimit || isFinished) {
        await this.store.flushBatch(run, pendingGuesses);
      }

      if (isFinished) {
        break;
      }
    }

    return { status: run.status, guessCount };
  }

  /**
   * Randomly select GROUP_SIZE words from the pool, re-rolling until the
   * selected group hasn't been tried before in this run. Returns null when
   * every possible group has already been proposed.
   */
  private pickRandomGroup(pool: string[], tried: Set<string>): string[] | null {
    if (pool.length < GROUP_SIZE) return null;

    const totalCombos = this.combinationCount(pool.length, GROUP_SIZE);

    // Rejection sampling with a generous cap — the expected number of attempts
    // stays well under this until the tried set is nearly full. Tried groups
    // from earlier (larger) pools can't be sampled anymore, so a pool-shrinking
    // solve never trips this up; it only gives up once no fresh group turns up.
    for (let attempt = 0; attempt < totalCombos * 10; attempt++) {
      const group = this.sampleRandom(pool, GROUP_SIZE);
      if (!tried.has(this.groupKey(group))) return group;
    }

    return null;
  }

  private sampleRandom<T>(pool: T[], k: number): T[] {
    const copy = [...pool];
    // Partial Fisher-Yates: shuffle the last k positions, then take them.
    for (let i = copy.length - 1; i >= copy.length - k; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - k);
  }

  private groupKey(words: string[]): string {
    return [...words].sort().join("|");
  }

  private combinationCount(n: number, k: number): number {
    let result = 1;
    for (let i = 0; i < k; i++) {
      result = (result * (n - i)) / (i + 1);
    }
    return Math.floor(result);
  }

  private async loadGuessesForRun(strategyRunId: number): Promise<Guess[]> {
    return this.guessRepo.find({
      where: { strategyRunId },
      select: { words: true },
    });
  }
}
