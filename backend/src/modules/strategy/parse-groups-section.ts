import { SolvePromptIssueTag } from "./entities/solve-prompt.entity";

export const GROUP_SIZE = 4;

// Some models (Mistral especially) don't put their reasoning in the
// scratchpad the prompt asks for — they append it straight onto the
// "Words:" line instead, e.g. "LOOK, TOUCH, SIGHT, SMELL (these are all
// senses)". Left in, that either glues onto the 4th word (breaking every
// downstream comparison against the puzzle's real words) or, when the
// aside itself contains commas, inflates the line past 4 tokens and gets
// the whole group discarded. Stripping it before splitting on commas fixes
// both cases at once, since either way what's left is the 4 bare words.
const WORDS_PARENTHETICAL_RE = /\([^)]*\)/g;

/**
 * Parses the "Category:"/"Words:" lines out of a response's ### GROUPS
 * section (falling back to the whole response text if that heading is
 * missing), returning cleaned per-group word lists plus each group
 * number's extracted category. `fallbackGroups` (the already-parsed
 * ### ANSWER lines the orchestrator returns) is used verbatim when this
 * structured parse finds nothing.
 *
 * Extracted from LlmStrategyRunner (a pure function, no `this` dependency)
 * so it can also drive `backfill-issue-tags.ts`'s re-parse of historical
 * SolvePrompt.rawResponseText — a single source of truth for the parsing
 * regexes avoids the live runner and the backfill script silently drifting
 * apart over time.
 */
export function parseGroupsSection(
  responseText: string,
  fallbackGroups: string[][],
): { proposalWords: string[][]; categoryMap: Map<number, string>; issueTags: string[] } {
  const categoryMap = new Map<number, string>();
  const parsedGroupWords: string[][] = [];
  const tags = new Set<string>();
  const wrongCountGroupNumbers = new Set<number>();
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
      categoryMap.set(groupNum, categoryMatch[1].trim());
    }

    if (wordsMatch) {
      const rawWordsLine = wordsMatch[1];
      // .replace() with a global regex, not .test() — WORDS_PARENTHETICAL_RE
      // is a shared module-level instance, and a global regex's .test()
      // mutates its own lastIndex across calls, which would silently
      // start missing matches on later prompts. Comparing before/after
      // avoids that stateful pitfall entirely.
      const strippedWordsLine = rawWordsLine.replace(WORDS_PARENTHETICAL_RE, "");
      if (strippedWordsLine !== rawWordsLine) {
        tags.add(SolvePromptIssueTag.PARENTHETICAL_STRIPPED);
      }

      const wordsLine = strippedWordsLine
        .split(",")
        .map((w) => w.replace(/[`*]/g, "").trim())
        .filter(Boolean);

      if (wordsLine.length === GROUP_SIZE) {
        parsedGroupWords[groupNum - 1] = wordsLine;
      } else {
        // A Words: line was found and split, but produced the wrong word
        // count — the group is dropped (same as before), now flagged so
        // it's queryable rather than silently vanishing.
        tags.add(SolvePromptIssueTag.GROUP_COUNT_OFF);
        wrongCountGroupNumbers.add(groupNum);
      }
    }
  }

  // Use parsed words from the GROUPS block if available; fall back to the
  // already-parsed ### ANSWER lines.
  const usedStructuredParse = parsedGroupWords.length > 0;
  const sourceGroups = usedStructuredParse ? parsedGroupWords : fallbackGroups;
  const proposalWords = sourceGroups.map((group) => group.map((item) => item.trim()));

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
      tags.add(SolvePromptIssueTag.UNCLASSIFIED);
    }
  }

  return { proposalWords, categoryMap, issueTags: Array.from(tags) };
}
