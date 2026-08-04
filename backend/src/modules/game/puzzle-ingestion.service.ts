import { Injectable, Logger, Inject } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Puzzle } from "./entities/puzzle.entity";
import { AnswerGroup } from "./entities/answer-group.entity";
import { GroupMember } from "./entities/group-member.entity";
import { InjectDataSource } from "@nestjs/typeorm";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { Queue } from "bullmq";
import { SUPPORTED_STRATEGIES } from "../../strategies";

interface ConnectionsCard {
  content: string;
  position: number;
}
interface ConnectionsGroup {
  title: string;
  cards: ConnectionsCard[];
}
interface ConnectionsPuzzle {
  categories: ConnectionsGroup[];
}

const AWKWARD_DATES = new Set([
  "2024-12-12",
  "2025-04-01",
  "2025-10-31",
  "2026-02-07",
  "2026-03-07",
  "2026-04-01",
  "2026-05-06",
]);

const ALL_STRATEGIES = SUPPORTED_STRATEGIES;

@Injectable()
export class PuzzleIngestionService {
  private readonly logger = new Logger(PuzzleIngestionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STRATEGY_QUEUE) private readonly strategyQueue: Queue,
  ) {}

  /**
   * Fetches and inserts NYT Connections puzzles day-by-day, starting the
   * day after the latest date currently in the DB, until the NYT endpoint
   * has no data for a date (i.e. we've caught up to "the future").
   */
  async populateUntilCaughtUp(): Promise<{
    inserted: number;
    upToDate: string | null;
  }> {
    let latestDate = await this.getLatestDate();
    let inserted = 0;

    while (true) {
      const nextDate = this.addDays(latestDate, 1);
      const formatted = this.formatDate(nextDate);

      if (AWKWARD_DATES.has(formatted)) {
        this.logger.log(`Skipping ${formatted} (known irregular NYT date)`);
        latestDate = nextDate;
        continue;
      }

      const puzzleData = await this.fetchNytPuzzle(formatted);

      if (puzzleData === null) {
        // 404 => no puzzle published for this date yet. We've caught up.
        break;
      }

      const puzzleId = await this.insertPuzzle(formatted, puzzleData);

      if (puzzleId !== null) {
        // Dispatch all deterministic strategy runs right after inserting
        for (const strategyName of ALL_STRATEGIES) {
          await this.strategyQueue.add("run-strategy", {
            puzzleId,
            strategyName,
            date: formatted,
          });
        }

        this.logger.log(
          `Queued all deterministic strategies (${ALL_STRATEGIES.join(
            ", ",
          )}) for puzzle ${puzzleId} (${formatted})`,
        );
        inserted++;
      }

      latestDate = nextDate;

      // Small delay between dates to avoid triggering NYT rate limits
      await this.delay(500);
    }

    this.logger.log(
      `Ingestion complete: inserted ${inserted} puzzle(s), latest date ${this.formatDate(
        latestDate,
      )}`,
    );
    return { inserted, upToDate: this.formatDate(latestDate) };
  }

  private async getLatestDate(): Promise<Date> {
    const result = await this.dataSource
      .createQueryBuilder(Puzzle, "puzzle")
      .select("MAX(puzzle.date)", "latest")
      .getRawOne();

    // Fall back to "yesterday" if the table is empty so the loop starts today.
    return result?.latest
      ? new Date(result.latest)
      : this.addDays(new Date(), -1);
  }

  private static readonly FETCH_MAX_RETRIES = 5;
  private static readonly FETCH_RETRY_BASE_DELAY_MS = 1000;

  private async fetchNytPuzzle(
    formattedDate: string,
  ): Promise<ConnectionsPuzzle | null> {
    const url = `https://www.nytimes.com/svc/connections/v2/${formattedDate}.json`;

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "connections-app-ingestion/1.0" },
        });

        if (response.status === 404) return null;

        if (response.ok) return response.json();

        // Retryable status (429 rate limit, 5xx server errors) — wait and
        // retry. Anything else (4xx) is a hard failure.
        if (this.isRetryableStatus(response.status)) {
          if (attempt >= PuzzleIngestionService.FETCH_MAX_RETRIES) {
            throw new Error(
              `NYT fetch for ${formattedDate} failed after ${
                PuzzleIngestionService.FETCH_MAX_RETRIES + 1
              } attempts: status ${response.status}`,
            );
          }
          this.logger.warn(
            `NYT fetch for ${formattedDate} returned ${response.status} (attempt ${attempt + 1})`,
          );
          await this.delay(this.computeBackoff(attempt));
          continue;
        }

        throw new Error(
          `NYT fetch failed for ${formattedDate}: ${response.status}`,
        );
      } catch (error) {
        // TypeError from fetch() indicates a network error — retryable
        if (!(error instanceof TypeError)) throw error;

        if (attempt >= PuzzleIngestionService.FETCH_MAX_RETRIES) {
          throw new Error(
            `NYT fetch for ${formattedDate} failed after ${
              PuzzleIngestionService.FETCH_MAX_RETRIES + 1
            } attempts: ${error.message}`,
          );
        }

        this.logger.warn(
          `Retrying NYT fetch for ${formattedDate} (attempt ${attempt + 1}): ${error.message}`,
        );
      }

      await this.delay(this.computeBackoff(attempt));
    }
  }

  private isRetryableStatus(status: number | undefined): boolean {
    return status === 429 || (status !== undefined && status >= 500);
  }

  private computeBackoff(attempt: number): number {
    const base = PuzzleIngestionService.FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt;
    return base + Math.floor(Math.random() * base * 0.2); // +0-20% jitter
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async insertPuzzle(
    formattedDate: string,
    data: ConnectionsPuzzle,
  ): Promise<number | null> {
    return this.dataSource.transaction(async (manager) => {
      const puzzle = await manager
        .getRepository(Puzzle)
        .createQueryBuilder()
        .insert()
        .into(Puzzle)
        .values({ date: formattedDate })
        .orIgnore()
        .returning("id")
        .execute();

      if (puzzle.identifiers.length === 0 || !puzzle.identifiers[0]?.id) {
        this.logger.warn(
          `${formattedDate} already existed — skipped (concurrent run?)`,
        );
        return null;
      }
      const puzzleId = puzzle.identifiers[0].id;

      for (const [level, category] of data.categories.entries()) {
        const group = await manager.getRepository(AnswerGroup).save({
          puzzle: { id: puzzleId } as Puzzle,
          level,
          group_name: category.title,
        });

        const members = category.cards.map((card) => ({
          group: { id: group.id } as AnswerGroup,
          word: card.content,
          position: card.position,
        }));
        await manager.getRepository(GroupMember).save(members);
      }

      this.logger.log(`Inserted puzzle for ${formattedDate}`);
      return puzzleId;
    });
  }

  private addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  private formatDate(date: Date): string {
    return (
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0")
    );
  }
}
