import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import {
  combinationToWords,
  firstCombination,
  nextCombination,
} from "./combinatorics";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { GameService } from "../game/game.service";
import {
  StrategyRunDetailDto,
  StrategyRunListItemDto,
} from "./dto/strategy.dto";
import {
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  strategyTrialNumbers,
} from "../../strategies";
import { runStrategyJobId } from "../queue/strategy.queue";

const GROUP_SIZE = 4;
const BATCH_SIZE = 50;

@Injectable()
export class StrategyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @Inject(GameService) private readonly gameService: GameService,
  ) {}

  async triggerRun(
    puzzleId: number,
    strategyName: string,
    date?: string,
    trialNumber = 0,
  ) {
    await this.queue.add("run-strategy", {
      puzzleId,
      strategyName,
      date,
      trialNumber,
    }, {
      // Deterministic id so duplicate enqueues of the same run collapse to a
      // single job instead of racing to create two runs.
      jobId: runStrategyJobId(puzzleId, strategyName, trialNumber),
    });
  }

  /**
   * Queues one job per trial for the strategy — a single trial (0) for
   * deterministic strategies, one per shuffle-smart/shuffle-foolish trial (1..N).
   */
  async triggerStrategyRuns(
    puzzleId: number,
    strategyName: string,
    date: string,
  ) {
    const trialNumbers = strategyTrialNumbers(strategyName);
    await this.queue.addBulk(
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

    const guesses = await this.guessRepo.find({
      where: { strategyRunId: run.id },
      order: { sequenceNumber: "ASC" },
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

    return this.mapRunDetail(run, guesses);
  }

  /**
   * Returns run metadata plus a guess count for every trial of a strategy on
   * a puzzle — deliberately WITHOUT the full guess arrays. The list drives
   * the strategy buttons in the UI; full guesses are fetched per-run via
   * getRunDetail, which keeps responses small (a deterministic run can hold
   * ~2,400 guesses).
   */
  async getRunsForPuzzle(
    date: string,
    strategyName: string,
  ): Promise<StrategyRunListItemDto[]> {
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
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      guessCount: countByRun.get(run.id) ?? 0,
    }));
  }

  private mapRunDetail(
    run: StrategyRun,
    guesses: Guess[],
  ): StrategyRunDetailDto {
    return {
      id: run.id,
      strategyName: run.strategyName,
      trialNumber: run.trialNumber,
      status: run.status,
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

  async runDeterministicStrategy(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
  ) {
    // loadOrCreateRun loads the (immutable) puzzle alongside the run so the
    // loop below evaluates guesses in memory without a full DB reload per
    // guess (~2,400 queries per worst-case deterministic run).
    const { run, puzzle } = await this.loadOrCreateRun(
      puzzleId,
      strategyName,
      trialNumber,
    );

    if (run.status === StrategyRunStatus.COMPLETED) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
      };
    }

    let guessCount: number;
    const triedGroups = new Set<string>();
    if (strategyName === SHUFFLE_SMART) {
      // Shuffle-smart re-rolls until it finds a group it hasn't already
      // proposed, so rebuild the tried set from guesses flushed to the DB
      // (e.g. after a worker restart mid-run). The single query below doubles
      // as the guess count. Shuffle-foolish deliberately does not deduplicate.
      const priorGuesses = await this.loadGuessesForRun(run.id);
      guessCount = priorGuesses.length;
      for (const guess of priorGuesses) {
        triedGroups.add(this.groupKey(guess.words));
      }
    } else {
      guessCount = await this.countGuesses(run.id);
    }

    const pendingGuesses: Partial<Guess>[] = [];

    while (true) {
      let words: string[] = [];
      let noMoreGroups = false;

      switch (strategyName) {
        case "alphabetical":
        case "reverse-alphabetical":
        case "order":
        case "reverse-order":
          words = combinationToWords(
            run.currentCombination,
            run.availableWords,
          );
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
          // Pure random picks with no tried-set, so duplicates are allowed.
          words = this.sampleRandom(run.availableWords, GROUP_SIZE);
          break;
        default:
          throw new BadRequestException(
            `Unsupported strategy name: '${strategyName}'`,
          );
      }

      if (!noMoreGroups) {
        const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, words);

        guessCount++;
        if (strategyName === SHUFFLE_SMART) {
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
          run.availableWords = run.availableWords.filter(
            (w) => !words.includes(w),
          );
          run.currentCombination = firstCombination(GROUP_SIZE);

          if (run.availableWords.length === 0) {
            run.status = StrategyRunStatus.COMPLETED;
            run.finishedAt = new Date();
          }
        } else if (
          strategyName !== SHUFFLE_SMART &&
          strategyName !== SHUFFLE_FOOLISH
        ) {
          const next = nextCombination(
            run.currentCombination,
            run.availableWords.length,
          );

          if (next === null) {
            run.status = StrategyRunStatus.FAILED;
            run.finishedAt = new Date();
          } else {
            run.currentCombination = next;
          }
        }
      }

      const isFinished = run.status !== StrategyRunStatus.RUNNING;
      const reachedBatchLimit = pendingGuesses.length >= BATCH_SIZE;

      // Flush to DB if batch size reached or run completed/failed
      if (reachedBatchLimit || isFinished) {
        await this.flushBatch(run, pendingGuesses);
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
  private pickRandomGroup(
    pool: string[],
    tried: Set<string>,
  ): string[] | null {
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

  private async flushBatch(
    run: StrategyRun,
    pendingGuesses: Partial<Guess>[],
  ): Promise<void> {
    if (pendingGuesses.length === 0) return;

    // Create a shallow copy to insert and clear the original buffer
    const guessesToInsert = [...pendingGuesses];
    pendingGuesses.length = 0;

    await this.dataSource.transaction(async (manager) => {
      await manager.insert("Guess", guessesToInsert);
      await manager.save(StrategyRun, run);
    });
  }

  private async loadOrCreateRun(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
  ): Promise<{ run: StrategyRun; puzzle: Puzzle }> {
    const puzzle = await this.puzzleRepo.findOne({
      where: { id: puzzleId },
      relations: { answerGroups: { members: true } },
    });

    if (!puzzle) throw new NotFoundException(`No puzzle with id: ${puzzleId}`);

    const existing = await this.strategyRunRepo.findOne({
      where: { puzzle: { id: puzzleId }, strategyName, trialNumber },
    });

    if (existing) {
      return { run: existing, puzzle };
    }

    let allWords: string[];

    switch (strategyName) {
      case "order":
      case SHUFFLE_SMART:
      case SHUFFLE_FOOLISH:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => a.position - b.position)
          .map((m) => m.word);
        break;

      case "reverse-order":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => b.position - a.position)
          .map((m) => m.word);
        break;

      case "reverse-alphabetical":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => b.localeCompare(a));
        break;

      case "alphabetical":
      default:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => a.localeCompare(b));
        break;
    }

    const run = this.strategyRunRepo.create({
      puzzle,
      strategyName,
      trialNumber,
      status: StrategyRunStatus.RUNNING,
      availableWords: allWords,
      currentCombination: firstCombination(GROUP_SIZE),
    });

    const saved = await this.strategyRunRepo.save(run);
    return { run: saved, puzzle };
  }

  private async countGuesses(strategyRunId: number): Promise<number> {
    // Plain indexed-column filter instead of a relation predicate so TypeORM
    // doesn't emit an unnecessary join/subquery.
    return this.guessRepo.count({
      where: { strategyRunId },
    });
  }
}
