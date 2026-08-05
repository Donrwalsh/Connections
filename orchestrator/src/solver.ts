import { generateObject } from "ai";
import {
  ProposedGroupSchema,
  type SolveRequest,
  type ProposedGroup,
} from "./types.js";
import { buildSolvePrompt, forbiddenIdSets } from "./prompt.js";
import { getModel } from "./provider.js";

export interface SolveResult {
  proposedGroup: ProposedGroup;
  prompt: string;
}

/**
 * Runs a single solve step: given the current puzzle state, ask the model
 * to propose one group of 4 words.
 *
 * Deliberately synchronous/single-shot for v0 — no internal retry or
 * backtrack loop yet. That logic will likely live here later, wrapping
 * this same generateObject call (e.g. re-prompt on low confidence,
 * generate multiple candidates and pick the best). Keeping this function
 * focused on "one model call in, one validated group out" makes it a
 * clean seam to build that around.
 *
 * Returns the prompt alongside the result so the caller can surface
 * exactly what was sent to the model (e.g. for the frontend's
 * "show me the prompt" panel), without the caller needing to duplicate
 * buildSolvePrompt's logic.
 */
export async function proposeGroup(
  request: SolveRequest,
): Promise<SolveResult> {
  const prompt = buildSolvePrompt(request);

  const { object } = await generateObject({
    model: getModel(),
    schema: ProposedGroupSchema,
    prompt,
  });

  validateProposedGroup(object, request);

  return { proposedGroup: object, prompt };
}

/**
 * Defensive check beyond schema validation: confirms the model's proposed
 * IDs point at words in the puzzle's remaining word list, are unique, and
 * don't repeat a previously-guessed group. generateObject guarantees shape
 * (4 ints, confidence in range, etc) but not that the IDs are valid options
 * — models occasionally hallucinate. Fail loudly here rather than silently
 * passing bad data up to the backend.
 */
function validateProposedGroup(
  group: ProposedGroup,
  request: SolveRequest,
): void {
  const wordCount = request.puzzleWords.length;
  const available = new Set(Array.from({ length: wordCount }, (_, i) => i));
  const invalidIds = group.word_ids.filter((id) => !available.has(id));

  if (invalidIds.length > 0) {
    throw new Error(
      `Model proposed word IDs not present in the puzzle's remaining word list: ${invalidIds.join(", ")}`,
    );
  }

  const uniqueIds = new Set(group.word_ids);
  if (uniqueIds.size !== 4) {
    throw new Error(
      `Model proposed a group with duplicate word IDs: ${group.word_ids.join(", ")}`,
    );
  }

  const proposed = new Set(group.word_ids);
  const repeated = forbiddenIdSets(request).some(
    (ids) =>
      ids.length === proposed.size && ids.every((id) => proposed.has(id)),
  );
  if (repeated) {
    throw new Error(
      `Model proposed a previously-guessed group: ${group.word_ids.join(", ")}`,
    );
  }
}
