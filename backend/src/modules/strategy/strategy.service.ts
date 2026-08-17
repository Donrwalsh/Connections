import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE } from "../queue/queue.module";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { combinationToWords, firstCombination, nextCombination } from "./combinatorics";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { GameService } from "../game/game.service";
import { StrategyRunDetailDto, StrategyRunListItemDto, GuessDetailDto } from "./dto/strategy.dto";
import {
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  shuffleFoolishDuplicateLimit,
  strategyTrialNumbers,
} from "../../strategies";
import { runStrategyJobId, queueForStrategy } from "../queue/strategy.queue";
import { StrategyRunStore } from "./strategy-run-store.service";

const GROUP_SIZE = 4;
const BATCH_SIZE = 50;

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
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
  ) {}

  /**
   * The queue a strategy's runs are dispatched to: llm-openai and llm-ollama
   * get their own per-provider queues, everything else the shared
   * strategy-runs queue.
   */
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, strategyName);
  }

  async triggerRun(puzzleId: number, strategyName: string, date?: string, trialNumber = 0) {
    await this.queueFor(strategyName).add(
      "run-strategy",
      {
        puzzleId,
        strategyName,
        date,
        trialNumber,
      },
      {
        // Deterministic id so duplicate enqueues of the same run collapse to a
        // single job instead of racing to create two runs.
        jobId: runStrategyJobId(puzzleId, strategyName, trialNumber),
      },
    );
  }

  /**
   * Queues one job per trial for the strategy — a single trial (0) for
   * deterministic strategies, one per shuffle-smart/shuffle-foolish trial (1..N).
   */
  async triggerStrategyRuns(puzzleId: number, strategyName: string, date: string) {
    const trialNumbers = strategyTrialNumbers(strategyName);
    await this.queueFor(strategyName).addBulk(
      trialNumbers.map((trialNumber) => ({
        name: "run-strategy",
        data: { puzzleId, strategyName, date, trialNumber },
        opts: { jobId: runStrategyJobId(puzzleId, strategyName, trialNumber) },
      })),
    );
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

    return {
      ...this.mapRunDetail(run, guesses),
      meta: { total, page: safePage, limit: safeLimit },
    };
  }

  /**
   * Full detail for a single guess: everything the run-detail list omits to
   * stay index-only, most notably the LLM telemetry recorded for strategy
   * guesses (prompt/completion tokens, latency, sampling parameters and the
   * free-form llmDetails). Returns nulls for non-LLM guesses. Fetched lazily
   * per guess from the frontend.
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
      numResponses: guess.numResponses,
      promptAttempts: guess.promptAttempts,
      duplicatesRejected: guess.duplicatesRejected,
      llmDetails: guess.llmDetails,
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

  private mapRunDetail(run: StrategyRun, guesses: Guess[]): Omit<StrategyRunDetailDto, "meta"> {
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
    let duplicateCount = 0;
    const tracksDuplicates = strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH;
    if (tracksDuplicates) {
      // Shuffle-smart re-rolls until it finds a group it hasn't already
      // proposed; shuffle-foolish records repeated groups as 'duplicate'
      // guesses so the run can be terminated once the duplicate limit is hit.
      // Both rebuild their tried set from guesses flushed to the DB (e.g.
      // after a worker restart mid-run). The single query below doubles as
      // the guess count.
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
          // Pure random picks. Unlike shuffle-smart, repeats are NOT re-rolled
          // — they are recorded as 'duplicate' guesses, so an unlucky run
          // terminates once it repeats the same group
          // SHUFFLE_FOOLISH_DUPLICATE_LIMIT times instead of grinding forever.
          words = this.sampleRandom(run.availableWords, GROUP_SIZE);
          isDuplicate = triedGroups.has(this.groupKey(words));
          break;
        default:
          throw new BadRequestException(`Unsupported strategy name: '${strategyName}'`);
      }

      if (!noMoreGroups) {
        guessCount++;

        if (isDuplicate) {
          duplicateCount++;
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: GuessResult.DUPLICATE,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
          });

          if (duplicateCount >= shuffleFoolishDuplicateLimit()) {
            run.status = StrategyRunStatus.DUPLICATE;
            run.finishedAt = new Date();
          }
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
