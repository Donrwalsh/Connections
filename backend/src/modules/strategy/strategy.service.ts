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
import { StrategyRunDetailDto } from "./dto/strategy.dto";
import {
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  strategyTrialNumbers,
} from "../../strategies";

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
    for (const trialNumber of strategyTrialNumbers(strategyName)) {
      await this.triggerRun(puzzleId, strategyName, date, trialNumber);
    }
  }

  async getRunDetail(
    date: string,
    strategyName: string,
    trialNumber = 0,
  ): Promise<StrategyRunDetailDto> {
    if (!this.gameService.isValidYYYYMMDD(date)) {
      throw new BadRequestException(
        `Invalid date format: '${date}'. Expected YYYY-MM-DD.`,
      );
    }

    const puzzleId = await this.gameService.puzzleDateToId(date);

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
    });

    return this.mapRunDetail(run, guesses);
  }

  async getRunsForPuzzle(
    date: string,
    strategyName: string,
  ): Promise<StrategyRunDetailDto[]> {
    if (!this.gameService.isValidYYYYMMDD(date)) {
      throw new BadRequestException(
        `Invalid date format: '${date}'. Expected YYYY-MM-DD.`,
      );
    }

    const puzzleId = await this.gameService.puzzleDateToId(date);

    const runs = await this.strategyRunRepo.find({
      where: { puzzleId, strategyName },
      order: { trialNumber: "ASC" },
    });

    const details: StrategyRunDetailDto[] = [];
    for (const run of runs) {
      const guesses = await this.guessRepo.find({
        where: { strategyRunId: run.id },
        order: { sequenceNumber: "ASC" },
      });
      details.push(this.mapRunDetail(run, guesses));
    }
    return details;
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
    const run = await this.loadOrCreateRun(puzzleId, strategyName, trialNumber);

    if (run.status === StrategyRunStatus.COMPLETED) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
      };
    }

    let guessCount = await this.countGuesses(run.id);
    const pendingGuesses: Partial<Guess>[] = [];

    // Shuffle-smart picks groups at random, so it re-rolls until it finds a
    // group it hasn't already proposed. Rebuild the tried set from guesses
    // that were flushed to the DB (e.g. after a worker restart mid-run) so a
    // resumed run still avoids duplicates. Shuffle-foolish deliberately does
    // not deduplicate — it may guess the same group more than once.
    const triedGroups = new Set<string>();
    if (strategyName === SHUFFLE_SMART) {
      for (const key of await this.loadTriedGroups(run.id)) {
        triedGroups.add(key);
      }
    }

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
        const evaluation = await this.gameService.evaluateGuess(puzzleId, words);

        guessCount++;
        triedGroups.add(this.groupKey(words));

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

  private async loadTriedGroups(strategyRunId: number): Promise<string[]> {
    const guesses = await this.guessRepo.find({
      where: { strategyRunId },
      select: { words: true },
    });
    return guesses.map((g) => this.groupKey(g.words));
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

  async getUnfinishedPuzzles(
    startDateStr: string,
    endDateStr: string,
    strategyName: string,
  ): Promise<{ id: number; date: string }[]> {
    const rawPuzzles = await this.puzzleRepo
      .createQueryBuilder("puzzle")
      .leftJoin(
        "StrategyRun",
        "run",
        "run.puzzleId = puzzle.id AND run.strategyName = :strategyName",
        { strategyName },
      )
      .where("puzzle.date BETWEEN :startDateStr AND :endDateStr", {
        startDateStr,
        endDateStr,
      })
      .andWhere("(run.id IS NULL OR run.status != :completedStatus)", {
        completedStatus: StrategyRunStatus.COMPLETED,
      })
      .select(["puzzle.id AS id", "puzzle.date AS date"])
      .distinct(true)
      .getRawMany<{ id: number; date: Date | string }>();

    return rawPuzzles.map((row) => ({
      id: Number(row.id),
      date:
        row.date instanceof Date
          ? row.date.toISOString().split("T")[0]
          : String(row.date).split("T")[0],
    }));
  }

  private async loadOrCreateRun(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
  ): Promise<StrategyRun> {
    const existing = await this.strategyRunRepo.findOne({
      where: { puzzle: { id: puzzleId }, strategyName, trialNumber },
    });

    if (existing) {
      return existing;
    }

    const puzzle = await this.puzzleRepo.findOne({
      where: { id: puzzleId },
      relations: { answerGroups: { members: true } },
    });

    if (!puzzle) throw new NotFoundException(`No puzzle with id: ${puzzleId}`);

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

    return this.strategyRunRepo.save(run);
  }

  private async countGuesses(strategyRunId: number): Promise<number> {
    return this.guessRepo.count({
      where: { strategyRun: { id: strategyRunId } },
    });
  }
}
