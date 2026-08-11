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
  type Proposal,
} from "./types.js";
import { buildSolvePrompt, forbiddenIdSets } from "./prompt.js";
import {
  defaultProvider,
  getContextWindow,
  getModel,
  getModelName,
} from "./provider.js";

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
  proposals: Proposal[];
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
  proposals?: Proposal[];
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
 * `proposals` carries every well-formed candidate proposed across the step's
 * prompts with its disposition, so callers can persist all of them (not just
 * the winner) for analysis.
 *
 * Usage and latency are aggregated across every prompt in the step so the
 * caller's per-guess telemetry reflects the true cost of reaching an answer.
 * `promptMetadata` records each prompt individually (parameters, latency,
 * token usage and outcome — not the prompt text, which is large) for tracking.
 */
export async function proposeGroup(
  request: SolveRequest,
): Promise<SolveResult> {
  // The provider is normally set explicitly by the backend (from the strategy
  // name); fall back to the configured default for robustness.
  const provider = request.modelProvider ?? defaultProvider();
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

  const isWellFormed = (ids: number[]): boolean =>
    ids.length === GROUP_SIZE &&
    ids.every(
      (id) => Number.isInteger(id) && id >= 0 && id < request.puzzleWords.length,
    ) &&
    new Set(ids).size === GROUP_SIZE;

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
  // Every well-formed candidate proposed across the step's prompts, annotated
  // with its prompt number and disposition. Structurally invalid candidates
  // (wrong length, out-of-range or duplicate ids) are skipped, matching what
  // a caller can meaningfully replay.
  const proposals: Proposal[] = [];

  /**
   * Classifies a batch of candidates: picks the first well-formed group that
   * does not repeat a prior guess as the winner and records every well-formed
   * group with its disposition. Groups before the winner that repeat a prior
   * guess are rejected_duplicate; the winner is used; well-formed groups after
   * the winner are fresh but were not selected (a higher-confidence proposal in
   * the batch won), so they are recorded as not_selected. Structurally unusable
   * candidates are skipped without counting toward the duplicate total.
   */
  const classifyBatch = (
    candidates: ProposedGroup[],
    promptNumber: number,
  ): { selected: ProposedGroup | null; proposals: Proposal[] } => {
    const batchProposals: Proposal[] = [];
    let selected: ProposedGroup | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const group = candidates[i];
      const ids = group.word_ids;

      if (!isWellFormed(ids)) {
        invalidSeen++;
        continue;
      }

      if (forbidden.has(idSetKey(ids))) {
        sawDuplicate = true;
        duplicatesRejected++;
        batchProposals.push({
          promptNumber,
          word_ids: ids,
          category: group.category,
          confidence: group.confidence,
          reasoning: group.reasoning,
          status: "rejected_duplicate",
        });
        continue;
      }

      selected = group;
      batchProposals.push({
        promptNumber,
        word_ids: ids,
        category: group.category,
        confidence: group.confidence,
        reasoning: group.reasoning,
        status: "used",
      });
      // Remaining well-formed candidates in this batch are fresh but were not
      // selected — the earlier proposal won. Record them without touching the
      // reject counters (which only cover candidates scanned before the winner).
      for (const rest of candidates.slice(i + 1)) {
        if (isWellFormed(rest.word_ids)) {
          batchProposals.push({
            promptNumber,
            word_ids: rest.word_ids,
            category: rest.category,
            confidence: rest.confidence,
            reasoning: rest.reasoning,
            status: "not_selected",
          });
        }
      }
      break;
    }

    return { selected, proposals: batchProposals };
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
        model: getModel(provider),
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
        model: getModelName(provider),
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
    const { selected, proposals: batchProposals } = classifyBatch(
      result.object.proposed_groups,
      attempts,
    );
    proposals.push(...batchProposals);
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
        proposals,
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
    proposals,
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
