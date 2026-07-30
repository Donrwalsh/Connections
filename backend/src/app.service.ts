import { Injectable } from "@nestjs/common";
import { PriorGuessDto, SolveResponseDto } from "./modules/game/dto/game.dto";

@Injectable()
export class AppService {
  private orchestratorUrl = "http://ai_orchestrator:3001";

  async solve(puzzleWords: string[], priorGuesses: PriorGuessDto[] = []) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${this.orchestratorUrl}/solve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": "potato",
        },
        body: JSON.stringify({ puzzleWords, priorGuesses }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return {
          orchestrator: "unhealthy",
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const data: SolveResponseDto = await res.json();
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
}
