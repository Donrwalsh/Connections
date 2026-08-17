import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { loadEnv, orchestratorTimeoutMs } from "./config/env";
import { AssistResponseDto, ChatMessageDto } from "./modules/game/dto/game.dto";

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

  /**
   * Proxies the AI Assist step to the orchestrator's POST /diagnose.
   * The AI Assist flow is conversational: the frontend owns the session and
   * sends the full message history (the INITIAL prompt, or the RETRY prompt
   * appended after a failed guess, plus the model's prior responses) on every
   * press. The backend just forwards it and relays the model's raw answer
   * back to the frontend; nothing is persisted. A single attempt is made —
   * a non-2xx already reflects a failed model call or unusable output, so
   * retrying would just re-burn tokens.
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
