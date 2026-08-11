import {
  generateObject,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import {
  solveOutputSchema,
  type SolveRequest,
  type ProposedGroup,
  type SolveErrorCode,
  type Usage,
  type PromptMetadata,
} from "./types.js";
import { buildSolvePrompt, forbiddenIdSets } from "./prompt.js";
import { getContextWindow, getModel, getModelName } from "./provider.js";

const GROUP_SIZE = 4;

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_NUM_RESPONSES = 1;
// The temperature ramp spans exactly this many increments from the default
// base to the ceiling (0 -> 3.2, step 0.032), so each increment is derived
// as (ceiling - base) / steps rather than configured directly.
const LLM_TEMPERATURE_RAMP_STEPS = 100;
const DEFAULT_MAX_TEMPERATURE = 3.2;
const DEFAULT_MAX_NUM_RESPONSES = 10;
const DEFAULT_MAX_PROMPTS = 19;

export interface SolveResult {
  proposedGroups: ProposedGroup[];
  prompt: string;
  model: string;
  contextWindow: number;
  latencyMs: number;
  temperature: number;
  numResponses: number;
  promptAttempts: number;
  duplicatesRejected: number;
  usage: Usage;
  promptMetadata: PromptMetadata[];
}

export interface SolveErrorDetails {
  proposedGroups?: ProposedGroup[];
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  numResponses?: number;
  promptAttempts?: number;
  duplicatesRejected?: number;
  usage?: Usage;
  promptMetadata?: PromptMetadata[];
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
 * to propose candidate groups of 4 words and return the first candidate
 * that is a fresh, well-formed group (no repeats of a prior guess).
 *
 * Deliberately self-contained: if every candidate repeats a previous guess
 * (or the model's output is unusable), the orchestrator re-prompts with
 * changed parameters — raising the sampling temperature and asking for one
 * more distinct candidate on each re-prompt — until a fresh candidate appears
 * or the prompt budget (maxPrompts) is exhausted.
 *
 * The temperature and numResponses that eventually produced the winning
 * candidate are returned so the caller (the backend) can record the escalated
 * values on the guess (the temperature is held onto for subsequent steps).
 *
 * Usage and latency are aggregated across every prompt in the step so the
 * caller's per-guess telemetry reflects the true cost of reaching an answer.
 * `promptMetadata` records each prompt individually (parameters, latency,
 * token usage and outcome — not the prompt text, which is large) for tracking.
 */
export async function proposeGroup(
  request: SolveRequest,
): Promise<SolveResult> {
  const maxTemperature = request.maxTemperature ?? DEFAULT_MAX_TEMPERATURE;
  const maxNumResponses = request.maxNumResponses ?? DEFAULT_MAX_NUM_RESPONSES;
  const maxPrompts = request.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  // The per-re-prompt step is derived rather than configured: unless the
  // caller pins it, size it so 100 increments take the base temperature to
  // the ceiling.
  const temperatureStep =
    request.temperatureStep ??
    (maxTemperature - DEFAULT_TEMPERATURE) / LLM_TEMPERATURE_RAMP_STEPS;

  let temperature = request.temperature ?? DEFAULT_TEMPERATURE;
  let numResponses = request.numResponses ?? DEFAULT_NUM_RESPONSES;

  // Every prior wrong guess becomes a forbidden ID set, so a candidate is a
  // "duplicate" when its sorted ID set is already in here. Reusing the same
  // mapping the prompt uses keeps the two in sync.
  const forbidden = new Set(forbiddenIdSets(request).map(idSetKey));

  const startedAt = Date.now();
  let totalLatencyMs = 0;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  let attempts = 0;
  let duplicatesRejected = 0;
  let sawDuplicate = false;
  let invalidSeen = 0;
  let lastGroups: ProposedGroup[] = [];
  let lastPrompt = "";
  let lastModel = "";
  let lastContextWindow = getContextWindow();
  // One entry per model call, for tracking: the parameters each prompt was
  // submitted with, its latency/token cost, and what it produced. The prompt
  // text is not kept here — it is large and reconstructable.
  const promptMetadata: PromptMetadata[] = [];

  /**
   * Picks the first candidate that is well-formed (4 unique, in-range IDs)
   * and does not repeat a prior guess. Candidates that repeat a prior guess
   * are counted as rejected duplicates (for telemetry); structurally unusable
   * candidates are skipped without counting toward the duplicate total.
   */
  const selectFirstUsable = (
    candidates: ProposedGroup[],
  ): ProposedGroup | null => {
    for (const group of candidates) {
      const ids = group.word_ids;
      const wellFormed =
        ids.length === GROUP_SIZE &&
        ids.every(
          (id) =>
            Number.isInteger(id) && id >= 0 && id < request.puzzleWords.length,
        ) &&
        new Set(ids).size === GROUP_SIZE;

      if (!wellFormed) {
        invalidSeen++;
        continue;
      }

      if (forbidden.has(idSetKey(ids))) {
        sawDuplicate = true;
        duplicatesRejected++;
        continue;
      }

      return group;
    }
    return null;
  };

  /**
   * Escalates the solve step's parameters by one notch, raising the sampling
   * temperature and asking for one more distinct candidate together. Returns
   * false when both levers are already at their cap, signalling the retry
   * loop to stop. The escalated values stick: they are used for the next
   * prompt and echoed back to the caller on success.
   */
  const escalate = (): boolean => {
    let escalated = false;

    if (numResponses < maxNumResponses) {
      numResponses++;
      escalated = true;
    }
    if (temperature < maxTemperature) {
      temperature = Math.min(temperature + temperatureStep, maxTemperature);
      escalated = true;
    }

    return escalated;
  };

  while (attempts < maxPrompts) {
    attempts++;
    const prompt = buildSolvePrompt({ ...request, numResponses, temperature });
    const attemptStartedAt = Date.now();

    let result;
    try {
      result = await generateObject({
        model: getModel(),
        schema: solveOutputSchema(numResponses),
        prompt,
        temperature,
      });
    } catch (err) {
      const failure = classifyModelCallError(err, { prompt });
      const latencyMs = Date.now() - attemptStartedAt;
      totalLatencyMs += latencyMs;
      const errored = failure.code === "model_error";
      promptMetadata.push({
        attempt: attempts,
        temperature,
        numResponses,
        model: getModelName(),
        contextWindow: getContextWindow(),
        latencyMs,
        outcome: errored ? "error" : "invalid",
      });
      if (errored) {
        // Unrecoverable model/network failure — do not re-prompt. Carry the
        // step's prompt metadata along so the caller can record the failure.
        throw new SolveError(failure.code, failure.message, {
          ...failure.details,
          promptMetadata,
        });
      }
      // Malformed-but-present output is recoverable: escalate and re-prompt.
      invalidSeen++;
      lastPrompt = prompt;
      if (!escalate()) break;
      continue;
    }

    const latencyMs = Date.now() - attemptStartedAt;
    totalLatencyMs += latencyMs;
    const attemptUsage: Usage = {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      totalTokens: result.usage.totalTokens ?? 0,
    };
    usage.promptTokens += attemptUsage.promptTokens;
    usage.completionTokens += attemptUsage.completionTokens;
    usage.totalTokens += attemptUsage.totalTokens;
    lastGroups = result.object.proposed_groups;
    lastPrompt = prompt;
    lastModel = result.response.modelId;
    lastContextWindow = getContextWindow();

    // Per-attempt outcome: distinguish duplicates and malformed output seen
    // only in this prompt from the step-level cumulative counters.
    const duplicatesBefore = duplicatesRejected;
    const invalidBefore = invalidSeen;
    const selected = selectFirstUsable(result.object.proposed_groups);
    const duplicateAttempt = duplicatesRejected > duplicatesBefore;
    const invalidAttempt = invalidSeen > invalidBefore;

    promptMetadata.push({
      attempt: attempts,
      temperature,
      numResponses,
      model: lastModel,
      contextWindow: lastContextWindow,
      latencyMs,
      usage: attemptUsage,
      outcome: selected
        ? "accepted"
        : duplicateAttempt
          ? "duplicate_rejected"
          : "invalid",
    });

    if (selected) {
      return {
        proposedGroups: [selected],
        prompt,
        model: lastModel,
        contextWindow: lastContextWindow,
        latencyMs: totalLatencyMs,
        temperature,
        numResponses,
        promptAttempts: attempts,
        duplicatesRejected,
        usage,
        promptMetadata,
      };
    }

    if (!escalate()) break;
  }

  // No usable candidate within the prompt budget. Prefer calling this a
  // duplicate failure when the model kept circling back to prior guesses —
  // that's the recoverable, observable failure mode — and fall back to
  // invalid output when it never produced a well-formed group at all.
  const code: SolveErrorCode = sawDuplicate
    ? "duplicate_group"
    : "invalid_group";
  const message =
    code === "duplicate_group"
      ? `Model repeated previously-guessed groups across ${attempts} prompt${attempts === 1 ? "" : "s"}`
      : `Model produced no usable candidate group across ${attempts} prompt${attempts === 1 ? "" : "s"}`;

  throw new SolveError(code, message, {
    proposedGroups: lastGroups,
    prompt: lastPrompt,
    model: lastModel,
    contextWindow: lastContextWindow,
    latencyMs: totalLatencyMs,
    temperature,
    numResponses,
    promptAttempts: attempts,
    duplicatesRejected,
    usage,
    promptMetadata,
  });
}

function idSetKey(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/**
 * Classifies an AI SDK failure from generateObject into a typed SolveError.
 * Malformed-but-present output (no/undecodable object) is recoverable — the
 * retry loop re-prompts with changed parameters. Provider/network failures
 * are not.
 */
function classifyModelCallError(
  err: unknown,
  details: SolveErrorDetails,
): SolveError {
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

  return new SolveError(
    "model_error",
    `Model call failed: ${message}`,
    details,
  );
}
