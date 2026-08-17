import { Injectable, Logger } from "@nestjs/common";
import { loadEnv, orchestratorTimeoutMs } from "../../config/env";

export type SolveErrorCode = "duplicate_group" | "invalid_group" | "model_error";

export interface SolveUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SolveAssistSuccess {
  response: string;
  groups: string[][];
  model: string;
  latencyMs: number;
  usage?: SolveUsage;
}

export interface SolveAssistFailure {
  error: string;
  code: SolveErrorCode;
}

export type SolveAssistOutcome =
  | { ok: true; data: SolveAssistSuccess }
  | { ok: false; error: SolveAssistFailure };

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const TIMEOUT_MS = orchestratorTimeoutMs();

/**
 * Thin client for the orchestrator's POST /solve-assist endpoint. The LLM
 * strategy runner calls solveAssist for the unified AI Assist flow — the
 * backend owns prompt building and conversation state.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly orchestratorUrl = loadEnv().ORCHESTRATOR_URL;
  private readonly internalApiKey = loadEnv().INTERNAL_API_KEY;

  /**
   * Calls the orchestrator's POST /solve-assist endpoint with the full
   * conversation history. Used by the LLM strategy runner for the unified
   * AI Assist flow — the backend owns prompt building and conversation state.
   */
  async solveAssist(messages: ChatMessage[]): Promise<SolveAssistOutcome> {
    return this.executeWithRetry<SolveAssistSuccess>(
      "/solve-assist",
      { messages },
      (raw) => ({
        response: raw.response,
        groups: raw.groups,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
      }),
    );
  }

  /**
   * Retry-with-exponential-backoff loop shared by every orchestrator call:
   * retries on 5xx/network failures up to MAX_RETRIES, treats 400/409 as a
   * terminal (non-retried) failure, and classifies a timed-out request as a
   * non-retried model_error. `mapSuccess` adapts the raw JSON body into the
   * endpoint's own success-data shape.
   */
  private async executeWithRetry<T>(
    path: string,
    body: unknown,
    mapSuccess: (raw: any) => T, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<{ ok: true; data: T } | { ok: false; error: SolveAssistFailure }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce(path, body);

        if (response.ok) {
          const raw = await response.json();
          return { ok: true, data: mapSuccess(raw) };
        }

        if (response.status === 400 || response.status === 409) {
          const failureBody = (await response.json().catch(() => null)) as
            (Partial<SolveAssistFailure> & { code?: string }) | null;
          return {
            ok: false,
            error: {
              error: failureBody?.error ?? `HTTP ${response.status}`,
              code: this.isKnownErrorCode(failureBody?.code) ? failureBody.code : "model_error",
            },
          };
        }

        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            ok: false,
            error: {
              error: "Request timed out",
              code: "model_error",
            },
          };
        }
        lastError = err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * 2 ** attempt;
        this.logger.warn(
          `Orchestrator ${path} attempt ${attempt + 1} of ${MAX_RETRIES + 1} failed` +
            ` (${this.describeError(lastError)}). Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    return {
      ok: false,
      error: {
        error: `Orchestrator ${path} failed after ${MAX_RETRIES + 1} attempts: ${this.describeError(lastError)}`,
        code: "model_error",
      },
    };
  }

  private async fetchOnce(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      return await fetch(`${this.orchestratorUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": this.internalApiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private isKnownErrorCode(code: string | undefined): code is SolveErrorCode {
    return code === "duplicate_group" || code === "invalid_group" || code === "model_error";
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
}
