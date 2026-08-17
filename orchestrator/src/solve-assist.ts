import { generateText } from "ai";
import { type ChatMessage } from "./types.js";
import { defaultProvider, getModel, getModelName } from "./provider.js";
import { SolveError, classifyModelCallError } from "./solver.js";
import { parseAnswerGroups } from "./assist.js";

export interface SolveAssistResult {
  response: string;
  groups: string[][];
  model: string;
}

const SOLVE_ASSIST_TEMPERATURE = 0.7;

/**
 * Runs a single solve-assist step: feeds the full conversation history to the
 * model and returns its raw answer plus the parsed group lines. This mirrors
 * the AI Assist flow (POST /diagnose) but is used by the backend strategy
 * runner for automated solving.
 *
 * The backend owns the session: it builds the prompts (INITIAL on a fresh
 * step, RETRY after a failed guess), accumulates the model's responses, and
 * submits the full history on every call. The orchestrator stays stateless.
 */
export async function solveAssist(messages: ChatMessage[]): Promise<SolveAssistResult> {
  const provider = defaultProvider();

  let text: string;
  let modelId: string;
  try {
    const result = await generateText({
      model: getModel(provider),
      messages,
      temperature: SOLVE_ASSIST_TEMPERATURE,
    });
    text = result.text;
    modelId = result.response.modelId;
  } catch (err) {
    throw classifyModelCallError(err, { model: getModelName(provider) });
  }

  const groups = parseAnswerGroups(text);
  if (groups.length === 0) {
    throw new SolveError(
      "invalid_group",
      'Model response contained no "ANSWER:" section with group lines',
      { model: modelId },
    );
  }

  return { response: text, groups, model: modelId };
}
