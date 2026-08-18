import { Inject, Injectable, Logger } from "@nestjs/common";
import * as path from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { DataSource } from "typeorm";
import { Queue } from "bullmq";
import { Puzzle } from "./entities/puzzle.entity";
import { AnswerGroup } from "./entities/answer-group.entity";
import { GroupMember } from "./entities/group-member.entity";
import { InjectDataSource } from "@nestjs/typeorm";
import { NYT_CONNECTIONS_ORIGIN_DATE } from "./constants";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { AUTOMATIC_STRATEGIES, strategyTrialNumbers } from "../../strategies";

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

      const puzzleData = await this.loadPuzzleData(formatted);

      if (puzzleData === null) {
        // 404 => no puzzle published for this date yet. We've caught up.
        break;
      }

      const puzzleId = await this.insertPuzzle(formatted, puzzleData);

      if (puzzleId !== null) {
        await this.dispatchStrategyRuns(puzzleId, formatted);
        this.logger.log(`Inserted puzzle for ${formatted} (id ${puzzleId})`);
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

    // Empty table: anchor the backfill one day before the NYT Connections
    // origin date so the first date the loop fetches is the origin puzzle.
    return result?.latest
      ? new Date(result.latest)
      : this.addDays(new Date(NYT_CONNECTIONS_ORIGIN_DATE), -1);
  }

  private static readonly FETCH_MAX_RETRIES = 5;
  private static readonly FETCH_RETRY_BASE_DELAY_MS = 1000;

  private get cacheDir(): string {
    return process.env.PUZZLE_CACHE_DIR || path.join(process.cwd(), ".puzzle-cache");
  }

  private cacheFileFor(formattedDate: string): string {
    return path.join(this.cacheDir, `${formattedDate}.json`);
  }

  /**
   * Cache-first, network-fallback puzzle loader. Returns parsed puzzle data,
   * or null when the date has no puzzle (NYT 404 — we've caught up).
   */
  private async loadPuzzleData(formattedDate: string): Promise<ConnectionsPuzzle | null> {
    const cached = await this.readCachedPuzzle(formattedDate);

    if (cached !== null) {
      this.logger.log(`Loaded ${formattedDate} from local cache`);
      return cached;
    }

    const puzzleData = await this.fetchNytPuzzle(formattedDate);

    if (puzzleData !== null) {
      await this.writePuzzleToCache(formattedDate, puzzleData);
    }

    return puzzleData;
  }

  private async readCachedPuzzle(formattedDate: string): Promise<ConnectionsPuzzle | null> {
    try {
      const raw = await readFile(this.cacheFileFor(formattedDate), "utf8");
      return JSON.parse(raw) as ConnectionsPuzzle;
    } catch (error) {
      // No cache file (ENOENT) is the normal path — fall back to NYT. Anything
      // else (corrupt JSON, unreadable file) also falls back to the network,
      // and the successful fetch overwrites the stale file.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          `Failed to read puzzle cache for ${formattedDate}: ${(error as Error).message}`,
        );
      }
      return null;
    }
  }

  private async writePuzzleToCache(formattedDate: string, data: ConnectionsPuzzle): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.cacheFileFor(formattedDate), JSON.stringify(data), "utf8");
    } catch (error) {
      // Cache is best-effort — never fail the ingestion run over it.
      this.logger.warn(
        `Failed to write puzzle cache for ${formattedDate}: ${(error as Error).message}`,
      );
    }
  }

  private async fetchNytPuzzle(formattedDate: string): Promise<ConnectionsPuzzle | null> {
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

        throw new Error(`NYT fetch failed for ${formattedDate}: ${response.status}`);
      } catch (error) {
        // TypeError from fetch() indicates a network error — retryable
        if (!(error instanceof TypeError)) throw error;

        if (attempt >= PuzzleIngestionService.FETCH_MAX_RETRIES) {
          throw new Error(
            `NYT fetch for ${formattedDate} failed after ${
              PuzzleIngestionService.FETCH_MAX_RETRIES + 1
            } attempts: ${error.message}`,
            { cause: error },
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

  /**
   * Queues one job per (strategy, trial) for every automatic strategy — the
   * deterministic ones plus shuffle-smart/shuffle-foolish — on the freshly
   * inserted puzzle. LLM strategies are deliberately never dispatched here,
   * so ingestion never spends LLM tokens or needs a SupportedModel to guess
   * a default from. Uses the same deterministic job ids as the
   * /dispatch/strategy endpoint, so a re-run of ingestion collapses onto the
   * existing jobs instead of duplicating them.
   *
   * Best-effort: a transient queue failure must not abort the multi-day
   * ingestion loop (the loop would be retried by BullMQ, and the already-
   * inserted puzzle would then be skipped on retry, losing its strategy
   * runs entirely). Failures are logged so runs can be triggered manually.
   */
  private async dispatchStrategyRuns(puzzleId: number, date: string): Promise<void> {
    const jobs = AUTOMATIC_STRATEGIES.flatMap((strategyName) =>
      strategyTrialNumbers(strategyName).map((trialNumber) => ({
        name: "run-strategy",
        data: { puzzleId, strategyName, date, trialNumber, model: null },
        opts: { jobId: runStrategyJobId(puzzleId, strategyName, trialNumber) },
      })),
    );

    try {
      await this.strategyQueue.addBulk(jobs);
      this.logger.log(`Queued ${jobs.length} strategy run(s) for puzzle ${date} (id ${puzzleId})`);
    } catch (error) {
      this.logger.warn(
        `Failed to queue strategy runs for puzzle ${date} (id ${puzzleId}): ${(error as Error).message}`,
      );
    }
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
        this.logger.warn(`${formattedDate} already existed — skipped (concurrent run?)`);
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
