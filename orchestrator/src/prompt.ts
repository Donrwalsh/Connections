import type { SolveRequest } from "./types.js";

/**
 * Builds the prompt for a single solve step: propose ONE group of 4 from
 * the remaining words, taking into account any prior guesses and their
 * outcomes. Kept as a pure function so it's easy to unit test and easy to
 * evolve independently of the HTTP/model-calling code.
 */
export function buildSolvePrompt(request: SolveRequest): string {
  const { puzzleWords, priorGuesses } = request;

  const wordList = puzzleWords.join(", ");

  const historySection =
    priorGuesses.length === 0
      ? "No prior guesses have been made yet."
      : [
          "Prior guesses and their outcomes:",
          ...priorGuesses.map((g, i) => {
            const outcomeExplanation =
              g.result === "oneAway"
                ? "3 of these 4 words belong together in some other correct group; exactly one does not belong with the other three."
                : g.result === "correct"
                  ? "This group was fully correct (should not reappear in remaining words, but noted for context)."
                  : "This exact group of 4 was wrong (not all 4 belong together).";
            return `  ${i + 1}. [${g.words.join(", ")}] → ${g.result}. ${outcomeExplanation}`;
          }),
        ].join("\n");

  return `You are solving a single step of an NYT Connections puzzle.

In Connections, 16 words must be sorted into 4 groups of 4, where each group shares a hidden category (e.g. synonyms, a wordplay pattern, "types of ___", etc). Categories can be deliberately misleading — a word may seem to fit an obvious category but actually belongs to a trickier one.

Remaining words in play: ${wordList}

${historySection}

Your task: propose exactly ONE group of 4 words from the remaining words that you believe share a category. Use any prior guess outcomes as constraints:
- If a prior guess was "oneAway", avoid proposing that exact same group of 4 again, and consider which 3 of those words are more likely correct together.
- If a prior guess was "incorrect", that exact group of 4 is wrong — do not propose it again.
- Favor the grouping you are most confident about, since an incorrect guess has a real cost in the actual game.

Respond with your proposed group, a short category label, your confidence (0 to 1), and a brief reasoning for the grouping.`;
}
