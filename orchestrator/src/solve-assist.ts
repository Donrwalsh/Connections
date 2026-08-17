import { generateText, type LanguageModelUsage } from "ai";
import { type ChatMessage } from "./types.js";
import { defaultProvider, getModel, getModelName } from "./provider.js";
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
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

const SOLVE_ASSIST_TEMPERATURE = 0.7;
const GROUP_SIZE = 4;

/**
 * Extracts structured group proposals (category + word list) from the ### GROUPS section.
 */
function parseGroupProposals(responseText: string): ParsedGroupProposal[] {
  const proposals: ParsedGroupProposal[] = [];
  const groupBlockRegex =
    /Group\s+(\d+)[\s\S]*?Category:\s*([^\n]+)[\s\S]*?Words:\s*([^\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = groupBlockRegex.exec(responseText)) !== null) {
    const category = match[2].trim();
    const words = match[3]
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
 */
export async function solveAssist(
  messages: ChatMessage[],
): Promise<SolveAssistResult> {
  const provider = defaultProvider();

  let text: string;
  let modelId: string;
  let usage: SolveAssistResult["usage"];
  const startTime = Date.now();
  let latencyMs: number;

  try {
    const result = await generateText({
      model: getModel(provider),
      messages,
      temperature: SOLVE_ASSIST_TEMPERATURE,
    });
    latencyMs = Date.now() - startTime;
    text = result.text;
    modelId = result.response.modelId;

    if (result.usage) {
      const u: LanguageModelUsage = result.usage;
      usage = {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
      };
    }
  } catch (err) {
    throw classifyModelCallError(err, { model: getModelName(provider) });
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
      { model: modelId },
    );
  }

  return {
    response: text,
    groups,
    proposals,
    model: modelId,
    latencyMs,
    usage,
  };
}
