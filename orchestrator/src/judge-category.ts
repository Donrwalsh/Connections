import { generateObject, type LanguageModelUsage } from "ai";
import { z } from "zod";
import {
  DEFAULT_JUDGE_PROVIDER,
  getModel,
  getModelName,
  type ModelProvider,
} from "./provider.js";
import { classifyModelCallError } from "./solver.js";

const JUDGE_TEMPERATURE = 0;

const VerdictSchema = z.object({
  verdict: z.enum(["correct", "partial", "lucky"]),
  rationale: z.string(),
});

export interface JudgeCategoryResult {
  verdict: "correct" | "partial" | "lucky";
  rationale: string;
  model: string;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  rawResponseText?: string;
}

export function buildJudgePrompt(proposedCategory: string, actualCategory: string): string {
  return [
    "You are grading whether a puzzle solver correctly identified the theme",
    "connecting a group of four items.",
    "",
    "The solver labeled the group:",
    `  "${proposedCategory}"`,
    "",
    "The puzzle's real label for that group is:",
    `  "${actualCategory}"`,
    "",
    "Both labels describe the same four items. Decide whether the solver",
    "understood the actual connection:",
    "",
    "- correct: the solver's label expresses the same connection as the real",
    "  label, even if worded differently.",
    "- partial: the solver's label is related or thematically close, but",
    "  misses, over-generalizes, or garbles the specific connection.",
    "- lucky: the solver's label does not reflect the real connection - a",
    "  right group of items for the wrong reason, or for no clear reason.",
    "",
    'Respond with JSON: {"verdict": "correct"|"partial"|"lucky",',
    '"rationale": "<one sentence>"}',
  ].join("\n");
}

/**
 * Runs one LLM-judge call: does `proposedCategory` name the same connection
 * as `actualCategory`? Structured output via generateObject so the verdict
 * can't drift; temperature 0 for reproducibility. Captures the same raw
 * request/response detail solve-assist.ts does. A model-call failure is
 * rethrown as a typed SolveError (classifyModelCallError) carrying whatever
 * detail was captured.
 */
export async function judgeCategory(
  proposedCategory: string,
  actualCategory: string,
  model?: string,
  provider?: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<JudgeCategoryResult> {
  const resolvedProvider = provider ?? DEFAULT_JUDGE_PROVIDER;
  const prompt = buildJudgePrompt(proposedCategory, actualCategory);
  const startTime = Date.now();

  try {
    const result = await generateObject({
      model: getModel(resolvedProvider, model),
      schema: VerdictSchema,
      prompt,
      temperature: JUDGE_TEMPERATURE,
      abortSignal,
    });
    const latencyMs = Date.now() - startTime;

    let usage: JudgeCategoryResult["usage"];
    if (result.usage) {
      const u: LanguageModelUsage = result.usage;
      usage = {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
      };
    }

    return {
      verdict: result.object.verdict,
      rationale: result.object.rationale,
      model: getModelName(resolvedProvider, model),
      latencyMs,
      usage,
      requestBody: result.request?.body,
      responseId: result.response?.id,
      responseHeaders: result.response?.headers,
      responseBody: result.response?.body,
      rawResponseText: JSON.stringify(result.object),
    };
  } catch (err) {
    throw classifyModelCallError(err, {
      model: getModelName(resolvedProvider, model),
      latencyMs: Date.now() - startTime,
    });
  }
}
