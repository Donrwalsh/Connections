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

  async triggerRun(puzzleId: number, strategyName: string, date?: string) {
    await this.queue.add("run-strategy", { puzzleId, strategyName, date });
  }

  async getRunDetail(
    date: string,
    strategyName: string,
  ): Promise<StrategyRunDetailDto> {
    if (!this.gameService.isValidYYYYMMDD(date)) {
      throw new BadRequestException(
        `Invalid date format: '${date}'. Expected YYYY-MM-DD.`,
      );
    }

    const puzzleId = await this.gameService.puzzleDateToId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName },
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

    return {
      strategyName: run.strategyName,
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

  async runDeterministicStrategy(puzzleId: number, strategyName: string) {
    const run = await this.loadOrCreateRun(puzzleId, strategyName);

    if (run.status === StrategyRunStatus.COMPLETED) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
      };
    }

    let guessCount = await this.countGuesses(run.id);
    const pendingGuesses: Partial<Guess>[] = [];

    while (true) {
      var words: string[] = [];

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
        default:
          throw new BadRequestException(
            `Unsupported strategy name: '${strategyName}'`,
          );
      }

      const evaluation = await this.gameService.evaluateGuess(puzzleId, words);

      guessCount++;

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
      } else {
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
  ): Promise<StrategyRun> {
    const existing = await this.strategyRunRepo.findOne({
      where: { puzzle: { id: puzzleId }, strategyName },
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
