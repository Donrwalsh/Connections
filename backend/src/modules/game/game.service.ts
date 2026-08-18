import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "./entities/puzzle.entity";
import { GuessResult } from "../strategy/entities/guess.entity";
import { NYT_CONNECTIONS_ORIGIN_DATE } from "./constants";

export interface PuzzleCategoryDto {
  id: string;
  name: string;
  difficulty: string;
  words: string[];
}

export interface PuzzleResponseDto {
  id: number;
  date: string;
  categories: PuzzleCategoryDto[];
  wordOrder: string[];
}

@Injectable()
export class GameService {
  // Puzzles are inserted once by ingestion and never mutated, so a date-keyed
  // in-memory cache is safe and needs no invalidation.
  private static readonly PUZZLE_CACHE_TTL_MS = 86_400_000; // 24h
  private readonly puzzleCache = new Map<string, { expiresAt: number; value: PuzzleResponseDto }>();

  constructor(@InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>) {}

  async puzzleDateToId(date: string): Promise<number> {
    const puzzle = await this.puzzleRepo.findOne({ where: { date } });
    if (!puzzle) {
      throw new NotFoundException(`No puzzle for date: ${date}`);
    }
    return puzzle.id;
  }

  /**
   * Reverse of puzzleDateToId — used by pages that only know a puzzle's
   * numeric id (e.g. the leaderboard's per-run page, which routes on
   * puzzleId) and need its date to link back to the actual puzzle.
   */
  async puzzleIdToDate(id: number): Promise<string> {
    const puzzle = await this.puzzleRepo.findOne({ where: { id } });
    if (!puzzle) {
      throw new NotFoundException(`No puzzle with id: ${id}`);
    }
    return puzzle.date;
  }

  /**
   * Validates a YYYY-MM-DD date string and resolves it to a puzzle id,
   * consolidating the validate-and-resolve dance shared by every strategy
   * date route.
   */
  async resolveDateToPuzzleId(date: string): Promise<number> {
    if (!this.isValidYYYYMMDD(date)) {
      throw new BadRequestException(`Invalid date format: '${date}'. Expected YYYY-MM-DD.`);
    }
    return this.puzzleDateToId(date);
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

  /**
   * Evaluates a guess against an already-loaded puzzle. The strategy worker
   * uses this with a puzzle loaded once per run instead of re-fetching the
   * same immutable puzzle from the DB for every single guess.
   */
  static evaluateGuessOnPuzzle(puzzle: Puzzle, words: string[]): { result: GuessResult } {
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
    // Empty table: fall back to the NYT Connections origin date so callers
    // still have a sensible "first" puzzle date to anchor on.
    return result.latest_date ?? NYT_CONNECTIONS_ORIGIN_DATE;
  }

  async getPuzzleByDate(date: string): Promise<PuzzleResponseDto> {
    const cached = this.puzzleCache.get(date);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

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
    const value: PuzzleResponseDto = {
      id: puzzle.id,
      date: puzzle.date,
      categories: puzzle.answerGroups.map((group) => ({
        id: `cat-${group.id}`,
        name: group.group_name,
        difficulty: this.levelToColor(group.level),
        words: group.members.map((member) => member.word),
      })),
      wordOrder: puzzle.answerGroups
        .flatMap((group) => group.members)
        .sort((a, b) => a.position - b.position)
        .map((m) => m.word),
    };

    this.puzzleCache.set(date, {
      expiresAt: Date.now() + GameService.PUZZLE_CACHE_TTL_MS,
      value,
    });

    return value;
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

    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
}
