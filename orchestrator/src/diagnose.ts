import { generateObject } from "ai";
import { DiagnoseOutputSchema, type DiagnoseGroup } from "./types.js";
import { buildDiagnosePrompt } from "./prompt.js";
import { defaultProvider, getModel, getModelName } from "./provider.js";
import { SolveError, classifyModelCallError } from "./solver.js";

export interface DiagnoseResult {
  groups: DiagnoseGroup[];
  prompt: string;
  model: string;
}

/**
 * Runs the AI Assist diagnostic: given the words in play, ask the model for a
 * full 4-group partition and return it for display. This is a display-only
 * read — the result is never persisted anywhere.
 *
 * Unlike proposeGroup there is no retry loop over forbidden guesses: the
 * diagnostic is a single-shot full-puzzle solve. The model's output is
 * validated against the partition rules (4 groups of 4, every item used
 * exactly once) and rejected with a typed SolveError when it does not hold
 * together.
 */
export async function diagnosePartition(
  words: string[],
): Promise<DiagnoseResult> {
  const provider = defaultProvider();
  const prompt = buildDiagnosePrompt(words);

  let result;
  try {
    result = await generateObject({
      model: getModel(provider),
      schema: DiagnoseOutputSchema,
      prompt,
      temperature: 0.2,
    });
  } catch (err) {
    throw classifyModelCallError(err, { prompt, model: getModelName(provider) });
  }

  const groups = result.object.groups;
  const violation = partitionViolation(words, groups);
  if (violation) {
    throw new SolveError("invalid_group", violation, {
      prompt,
      model: result.response.modelId,
    });
  }

  return { groups, prompt, model: result.response.modelId };
}

/**
 * Checks that a candidate partition only uses board words, each exactly once.
 * Group size (4) and count (4) are already guaranteed by the output schema, so
 * the only thing left to verify is that the 16 items it emits are exactly the
 * board: any item outside the board or repeated across groups is rejected.
 * Matching is case-insensitive since the model may echo words with altered case.
 */
function partitionViolation(
  words: string[],
  groups: DiagnoseGroup[],
): string | null {
  const input = new Set(words.map((word) => word.toLowerCase()));
  const seen = new Set<string>();

  for (const group of groups) {
    for (const item of group.items) {
      const key = item.toLowerCase();
      if (!input.has(key)) {
        return `Item "${item}" is not on the board`;
      }
      if (seen.has(key)) {
        return `Item "${item}" appears in more than one group`;
      }
      seen.add(key);
    }
  }

  return null;
}
