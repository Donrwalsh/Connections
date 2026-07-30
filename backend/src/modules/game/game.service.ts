import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { Client } from "pg";
import { STRATEGY_QUEUE } from "../queue/queue.module";

@Injectable()
export class GameService {
  constructor(
    @Inject("PG") private readonly db: Client,
    @Inject(STRATEGY_QUEUE) private queue: Queue,
  ) {}

  async triggerRun(puzzleId: string, strategyName: string) {
    await this.queue.add("run-strategy", { puzzleId, strategyName });
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

  async getLatestDate() {
    const result = await this.db.query(
      "SELECT MAX(date) AS latest_date FROM Puzzle",
    );
    return result.rows[0].latest_date;
  }

  async getPuzzleByDate(date: string) {
    // 1. Fetch the puzzle row (single row)
    const puzzleRes = await this.db.query(
      `SELECT id, date FROM Puzzle WHERE date = $1`,
      [date],
    );

    if (puzzleRes.rows.length === 0)
      throw new NotFoundException(`No puzzle for date: ${date}`);

    const puzzle = puzzleRes.rows[0];

    // 2. Fetch answer groups + members
    const groupsRes = await this.db.query(
      `
      SELECT
        ag.id AS group_id,
        ag.group_name,
        ag.level,
        gm.word,
        gm.position
      FROM AnswerGroup ag
      JOIN GroupMember gm ON gm.group_id = ag.id
      WHERE ag.puzzle_id = $1
      ORDER BY ag.level ASC, gm.position ASC;
      `,
      [puzzle.id],
    );
    // 3. Build categories array
    const categoriesMap = new Map();

    for (const row of groupsRes.rows) {
      if (!categoriesMap.has(row.group_id)) {
        categoriesMap.set(row.group_id, {
          id: `cat-${row.group_id}`,
          name: row.group_name,
          difficulty: this.levelToColor(row.level),
          words: [],
        });
      }

      categoriesMap.get(row.group_id).words.push(row.word);
    }

    return {
      date: puzzle.date,
      categories: Array.from(categoriesMap.values()),
    };
  }

  private levelToColor(level: number): string {
    return ["yellow", "green", "blue", "purple"][level] ?? "yellow";
  }

  private isValidYYYYMMDD(dateString: string): boolean {
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
