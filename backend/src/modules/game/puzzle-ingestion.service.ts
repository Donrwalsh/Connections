import { Injectable, Logger, Inject, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Puzzle } from "./entities/puzzle.entity";
import { AnswerGroup } from "./entities/answer-group.entity";
import { GroupMember } from "./entities/group-member.entity";
import { InjectDataSource } from "@nestjs/typeorm";
import { StrategyService } from "../strategy/strategy.service";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { Queue } from "bullmq";

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
        // Dispatch deterministic alphabetical run right after inserting
        await this.strategyQueue.add("run-strategy", {
          puzzleId,
          strategyName: "alphabetical",
          date: formatted,
        });

        this.logger.log(
          `Queued 'alphabetical' strategy for puzzle ${puzzleId} (${formatted})`,
        );
        inserted++;
      }

      latestDate = nextDate;
    }

    this.logger.log(
      `Ingestion complete: inserted ${inserted} puzzle(s), latest date ${this.formatDate(latestDate)}`,
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

  private async fetchNytPuzzle(
    formattedDate: string,
  ): Promise<ConnectionsPuzzle | null> {
    const url = `https://www.nytimes.com/svc/connections/v2/${formattedDate}.json`;
    const response = await fetch(url, {
      headers: { "User-Agent": "connections-app-ingestion/1.0" },
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(
        `NYT fetch failed for ${formattedDate}: ${response.status}`,
      );
    }

    return response.json();
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
