import { generateObject, JSONParseError, NoObjectGeneratedError, TypeValidationError } from "ai";
import {
  solveOutputSchema,
  type SolveRequest,
  type ProposedGroup,
  type SolveErrorCode,
  type Usage,
} from "./types.js";
import { buildSolvePrompt } from "./prompt.js";
import { getContextWindow, getModel } from "./provider.js";

export interface SolveResult {
  proposedGroups: ProposedGroup[];
  prompt: string;
  model: string;
  contextWindow: number;
  latencyMs: number;
  temperature?: number;
  usage: Usage;
}

export interface SolveErrorDetails {
  proposedGroups?: ProposedGroup[];
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  usage?: Usage;
}

/**
 * Typed failure from a solve step. `code` distinguishes recoverable bad
 * model output (duplicate/invalid groups) from unrecoverable model/network
 * failures so the backend can react appropriately (re-prompt vs. abort).
 */
export class SolveError extends Error {
  constructor(
    readonly code: SolveErrorCode,
    message: string,
    readonly details: SolveErrorDetails = {},
  ) {
    super(message);
    this.name = "SolveError";
  }
}

/**
 * Runs a single solve step: given the current puzzle state, ask the model
 * to propose numResponses candidate groups of 4 words.
 *
 * Deliberately synchronous/single-shot for v0 — no internal retry or
 * backtrack loop yet. That logic lives on the backend, which re-invokes
 * this endpoint with an updated guess history until the puzzle is solved.
 *
 * The model output is only checked for shape here (exactly numResponses
 * well-formed groups); the backend decides which candidate to actually
 * submit, since it owns the full guess history and can tell a fresh group
 * from a repeat.
 *
 * Returns the prompt alongside the result so the caller can surface
 * exactly what was sent to the model, without duplicating
 * buildSolvePrompt's logic, plus model/usage metadata for telemetry.
 */
export async function proposeGroup(
  request: SolveRequest,
): Promise<SolveResult> {
  const prompt = buildSolvePrompt(request);
  const startedAt = Date.now();

  let result;
  try {
    result = await generateObject({
      model: getModel(),
      schema: solveOutputSchema(request.numResponses),
      prompt,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    });
  } catch (err) {
    throw classifyModelCallError(err, { prompt });
  }

  const latencyMs = Date.now() - startedAt;
  const model = result.response.modelId;
  const usage: Usage = {
    promptTokens: result.usage.inputTokens ?? 0,
    completionTokens: result.usage.outputTokens ?? 0,
    totalTokens: result.usage.totalTokens ?? 0,
  };

  return {
    proposedGroups: result.object.proposed_groups,
    prompt,
    model,
    contextWindow: getContextWindow(),
    latencyMs,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    usage,
  };
}

/**
 * Classifies an AI SDK failure from generateObject into a typed SolveError.
 * Malformed-but-present output (no/undecodable object) is recoverable —
 * the backend can re-prompt. Provider/network failures are not.
 */
function classifyModelCallError(err: unknown, details: SolveErrorDetails): SolveError {
  const message = err instanceof Error ? err.message : "Unknown model error";

  if (
    err instanceof NoObjectGeneratedError ||
    err instanceof TypeValidationError ||
    err instanceof JSONParseError
  ) {
    return new SolveError(
      "invalid_group",
      `Model produced a malformed response: ${message}`,
      details,
    );
  }

  return new SolveError("model_error", `Model call failed: ${message}`, details);
}
