import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE } from "../queue/queue.module";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { combinationToWords, firstCombination, nextCombination } from "./combinatorics";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { GameService } from "../game/game.service";
import {
  StrategyRunDetailDto,
  StrategyRunListItemDto,
  GuessDetailDto,
  LeaderboardDto,
  LeaderboardRowDto,
} from "./dto/strategy.dto";
import {
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  isLlmStrategy,
  llmMaxTrialsPerModel,
  strategyTrialNumbers,
} from "../../strategies";
import { runStrategyJobId, queueForStrategy } from "../queue/strategy.queue";
import { StrategyRunStore, computeInitialWordOrder } from "./strategy-run-store.service";
import { reconstructSolvePrompts } from "./prompt-reconstruction";
import { SupportedModelService } from "../supported-model/supported-model.service";

const GROUP_SIZE = 4;
const BATCH_SIZE = 50;

// How many waiting/delayed BullMQ jobs to fetch per page when tallying
// queued counts — see StrategyService.queuedCountsByKey.
const QUEUE_PAGE_SIZE = 1000;

/**
 * Groups a leaderboard row by strategy + model — the same pair a StrategyRun
 * row and a queued BullMQ job both carry, so DB aggregates and live queue
 * counts can be merged onto the same row. `modelName` is always null for
 * non-LLM strategies.
 */
function leaderboardKey(strategyName: string, modelName: string | null): string {
  return `${strategyName}::${modelName ?? ""}`;
}

interface LeaderboardAccumulator {
  strategyName: string;
  modelName: string | null;
  puzzleIds: Set<number>;
  completed: number;
  active: number;
  failed: number;
  // Guess counts and durations of COMPLETED runs only — the metrics a
  // leaderboard row surfaces (avg/min/max guesses, avg duration) are only
  // meaningful for runs that actually solved the puzzle.
  guessCounts: number[];
  durationsMs: number[];
}

@Injectable()
export class StrategyService {
  constructor(
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt) private readonly solvePromptRepo: Repository<SolvePrompt>,
    @InjectRepository(LlmProposal) private readonly llmProposalRepo: Repository<LlmProposal>,
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
    return queueForStrategy(this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, strategyName);
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
    const [runs, guessCountRows, queuedCounts, totalPuzzles] = await Promise.all([
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
      this.queuedCountsByKey(),
      this.puzzleRepo.count(),
    ]);

    const guessCountByRun = new Map<number, number>();
    for (const row of guessCountRows) {
      guessCountByRun.set(Number(row.strategyRunId), Number(row.count));
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
          guessCounts: [],
          durationsMs: [],
        };
        aggregates.set(key, acc);
      }

      acc.puzzleIds.add(run.puzzleId);

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
      }
    }

    const rows: LeaderboardRowDto[] = [...aggregates.values()].map((acc) => {
      const finished = acc.completed + acc.failed;
      const sortedGuesses = [...acc.guessCounts].sort((a, b) => a - b);

      return {
        id: acc.modelName ?? acc.strategyName,
        strategyName: acc.strategyName,
        modelName: acc.modelName,
        kind: isLlmStrategy(acc.strategyName) ? "llm" : "deterministic",
        puzzlesCovered: acc.puzzleIds.size,
        totalPuzzles,
        progress: {
          completed: acc.completed,
          active: acc.active,
          failed: acc.failed,
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
      };
    });

    rows.sort((a, b) => a.id.localeCompare(b.id));

    return {
      deterministic: rows.filter((row) => row.kind === "deterministic"),
      llm: rows.filter((row) => row.kind === "llm"),
    };
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
    const queues = [this.queue, this.llmOpenAIQueue, this.llmOllamaQueue];

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
   */
  private async buildSolvePromptDtos(run: StrategyRun) {
    const [solvePrompts, proposals, allGuesses, puzzle] = await Promise.all([
      this.solvePromptRepo.find({
        where: { strategyRunId: run.id },
        order: { promptNumber: "ASC" },
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
