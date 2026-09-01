import { generateText, type LanguageModelUsage } from "ai";
import { type ChatMessage } from "./types.js";
import {
  defaultProvider,
  effectiveContextWindow,
  getModel,
  getModelName,
  type ModelProvider,
} from "./provider.js";
import { SolveError, classifyModelCallError } from "./solver.js";

export interface ParsedGroupProposal {
  words: string[];
  category: string;
}

export interface SolveAssistResult {
  response: string;
  groups: string[][];
  proposals: ParsedGroupProposal[];
  model: string;
  // The context window actually used for this call — may differ from the
  // contextWindow the caller passed in, since Ollama's is always capped at
  // MODEL_CONTEXT_WINDOW (see provider.ts's effectiveContextWindow).
  contextWindow?: number;
  latencyMs: number;
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

const SOLVE_ASSIST_TEMPERATURE = 0.7;
const GROUP_SIZE = 4;

// Some models (Mistral especially) don't put their reasoning in the
// scratchpad the prompt asks for — they append it straight onto the
// "Words:" line instead, e.g. "LOOK, TOUCH, SIGHT, SMELL (these are all
// senses)". Left in, that either glues onto the 4th word or, when the aside
// itself contains commas, inflates the line past 4 tokens and gets the
// whole group discarded. Stripping it before splitting on commas fixes both
// cases — mirrors llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE
// on the backend, which had this same fix (see commit cdd6b22) but this
// parser didn't.
const WORDS_PARENTHETICAL_RE = /\([^)]*\)/g;

/**
 * Extracts structured group proposals (category + word list) from the ### GROUPS section.
 */
export function parseGroupProposals(responseText: string): ParsedGroupProposal[] {
  const proposals: ParsedGroupProposal[] = [];
  const groupBlockRegex =
    /Group\s+(\d+)[\s\S]*?Category:\s*([^\n]+)[\s\S]*?Words:\s*([^\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = groupBlockRegex.exec(responseText)) !== null) {
    const category = match[2].trim();
    const words = match[3]
      .replace(WORDS_PARENTHETICAL_RE, "")
      .split(",")
      .map((w) => w.replace(/[`*#-]/g, "").trim())
      .filter(Boolean);

    if (words.length === GROUP_SIZE) {
      proposals.push({ category, words });
    }
  }

  return proposals;
}

/**
 * Extracts final grid lines from the ### ANSWER section, stripping markdown elements.
 */
export function parseAnswerGroups(responseText: string): string[][] {
  const parts = responseText.split(/###?\s*ANSWER:?/i);
  if (parts.length < 2) return [];

  const answerBlock = parts[1].trim();
  const lines = answerBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const groups: string[][] = [];
  for (const line of lines) {
    const words = line
      .split(",")
      .map((w) => w.replace(/[`*#-]/g, "").trim())
      .filter(Boolean);

    if (words.length === GROUP_SIZE) {
      groups.push(words);
    }
  }

  return groups;
}

/**
 * Runs a single solve-assist step: feeds the full conversation history to the
 * model and returns its raw answer, extracted group proposals, final answer grid,
 * and token usage telemetry.
 *
 * `model`/`provider` override the env-configured default — the backend
 * strategy runner sends both on every call, since it's already validated
 * `model` against its own SupportedModel table before this endpoint is ever
 * hit. `contextWindow` similarly overrides MODEL_CONTEXT_WINDOW for Ollama's
 * num_ctx (see provider.ts's getModel).
 */
export async function solveAssist(
  messages: ChatMessage[],
  model?: string,
  provider?: ModelProvider,
  contextWindow?: number,
  abortSignal?: AbortSignal,
): Promise<SolveAssistResult> {
  const resolvedProvider = provider ?? defaultProvider();

  let text: string;
  let modelId: string;
  let usage: SolveAssistResult["usage"];
  let requestBody: unknown;
  let responseId: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let responseBody: unknown;
  const startTime = Date.now();
  let latencyMs: number;

  try {
    const result = await generateText({
      model: getModel(resolvedProvider, model, contextWindow),
      messages,
      temperature: SOLVE_ASSIST_TEMPERATURE,
      // Both default to false — without this, result.request.body and
      // result.response.body stay undefined on a successful call (the
      // rejection path's APICallError.responseBody isn't gated the same
      // way, which is why only failures were landing in SolvePrompt).
      include: { requestBody: true, responseBody: true },
      // The strategy runner's own step loop is the only retry layer; the AI
      // SDK's default of 2 silently adds a second one that also delays and
      // re-bills a doomed call (e.g. a Google daily-quota 429) before it
      // ever reaches classifyModelCallError.
      maxRetries: 0,
      // Forwards the incoming HTTP request's own abort signal (see app.ts),
      // so a client that gives up (e.g. the backend's ORCHESTRATOR_TIMEOUT_MS)
      // actually cancels this call instead of leaving it running server-side
      // to complete — and bill tokens for — a result nobody will ever read.
      abortSignal,
    });
    latencyMs = Date.now() - startTime;
    text = result.text;
    modelId = result.response.modelId;
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
  } catch (err) {
    throw classifyModelCallError(err, resolvedProvider, {
      model: getModelName(resolvedProvider, model),
      latencyMs: Date.now() - startTime,
    });
  }

  // 1. Extract proposals (Reasoning + Words) from the ### GROUPS section
  const proposals = parseGroupProposals(text);

  // 2. Parse final ANSWER section lines
  let groups = parseAnswerGroups(text);

  // 3. Fallback: If parseAnswerGroups failed due to markdown formatting in ### ANSWER,
  //    use the valid word lists extracted from the ### GROUPS block instead
  if (groups.length === 0 && proposals.length > 0) {
    groups = proposals.map((p) => p.words);
  }

  // 4. Reject only if BOTH extraction strategies failed to produce valid 4-word groups
  if (groups.length === 0) {
    throw new SolveError(
      "invalid_group",
      'Model response contained no parseable group proposals or "ANSWER:" section',
      { model: modelId, latencyMs, requestBody, responseId, responseHeaders, responseBody },
    );
  }

  return {
    response: text,
    groups,
    proposals,
    model: modelId,
    contextWindow: effectiveContextWindow(resolvedProvider, contextWindow),
    latencyMs,
    usage,
    requestBody,
    responseId,
    responseHeaders,
    responseBody,
  };
}
