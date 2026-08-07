import type { SolveRequest } from "./types.js";

const COLUMNS_PER_ROW = 4;

function wordIndexMap(words: string[]): Map<string, number> {
  return new Map(words.map((word, i) => [word.toLowerCase(), i]));
}

/**
 * Maps a prior guess's words onto sorted indices in the remaining words
 * list, or null when any of its words are no longer in play (a "correct"
 * guess, or any guess touching a word solved since, can't be expressed as
 * an ID set against the current list).
 */
function guessToIdSet(
  indexByWord: Map<string, number>,
  words: string[],
): number[] | null {
  const ids: number[] = [];
  for (const word of words) {
    const id = indexByWord.get(word.toLowerCase());
    if (id === undefined) return null;
    ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * Maps prior wrong-guess word sets onto indices in the remaining words
 * list. The result is the exact set of ID groups the model must never
 * repeat. "correct" groups are resolved (their words leave play) — they
 * are context, not wrong guesses, so they never become forbidden sets.
 */
export function forbiddenIdSets(request: SolveRequest): number[][] {
  const indexByWord = wordIndexMap(request.puzzleWords);

  const sets: number[][] = [];
  for (const guess of request.priorGuesses) {
    if (guess.result === "correct") continue;
    const ids = guessToIdSet(indexByWord, guess.words);
    if (ids) sets.push(ids);
  }
  return sets;
}

/**
 * The subset of prior guesses that were reported "one away": exactly 3 of
 * the 4 words were correct. These sets are still forbidden to repeat, but
 * they also carry extra signal — 3 of their words definitely share a
 * category — so they get their own block in the prompt.
 */
export function oneAwayIdSets(request: SolveRequest): number[][] {
  const indexByWord = wordIndexMap(request.puzzleWords);

  const sets: number[][] = [];
  for (const guess of request.priorGuesses) {
    if (guess.result !== "oneAway") continue;
    const ids = guessToIdSet(indexByWord, guess.words);
    if (ids) sets.push(ids);
  }
  return sets;
}

function formatSetLines(request: SolveRequest, sets: number[][]): string {
  return sets
    .map((ids) => {
      const wordList = ids.map((id) => `"${request.puzzleWords[id]}"`).join(", ");
      return `- [${ids.join(", ")}] (${wordList})`;
    })
    .join("\n");
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
 * Builds the prompt for a single solve step: propose numResponses candidate
 * groups of 4 from the remaining words, taking into account any prior
 * guesses and their outcomes. Kept as a pure function so it's easy to unit
 * test and easy to evolve independently of the HTTP/model-calling code.
 */
export function buildSolvePrompt(request: SolveRequest): string {
  const { puzzleWords } = request;
  const lastId = puzzleWords.length - 1;
  const numResponses = request.numResponses;

  const forbidden = forbiddenIdSets(request);
  const forbiddenSection =
    forbidden.length === 0
      ? ""
      : `\nFORBIDDEN SETS (Previously attempted — DO NOT REPEAT):\n${formatSetLines(
          request,
          forbidden,
        )}\n`;

  const oneAway = oneAwayIdSets(request);
  const oneAwaySection =
    oneAway.length === 0
      ? ""
      : `\nONE-AWAY SETS (Exactly 3 of the 4 words are correct — use these as templates, never repeat them as-is):\n${formatSetLines(
          request,
          oneAway,
        )}\n
HINT: In each ONE-AWAY SET exactly 3 words belong to the same category and the 4th does not. Keep 3 words from a ONE-AWAY SET together and try substituting each other remaining word for the fourth — a candidate that differs from a ONE-AWAY SET by exactly one word is especially promising.\n`;

  return `You are solving a single step of an NYT Connections puzzle.

16 words are sorted into 4 groups of 4, sharing hidden categories (synonyms, wordplay, "types of ___", etc). Categories can be deliberately misleading.

Remaining words (indexed):
${formatIndexedWords(puzzleWords)}
${forbiddenSection}
${oneAwaySection}
Task: Propose exactly ${numResponses} DISTINCT candidate groups of 4 unique word IDs (from 0 to ${lastId}). Every candidate must be a different set of 4 word IDs that share a valid category, and no candidate may repeat a FORBIDDEN SET. Order the candidates by your confidence, strongest first.

STRICT CONSTRAINTS:
1. Provide exactly ${numResponses} groups.
2. Each group selects 4 distinct IDs between 0 and ${lastId}.
3. No group may match any set in FORBIDDEN SETS (regardless of element order).
4. All ${numResponses} groups must be different from one another.
5. First write out your step-by-step evaluation for each candidate — including how it uses any ONE-AWAY SETS — then select the final word IDs.
6. Leverage every ONE-AWAY SET: it tells you 3 of its 4 words share a category, so explore candidates that keep those 3 words together and change the fourth. Prefer such candidates over unrelated groupings.

Respond strictly with valid JSON using this exact structure:
{
  "proposed_groups": [
    {
      "reasoning": "Explain the category step-by-step, verify the set is not in FORBIDDEN SETS, and note which 3 words from a ONE-AWAY SET the candidate keeps",
      "category": "short label",
      "word_ids": [int, int, int, int],
      "confidence": 0.0-1.0
    }
  ]
}`;
}
