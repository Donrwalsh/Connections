import { BadRequestException, Inject, NotFoundException } from "@nestjs/common";
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

  async triggerRun(puzzleId: number, strategyName: string) {
    await this.queue.add("run-strategy", { puzzleId, strategyName });
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

    // Throws NotFoundException with a clear message if no puzzle exists for this date.
    const puzzleId = await this.gameService.puzzleDateToId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName },
    });

    if (!run) {
      throw new NotFoundException(
        `Strategy '${strategyName}' has not been run for the puzzle on ${date}.`,
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

  async runDeterministicStrategy(
    puzzleId: number,
    strategyName = "alphabetical",
  ) {
    const run = await this.loadOrCreateRun(puzzleId, strategyName);

    if (run.status === StrategyRunStatus.COMPLETED) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
      };
    }

    let guessCount = await this.countGuesses(run.id);

    while (true) {
      const words = combinationToWords(
        run.currentCombination,
        run.availableWords,
      );
      const evaluation = await this.gameService.evaluateGuess(puzzleId, words);

      guessCount++;

      await this.dataSource.transaction(async (manager) => {
        await manager.insert("Guess", {
          puzzle: { id: puzzleId },
          strategyRun: { id: run.id },
          words,
          result: evaluation.result,
          sequenceNumber: guessCount,
          source: GuessSource.STRATEGY,
        });

        if (evaluation.result === GuessResult.SUCCESS) {
          // Remove solved words from the pool, reset combination to the start
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
            // Exhausted every combination of the current pool without success.
            // Shouldn't happen against valid puzzle data, but don't loop forever.
            run.status = StrategyRunStatus.FAILED;
            run.finishedAt = new Date();
          } else {
            run.currentCombination = next;
          }
        }

        await manager.save(StrategyRun, run);
      });

      if (run.status !== StrategyRunStatus.RUNNING) {
        break;
      }
    }

    return { status: run.status, guessCount };
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

    const allWords = puzzle.answerGroups
      .flatMap((group) => group.members.map((m) => m.word))
      .sort((a, b) => a.localeCompare(b));

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
    // Cheap count for the return value's guessCount; not used for control flow.
    return this.guessRepo.count({
      where: { strategyRun: { id: strategyRunId } },
    });
  }
}
