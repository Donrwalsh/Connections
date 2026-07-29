import { Inject, Injectable } from "@nestjs/common";
import { Client } from "pg";

@Injectable()
export class AppService {
  constructor(@Inject("PG") private readonly db: Client) {}

  private orchestratorUrl = "http://ai_orchestrator:3001";

  async solve(puzzleWords: string[]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${this.orchestratorUrl}/solve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": "potato",
        },
        body: JSON.stringify({ puzzleWords }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return {
          orchestrator: "unhealthy",
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const data = await res.json();
      return { orchestrator: "healthy", data };
    } catch (err) {
      clearTimeout(timeout);

      if (err instanceof Error) {
        console.log(err);
        return {
          orchestrator: "unhealthy",
          error: err.name === "AbortError" ? "Request timed out" : err.message,
        };
      }

      return {
        orchestrator: "unhealthy",
        error: "Unknown error",
      };
    }
  }

  async checkOrchestrator() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${this.orchestratorUrl}/health`, {
        method: "GET",
        headers: {
          "x-internal-api-key": "potato",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return {
          orchestrator: "unhealthy",
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const data = await res.json();
      return { orchestrator: "healthy", data };
    } catch (err) {
      clearTimeout(timeout);

      return {
        orchestrator: "unhealthy",
        error: String(err),
      };
    }
  }

  getHello() {
    return { message: "Hello from NestJS starter app!" };
  }

  async getTodaysPuzzle() {
    const today = new Date().toISOString().split("T")[0];
    // 1. Fetch the puzzle row (single row)
    const puzzleRes = await this.db.query(
      `SELECT id, date FROM Puzzle WHERE date = $1`,
      [today],
    );

    if (puzzleRes.rows.length === 0) return null;

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

  async getLatestDate() {
    const result = await this.db.query(
      "SELECT MAX(date) AS latest_date FROM Puzzle",
    );
    return result.rows[0].latest_date;
  }
}
