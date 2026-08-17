import { Injectable, Logger } from "@nestjs/common";
import { loadEnv, orchestratorTimeoutMs } from "../../config/env";

export type SolveErrorCode = "duplicate_group" | "invalid_group" | "model_error";

export type ModelProvider = "openai" | "ollama";

export interface SolveUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface PromptMetadata {
  attempt: number;
  temperature: number;
  model: string;
  contextWindow: number;
  latencyMs: number;
  usage?: SolveUsage;
  outcome: "accepted" | "duplicate_rejected" | "invalid" | "error";
}

export interface ProposedGroup {
  word_ids: number[];
  reasoning: string;
}

export type ProposalStatus = "used" | "rejected_duplicate" | "not_selected";

export interface ProposalAnnotation {
  promptNumber: number;
  word_ids: number[];
  reasoning: string;
  status: ProposalStatus;
}

export interface SolveSuccess {
  proposedGroups: ProposedGroup[];
  proposals: ProposalAnnotation[];
  prompt: string;
  model: string;
  contextWindow: number;
  latencyMs: number;
  temperature: number;
  usage: SolveUsage;
  promptMetadata: PromptMetadata[];
}

export interface SolveErrorDetails {
  proposedGroups?: ProposedGroup[];
  proposals?: ProposalAnnotation[];
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  usage?: SolveUsage;
  promptMetadata?: PromptMetadata[];
}

export interface SolveFailure {
  error: string;
  code: SolveErrorCode;
  details?: SolveErrorDetails;
}

export type SolveOutcome = { ok: true; data: SolveSuccess } | { ok: false; error: SolveFailure };

export interface OrchestratorSolveRequest {
  puzzleWords: string[];
  priorGuesses: { words: string[]; result: "correct" | "incorrect" | "oneAway" }[];
  modelProvider?: ModelProvider;
  temperature?: number;
  numResponses?: number;
  maxNumResponses?: number;
  maxPrompts?: number;
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
 * Thin client for the orchestrator's POST /solve and POST /solve-assist
 * endpoints. The LLM strategy runner calls proposeGroup repeatedly (one
 * proposal per guess step) or solveAssist for the unified AI Assist flow.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly orchestratorUrl = loadEnv().ORCHESTRATOR_URL;
  private readonly internalApiKey = loadEnv().INTERNAL_API_KEY;

  async proposeGroup(request: OrchestratorSolveRequest): Promise<SolveOutcome> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce("/solve", request);

        if (response.ok) {
          const data: SolveSuccess = await response.json();
          return { ok: true, data };
        }

        if (response.status === 400 || response.status === 409) {
          const body = (await response.json().catch(() => null)) as
            (Partial<SolveFailure> & { code?: string }) | null;
          return {
            ok: false,
            error: {
              error: body?.error ?? `HTTP ${response.status}`,
              code: this.isKnownErrorCode(body?.code) ? body.code : "model_error",
              details: body?.details,
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
          `Orchestrator /solve attempt ${attempt + 1} of ${MAX_RETRIES + 1} failed` +
            ` (${this.describeError(lastError)}). Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    return {
      ok: false,
      error: {
        error: `Orchestrator /solve failed after ${MAX_RETRIES + 1} attempts: ${this.describeError(lastError)}`,
        code: "model_error",
      },
    };
  }

  /**
   * Calls the orchestrator's POST /solve-assist endpoint with the full
   * conversation history. Used by the LLM strategy runner for the unified
   * AI Assist flow — the backend owns prompt building and conversation state.
   */
  async solveAssist(messages: ChatMessage[]): Promise<SolveAssistOutcome> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce("/solve-assist", { messages });

        if (response.ok) {
          const body = await response.json();
          return {
            ok: true,
            data: {
              response: body.response,
              groups: body.groups,
              model: body.model,
              latencyMs: body.latencyMs ?? 0,
              usage: body.usage,
            },
          };
        }

        if (response.status === 400 || response.status === 409) {
          const body = (await response.json().catch(() => null)) as
            (Partial<SolveAssistFailure> & { code?: string }) | null;
          return {
            ok: false,
            error: {
              error: body?.error ?? `HTTP ${response.status}`,
              code: this.isKnownErrorCode(body?.code) ? body.code : "model_error",
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
          `Orchestrator /solve-assist attempt ${attempt + 1} of ${MAX_RETRIES + 1} failed` +
            ` (${this.describeError(lastError)}). Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    return {
      ok: false,
      error: {
        error: `Orchestrator /solve-assist failed after ${MAX_RETRIES + 1} attempts: ${this.describeError(lastError)}`,
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
