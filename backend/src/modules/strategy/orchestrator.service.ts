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
  numResponses: number;
  model: string;
  contextWindow: number;
  latencyMs: number;
  usage?: SolveUsage;
  outcome: "accepted" | "duplicate_rejected" | "invalid" | "error";
}

export interface ProposedGroup {
  word_ids: number[];
  category: string;
  confidence: number;
  reasoning: string;
}

export type ProposalStatus = "used" | "rejected_duplicate" | "not_selected";

export interface ProposalAnnotation {
  promptNumber: number;
  word_ids: number[];
  category: string;
  confidence: number;
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
  numResponses: number;
  promptAttempts: number;
  duplicatesRejected: number;
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
  numResponses?: number;
  promptAttempts?: number;
  duplicatesRejected?: number;
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
  // Which LLM backend the orchestrator should consult for this step, derived
  // from the strategy name (llm-openai -> openai, llm-ollama -> ollama).
  // Omitted for provider-less callers (the orchestrator then uses its default).
  modelProvider?: ModelProvider;
  temperature?: number;
  numResponses?: number;
  temperatureStep?: number;
  maxTemperature?: number;
  maxNumResponses?: number;
  maxPrompts?: number;
}

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
// A single solve step makes up to LLM_MAX_PROMPTS (default 19) sequential model
// calls with escalating candidate counts, so a legitimate step can take well
// over a minute. Budget the whole step on every attempt rather than sizing for
// one model call (the old 40s/15s split assumed a single call plus cold start).
const TIMEOUT_MS = orchestratorTimeoutMs();

/**
 * Thin client for the orchestrator's POST /solve endpoint. The LLM strategy
 * calls this repeatedly (one proposal per guess step), so the outcome is a
 * typed discriminated union rather than a thrown exception: the caller
 * decides whether a failure is recoverable by re-prompting.
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
        const response = await this.fetchOnce(request);

        if (response.ok) {
          const data: SolveSuccess = await response.json();
          return { ok: true, data };
        }

        // 400/409 are meaningful model outputs, not transport failures —
        // don't retry them.
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

        // 5xx (including the orchestrator's own model_error) and any other
        // unexpected status are treated as transport failures: retry.
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      } catch (err) {
        // A timeout means the step exceeded its budget. The orchestrator is
        // likely still working on the aborted request, so retrying would just
        // queue behind it and burn the budget again. Fail fast — the strategy
        // worker re-runs the guess step on its own backoff schedule.
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

  private async fetchOnce(request: OrchestratorSolveRequest): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      return await fetch(`${this.orchestratorUrl}/solve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-api-key": this.internalApiKey,
        },
        body: JSON.stringify(request),
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
