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

  async getLatestDate() {
    const result = await this.db.query(
      "SELECT MAX(date) AS latest_date FROM Puzzle",
    );
    return result.rows[0].latest_date;
  }
}
