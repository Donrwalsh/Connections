export const GROUP_SIZE = 4;

export type AnswerTextIssue =
  | "parentheticalStripped"
  | "groupCountOff"
  | "unclassified"
  | "multipleProposals";

export interface ParsedAnswer {
  // The "### ANSWER" block's own lines, one group per line — the model's
  // terse final restatement of its answer. Falls back to the "### GROUPS"
  // block's structured words (see proposalWords) only when the ANSWER block
  // itself yielded nothing. This is the wire-level "groups" field both
  // POST /solve-step and POST /diagnose have always returned.
  groups: string[][];
  // The "### GROUPS" block's Category:/Words: extraction, indexed by group
  // number - 1 (may be sparse — a group number that never parsed leaves a
  // hole). Falls back to `groups` only when the GROUPS block itself yielded
  // no group at all. This is what the backend's automated-solving path has
  // always submitted as guesses (LlmProposal rows) — richer than `groups`
  // because it also carries each group's category label and per-group
  // parse-quality tracking (see textIssues).
  proposalWords: string[][];
  categoryByGroup: Map<number, string>;
  textIssues: AnswerTextIssue[];
}

// Some models (Mistral especially) don't put their reasoning in the
// scratchpad the prompt asks for — they append it straight onto the
// "Words:" line instead, e.g. "LOOK, TOUCH, SIGHT, SMELL (these are all
// senses)". Left in, that either glues onto the 4th word (breaking every
// downstream comparison against the puzzle's real words) or, when the
// aside itself contains commas, inflates the line past 4 tokens and gets
// the whole group discarded. Stripping it before splitting on commas fixes
// both cases at once, since either way what's left is the 4 bare words.
const WORDS_PARENTHETICAL_RE = /\([^)]*\)/g;

// Characters any of the stripping steps below remove. Only a board word
// containing one of these needs protecting from them.
const STRIPPABLE_CHAR_RE = /[()`*#-]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Guards the puzzle's own words from the cleanup stripping below. Image
 * puzzles use card alt text as the word, and that text can legitimately
 * contain what the cleanup treats as noise: "TEE (GOLF)" (2024-12-12), a
 * literal "(" / ")" card (2025-04-01), or any hyphenated word like "YO-YO".
 *
 * Swaps each occurrence of such a board word in `line` for a placeholder
 * the strippers can't touch, and returns a `restore` that puts the model's
 * original text (its own casing included — case normalization happens
 * later, against the board) back into each split-out word. A match only
 * counts on an item boundary (line start/end, comma, whitespace, or
 * markdown emphasis), so the "(" card never claims the opening of an aside
 * like "DATE (these are fruits)". Longer words are matched first so
 * "TEE (GOLF)" wins over any shorter overlapping board word.
 */
function protectBoardWords(
  line: string,
  boardWords: readonly string[],
): { masked: string; restore: (word: string) => string } {
  const protectedWords = boardWords
    .filter((word) => STRIPPABLE_CHAR_RE.test(word))
    .sort((a, b) => b.length - a.length);
  if (protectedWords.length === 0) {
    return { masked: line, restore: (word) => word };
  }

  const originals: string[] = [];
  const pattern = new RegExp(
    `(?<=^|[\\s,*\`])(?:${protectedWords.map(escapeRegExp).join("|")})(?=$|[\\s,*\`])`,
    "gi",
  );
  const masked = line.replace(pattern, (match) => {
    originals.push(match);
    return `${originals.length - 1}`;
  });

  return {
    masked,
    restore: (word) => word.replace(/(\d+)/g, (_, index) => originals[Number(index)]),
  };
}

/**
 * Splits the "### ANSWER" block into one word list per line — the model's
 * terse final restatement of its answer, independent of the "### GROUPS"
 * block's per-group reasoning. Used both as the primary source of `groups`
 * and as the fallback source for `proposalWords` when the GROUPS block
 * itself is empty or malformed.
 */
function parseAnswerBlock(responseText: string, boardWords: readonly string[]): string[][] {
  const parts = responseText.split(/###?\s*ANSWER:?/i);
  if (parts.length < 2) return [];

  const answerBlock = parts[1].trim();
  const lines = answerBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const groups: string[][] = [];
  for (const line of lines) {
    const { masked, restore } = protectBoardWords(line, boardWords);
    const words = masked
      .split(",")
      .map((w) => restore(w.replace(/[`*#-]/g, "").trim()))
      .filter(Boolean);

    if (words.length === GROUP_SIZE) {
      groups.push(words);
    }
  }

  return groups;
}

/**
 * The single grammar for a solve model's response text — both the
 * orchestrator (POST /solve-step, POST /diagnose) and the backend (live
 * parsing, backfill-issue-tags.ts's re-parse of historical
 * rawResponseText) import this so the parsing regexes never drift apart
 * across copies again.
 *
 * Deliberately preserves two independent, pre-existing precedences rather
 * than forcing them to agree — unifying the regexes was the actual goal;
 * changing which section wins for either existing consumer was not:
 *   - `groups`: ANSWER-block primary, GROUPS-block fallback (unchanged from
 *     the orchestrator's own prior behaviour).
 *   - `proposalWords`: GROUPS-block primary, ANSWER-block fallback
 *     (unchanged from the backend's own prior behaviour — previously
 *     fed by the orchestrator's `groups` as an external `fallbackGroups`
 *     argument; now derived from the same response text directly instead).
 *
 * `boardWords` is the puzzle's full original word list (not just the words
 * still unsolved — a model may restate an already-solved group). Any of
 * them that contain characters the cleanup would otherwise strip are kept
 * intact; see protectBoardWords. Omitted, every such character is stripped
 * as before.
 */
export function parseAnswer(
  responseText: string,
  boardWords: readonly string[] = [],
): ParsedAnswer {
  const answerBlockGroups = parseAnswerBlock(responseText, boardWords);

  const categoryByGroup = new Map<number, string>();
  const parsedGroupWords: string[][] = [];
  const issues = new Set<AnswerTextIssue>();
  const wrongCountGroupNumbers = new Set<number>();

  // More than one "### ANSWER" marker means the model produced more than
  // one full attempt in the same response (a draft it reconsidered, or a
  // stray repeat) — only the first is ever parsed into groups/proposalWords
  // below, so this just names that shape rather than changing it.
  if (responseText.split(/###?\s*ANSWER:?/i).length > 2) {
    issues.add("multipleProposals");
  }
  // Highest "Group N" heading number the response itself mentioned — the
  // catch-all below checks against this, never against the puzzle's
  // total remaining group count. The model normally addresses just one
  // group per call (the common case, not an error), so a response that
  // simply doesn't mention a group at all must never be flagged.
  let maxGroupNum = 0;

  // Scope parsing to the ### GROUPS section so scratchpad content
  // (which may itself mention "Group" or contain stray colons) can't
  // produce false matches.
  const groupsSectionMatch = responseText.match(/### GROUPS([\s\S]*?)### ANSWER/i);
  const groupsSectionText = groupsSectionMatch ? groupsSectionMatch[1] : responseText;

  // Parse structured "Group N" blocks: Category + Words. Split into
  // per-group chunks first (on each "Group N" heading) so a missing
  // field in one group can't bleed into the next group's match.
  const groupChunks = groupsSectionText.split(/(?=Group\s+\d+)/i);

  for (const chunk of groupChunks) {
    const headingMatch = chunk.match(/Group\s+(\d+)/i);
    if (!headingMatch) continue;

    const groupNum = parseInt(headingMatch[1], 10);
    maxGroupNum = Math.max(maxGroupNum, groupNum);
    const categoryMatch = chunk.match(/Category:\s*([^\n]+)/i);
    const wordsMatch = chunk.match(/Words:\s*([^\n]+)/i);

    if (categoryMatch) {
      categoryByGroup.set(groupNum, categoryMatch[1].trim());
    }

    if (wordsMatch) {
      // Board words are masked first, so a card's own parenthetical (e.g.
      // "TEE (GOLF)") is neither stripped nor flagged as an aside.
      const { masked: rawWordsLine, restore } = protectBoardWords(wordsMatch[1], boardWords);
      // .replace() with a global regex, not .test() — WORDS_PARENTHETICAL_RE
      // is a shared module-level instance, and a global regex's .test()
      // mutates its own lastIndex across calls, which would silently
      // start missing matches on later prompts. Comparing before/after
      // avoids that stateful pitfall entirely.
      const strippedWordsLine = rawWordsLine.replace(WORDS_PARENTHETICAL_RE, "");
      if (strippedWordsLine !== rawWordsLine) {
        issues.add("parentheticalStripped");
      }

      const wordsLine = strippedWordsLine
        .split(",")
        .map((w) => restore(w.replace(/[`*]/g, "").trim()))
        .filter(Boolean);

      if (wordsLine.length === GROUP_SIZE) {
        parsedGroupWords[groupNum - 1] = wordsLine;
      } else {
        // A Words: line was found and split, but produced the wrong word
        // count — the group is dropped (same as before), now flagged so
        // it's queryable rather than silently vanishing.
        issues.add("groupCountOff");
        wrongCountGroupNumbers.add(groupNum);
      }
    }
  }

  // Use parsed words from the GROUPS block if available; fall back to the
  // ANSWER block's own lines.
  const usedStructuredParse = parsedGroupWords.length > 0;
  const sourceGroups = usedStructuredParse ? parsedGroupWords : answerBlockGroups;
  const proposalWords = sourceGroups.map((group) => group.map((item) => item.trim()));

  // The ANSWER block is the primary source for `groups`; only fall back to
  // the GROUPS block's own (valid, non-sparse) words when the ANSWER block
  // itself produced nothing at all.
  const groups =
    answerBlockGroups.length > 0
      ? answerBlockGroups
      : parsedGroupWords.filter((group): group is string[] => Boolean(group));

  // Catch-all: within the range of group numbers this response's own
  // headings actually mentioned (1..maxGroupNum), a group number that
  // never landed in parsedGroupWords and isn't already explained by a
  // wrong word count is a failure shape this parser doesn't have a name
  // for yet — e.g. a heading with no Words: line at all, or a skipped
  // number between two real headings. No gate on usedStructuredParse
  // needed here: maxGroupNum only increments when a "Group N" heading
  // actually matched, so when a response has zero such headings anywhere
  // (the true "totally different format" fallback case), maxGroupNum
  // stays 0 and this loop's own bound means the body never runs — the
  // loop's range is already the correct gate on its own.
  for (let groupNum = 1; groupNum <= maxGroupNum; groupNum++) {
    if (!parsedGroupWords[groupNum - 1] && !wrongCountGroupNumbers.has(groupNum)) {
      issues.add("unclassified");
    }
  }

  return { groups, proposalWords, categoryByGroup, textIssues: Array.from(issues) };
}

/**
 * Rebuilds a minimal "### GROUPS" / "### ANSWER" block from already-parsed
 * proposal data (the same proposalWords/categoryByGroup that drove the
 * actual submitted guesses) rather than from raw model text. Used to
 * replace a response flagged `multipleProposals` in conversation history —
 * the model's own verbose multi-attempt reply is swapped for a compact
 * restatement of just the proposal that was actually registered, so later
 * turns don't keep re-sending every earlier draft. `proposalWords` may be
 * sparse (a hole for a group number that failed to parse); holes are
 * skipped rather than rendered as empty groups.
 */
export function formatCompactAnswer(
  proposalWords: string[][],
  categoryByGroup: Map<number, string>,
): string {
  const groupNumbers = proposalWords
    .map((words, index) => (words ? index + 1 : null))
    .filter((groupNum): groupNum is number => groupNum !== null);

  const groupsSection = groupNumbers
    .map((groupNum) => {
      const words = proposalWords[groupNum - 1];
      const category = categoryByGroup.get(groupNum);
      const categoryLine = category ? `Category: ${category}\n` : "";
      return `Group ${groupNum}\n${categoryLine}Words: ${words.join(", ")}`;
    })
    .join("\n\n");

  const answerSection = groupNumbers
    .map((groupNum) => proposalWords[groupNum - 1].join(", "))
    .join("\n");

  return `### GROUPS\n${groupsSection}\n\n### ANSWER\n${answerSection}`;
}
