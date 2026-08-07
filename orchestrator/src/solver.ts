import { generateObject, JSONParseError, NoObjectGeneratedError, TypeValidationError } from "ai";
import {
  ProposedGroupSchema,
  type SolveRequest,
  type ProposedGroup,
  type SolveErrorCode,
  type Usage,
} from "./types.js";
import { buildSolvePrompt, forbiddenIdSets } from "./prompt.js";
import { getContextWindow, getModel } from "./provider.js";

export interface SolveResult {
  proposedGroup: ProposedGroup;
  prompt: string;
  model: string;
  contextWindow: number;
  latencyMs: number;
  usage: Usage;
}

export interface SolveErrorDetails {
  proposedGroup?: ProposedGroup;
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
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
 * to propose one group of 4 words.
 *
 * Deliberately synchronous/single-shot for v0 — no internal retry or
 * backtrack loop yet. That logic lives on the backend, which re-invokes
 * this endpoint with an updated guess history until the puzzle is solved.
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
      schema: ProposedGroupSchema,
      prompt,
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
  const metadata: SolveErrorDetails = {
    prompt,
    model,
    contextWindow: getContextWindow(),
    latencyMs,
    usage,
  };

  try {
    validateProposedGroup(result.object, request);
  } catch (err) {
    if (err instanceof SolveError) {
      throw new SolveError(err.code, err.message, {
        ...metadata,
        proposedGroup: result.object,
      });
    }
    throw err;
  }

  return {
    proposedGroup: result.object,
    prompt,
    model,
    contextWindow: getContextWindow(),
    latencyMs,
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

/**
 * Defensive check beyond schema validation: confirms the model's proposed
 * IDs point at words in the puzzle's remaining word list, are unique, and
 * don't repeat a previously-guessed group. generateObject guarantees shape
 * (4 ints, confidence in range, etc) but not that the IDs are valid options
 * — models occasionally hallucinate. Fail loudly here rather than silently
 * passing bad data up to the backend.
 */
export function validateProposedGroup(
  group: ProposedGroup,
  request: SolveRequest,
): void {
  const wordCount = request.puzzleWords.length;
  const available = new Set(Array.from({ length: wordCount }, (_, i) => i));
  const invalidIds = group.word_ids.filter((id) => !available.has(id));

  if (invalidIds.length > 0) {
    throw new SolveError(
      "invalid_group",
      `Model proposed word IDs not present in the puzzle's remaining word list: ${invalidIds.join(", ")}`,
    );
  }

  const uniqueIds = new Set(group.word_ids);
  if (uniqueIds.size !== 4) {
    throw new SolveError(
      "invalid_group",
      `Model proposed a group with duplicate word IDs: ${group.word_ids.join(", ")}`,
    );
  }

  const proposed = new Set(group.word_ids);
  const repeated = forbiddenIdSets(request).some(
    (ids) =>
      ids.length === proposed.size && ids.every((id) => proposed.has(id)),
  );
  if (repeated) {
    throw new SolveError(
      "duplicate_group",
      `Model proposed a previously-guessed group: ${group.word_ids.join(", ")}`,
    );
  }
}
