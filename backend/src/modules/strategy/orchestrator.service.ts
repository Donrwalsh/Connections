import { Injectable, Logger } from "@nestjs/common";
import { loadEnv, orchestratorTimeoutMs } from "../../config/env";

export type SolveErrorCode =
  "duplicate_group" | "invalid_group" | "model_error" | "rate_limited" | "rate_limited_daily";

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
  // The context window actually used for this call — reported back by the
  // orchestrator, since it can differ from the contextWindow requested (see
  // this class's solveAssist doc comment and provider.ts's
  // effectiveContextWindow on the orchestrator side).
  contextWindow?: number;
  latencyMs: number;
  usage?: SolveUsage;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
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
  // Seconds to wait before retrying — set only when code is "rate_limited".
  retryAfterSeconds?: number;
}

export type SolveAssistOutcome =
  { ok: true; data: SolveAssistSuccess } | { ok: false; error: SolveAssistFailure };

export interface JudgeCategorySuccess {
  verdict: "correct" | "partial" | "lucky";
  rationale: string;
  model: string;
  latencyMs: number;
  usage?: SolveUsage;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  rawResponseText?: string;
}

export type JudgeCategoryOutcome =
  { ok: true; data: JudgeCategorySuccess } | { ok: false; error: SolveAssistFailure };

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
   * /diagnose AI Assist path, which never sends these). `contextWindow` is
   * this model's real context window (from SupportedModel) — omitted when
   * the model hasn't been through a metadata refresh yet. For Ollama, the
   * orchestrator always caps what it actually requests at its own
   * MODEL_CONTEXT_WINDOW regardless of this value, and reports the true
   * effective context window back on `SolveAssistSuccess.contextWindow`.
   */
  async solveAssist(
    messages: ChatMessage[],
    model?: string,
    provider?: "openai" | "ollama" | "google" | "groq",
    contextWindow?: number | null,
  ): Promise<SolveAssistOutcome> {
    return this.executeCall<SolveAssistSuccess>(
      "/solve-assist",
      { messages, model, provider, contextWindow: contextWindow ?? undefined },
      (raw) => ({
        response: raw.response,
        groups: raw.groups,
        model: raw.model,
        contextWindow: raw.contextWindow,
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
   * Calls the orchestrator's POST /judge-category — an LLM-as-judge verdict
   * on whether `proposedCategory` names the same connection as
   * `actualCategory`. `model`/`provider` default to JUDGE_MODEL/
   * JUDGE_PROVIDER on the orchestrator side when omitted; the backend always
   * passes both (from loadEnv()). Same failure shape as solveAssist.
   */
  async judgeCategory(
    proposedCategory: string,
    actualCategory: string,
    model?: string,
    provider?: "openai" | "ollama" | "google",
  ): Promise<JudgeCategoryOutcome> {
    return this.executeCall<JudgeCategorySuccess>(
      "/judge-category",
      { proposedCategory, actualCategory, model, provider },
      (raw) => ({
        verdict: raw.verdict,
        rationale: raw.rationale,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
        requestBody: raw.requestBody,
        responseId: raw.responseId,
        responseHeaders: raw.responseHeaders,
        responseBody: raw.responseBody,
        rawResponseText: raw.rawResponseText,
      }),
    );
  }

  /**
   * Makes a single call to the orchestrator — no client-side retry. Every
   * attempt, successful or not, is persisted as its own SolvePrompt row by
   * the caller (see llm-strategy-runner.service.ts), so a failed call is
   * captured rather than silently retried here; the strategy run's own step
   * loop (LLM_MAX_MODEL_ERRORS) is the only retry layer left. `mapSuccess`
   * adapts the raw JSON body into the endpoint's own success-data shape.
   */
  private async executeCall<T>(
    path: string,
    body: unknown,
    mapSuccess: (raw: any) => T, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<{ ok: true; data: T } | { ok: false; error: SolveAssistFailure }> {
    try {
      const response = await this.fetchOnce(path, body);

      if (response.ok) {
        const raw = await response.json();
        return { ok: true, data: mapSuccess(raw) };
      }

      const failureBody = (await response.json().catch(() => null)) as
        (Partial<SolveAssistFailure> & { code?: string; details?: Record<string, unknown> }) | null;
      const callDetail = this.extractCallDetail(failureBody?.details);

      return {
        ok: false,
        error: {
          error: failureBody?.error ?? `HTTP ${response.status}`,
          code: this.isKnownErrorCode(failureBody?.code) ? failureBody.code : "model_error",
          ...callDetail,
          // response.status is the authoritative HTTP status this call just
          // observed — it must win over extractCallDetail's own `statusCode`
          // key, which is only present when the orchestrator's error details
          // bag happened to carry one and is `undefined` otherwise.
          statusCode: callDetail.statusCode ?? response.status,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, error: { error: "Request timed out", code: "model_error" } };
      }
      const message = this.describeError(err);
      this.logger.warn(`Orchestrator ${path} call failed: ${message}`);
      return { ok: false, error: { error: message, code: "model_error" } };
    }
  }

  /** Pulls the known raw-detail keys off a SolveError `details` bag (see solver.ts on the orchestrator side), ignoring anything else it might carry. */
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    SolveAssistFailure,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
    | "retryAfterSeconds"
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
      retryAfterSeconds: details.retryAfterSeconds as number | undefined,
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
    return (
      code === "duplicate_group" ||
      code === "invalid_group" ||
      code === "model_error" ||
      code === "rate_limited" ||
      code === "rate_limited_daily"
    );
  }

  private describeError(err: unknown): string {
    if (err instanceof Error) {
      return err.name === "AbortError" ? "Request timed out" : err.message;
    }
    return String(err);
  }
}
