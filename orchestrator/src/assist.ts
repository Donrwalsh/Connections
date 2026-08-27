import { generateText } from "ai";
import { type ChatMessage } from "./types.js";
import { defaultProvider, getModel, getModelName } from "./provider.js";
import { SolveError, classifyModelCallError } from "./solver.js";

export interface AssistResult {
  response: string;
  groups: string[][];
  model: string;
}

const ASSIST_TEMPERATURE = 0.7;

/**
 * Runs one AI Assist step: feed the full conversation history to the model
 * and return its raw answer plus the parsed group lines.
 *
 * The AI Assist flow is conversational — each button press in the frontend
 * appends a new user prompt (INITIAL on a fresh session, RETRY after a failed
 * guess) to the accumulated history and re-sends the whole thing. The
 * orchestrator holds no state: it is given the complete history and only
 * calls the model, then parses the "ANSWER:" section that the prompts ask
 * for. The model answers in board items themselves (not word_ids), since
 * nothing here is persisted and the frontend needs displayable groups.
 */
export async function runAssistStep(messages: ChatMessage[]): Promise<AssistResult> {
  const provider = defaultProvider();

  let text: string;
  let modelId: string;
  try {
    const result = await generateText({
      model: getModel(provider),
      messages,
      temperature: ASSIST_TEMPERATURE,
    });
    text = result.text;
    modelId = result.response.modelId;
  } catch (err) {
    throw classifyModelCallError(err, provider, { model: getModelName(provider) });
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

/**
 * Extracts the group lines from a model answer. The prompts ask for a line
 * containing only "ANSWER:" followed by one four-comma-separated-item line
 * per remaining group, so we take everything after the first bare ANSWER:
 * line and split it into groups (one per non-blank line that actually looks
 * like an item list — i.e. contains a comma). Trailing prose lines ("Done!",
 * "Good luck!") are ignored so they don't masquerade as groups; item counts
 * are otherwise not enforced here — the frontend's guess validation decides
 * what a malformed line actually means.
 */
export function parseAnswerGroups(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const answerIndex = lines.findIndex((line) => /^ANSWER:\s*$/i.test(line.trim()));
  if (answerIndex === -1) return [];

  const groups: string[][] = [];
  for (const line of lines.slice(answerIndex + 1)) {
    if (!line.trim() || !line.includes(",")) continue;
    const items = line
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length === 0) continue;
    groups.push(items);
  }
  return groups;
}
