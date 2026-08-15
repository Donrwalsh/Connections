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
      const wordList = ids
        .map((id) => `"${request.puzzleWords[id]}"`)
        .join(", ");
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
  const oneAway = oneAwayIdSets(request);
  const hasForbidden = forbidden.length > 0;
  const hasOneAway = oneAway.length > 0;

  // Every section below that references one-away or forbidden sets is emitted
  // only when that kind of set is actually present, so the model never gets
  // hints or constraints about signal it cannot see.

  const intro =
    hasForbidden && hasOneAway
      ? "You are solving a single step of an NYT Connections puzzle. Any previous guesses you have made are included as forbidden sets or one-away sets depending on the result of the guess."
      : hasForbidden
        ? "You are solving a single step of an NYT Connections puzzle. Any previous wrong guesses you have made are included as forbidden sets."
        : hasOneAway
          ? "You are solving a single step of an NYT Connections puzzle. Any previous guesses you have made that were one away are included as one-away sets."
          : "You are solving a single step of an NYT Connections puzzle.";

  const setBlocks: string[] = [];
  if (hasForbidden) {
    setBlocks.push(
      `FORBIDDEN SETS (Previously attempted — DO NOT REPEAT):\n${formatSetLines(
        request,
        forbidden,
      )}`,
    );
  }
  if (hasOneAway) {
    setBlocks.push(
      `ONE-AWAY SETS (Exactly 3 of these 4 words belong to a true category):\n${formatSetLines(
        request,
        oneAway,
      )}`,
    );
  }

  const hintList: string[] = [];
  if (hasOneAway) {
    hintList.push(
      "OVERLAP INFERENCE: Look for shared 3-word combinations across ONE-AWAY SETS. These shared subsets strongly hint at 3 words of a true category.",
      "BALANCED EXPLORATION: Use ONE-AWAY overlaps to test untried 4th-word swaps, but do not rely on them exclusively. The One-Away list is often your best option for proposing a reasonable solution, but you may use a fresh guess if you prefer.",
      'Note on "One-Away" Signals: Distinct 3-word "one-away" set candidates may point toward mutually exclusive candidate categories; do not assume a shared 3-word core triad spans across all observed sets.',
    );
  }
  if (hasForbidden) {
    hintList.push(
      "Any candidate set on the forbidden list invalidates large overlaps. At most 2 of its words can coexist in a valid solution group (3 or 4 words together are strictly ruled out).",
    );
  }

  const setTheoryRules = hasOneAway
    ? [
        "CRITICAL SET-THEORY RULES: (Use this for ONE-AWAY analysis if applicable)",
        "1. TRIAD INTERSECTION MUST BE EXACT: A 3-word triad [A, B, C] is ONLY valid if ALL 3 IDs appear in EVERY source set used to build it. Do not claim a triad exists if an ID is missing from any source set.",
        "2. ELIMINATED WORDS ARE 4th-POSITION SWAPS: For a valid triad [A, B, C] derived from one-away set [A, B, C, D], ONLY 'D' is eliminated. Never list A, B, or C as eliminated words.",
        "3. 4th WORD SELECTION: To form a 4-word candidate, select EXACTLY ONE untried ID from outside the triad [A, B, C]. Never select an ID that is already inside the triad.",
      ].join("\n")
    : "";

  const constraintList: string[] = [
    `Provide exactly ${numResponses} distinct candidate groups of 4 unique word IDs (from 0 to ${lastId}).`,
  ];
  if (hasForbidden) {
    constraintList.push(
      "No group may match any set in FORBIDDEN SETS (regardless of element order).",
    );
  }
  if (hasOneAway) {
    constraintList.push(
      "First, identify any Core Triads inferred from single or intersecting ONE-AWAY sets, list the eliminated 4th words, and list all remaining untried 4th words to test.",
      "Order candidates strictly by priority: multi-set triangulated triads first, single-set triads second, fresh board groupings last.",
    );
  }

  const reasoningNote: string[] = [];
  if (hasForbidden) {
    reasoningNote.push("verify the set is not in FORBIDDEN SETS");
  }
  if (hasOneAway) {
    reasoningNote.push(
      "include any core triad analysis you may have performed in order to obtain this grouping",
    );
  }
  const reasoningGuidance =
    reasoningNote.length === 0
      ? "Explain the category step-by-step."
      : `Explain the category step-by-step and ${reasoningNote.join("; also ")}.`;

  const sections: string[] = [
    intro,
    `16 words are sorted into 4 groups of 4, sharing hidden categories (synonyms, wordplay, "types of ___", etc). Categories can be deliberately misleading.`,
    `Remaining words (indexed):\n${formatIndexedWords(puzzleWords)}`,
  ];
  sections.push(...setBlocks);
  if (hintList.length > 0) {
    sections.push(
      `STRATEGY & HINTS:\n${hintList
        .map((hint, i) => `${i + 1}. ${hint}`)
        .join("\n")}`,
    );
  }
  if (setTheoryRules) {
    sections.push(setTheoryRules);
  }
  sections.push(
    `STRICT CONSTRAINTS:\n${constraintList
      .map((constraint, i) => `${i + 1}. ${constraint}`)
      .join("\n")}`,
  );
  sections.push(
    `Respond strictly with valid JSON using this exact structure:\n{\n  "proposed_groups": [\n    {\n      "reasoning": "${reasoningGuidance}",\n      "category": "short label",\n      "word_ids": [int, int, int, int],\n      "confidence": 0.0-1.0\n    }\n  ]\n}`,
  );

  return sections.join("\n\n");
}

/**
 * Builds the prompt for the AI Assist diagnostic: hand the model the word
 * list and ask for a full 4-group partition. This is a display-only read
 * (nothing is persisted), so the model answers with the items themselves
 * rather than word_ids, and no prior-guess context is included.
 */
export function buildDiagnosePrompt(words: string[]): string {
  return [
    `Words: ${words.join(", ")}`,
    "",
    "Find groups of four items that share something in common.",
    "",
    "Output your answer as a JSON object with a single key \"groups\" holding",
    "an array of exactly four objects, one per group. Each group object must",
    "have exactly these fields:",
    '- "category": a short string naming the shared theme',
    '- "items": an array of exactly four strings, the items in this group',
    '- "confidence": a number between 0 and 1 (inclusive) representing how',
    "  confident you are that this group is correct",
    "",
    "Output ONLY the JSON object. No additional text, explanation, headers,",
    "or markdown code fences before or after it.",
    "",
    "Example shape (do not reuse this content, it's illustrative only):",
    '{',
    '  "groups": [',
    '    {"category": "Types of bread", "items": ["RYE", "SOURDOUGH", "PITA", "NAAN"], "confidence": 0.9},',
    '    {"category": "___ ball", "items": ["BASKET", "FOOT", "BASE", "FIRE"], "confidence": 0.75},',
    '    {"category": "Colors", "items": ["RED", "BLUE", "GREEN", "TEAL"], "confidence": 0.6},',
    '    {"category": "Currencies", "items": ["YEN", "EURO", "PESO", "RAND"], "confidence": 0.4}',
    '  ]',
    '}',
  ].join("\n");
}
