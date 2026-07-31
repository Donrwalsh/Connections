import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm/dist/common/typeorm.decorators";
import { Queue } from "bullmq";
import { Repository } from "typeorm/browser/repository/Repository.js";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { Puzzle } from "./entities/puzzle.entity";
import { GuessResult } from "../strategy/entities/guess.entity";

@Injectable()
export class GameService {
  constructor(
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
  ) {}

  async triggerRun(puzzleId: string, strategyName: string) {
    await this.queue.add("run-strategy", { puzzleId, strategyName });
  }

  async puzzleDateToId(date: string): Promise<number> {
    const puzzle = await this.puzzleRepo.findOne({ where: { date } });
    if (!puzzle) {
      throw new NotFoundException(`No puzzle for date: ${date}`);
    }
    return puzzle.id;
  }

  async getDatesPuzzle(date: string) {
    if (!this.isValidYYYYMMDD(date)) {
      throw new NotFoundException(`Invalid date format: ${date}`);
    }
    return await this.getPuzzleByDate(date);
  }

  async getTodaysPuzzle() {
    const today = new Date().toISOString().split("T")[0];
    return await this.getPuzzleByDate(today);
  }

  async evaluateGuess(
    puzzleId: number,
    words: string[],
  ): Promise<{ result: GuessResult }> {
    const puzzle = await this.puzzleRepo.findOne({
      where: { id: puzzleId },
      relations: {
        answerGroups: {
          members: true,
        },
      },
    });

    if (!puzzle) {
      throw new NotFoundException(`Puzzle with ID ${puzzleId} not found`);
    }

    // Normalize guessed words for case-insensitive matching
    const guessedSet = new Set(words.map((w) => w.trim().toLowerCase()));
    let isOffByOne = false;

    for (const group of puzzle.answerGroups) {
      const groupWords = group.members.map((m) => m.word.trim().toLowerCase());

      // Count matching words in this group
      const matches = groupWords.filter((word) => guessedSet.has(word)).length;

      // Exact match for the 4-word group
      if (matches === 4 && groupWords.length === 4) {
        return { result: GuessResult.SUCCESS };
      }

      // Check if 3 out of 4 words match
      if (matches === 3) {
        isOffByOne = true;
      }
    }

    if (isOffByOne) {
      return { result: GuessResult.OFF_BY_ONE };
    }

    return { result: GuessResult.FAILURE };
  }

  async getLatestDate() {
    const result = await this.puzzleRepo
      .createQueryBuilder("puzzle")
      .select("MAX(puzzle.date)", "latest_date")
      .getRawOne();
    return result.latest_date;
  }

  async getPuzzleByDate(date: string) {
    // 1. Fetch puzzle with eager-loaded relations in a single query
    const puzzle = await this.puzzleRepo.findOne({
      where: { date },
      relations: {
        answerGroups: {
          members: true, // Loads nested GroupMember array
        },
      },
      order: {
        answerGroups: {
          level: "ASC",
          members: {
            position: "ASC",
          },
        },
      },
    });

    // 2. Throw exception if not found
    if (!puzzle) {
      throw new NotFoundException(`No puzzle for date: ${date}`);
    }

    // 3. Map relations to your response DTO/format
    return {
      date: puzzle.date,
      categories: puzzle.answerGroups.map((group) => ({
        id: `cat-${group.id}`,
        name: group.group_name,
        difficulty: this.levelToColor(group.level),
        words: group.members.map((member) => member.word),
      })),
    };
  }

  private levelToColor(level: number): string {
    return ["yellow", "green", "blue", "purple"][level] ?? "yellow";
  }

  isValidYYYYMMDD(dateString: string): boolean {
    // 1. Validate structure using regex (YYYY-MM-DD)
    const regex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    if (!regex.test(dateString)) {
      return false;
    }

    // 2. Validate calendar correctness (e.g., leap years, days in month)
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);

    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    );
  }
}
