import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  ProposedGroupSchema,
  type SolveRequest,
  type ProposedGroup,
} from "./types.js";
import { buildSolvePrompt } from "./prompt.js";

const MODEL = "gpt-4o-2024-08-06";

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
    model: openai(MODEL),
    schema: ProposedGroupSchema,
    prompt,
  });

  validateProposedGroup(object, request);

  return { proposedGroup: object, prompt };
}

/**
 * Defensive check beyond schema validation: confirms the model's proposed
 * words actually come from the puzzle's remaining word list. generateObject
 * guarantees shape (4 strings, confidence in range, etc) but not that the
 * words are real options — models occasionally hallucinate or slightly
 * misspell a word. Fail loudly here rather than silently passing bad data
 * up to the backend.
 */
function validateProposedGroup(
  group: ProposedGroup,
  request: SolveRequest,
): void {
  const available = new Set(request.puzzleWords.map((w) => w.toLowerCase()));
  const invalidWords = group.words.filter(
    (w) => !available.has(w.toLowerCase()),
  );

  if (invalidWords.length > 0) {
    throw new Error(
      `Model proposed words not present in the puzzle's remaining word list: ${invalidWords.join(", ")}`,
    );
  }

  const uniqueWords = new Set(group.words.map((w) => w.toLowerCase()));
  if (uniqueWords.size !== 4) {
    throw new Error(
      `Model proposed a group with duplicate words: ${group.words.join(", ")}`,
    );
  }
}
