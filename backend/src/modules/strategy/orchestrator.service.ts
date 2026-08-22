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

/**
 * One real call attempt to OpenAI that failed and got retried before this
 * request's outcome (success or terminal failure) was reached. Previously
 * these left no trace at all — only the last attempt's bare error message
 * survived. `attemptNumber` is 1-based within this OrchestratorService call.
 */
export interface OpenAiCallAttempt {
  attemptNumber: number;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  errorMessage?: string;
  isRetryable?: boolean;
}

export interface SolveAssistSuccess {
  response: string;
  groups: string[][];
  model: string;
  latencyMs: number;
  usage?: SolveUsage;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  retriedAttempts?: OpenAiCallAttempt[];
}

export interface SolveAssistFailure {
  error: string;
  code: SolveErrorCode;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  isRetryable?: boolean;
  retriedAttempts?: OpenAiCallAttempt[];
  /**
   * True only on the retry loop's own exhaustion return (every attempt
   * 0..MAX_RETRIES failed with a 5xx/network error) — in that case
   * `retriedAttempts` already includes the LAST attempt's own failure,
   * unlike every other failure path (a terminal 400/409, a timeout, or a
   * mid-retry terminal error), where `retriedAttempts` holds only the
   * attempts that happened BEFORE this one. Lets callers avoid recording
   * this failure's own aggregate summary message as if it were a distinct
   * extra call attempt — see llm-strategy-runner.service.ts.
   */
  retriedAttemptsIncludeFinal?: boolean;
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
   *
   * `model`/`provider` tell the orchestrator which model to actually call —
   * the backend has already validated `model` against the SupportedModel
   * table before a run ever gets this far (see StrategyService), so this is
   * the one place that choice is handed off. Omit either to fall back to the
   * orchestrator's own env-configured default (used for the provider-less
   * /diagnose AI Assist path, which never sends these).
   */
  async solveAssist(
    messages: ChatMessage[],
    model?: string,
    provider?: "openai" | "ollama",
  ): Promise<SolveAssistOutcome> {
    return this.executeWithRetry<SolveAssistSuccess>(
      "/solve-assist",
      { messages, model, provider },
      (raw) => ({
        response: raw.response,
        groups: raw.groups,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
        requestBody: raw.requestBody,
        responseId: raw.responseId,
        responseHeaders: raw.responseHeaders,
        responseBody: raw.responseBody,
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
    const retriedAttempts: OpenAiCallAttempt[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce(path, body);

        if (response.ok) {
          const raw = await response.json();
          const data = mapSuccess(raw) as T & { retriedAttempts?: OpenAiCallAttempt[] };
          if (retriedAttempts.length > 0) {
            data.retriedAttempts = retriedAttempts;
          }
          return { ok: true, data };
        }

        const failureBody = (await response.json().catch(() => null)) as
          | (Partial<SolveAssistFailure> & { code?: string; details?: Record<string, unknown> })
          | null;

        if (response.status === 400 || response.status === 409) {
          return {
            ok: false,
            error: {
              error: failureBody?.error ?? `HTTP ${response.status}`,
              code: this.isKnownErrorCode(failureBody?.code) ? failureBody.code : "model_error",
              ...this.extractCallDetail(failureBody?.details),
              retriedAttempts: retriedAttempts.length > 0 ? retriedAttempts : undefined,
            },
          };
        }

        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        // response.status is the authoritative HTTP status this call just
        // observed — it must win over extractCallDetail's own `statusCode`
        // key, which is only present when the orchestrator's error details
        // bag happened to carry one (e.g. from an APICallError) and is
        // `undefined` otherwise. Spreading callDetail AFTER statusCode would
        // let that `undefined` silently clobber the real status.
        const callDetail = this.extractCallDetail(failureBody?.details);
        retriedAttempts.push({
          attemptNumber: attempt + 1,
          errorMessage: failureBody?.error ?? this.describeError(lastError),
          ...callDetail,
          statusCode: callDetail.statusCode ?? response.status,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            ok: false,
            error: {
              error: "Request timed out",
              code: "model_error",
              retriedAttempts: retriedAttempts.length > 0 ? retriedAttempts : undefined,
            },
          };
        }
        lastError = err;
        retriedAttempts.push({
          attemptNumber: attempt + 1,
          errorMessage: this.describeError(err),
        });
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
        retriedAttempts,
        // retriedAttempts already recorded all MAX_RETRIES + 1 real
        // attempts, including this last one — see retriedAttemptsIncludeFinal's
        // own docblock.
        retriedAttemptsIncludeFinal: true,
      },
    };
  }

  /** Pulls the known raw-detail keys off a SolveError `details` bag (see solver.ts on the orchestrator side), ignoring anything else it might carry. */
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    OpenAiCallAttempt,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
  > {
    if (!details) return {};
    return {
      requestBody: details.requestBody,
      responseId: details.responseId as string | undefined,
      responseHeaders: details.responseHeaders as Record<string, string> | undefined,
      responseBody: details.responseBody,
      statusCode: details.statusCode as number | undefined,
      errorName: details.errorName as string | undefined,
      isRetryable: details.isRetryable as boolean | undefined,
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
