import { Injectable } from "@nestjs/common";
import { PriorGuessDto, SolveResponseDto } from "./modules/game/dto/game.dto";

export interface FetchRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number | number[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;

// The first call in a session is slow because the model is cold-loaded;
// give it much more room than the warm subsequent attempts.
const SOLVE_RETRY_OPTIONS: FetchRetryOptions = {
  maxRetries: DEFAULT_MAX_RETRIES,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  timeoutMs: [40000, 15000],
};

@Injectable()
export class AppService {
  private orchestratorUrl = "http://ai_orchestrator:3001";

  async solve(
    puzzleWords: string[],
    priorGuesses: PriorGuessDto[] = [],
    retryOptions: FetchRetryOptions = SOLVE_RETRY_OPTIONS,
  ) {
    try {
      const res = await this.fetchWithRetry(
        `${this.orchestratorUrl}/solve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-api-key": "potato",
          },
          body: JSON.stringify({ puzzleWords, priorGuesses }),
        },
        retryOptions,
      );

      if (!res.ok) {
        return {
          orchestrator: "unhealthy",
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const data: SolveResponseDto = await res.json();
      return { orchestrator: "healthy", data };
    } catch (err) {
      if (err instanceof Error) {
        console.log(err);
        return {
          orchestrator: "unhealthy",
          error: err.message,
        };
      }

      return {
        orchestrator: "unhealthy",
        error: "Unknown error",
      };
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    options: FetchRetryOptions = {},
  ): Promise<Response> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const timeouts = Array.isArray(options.timeoutMs)
      ? options.timeoutMs
      : [options.timeoutMs ?? DEFAULT_TIMEOUT_MS];

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const timeout =
        timeouts[Math.min(attempt, timeouts.length - 1)] ?? DEFAULT_TIMEOUT_MS;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        let response: Response;
        try {
          response = await fetch(url, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        } else {
          return response;
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < maxRetries) {
        const delay = initialDelayMs * 2 ** attempt;
        console.warn(
          `[AppService] AI solve request attempt ${attempt + 1} of ${
            maxRetries + 1
          } failed (${this.describeError(lastError)}). ` +
            `Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    const attempts = maxRetries + 1;
    throw new Error(
      `AI solve request failed after ${attempts} attempt${
        attempts === 1 ? "" : "s"
      }: ` + this.describeError(lastError),
    );
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) {
      return err.name === "AbortError" ? "Request timed out" : err.message;
    }
    return String(err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
