import { z } from "zod";

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

/**
 * Request body for POST /solve-assist. The backend strategy runner owns the
 * session: it builds the prompts (INITIAL on a fresh step, RETRY after a
 * failed guess), accumulates the model's responses, and submits the full
 * message history on every call. The orchestrator stays stateless.
 *
 * `model`/`provider` are optional overrides: the backend validates `model`
 * against its SupportedModel table before ever calling this endpoint (see
 * StrategyService), so a strategy run always sends both. When omitted (the
 * provider-less /diagnose AI Assist path uses AssistRequestSchema directly
 * and never has these), the orchestrator falls back to its own
 * env-configured default provider/model.
 */
export const SolveAssistRequestSchema = AssistRequestSchema.extend({
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Model to call, overriding the orchestrator's env-configured default"),
  provider: z
    .enum(["openai", "ollama", "google"])
    .optional()
    .describe("Provider to call, overriding MODEL_PROVIDER"),
  contextWindow: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "This model's real context window, overriding MODEL_CONTEXT_WINDOW for Ollama's num_ctx",
    ),
});
export type SolveAssistRequest = z.infer<typeof SolveAssistRequestSchema>;

/**
 * Response body for POST /solve-assist. Same base shape as AssistResponse
 * (raw model text, parsed ANSWER: groups, model identifier), plus per-call
 * telemetry (latency and token usage) that the backend persists onto its
 * SolvePrompt row.
 */
export const SolveAssistResponseSchema = AssistResponseSchema.extend({
  latencyMs: z.number(),
  // The context window actually used for this call — see
  // solve-assist.ts's SolveAssistResult for why it can differ from the
  // request's contextWindow.
  contextWindow: z.number().optional(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
});
export type SolveAssistResponse = z.infer<typeof SolveAssistResponseSchema>;
