import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { loadEnv, orchestratorTimeoutMs } from "./config/env";
import {
  AssistResponseDto,
  ChatMessageDto,
  PriorGuessDto,
  SolveResponseDto,
} from "./modules/game/dto/game.dto";

export interface FetchRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number | number[];
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;

// A single solve step makes up to LLM_MAX_PROMPTS (default 19) sequential model
// calls with escalating candidate counts, so the budget is sized for the whole
// step (ORCHESTRATOR_TIMEOUT_MS, default 120s) and applied to every attempt.
// Timeout failures are not retried by fetchWithRetry — the orchestrator keeps
// working on an aborted request, so retrying just queues behind it.
const SOLVE_RETRY_OPTIONS: FetchRetryOptions = {
  maxRetries: DEFAULT_MAX_RETRIES,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  timeoutMs: orchestratorTimeoutMs(),
};

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly orchestratorUrl = loadEnv().ORCHESTRATOR_URL;
  // Shared secret for the backend↔orchestrator boundary. loadEnv() throws if
  // INTERNAL_API_KEY is missing so an unconfigured deployment fails fast at
  // startup instead of silently degrading to an unauthenticated fallback.
  private readonly internalApiKey = loadEnv().INTERNAL_API_KEY;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness/readiness probe for container orchestration. Returns a
   * "degraded" status (HTTP 503) when the database is unreachable instead of
   * crashing, so the orchestrator can restart the container.
   */
  async checkHealth(): Promise<{ status: "ok" | "degraded"; db: "up" | "down" }> {
    try {
      await this.dataSource.query("SELECT 1");
      return { status: "ok", db: "up" };
    } catch {
      return { status: "degraded", db: "down" };
    }
  }

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
            "x-internal-api-key": this.internalApiKey,
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
        this.logger.error(err);
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

  /**
   * Proxies the AI Assist step to the orchestrator's POST /diagnose.
   * The AI Assist flow is conversational: the frontend owns the session and
   * sends the full message history (the INITIAL prompt, or the RETRY prompt
   * appended after a failed guess, plus the model's prior responses) on every
   * press. The backend just forwards it and relays the model's raw answer
   * back to the frontend; nothing is persisted. Unlike solve, a single
   * attempt is made — a non-2xx already reflects a failed model call or
   * unusable output, so retrying would just re-burn tokens.
   */
  async diagnose(
    messages: ChatMessageDto[],
  ): Promise<
    | { orchestrator: "healthy"; data: AssistResponseDto }
    | { orchestrator: "unhealthy"; error: string }
  > {
    const url = `${this.orchestratorUrl}/diagnose`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": this.internalApiKey,
      },
      body: JSON.stringify({ messages }),
    };

    try {
      const res = await this.fetchOnceWithTimeout(url, init);
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        // Surface the orchestrator's own error message (e.g. an unusable
        // response with no ANSWER: section) so the frontend can explain why
        // the AI Assist step failed.
        const message =
          body && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `HTTP ${res.status} ${res.statusText}`;
        return { orchestrator: "unhealthy", error: message };
      }

      return { orchestrator: "healthy", data: body as AssistResponseDto };
    } catch (err) {
      if (err instanceof Error) {
        this.logger.error(err);
        return { orchestrator: "unhealthy", error: err.message };
      }

      return { orchestrator: "unhealthy", error: "Unknown error" };
    }
  }

  private async fetchOnceWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), orchestratorTimeoutMs());
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
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
      const timeout = timeouts[Math.min(attempt, timeouts.length - 1)] ?? DEFAULT_TIMEOUT_MS;

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
        // A timeout means the step exceeded its budget. The orchestrator is
        // likely still working on the aborted request, so retrying would just
        // queue behind it and double the wait. Fail fast — a fresh user action
        // (or the strategy worker's per-step backoff) retries instead.
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(
            `AI solve request failed after ${attempt + 1} attempt${attempt + 1 === 1 ? "" : "s"}: Request timed out`,
            { cause: err },
          );
        }
      }

      if (attempt < maxRetries) {
        const delay = initialDelayMs * 2 ** attempt;
        this.logger.warn(
          `AI solve request attempt ${attempt + 1} of ${
            maxRetries + 1
          } failed (${this.describeError(lastError)}). ` + `Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    const attempts = maxRetries + 1;
    throw new Error(
      `AI solve request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ` +
        this.describeError(lastError),
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
          "x-internal-api-key": this.internalApiKey,
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
