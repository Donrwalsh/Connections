import { generateText, type LanguageModelUsage } from "ai";
import { parseAnswer, type AnswerTextIssue } from "answer-grammar";
import { type ChatMessage } from "./types.js";
import {
  defaultProvider,
  effectiveContextWindow,
  getModel,
  getModelName,
  type ModelProvider,
} from "./provider.js";
import { SolveError, classifyModelCallError } from "./solver.js";

export interface AnswerStepResult {
  response: string;
  groups: string[][];
  proposalWords: string[][];
  categoryByGroup: Record<string, string>;
  textIssues: AnswerTextIssue[];
  model: string;
  // The context window actually used for this call — may differ from the
  // contextWindow the caller passed in, since Ollama's is always capped at
  // MODEL_CONTEXT_WINDOW (see provider.ts's effectiveContextWindow).
  contextWindow?: number;
  latencyMs?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
}

export interface AnswerStepOpts {
  model?: string;
  provider?: ModelProvider;
  contextWindow?: number;
  abortSignal?: AbortSignal;
  // The automated strategy runner's per-step call (default, true) persists
  // latency/usage/request-response detail onto its SolvePrompt row; the
  // conversational AI Assist button (/diagnose) never persists anything, so
  // this must genuinely skip asking the AI SDK to assemble that detail
  // (include: {requestBody, responseBody}) rather than compute-then-discard
  // it.
  captureTelemetry?: boolean;
}

const ANSWER_STEP_TEMPERATURE = 0.7;

/**
 * Runs a single answer step: feeds the full conversation history to the
 * model and returns its raw answer plus the full structured parse (final
 * answer grid, GROUPS-block proposals/categories, and any text-parsing
 * issues) — see the answer-grammar package for the single grammar behind
 * `groups`/`proposalWords`/`categoryByGroup`/`textIssues`.
 *
 * Backs both POST /solve-step (the automated strategy runner's per-step
 * call — `model`/`provider`/`contextWindow` overrides, telemetry captured)
 * and POST /diagnose (the frontend's conversational AI Assist button — no
 * overrides, `captureTelemetry: false`).
 */
export async function runAnswerStep(
  messages: ChatMessage[],
  opts: AnswerStepOpts = {},
): Promise<AnswerStepResult> {
  const captureTelemetry = opts.captureTelemetry ?? true;
  const resolvedProvider = opts.provider ?? defaultProvider();

  let text: string;
  let modelId: string;
  let usage: AnswerStepResult["usage"];
  let requestBody: unknown;
  let responseId: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let responseBody: unknown;
  const startTime = captureTelemetry ? Date.now() : undefined;
  let latencyMs: number | undefined;

  try {
    const result = await generateText({
      model: getModel(resolvedProvider, opts.model, opts.contextWindow),
      messages,
      temperature: ANSWER_STEP_TEMPERATURE,
      // Both default to false — without this, result.request.body and
      // result.response.body stay undefined on a successful call (the
      // rejection path's APICallError.responseBody isn't gated the same
      // way, which is why only failures were landing in SolvePrompt).
      // /diagnose never persists telemetry, so skip asking the SDK to
      // assemble this detail at all rather than compute-then-discard it.
      ...(captureTelemetry ? { include: { requestBody: true, responseBody: true } } : {}),
      // The strategy runner's own step loop is the only retry layer; the AI
      // SDK's default of 2 silently adds a second one that also delays and
      // re-bills a doomed call (e.g. a Google daily-quota 429) before it
      // ever reaches classifyModelCallError.
      maxRetries: 0,
      // Forwards the incoming HTTP request's own abort signal (see app.ts),
      // so a client that gives up (e.g. the backend's ORCHESTRATOR_TIMEOUT_MS)
      // actually cancels this call instead of leaving it running server-side
      // to complete — and bill tokens for — a result nobody will ever read.
      abortSignal: opts.abortSignal,
    });
    if (captureTelemetry) {
      latencyMs = Date.now() - startTime!;
      requestBody = result.request.body;
      responseId = result.response.id;
      responseHeaders = result.response.headers;
      responseBody = result.response.body;
      if (result.usage) {
        const u: LanguageModelUsage = result.usage;
        usage = {
          promptTokens: u.inputTokens,
          completionTokens: u.outputTokens,
          totalTokens: u.totalTokens,
        };
      }
    }
    text = result.text;
    modelId = result.response.modelId;
  } catch (err) {
    throw classifyModelCallError(err, resolvedProvider, {
      model: getModelName(resolvedProvider, opts.model),
      latencyMs: captureTelemetry ? Date.now() - startTime! : undefined,
    });
  }

  const parsed = parseAnswer(text);

  if (parsed.groups.length === 0) {
    throw new SolveError(
      "invalid_group",
      'Model response contained no parseable group proposals or "ANSWER:" section',
      { model: modelId, latencyMs, requestBody, responseId, responseHeaders, responseBody },
    );
  }

  return {
    response: text,
    groups: parsed.groups,
    proposalWords: parsed.proposalWords,
    categoryByGroup: Object.fromEntries(parsed.categoryByGroup),
    textIssues: parsed.textIssues,
    model: modelId,
    contextWindow: effectiveContextWindow(resolvedProvider, opts.contextWindow),
    latencyMs,
    usage,
    requestBody,
    responseId,
    responseHeaders,
    responseBody,
  };
}
