import type { SolveRequest } from "./types.js";

const COLUMNS_PER_ROW = 4;

/**
 * Maps prior wrong-guess word sets onto indices in the remaining words
 * list. Only guesses whose 4 words are ALL still in play can be expressed
 * as an ID set — a "correct" guess (or any guess touching a word since
 * solved) can't be formed from the remaining words, so it is omitted. The
 * result is the exact set of ID groups the model must never repeat.
 */
export function forbiddenIdSets(request: SolveRequest): number[][] {
  const indexByWord = new Map(
    request.puzzleWords.map((word, i) => [word.toLowerCase(), i]),
  );

  const sets: number[][] = [];
  for (const guess of request.priorGuesses) {
    // "correct" groups are resolved (their words leave play) — they are
    // context, not wrong guesses, so they never become forbidden sets.
    if (guess.result === "correct") continue;

    const ids: number[] = [];
    let complete = true;
    for (const word of guess.words) {
      const id = indexByWord.get(word.toLowerCase());
      if (id === undefined) {
        complete = false;
        break;
      }
      ids.push(id);
    }
    if (complete) {
      ids.sort((a, b) => a - b);
      sets.push(ids);
    }
  }
  return sets;
}

function formatIndexedWords(words: string[]): string {
  const entries = words.map((word, i) => `${i}: ${word}`);
  const width = Math.max(...entries.map((entry) => entry.length)) + 2;

  const rows: string[] = [];
  for (let i = 0; i < entries.length; i += COLUMNS_PER_ROW) {
    rows.push(
      entries
        .slice(i, i + COLUMNS_PER_ROW)
        .map((entry) => entry.padEnd(width))
        .join("")
        .trimEnd(),
    );
  }
  return rows.join("\n");
}

/**
 * Builds the prompt for a single solve step: propose ONE group of 4 from
 * the remaining words, taking into account any prior guesses and their
 * outcomes. Kept as a pure function so it's easy to unit test and easy to
 * evolve independently of the HTTP/model-calling code.
 */
export function buildSolvePrompt(request: SolveRequest): string {
  const { puzzleWords } = request;
  const lastId = puzzleWords.length - 1;

  const forbidden = forbiddenIdSets(request);
  const forbiddenSection =
    forbidden.length === 0
      ? ""
      : `\nFORBIDDEN SETS (Previously attempted — DO NOT REPEAT):\n${forbidden
          .map((ids) => `- [${ids.join(", ")}]`)
          .join("\n")}\n`;

  return `You are solving a single step of an NYT Connections puzzle.

16 words are sorted into 4 groups of 4, sharing hidden categories (synonyms, wordplay, "types of ___", etc). Categories can be deliberately misleading.

Remaining words (indexed):
${formatIndexedWords(puzzleWords)}
${forbiddenSection}
Task: Propose exactly ONE group of 4 unique word IDs (from 0 to ${lastId}) sharing a valid category.

STRICT CONSTRAINTS:
1. Select 4 distinct IDs between 0 and ${lastId}.
2. The selected array MUST NOT match any set in FORBIDDEN SETS (regardless of element order).
3. First write out your step-by-step evaluation, then select the final word IDs.

Respond strictly with valid JSON using this exact key order:
{
  "reasoning": "Explain the category step-by-step and verify the set is not in FORBIDDEN SETS",
  "category": "short label",
  "word_ids": [int, int, int, int],
  "confidence": 0.0-1.0
}`;
}
