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
  numResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(1)
    .describe("Starting number of candidate groups the model should propose per prompt. Each solve step begins by asking for this many groups and, when every candidate repeats a prior guess, the orchestrator re-prompts with more distinct candidates (numResponses) and/or a higher temperature. The value that eventually produced a usable candidate is echoed back so the caller can hold onto it for subsequent steps"),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Starting sampling temperature for this solve step. When every candidate repeats a prior guess, the orchestrator re-prompts with a raised temperature; the value that produced a usable candidate is echoed back so the caller can hold onto it for subsequent steps"),
  temperatureStep: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .default(0.1)
    .describe("How much to raise the temperature on each temperature-raising re-prompt"),
  maxTemperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .default(2)
    .describe("Ceiling for temperature escalation (the OpenAI API's max)"),
  maxNumResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(10)
    .describe("Ceiling for the number of distinct candidates requested per prompt"),
  maxPrompts: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(5)
    .describe("Maximum number of prompts a single solve step may make before giving up on a fresh candidate"),
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
    .describe("Exactly 4 indices (0-15) into the puzzle's remaining word list that the model believes share a category"),
  category: z
    .string()
    .describe("A short label describing the shared theme/category, e.g. 'Types of ___'"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Model's self-assessed confidence that this exact grouping is correct"),
  reasoning: z
    .string()
    .describe("Brief explanation of why these 4 words were grouped together"),
});
export type ProposedGroup = z.infer<typeof ProposedGroupSchema>;

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
      .describe(`Exactly ${numResponses} candidate groups, ordered by the model's confidence`),
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
 * Response body for POST /solve.
 * `prompt` is the exact text of the model call that produced the winning
 * candidate — returned alongside the result so callers can show what was
 * actually asked, e.g. for debugging or transparency.
 * The model metadata/usage fields let the backend record per-guess LLM
 * telemetry without making a second request, including how many times the
 * solve step had to prompt the model (promptAttempts) and the final
 * temperature/numResponses that produced the candidate — the caller holds
 * these onto for subsequent solve steps.
 */
export const SolveResponseSchema = z.object({
  proposedGroups: z
    .array(ProposedGroupSchema)
    .length(1)
    .describe("The single selected candidate: the first well-formed group that does not repeat a prior guess"),
  prompt: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive(),
  latencyMs: z.number().int().nonnegative(),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .describe("Temperature of the model call that produced the candidate"),
  numResponses: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe("Number of candidates requested in the model call that produced the candidate"),
  promptAttempts: z
    .number()
    .int()
    .min(1)
    .describe("How many times the model was prompted before a usable candidate was found (1 when no re-prompt was needed)"),
  duplicatesRejected: z
    .number()
    .int()
    .nonnegative()
    .describe("How many candidate groups that repeated a prior guess were rejected across this solve step's prompts"),
  usage: UsageSchema,
});
export type SolveResponse = z.infer<typeof SolveResponseSchema>;

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
