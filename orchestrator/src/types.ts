import { z } from "zod";

/**
 * The outcome of a previously submitted guess, as reported by NYT Connections.
 * "oneAway" specifically means 3 of the 4 words were correct — this is a
 * meaningful constraint signal, not just a pass/fail flag, so we keep it
 * distinct rather than collapsing it into "incorrect".
 */
export const GuessResultSchema = z.enum(["correct", "incorrect", "oneAway"]);
export type GuessResult = z.infer<typeof GuessResultSchema>;

/**
 * A single group of exactly 4 words, with the outcome of guessing it (if known).
 */
export const PriorGuessSchema = z.object({
  words: z.array(z.string()).length(4),
  result: GuessResultSchema,
});
export type PriorGuess = z.infer<typeof PriorGuessSchema>;

/**
 * Request body for POST /solve.
 * The backend is the source of truth for puzzle state; it must send the
 * full remaining word list and full guess history on every call, since
 * the orchestrator holds no state between requests.
 */
export const SolveRequestSchema = z.object({
  puzzleWords: z
    .array(z.string())
    .min(4)
    .describe("Words still in play (not yet correctly grouped)"),
  priorGuesses: z.array(PriorGuessSchema).optional().default([]),
  modelProvider: z
    .enum(["openai", "ollama"])
    .optional()
    .describe(
      "Which LLM backend to consult for this solve step. When omitted, the orchestrator's configured default (MODEL_PROVIDER) is used",
    ),
  numResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(1)
    .describe(
      "Starting number of candidate groups the model should propose per prompt. Each solve step begins by asking for this many groups and, when every candidate repeats a prior guess, the orchestrator re-prompts asking for one more distinct candidate until a fresh candidate appears. The count that eventually produced a usable candidate is echoed back so the caller can record it; each fresh solve step starts back at this base count",
    ),
  temperature: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe(
      "Fixed sampling temperature for this solve step. The orchestrator never changes it while re-prompting; the value used is echoed back so the caller can record it",
    ),
  maxNumResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(10)
    .describe(
      "Ceiling for the number of distinct candidates requested per prompt",
    ),
  maxPrompts: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(19)
    .describe(
      "Maximum number of prompts a single solve step may make before giving up on a fresh candidate",
    ),
});
export type SolveRequest = z.infer<typeof SolveRequestSchema>;

/**
 * The shape we ask the model to produce. Kept separate from the HTTP
 * response schema below in case we want to enrich the response later
 * without changing what we prompt the model for.
 *
 * Words are referenced by their index into the remaining words list
 * (0-15) rather than by spelling, so the model answers in IDs that map
 * unambiguously back to the puzzle state.
 */
export const ProposedGroupSchema = z.object({
  word_ids: z
    .array(z.number().int().min(0).max(15))
    .length(4)
    .describe(
      "Exactly 4 indices (0-15) into the puzzle's remaining word list that the model believes share a category",
    ),
  category: z
    .string()
    .describe(
      "A short label describing the shared theme/category, e.g. 'Types of ___'",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Model's self-assessed confidence that this exact grouping is correct",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of why these 4 words were grouped together"),
});
export type ProposedGroup = z.infer<typeof ProposedGroupSchema>;

/**
 * Why a well-formed proposed group did not become the step's guess. Mirrors
 * the disposition the solver gives each candidate: the winner is 'used',
 * groups repeating a prior guess are 'rejected_duplicate', and fresh groups
 * that lost to an earlier (higher-confidence) candidate in the same batch are
 * 'not_selected'. Structurally invalid candidates (wrong length, out-of-range
 * or duplicate ids) are not reported as proposals at all.
 */
export const ProposalStatusSchema = z.enum([
  "used",
  "rejected_duplicate",
  "not_selected",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * A single candidate group the model proposed, annotated with the prompt that
 * produced it and its disposition. The full list is returned so callers can
 * persist every proposal of a solve step, not just the winner. word_ids are
 * indices into the puzzleWords sent in the request (same as ProposedGroup).
 */
export const ProposalSchema = z.object({
  promptNumber: z
    .number()
    .int()
    .min(1)
    .describe("1-based index of the prompt within the solve step that produced this group"),
  word_ids: z
    .array(z.number().int().min(0).max(15))
    .length(4)
    .describe("Indices into the puzzle's remaining word list"),
  category: z.string().describe("Shared theme/category label chosen by the model"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Model's self-assessed confidence in this exact grouping"),
  reasoning: z.string().describe("Brief explanation of why these 4 words were grouped together"),
  status: ProposalStatusSchema.describe(
    "Whether this group was used as the guess, rejected as a repeat of a prior guess, or passed over for a higher-confidence proposal in the same batch",
  ),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * The full shape we ask the model to produce: exactly `numResponses`
 * candidate groups, ordered by the model's confidence. Kept as a factory
 * because the requested candidate count varies per request (see
 * SolveRequestSchema.numResponses, which the orchestrator raises on retries).
 * Shape guarantees (each group has 4 int IDs plus category/confidence/reasoning)
 * are enforced here; content-level checks (are the IDs in range? does the
 * group repeat a previous guess?) happen in the solver, which re-prompts with
 * changed parameters until a fresh candidate appears.
 */
export function solveOutputSchema(numResponses: number) {
  return z.object({
    proposed_groups: z
      .array(ProposedGroupSchema)
      .length(numResponses)
      .describe(
        `Exactly ${numResponses} candidate groups, ordered by the model's confidence`,
      ),
  });
}

/**
 * Token usage of a single model call, mirroring the AI SDK's LanguageModelUsage.
 */
export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

/**
 * What a single model call within a solve step produced. Used for tracking:
 * one entry per prompt submitted, carrying the parameters that call was made
 * with, the measured latency/token cost, and whether its candidate was
 * accepted, rejected as a repeat of a prior guess, unusable, or the call
 * itself failed. The prompt text is deliberately omitted — it is large and
 * reconstructable from the parameters plus the puzzle state.
 */
export const PromptMetadataSchema = z.object({
  attempt: z
    .number()
    .int()
    .min(1)
    .describe("1-based index of this prompt within the solve step"),
  temperature: z
    .number()
    .min(0)
    .max(10)
    .describe("Sampling temperature this prompt was submitted with"),
  numResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe("Number of candidate groups requested from this prompt"),
  model: z
    .string()
    .describe(
      "The model this prompt was sent to (configured name, or the modelId reported on success)",
    ),
  contextWindow: z
    .number()
    .int()
    .positive()
    .describe("Configured context window (num_ctx) at the time of this prompt"),
  latencyMs: z
    .number()
    .int()
    .nonnegative()
    .describe("How long the model call took, including a failed call"),
  usage: UsageSchema.optional().describe(
    "Token usage of this call; omitted when the call failed and no usage was reported",
  ),
  outcome: z
    .enum(["accepted", "duplicate_rejected", "invalid", "error"])
    .describe(
      "What this prompt produced: a usable candidate, only repeats of prior guesses, unusable output, or a model/network error",
    ),
});
export type PromptMetadata = z.infer<typeof PromptMetadataSchema>;

/**
 * Response body for POST /solve.
 * `prompt` is the exact text of the model call that produced the winning
 * candidate — returned alongside the result so callers can show what was
 * actually asked, e.g. for debugging or transparency.
 * The model metadata/usage fields let the backend record per-guess LLM
 * telemetry without making a second request, including how many times the
 * solve step had to prompt the model (promptAttempts) and the fixed
 * temperature/numResponses of the call that produced the candidate.
 * `promptMetadata` is the per-prompt tracking record (parameters, latency,
 * usage and outcome for every model call the step made) — the prompt text
 * itself is omitted since it is large.
 */
export const SolveResponseSchema = z.object({
  proposedGroups: z
    .array(ProposedGroupSchema)
    .length(1)
    .describe(
      "The single selected candidate: the first well-formed group that does not repeat a prior guess",
    ),
  proposals: z
    .array(ProposalSchema)
    .describe(
      "Every well-formed candidate group proposed across this solve step's prompts, each annotated with its prompt number and disposition (used/rejected_duplicate/not_selected)",
    ),
  prompt: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive(),
  latencyMs: z.number().int().nonnegative(),
  temperature: z
    .number()
    .min(0)
    .max(10)
    .describe("Temperature of the model call that produced the candidate"),
  numResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe(
      "Number of candidates requested in the model call that produced the candidate",
    ),
  promptAttempts: z
    .number()
    .int()
    .min(1)
    .describe(
      "How many times the model was prompted before a usable candidate was found (1 when no re-prompt was needed)",
    ),
  duplicatesRejected: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "How many candidate groups that repeated a prior guess were rejected across this solve step's prompts",
    ),
  usage: UsageSchema,
  promptMetadata: z
    .array(PromptMetadataSchema)
    .describe(
      "Per-prompt tracking record for every model call this solve step made",
    ),
});
export type SolveResponse = z.infer<typeof SolveResponseSchema>;

/**
 * A single message in the AI Assist conversation history. The frontend owns
 * the session: it builds the prompts (INITIAL or RETRY, per its game state),
 * accumulates the model's free-form responses, and submits the full history
 * on every press. The orchestrator stays stateless — it just feeds the
 * history to the LLM and returns the raw assistant text.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]).describe("Author of the message"),
  content: z
    .string()
    .min(1)
    .describe("Plain-text message body, exactly as displayed"),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Request body for POST /diagnose. The AI Assist flow is conversational:
 * each button press appends a new user prompt (INITIAL on a fresh session,
 * RETRY after a failed guess) and re-sends the whole message history so the
 * model sees its prior proposals and the feedback on them.
 */
export const AssistRequestSchema = z.object({
  messages: z
    .array(ChatMessageSchema)
    .min(1)
    .describe(
      "Full conversation history to submit to the model, oldest first",
    ),
});
export type AssistRequest = z.infer<typeof AssistRequestSchema>;

/**
 * Response body for POST /diagnose. `response` is the model's raw answer
 * (reasoning plus the "ANSWER:" block); `groups` is the parsed ANSWER block —
 * one array of items per group line, in the order the model listed them. The
 * frontend submits each group as an individual guess through the game's own
 * validation. `prompt` is omitted here because the orchestrator never builds
 * it — the frontend echoes the exact prompt it sent for display.
 */
export const AssistResponseSchema = z.object({
  response: z.string().describe("Raw assistant text returned by the model"),
  groups: z
    .array(z.array(z.string()))
    .describe("Parsed group lines from the ANSWER: section, in listed order"),
  model: z.string(),
});
export type AssistResponse = z.infer<typeof AssistResponseSchema>;

/**
 * Why a solve step failed. Distinct codes let the backend decide whether
 * the model simply repeated a forbidden group (recoverable by re-prompting
 * until a limit), emitted malformed output (same), or hit a real
 * model/network failure (unrecoverable).
 */
export const SolveErrorCodeSchema = z.enum([
  "duplicate_group",
  "invalid_group",
  "model_error",
]);
export type SolveErrorCode = z.infer<typeof SolveErrorCodeSchema>;

export const SolveErrorResponseSchema = z.object({
  error: z.string(),
  code: SolveErrorCodeSchema,
  details: z.unknown().optional(),
});
export type SolveErrorResponse = z.infer<typeof SolveErrorResponseSchema>;
