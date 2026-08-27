# Extensible LLM Failure-Tag Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SolvePrompt.wordsHadParenthetical` (a single boolean flag) with an open-ended `issueTags: string[]` column, add detection for two previously-silent model-response failures (a group's word count coming out wrong, a proposed word that was never part of the puzzle), add a deterministic catch-all tag for failure shapes not yet named, and surface a per-run issue count in the existing run-history listing.

**Architecture:** All detection lives in `llm-strategy-runner.service.ts`'s existing parsing/evaluation methods (`parseGroupsSection`, `evaluateProposals`) — no new files, no new services. Tags mutate the same `SolvePrompt` object already threaded through `pendingPrompts` today (the pattern `wordsHadParenthetical` already uses). The run-level count reuses the existing computed-subquery pattern already used for `guessCount` in `strategy.service.ts`'s run-history query, rather than a denormalized counter.

**Tech Stack:** NestJS + TypeORM (backend), React + Vite (frontend), Jest (backend tests), Vitest (frontend tests), Postgres.

**Spec:** [docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md](../specs/2026-08-26-llm-failure-taxonomy-design.md)

## Global Constraints

- `issueTags` is a plain Postgres `text[]` column with app-level string constants (`SolvePromptIssueTag`), not a DB enum — a new tag must never require a migration.
- A tag never appears twice in the same row's `issueTags` array (dedupe on write, both in `parseGroupsSection`'s internal `Set` and in `evaluateProposals`'s push).
- `issueCount` (the run-level rollup) counts only `issueTags`-bearing `SolvePrompt` rows — it must never include `CALL_ERROR` rows. That failure mode is already visible via `run.status` transitioning to `ERROR`.
- Neither `groupCountOff` nor `unclassified` is gated on whether the structured `### GROUPS`-block parse produced any valid groups overall (`parsedGroupWords.length`/`usedStructuredParse`) — both fire per-group based on what the response's own `Group N` headings actually contained, regardless of whether any other group in the same response parsed cleanly. A response where every group is malformed (so the response as a whole falls back to `fallbackGroups` for `proposalWords`) still surfaces `groupCountOff`/`unclassified` for the group(s) that earned them — e.g. a response whose only `Group 1` heading has a `Category:` line but no `Words:` line at all must still tag `unclassified`, not silently produce `issueTags: []`. (An earlier version of this plan gated both checks behind `usedStructuredParse`; that was an implementation-detail overreach never required by the spec, caught in the final whole-branch review, and corrected here — see the fix commit after Task 5.)
- `unclassified` is scoped to the group numbers the response's own `Group N` headings actually mention (1 through the highest heading number seen — `maxGroupNum`, which is `0` and thus never fires the check at all when the response has no `Group N` headings anywhere), never against the puzzle's total remaining group count. The model normally addresses just one group per call — that's the common case, not an error — so comparing against how many groups the *puzzle* still needs would misfire on every ordinary single-group response.
- `wordNotOnList`'s "was this word ever part of the puzzle at all" check must be resume-safe: it derives the full original word set from `puzzle.answerGroups`/`GroupMember.word` (already eagerly loaded by `StrategyRunStore.loadOrCreateRun`'s `relations: { answerGroups: { members: true } }`), never from `state.lockedInGroups` — that field is unconditionally reset to `[]` on every call to `runLlmStrategy` (including a resumed run, whose `priorGuesses` gets rebuilt from stored `Guess` rows but whose `lockedInGroups` does not), so deriving the original word set from it would falsely tag an already-solved word as hallucinated after any worker restart mid-run. (Also caught in the final whole-branch review, corrected in the same fix commit.)
- `SolvePromptStatus.MALFORMED_GROUP_COUNT`/`MALFORMED_OTHER` are removed from the TypeScript enum (dead code — nothing sets them today) and from the frontend's mirrored `SolvePromptStatusValue` type. Per the existing precedent in `1767000000000-add-solve-prompt-call-detail.ts`'s `down()`, the migration does **not** attempt to remove the corresponding values from the Postgres `solve_prompt_status_enum` type itself — that requires recreating the type, and leaving unused values there is harmless.

---

### Task 1: Schema — `issueTags` column replaces `wordsHadParenthetical`

**Files:**
- Modify: `backend/src/modules/strategy/entities/solve-prompt.entity.ts`
- Create: `backend/src/migrations/1774000000000-add-solve-prompt-issue-tags.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SolvePromptIssueTag` (exported const object) and `SolvePromptIssueTagValue` (its value union type), both exported from `solve-prompt.entity.ts`. `SolvePrompt.issueTags: string[]` replaces `SolvePrompt.wordsHadParenthetical: boolean`. `SolvePromptStatus` loses `MALFORMED_GROUP_COUNT`/`MALFORMED_OTHER`. Task 2 imports `SolvePromptIssueTag` from this file.

- [ ] **Step 1: Update `backend/src/modules/strategy/entities/solve-prompt.entity.ts`**

Replace the `SolvePromptStatus` enum (currently):

```typescript
export enum SolvePromptStatus {
  PARSED = "parsed",
  MALFORMED_NO_ANSWER_BLOCK = "malformedNoAnswerBlock",
  MALFORMED_GROUP_COUNT = "malformedGroupCount",
  MALFORMED_OTHER = "malformedOther",
  // The OpenAI call itself never produced usable model text — either an
  // earlier attempt this step's backend retry loop discarded, or the step's
  // own terminal failure. rawResponseText stays null for these rows; the
  // request/response/error columns below carry whatever raw detail the
  // orchestrator captured instead.
  CALL_ERROR = "callError",
}
```

with:

```typescript
export enum SolvePromptStatus {
  PARSED = "parsed",
  MALFORMED_NO_ANSWER_BLOCK = "malformedNoAnswerBlock",
  // The OpenAI call itself never produced usable model text — either an
  // earlier attempt this step's backend retry loop discarded, or the step's
  // own terminal failure. rawResponseText stays null for these rows; the
  // request/response/error columns below carry whatever raw detail the
  // orchestrator captured instead.
  CALL_ERROR = "callError",
}

// Known SolvePrompt.issueTags values. Not a DB enum — issueTags is a plain
// text[] column specifically so a new tag can be added here without a
// migration. 'unclassified' is the deliberate exception: it's applied when
// a response fails in a way none of the other tags explain, so a genuinely
// new failure variety is still discoverable (query for it, read
// rawResponseText, decide whether it deserves its own named tag) instead of
// silently vanishing — see
// docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md.
export const SolvePromptIssueTag = {
  PARENTHETICAL_STRIPPED: "parentheticalStripped",
  GROUP_COUNT_OFF: "groupCountOff",
  WORD_NOT_ON_LIST: "wordNotOnList",
  UNCLASSIFIED: "unclassified",
} as const;

export type SolvePromptIssueTagValue =
  (typeof SolvePromptIssueTag)[keyof typeof SolvePromptIssueTag];
```

Replace the `wordsHadParenthetical` column and its comment (currently):

```typescript
  // True when at least one group's "Words:" line in this response had a
  // trailing parenthetical explanation glued onto it (e.g. "LOOK, TOUCH,
  // SIGHT, SMELL (these are all senses)") that the parser had to strip
  // before splitting on commas. rawResponseText always keeps the untouched
  // original text — this just flags that the parser had to work around it,
  // so a run that got stuck on this can be found later. See
  // llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE.
  @Column({ type: "boolean", default: false })
  wordsHadParenthetical: boolean;
```

with:

```typescript
  // Every model-response quality issue detected for this prompt (a group's
  // "Words:" line needing a trailing parenthetical stripped, a group whose
  // word count came out wrong, a proposed word that was never part of the
  // puzzle, or 'unclassified' for a failure shape none of those name yet —
  // see SolvePromptIssueTag above). rawResponseText always keeps the
  // untouched original text regardless of what's flagged here. A response
  // can trip more than one at once, which is why this is a list rather than
  // a single status value. Detection lives in
  // llm-strategy-runner.service.ts's parseGroupsSection/evaluateProposals.
  @Column({ type: "text", array: true, default: () => "'{}'" })
  issueTags: string[];
```

- [ ] **Step 2: Create the migration**

Create `backend/src/migrations/1774000000000-add-solve-prompt-issue-tags.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Replaces SolvePrompt.wordsHadParenthetical (a single boolean flag) with an
 * open-ended issueTags text[] column, so new model-response issue types
 * (group count off, hallucinated word, and an "unclassified" catch-all for
 * failure varieties not yet named) can be recorded without a schema
 * migration each time — see
 * docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md.
 */
export class AddSolvePromptIssueTags1774000000000 implements MigrationInterface {
  name = "AddSolvePromptIssueTags1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "issueTags" TEXT[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      UPDATE "SolvePrompt" SET "issueTags" = ARRAY['parentheticalStripped']
      WHERE "wordsHadParenthetical" = true
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "wordsHadParenthetical"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "wordsHadParenthetical" BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      UPDATE "SolvePrompt" SET "wordsHadParenthetical" = true
      WHERE 'parentheticalStripped' = ANY("issueTags")
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "issueTags"
    `);
    // The SolvePromptStatus TS enum's MALFORMED_GROUP_COUNT/MALFORMED_OTHER
    // values are removed from the entity in this same change, but — per the
    // existing precedent in 1767000000000-add-solve-prompt-call-detail.ts —
    // this migration doesn't attempt to remove them from the Postgres
    // "solve_prompt_status_enum" type itself (that requires recreating the
    // type: rename it, create a replacement without the value, repoint the
    // column, drop the old type). Leaving them as valid-but-unreferenced
    // values in the DB enum is harmless.
  }
}
```

- [ ] **Step 3: Run the migration against the local dev database**

Run: `cd backend && npm run migration:run`
Expected: Migration `AddSolvePromptIssueTags1774000000000` applies cleanly with no errors.

- [ ] **Step 4: Verify both directions**

Run: `cd backend && npm run migration:revert`
Expected: Reverts cleanly (recreates `wordsHadParenthetical`, drops `issueTags`).

Run: `cd backend && npm run migration:run`
Expected: Re-applies cleanly.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/entities/solve-prompt.entity.ts backend/src/migrations/1774000000000-add-solve-prompt-issue-tags.ts
git commit -m "feat: replace SolvePrompt.wordsHadParenthetical with an extensible issueTags list"
```

---

### Task 2: `parseGroupsSection` detects `groupCountOff` and the `unclassified` catch-all

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `SolvePromptIssueTag` from Task 1 (`./entities/solve-prompt.entity`).
- Produces: `parseGroupsSection(responseText: string, fallbackGroups: string[][]): { proposalWords: string[][]; categoryMap: Map<number, string>; issueTags: string[] }` — same signature as today, just replaces the old `hadParenthetical: boolean` return field with `issueTags: string[]`. Task 3 consumes `issueTags` being present (as an initialized array) on `currentPrompt` before `evaluateProposals` runs.

- [ ] **Step 1: Update the import in `llm-strategy-runner.service.ts`**

Change (near the top of the file):

```typescript
import { SolvePrompt, SolvePromptType, SolvePromptStatus } from "./entities/solve-prompt.entity";
```

to:

```typescript
import {
  SolvePrompt,
  SolvePromptType,
  SolvePromptStatus,
  SolvePromptIssueTag,
} from "./entities/solve-prompt.entity";
```

- [ ] **Step 2: Write the failing tests**

In `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, replace the three existing `wordsHadParenthetical`-based tests (currently at approximately lines 246-320: `"should strip a trailing parenthetical from a Words: line and flag the prompt"` and `"should not flag a Words: line with no parenthetical"`) with:

```typescript
    it("should strip a trailing parenthetical from a Words: line and flag the prompt", async () => {
      // Mirrors a real Mistral response: explanatory asides glued onto the
      // Words: line instead of kept in the scratchpad. Group 1's aside has
      // no internal comma (contaminates just the last word if left in);
      // Group 2's aside has several (would otherwise push the line past 4
      // comma-separated tokens and get the whole group discarded). Both
      // must still resolve to exactly 4 clean words.
      const responseOne =
        "### GROUPS\n#### Group 1\nCategory: Fruits\n" +
        "Words: APPLE, BANANA, CHERRY, DATE (these are all fruits)\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      const responseTwo =
        "### GROUPS\n#### Group 1\nCategory: Misc\n" +
        "Words: EGGPLANT, FIG, GRAPE, HONEY (eggplant is purple, fig is sweet, " +
        "grape is small, honey is sticky)\n\n" +
        "### ANSWER\nEGGPLANT, FIG, GRAPE, HONEY";

      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], responseOne),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]], responseTwo),
        );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      // The contamination never reaches the guess — both submitted with
      // exactly the 4 real puzzle words.
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<{ words: string[]; result: GuessResult }>);
      expect(inserted).toEqual([
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
        }),
        expect.objectContaining({
          words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          result: GuessResult.SUCCESS,
        }),
      ]);

      // Flagged so affected runs can be found later, and rawResponseText
      // keeps the untouched original (parenthetical and all) — only the
      // parser's internal word-extraction is fixed, not what's stored.
      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows).toEqual([
        expect.objectContaining({ issueTags: ["parentheticalStripped"], rawResponseText: responseOne }),
        expect.objectContaining({ issueTags: ["parentheticalStripped"], rawResponseText: responseTwo }),
      ]);
    });

    it("should not flag a Words: line with no parenthetical", async () => {
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], response),
      );
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: [] }));
    });

    it("should flag groupCountOff when a Words: line splits to the wrong word count, and still solve from the group that parsed fine", async () => {
      // Group 1's Words: line is missing DATE (3 words, not 4) — dropped
      // from proposals, same as today, but now flagged. Group 2 parses
      // fine and still becomes a guess.
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY\n\n" +
        "#### Group 2\nCategory: Misc\nWords: EGGPLANT, FIG, GRAPE, HONEY\n\n" +
        "### ANSWER\nEGGPLANT, FIG, GRAPE, HONEY";
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]], response),
      );
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]),
      );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      const proposalRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "LlmProposal")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      // Only group 2 ever became a proposal from the first call.
      expect(proposalRows.filter((p) => p.words === undefined)).toHaveLength(0);
      expect(proposalRows[0]).toEqual(
        expect.objectContaining({ words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"] }),
      );

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: ["groupCountOff"] }));
    });

    it("should flag unclassified when a group heading has no matching Words: line at all", async () => {
      // Group 2 has a heading and a Category but no Words: line whatsoever
      // — a different shape than a wrong word count, and one the parser
      // has no specific name for. Group 2's own heading is what makes it
      // "expected" here (not the puzzle's total remaining group count,
      // which the model is never required to fully address in one call —
      // see the single-group parenthetical test above, which must NOT
      // trip this).
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
        "#### Group 2\nCategory: Misc\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], response),
      );
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: ["unclassified"] }));
    });

    it("should NOT flag unclassified when a response only addresses one of the puzzle's remaining groups", async () => {
      // The model solving one group per call is the normal, common case
      // (see "should solve a puzzle through iterative orchestrator calls"
      // above) — group 2 isn't mentioned anywhere in this response at all,
      // so it must never be treated as "missing."
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], response),
      );
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: [] }));
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — `parseGroupsSection` still returns `hadParenthetical` (no `groupCountOff`/`unclassified` detection), and `currentPrompt` still carries `wordsHadParenthetical` instead of `issueTags`.

- [ ] **Step 4: Update `parseGroupsSection`**

Replace the whole method (currently `private parseGroupsSection(responseText: string, fallbackGroups: string[][]): { proposalWords: string[][]; categoryMap: Map<number, string>; hadParenthetical: boolean }` through its closing `}`) with:

```typescript
  /**
   * Parses the "Category:"/"Words:" lines out of a response's ### GROUPS
   * section (falling back to the whole response text if that heading is
   * missing), returning cleaned per-group word lists plus each group
   * number's extracted category. `fallbackGroups` (the already-parsed
   * ### ANSWER lines the orchestrator returns) is used verbatim when this
   * structured parse finds nothing.
   */
  private parseGroupsSection(
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
    // number between two real headings. Only checked when the structured
    // GROUPS-block parse actually found something to work with — a total
    // fallback to the ### ANSWER block has no per-group visibility to check.
    if (usedStructuredParse) {
      for (let groupNum = 1; groupNum <= maxGroupNum; groupNum++) {
        if (!parsedGroupWords[groupNum - 1] && !wrongCountGroupNumbers.has(groupNum)) {
          tags.add(SolvePromptIssueTag.UNCLASSIFIED);
        }
      }
    }

    return { proposalWords, categoryMap, issueTags: Array.from(tags) };
  }
```

- [ ] **Step 5: Update `runLlmStrategy`'s call site and `currentPrompt` construction**

In the same file, change (in the `currentPrompt` object literal inside `runLlmStrategy`):

```typescript
          rawResponseText: data.response,
          wordsHadParenthetical: false,
```

to:

```typescript
          rawResponseText: data.response,
          issueTags: [],
```

Then change:

```typescript
          const { proposalWords, categoryMap, hadParenthetical } = this.parseGroupsSection(
            data.response ?? "",
            groups,
          );
          // currentPrompt is the same object already queued in
          // pendingPrompts, so mutating it here still reflects at flush time.
          currentPrompt.wordsHadParenthetical = hadParenthetical;
```

to:

```typescript
          const { proposalWords, categoryMap, issueTags } = this.parseGroupsSection(
            data.response ?? "",
            groups,
          );
          // currentPrompt is the same object already queued in
          // pendingPrompts, so mutating it here still reflects at flush time.
          currentPrompt.issueTags = issueTags;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: detect groupCountOff and an unclassified catch-all in parseGroupsSection"
```

---

### Task 3: `evaluateProposals` detects `wordNotOnList`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `SolvePromptIssueTag.WORD_NOT_ON_LIST` from Task 1; `currentPrompt.issueTags` already initialized to `[]` by Task 2 before `evaluateProposals` runs.
- Produces: no signature change to `evaluateProposals` — same behavior (proposal still skipped either way), only adds a tag write for the hallucination case.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, inside the `describe("runLlmStrategy", ...)` block:

```typescript
    it("should flag wordNotOnList when a proposed word was never part of the puzzle", async () => {
      // OCEAN was never one of the puzzle's 8 words — the proposal is
      // skipped exactly as it is today (silently, no guess produced), but
      // now the prompt gets flagged. The run only finishes once the second
      // call proposes both real groups correctly.
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(makeAssistResponse([["OCEAN", "BANANA", "CHERRY", "DATE"]]))
        .mockResolvedValueOnce(
          makeAssistResponse([
            ["APPLE", "BANANA", "CHERRY", "DATE"],
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          ]),
        );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<{ words: string[] }>);
      // The hallucinated-word proposal from call 1 never became a guess.
      expect(inserted.every((g) => !g.words.includes("OCEAN"))).toBe(true);

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: ["wordNotOnList"] }));
      expect(promptRows[1]).toEqual(expect.objectContaining({ issueTags: [] }));
    });

    it("should not flag a proposal that only reuses an already-solved word", async () => {
      // Call 1 solves group 1 (APPLE/BANANA/CHERRY/DATE). Call 2 proposes a
      // group that reuses APPLE (now already solved, not hallucinated) plus
      // 3 of the remaining real words — still skipped the same way today
      // (APPLE is missing from the now-shrunk availableWords), but this is
      // an expected, boring case and must NOT get wordNotOnList. Call 3
      // finishes the run by proposing group 2 correctly.
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]))
        .mockResolvedValueOnce(makeAssistResponse([["APPLE", "EGGPLANT", "FIG", "GRAPE"]]))
        .mockResolvedValueOnce(makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      // promptRows[1] is call 2's row — the reused-word call.
      expect(promptRows[1]).toEqual(expect.objectContaining({ issueTags: [] }));
    });

    it("should carry both parentheticalStripped and wordNotOnList when a response trips both at once", async () => {
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\n" +
        "Words: OCEAN, BANANA, CHERRY, DATE (a hallucinated word here)\n\n" +
        "### ANSWER\nOCEAN, BANANA, CHERRY, DATE";
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(makeAssistResponse([["OCEAN", "BANANA", "CHERRY", "DATE"]], response))
        .mockResolvedValueOnce(
          makeAssistResponse([
            ["APPLE", "BANANA", "CHERRY", "DATE"],
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          ]),
        );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(
        expect.objectContaining({
          issueTags: expect.arrayContaining(["parentheticalStripped", "wordNotOnList"]),
        }),
      );
      expect((promptRows[0].issueTags as string[])).toHaveLength(2);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — `evaluateProposals` doesn't distinguish hallucinated words from already-solved ones yet, so no `wordNotOnList` tag is ever written.

- [ ] **Step 3: Update `evaluateProposals`**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, replace:

```typescript
      const guessWords = currentProposal.words!;

      // Skip proposals containing words that were already solved by an
      // earlier guess in this loop.
      const isWordAlreadySolved = guessWords.some((w) => !run.availableWords.includes(w));
      if (isWordAlreadySolved) {
        continue;
      }

      state.guessCount++;
```

with:

```typescript
      const guessWords = currentProposal.words!;

      // A word missing from run.availableWords is either already solved by
      // an earlier guess in this loop (expected, boring — every word in
      // state.lockedInGroups is still a real puzzle word) or was never part
      // of the puzzle at all (a genuine model hallucination). Both skip the
      // proposal the same way today; only the second is worth flagging.
      const isWordMissingFromAvailable = guessWords.some((w) => !run.availableWords.includes(w));
      if (isWordMissingFromAvailable) {
        const originalPuzzleWords = [...run.availableWords, ...state.lockedInGroups.flat()];
        const hasHallucinatedWord = guessWords.some((w) => !originalPuzzleWords.includes(w));
        if (hasHallucinatedWord) {
          const issueTags = currentProposal.solvePrompt!.issueTags;
          if (!issueTags.includes(SolvePromptIssueTag.WORD_NOT_ON_LIST)) {
            issueTags.push(SolvePromptIssueTag.WORD_NOT_ON_LIST);
          }
        }
        continue;
      }

      state.guessCount++;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full backend test suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: detect wordNotOnList when a proposal hallucinates a word"
```

---

### Task 4: Backend `issueCount` rollup and DTO/reconstruction field renames

**Files:**
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/dto/strategy.dto.ts`
- Modify: `backend/src/modules/strategy/prompt-reconstruction.ts`
- Test: `backend/src/modules/strategy/strategy.service.spec.ts`
- Test: `backend/src/modules/strategy/prompt-reconstruction.spec.ts` (fixture only, no assertion changes)

**Interfaces:**
- Consumes: `SolvePrompt.issueTags` from Task 1.
- Produces: `RunHistoryRowDto.issueCount: number` replaces `RunHistoryRowDto.hadWordsParenthetical: boolean`. `SolvePromptDto.issueTags: string[]` replaces `SolvePromptDto.wordsHadParenthetical: boolean`. Task 5 (frontend) consumes both new field names verbatim — the frontend fetches these DTOs as raw JSON with no field remapping (see `fetchRunHistory`/`fetchRunDetail` in `frontend/src/data/benchmark/api.ts`), so the frontend type/field names must match exactly.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/strategy/strategy.service.spec.ts`, inside `describe("getRunHistory", ...)`:

Replace the `rawRun` helper (currently):

```typescript
    function rawRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        puzzleId: 10,
        puzzleDate: "2024-01-01",
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        modelName: null,
        startedAt: new Date("2024-01-01T00:00:00Z"),
        finishedAt: new Date("2024-01-01T00:00:05Z"),
        guessCount: 4,
        hadWordsParenthetical: false,
        tokenCostUsd: null,
        ...overrides,
      };
    }
```

with:

```typescript
    function rawRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        puzzleId: 10,
        puzzleDate: "2024-01-01",
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        modelName: null,
        startedAt: new Date("2024-01-01T00:00:00Z"),
        finishedAt: new Date("2024-01-01T00:00:05Z"),
        guessCount: 4,
        issueCount: 0,
        tokenCostUsd: null,
        ...overrides,
      };
    }
```

Replace the `"should return paginated rows with the default page/limit/sort"` test's `addSelect`/`result.rows` assertions (currently):

```typescript
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('"wordsHadParenthetical" = true'),
        "hadWordsParenthetical",
      );
```

with:

```typescript
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('array_length(sp."issueTags", 1) > 0'),
        "issueCount",
      );
```

and (still in the same test) replace:

```typescript
      expect(result.rows).toEqual([
        {
          id: 1,
          puzzleId: 10,
          puzzleDate: "2024-01-01",
          strategyName: "alphabetical",
          modelName: null,
          trialNumber: 0,
          status: StrategyRunStatus.COMPLETED,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:05Z"),
          guessCount: 4,
          tokenCostUsd: null,
          hadWordsParenthetical: false,
        },
      ]);
```

with:

```typescript
      expect(result.rows).toEqual([
        {
          id: 1,
          puzzleId: 10,
          puzzleDate: "2024-01-01",
          strategyName: "alphabetical",
          modelName: null,
          trialNumber: 0,
          status: StrategyRunStatus.COMPLETED,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:05Z"),
          guessCount: 4,
          tokenCostUsd: null,
          issueCount: 0,
        },
      ]);
```

Replace the `"should surface hadWordsParenthetical from the row when true"` test with:

```typescript
    it("should surface issueCount from the row", async () => {
      mockRunHistoryQuery(1, [rawRun({ issueCount: 3 })]);

      const result = await service.getRunHistory("alphabetical", {});

      expect(result.rows[0].issueCount).toBe(3);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest strategy.service.spec.ts`
Expected: FAIL — `getRunHistory` still selects `hadWordsParenthetical` and maps to that field name.

- [ ] **Step 3: Update `backend/src/modules/strategy/strategy.service.ts`**

Replace:

```typescript
      .addSelect(
        `EXISTS (
          SELECT 1 FROM "SolvePrompt" sp
          WHERE sp."strategyRunId" = run.id AND sp."wordsHadParenthetical" = true
        )`,
        "hadWordsParenthetical",
      )
```

with:

```typescript
      .addSelect(
        `(SELECT COUNT(*)::int FROM "SolvePrompt" sp
          WHERE sp."strategyRunId" = run.id AND array_length(sp."issueTags", 1) > 0)`,
        "issueCount",
      )
```

Replace the `getRawMany` type parameter's `hadWordsParenthetical: boolean;` field with `issueCount: number;`:

```typescript
        guessCount: number;
        issueCount: number;
        tokenCostUsd: string | number | null;
```

Replace the row-mapping's `hadWordsParenthetical: row.hadWordsParenthetical,` with `issueCount: Number(row.issueCount),`:

```typescript
      guessCount: Number(row.guessCount),
      tokenCostUsd: row.tokenCostUsd === null ? null : Number(row.tokenCostUsd),
      issueCount: Number(row.issueCount),
```

- [ ] **Step 4: Update `backend/src/modules/strategy/dto/strategy.dto.ts`**

Replace the `SolvePromptDto` field (currently):

```typescript
  // True when this response's "Words:" line had a trailing parenthetical
  // explanation the parser had to strip before it would parse as 4 clean
  // words (see llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE).
  // rawResponseText above always keeps the untouched original text.
  wordsHadParenthetical: boolean;
```

with:

```typescript
  // Every model-response quality issue detected for this prompt — see
  // SolvePromptIssueTag in solve-prompt.entity.ts. rawResponseText above
  // always keeps the untouched original text regardless of what's flagged
  // here.
  issueTags: string[];
```

Replace the `RunHistoryRowDto` field (currently):

```typescript
  // True if any SolvePrompt in this run had the trailing-parenthetical
  // parsing issue (see SolvePromptDto.wordsHadParenthetical) — a run can hit
  // it on some calls and not others, so this is an OR across every prompt,
  // not a property of the run as a whole. Always false for non-LLM
  // strategies (no SolvePrompt rows at all).
  hadWordsParenthetical: boolean;
```

with:

```typescript
  // Count of this run's SolvePrompt rows with at least one issueTags entry
  // (see SolvePromptDto.issueTags) — a run can hit issues on some calls and
  // not others, so this sums across every prompt, not a property of the run
  // as a whole. Always 0 for non-LLM strategies (no SolvePrompt rows at
  // all).
  issueCount: number;
```

Update the comment above `RecentRunDto` referencing the old field name (currently `... no guessCount/tokenCostUsd/ hadWordsParenthetical) since this is polled repeatedly.`) to say `issueCount` instead of `hadWordsParenthetical`.

- [ ] **Step 5: Update `backend/src/modules/strategy/prompt-reconstruction.ts`**

Replace:

```typescript
      wordsHadParenthetical: prompt.wordsHadParenthetical,
```

with:

```typescript
      issueTags: prompt.issueTags,
```

- [ ] **Step 6: Update the shared test fixture in `backend/src/modules/strategy/prompt-reconstruction.spec.ts`**

Add `issueTags: []` to `makeSolvePrompt`'s base object (currently ends with `responseBody: null,` before `...overrides`):

```typescript
    responseBody: null,
    issueTags: [],
    ...overrides,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx jest strategy.service.spec.ts prompt-reconstruction.spec.ts`
Expected: PASS

- [ ] **Step 8: Run the full backend test suite to check for regressions**

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/dto/strategy.dto.ts backend/src/modules/strategy/prompt-reconstruction.ts backend/src/modules/strategy/strategy.service.spec.ts backend/src/modules/strategy/prompt-reconstruction.spec.ts
git commit -m "feat: surface issueCount/issueTags through the run-history and run-detail DTOs"
```

---

### Task 5: Frontend — `issueTags`/`issueCount` types, rendering, and status-value cleanup

**Files:**
- Modify: `frontend/src/data/benchmark/types.ts`
- Modify: `frontend/src/components/benchmark/GuessChainVisualizer.tsx`
- Modify: `frontend/src/components/benchmark/RunHistoryTable.tsx`
- Test: `frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`
- Test: `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`

**Interfaces:**
- Consumes: `issueTags`/`issueCount` field names from Task 4's DTOs, fetched as raw JSON with no remapping.
- Produces: `SolvePromptRecord.issueTags: string[]` replaces `wordsHadParenthetical: boolean`. `RunHistoryRow.issueCount: number` replaces `hadWordsParenthetical: boolean`. `SolvePromptStatusValue` loses `"malformedGroupCount"`/`"malformedOther"`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`, change the `llmDetail.solvePrompts[0]` fixture's field (currently `wordsHadParenthetical: false,`) to `issueTags: [],`.

Replace the `"flags a step whose Words: line needed a parenthetical stripped"` and `"does not flag a step whose Words: line had no parenthetical"` tests with:

```typescript
  it("flags a step with a parentheticalStripped issue tag", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [{ ...llmDetail.solvePrompts[0]!, issueTags: ["parentheticalStripped"] }],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Parenthetical stripped")).toBeInTheDocument();
  });

  it("flags a step with a wordNotOnList issue tag", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [{ ...llmDetail.solvePrompts[0]!, issueTags: ["wordNotOnList"] }],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Hallucinated word")).toBeInTheDocument();
  });

  it("does not render an issue badge for a step with no issue tags", async () => {
    stubFetch(llmDetail);

    render(<GuessChainVisualizer runId={12345} />);

    await screen.findByText("Initial solve");
    expect(screen.queryByText("Parenthetical stripped")).not.toBeInTheDocument();
    expect(screen.queryByText("Hallucinated word")).not.toBeInTheDocument();
  });
```

In `frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx`, change `makeRow`'s field (currently `hadWordsParenthetical: false,`) to `issueCount: 0,`.

Replace the `"flags a run whose model needed a parenthetical stripped from its words"` and `"does not flag a run with no parenthetical-stripping quirk"` tests with:

```typescript
  it("flags a run with issue-tagged prompts", async () => {
    stubFetch({
      history: {
        rows: [makeRow({ issueCount: 2 })],
        meta: { total: 1, page: 1, limit: 100 },
      },
    });

    renderStrategy("alphabetical");

    expect(await screen.findByText("2 issues")).toBeInTheDocument();
  });

  it("does not render an issue badge for a run with no issues", async () => {
    stubFetch({
      history: { rows: [makeRow()], meta: { total: 1, page: 1, limit: 100 } },
    });

    renderStrategy("alphabetical");

    await screen.findByRole("table");
    expect(screen.queryByText(/issue/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run GuessChainVisualizer.test.tsx StrategyPuzzlePage.test.tsx`
Expected: FAIL — components still reference `wordsHadParenthetical`/`hadWordsParenthetical`, and the "Hallucinated word"/count badges don't exist yet.

- [ ] **Step 3: Update `frontend/src/data/benchmark/types.ts`**

Replace the `SolvePromptStatusValue` type (currently):

```typescript
export type SolvePromptStatusValue =
  | "parsed"
  | "malformedNoAnswerBlock"
  | "malformedGroupCount"
  | "malformedOther"
  // The OpenAI call itself never produced usable model text (backend:
  // SolvePromptStatus.CALL_ERROR). Shown inline in the guess chain like
  // any other step — see errorName/errorMessage/etc. below.
  | "callError";
```

with:

```typescript
export type SolvePromptStatusValue =
  | "parsed"
  | "malformedNoAnswerBlock"
  // The OpenAI call itself never produced usable model text (backend:
  // SolvePromptStatus.CALL_ERROR). Shown inline in the guess chain like
  // any other step — see errorName/errorMessage/etc. below.
  | "callError";
```

Replace the `SolvePromptRecord.wordsHadParenthetical` field (currently):

```typescript
  /** True when this response's "Words:" line had a trailing parenthetical
   * explanation (e.g. "LOOK, TOUCH, SIGHT, SMELL (these are all senses)")
   * that had to be stripped before it would parse as 4 clean words.
   * rawResponseText above is always the untouched original text. */
  wordsHadParenthetical: boolean;
```

with:

```typescript
  /** Every model-response quality issue detected for this prompt — see
   * SolvePromptIssueTag on the backend (solve-prompt.entity.ts).
   * rawResponseText above is always the untouched original text regardless
   * of what's flagged here. */
  issueTags: string[];
```

Replace the `RunHistoryRow.hadWordsParenthetical` field (currently):

```typescript
  /** True if any solve step in this run hit the "Words:" trailing-
   * parenthetical parsing quirk (see SolvePromptRecord.wordsHadParenthetical)
   * — some models glue their reasoning onto the words line instead of
   * keeping it in the scratchpad. Always false for non-LLM strategies. */
  hadWordsParenthetical: boolean;
```

with:

```typescript
  /** Count of this run's solve steps with at least one issue tag (see
   * SolvePromptRecord.issueTags). Always 0 for non-LLM strategies. */
  issueCount: number;
```

- [ ] **Step 4: Update `frontend/src/components/benchmark/GuessChainVisualizer.tsx`**

Replace the `solvePromptStatusLabel` function (currently):

```typescript
function solvePromptStatusLabel(status: SolvePromptRecord["status"]): string {
  switch (status) {
    case "malformedNoAnswerBlock":
      return "No answer block";
    case "malformedGroupCount":
      return "Bad group count";
    case "malformedOther":
      return "Malformed";
    case "callError":
      return "Call failed";
    case "parsed":
      return "Parsed";
  }
}
```

with:

```typescript
function solvePromptStatusLabel(status: SolvePromptRecord["status"]): string {
  switch (status) {
    case "malformedNoAnswerBlock":
      return "No answer block";
    case "callError":
      return "Call failed";
    case "parsed":
      return "Parsed";
  }
}

function issueTagLabel(tag: string): string {
  switch (tag) {
    case "parentheticalStripped":
      return "Parenthetical stripped";
    case "groupCountOff":
      return "Bad group count";
    case "wordNotOnList":
      return "Hallucinated word";
    case "unclassified":
      return "Unclassified issue";
    default:
      return tag;
  }
}

function issueTagTitle(tag: string): string {
  switch (tag) {
    case "parentheticalStripped":
      return "This response tucked an explanation into the Words: line — the parser stripped it before guessing.";
    case "groupCountOff":
      return "A group's Words: line didn't split into exactly 4 words.";
    case "wordNotOnList":
      return "The model proposed a word that was never part of this puzzle.";
    case "unclassified":
      return "A group went missing from the response for a reason not yet covered by a named check.";
    default:
      return "Unrecognized issue tag.";
  }
}
```

Replace the parenthetical badge block inside `PromptStep` (currently):

```typescript
        {prompt.wordsHadParenthetical ? (
          <span title="This response tucked an explanation into the Words: line — the parser stripped it before guessing.">
            <StatusPill label="Parenthetical stripped" tone="neutral" />
          </span>
        ) : null}
```

with:

```typescript
        {prompt.issueTags.map((tag) => (
          <span key={tag} title={issueTagTitle(tag)}>
            <StatusPill label={issueTagLabel(tag)} tone="neutral" />
          </span>
        ))}
```

- [ ] **Step 5: Update `frontend/src/components/benchmark/RunHistoryTable.tsx`**

Replace the parenthetical badge block (currently):

```typescript
                  {row.hadWordsParenthetical ? (
                    <span title="At least one model response tucked an explanation into the Words: line — the parser stripped it before guessing.">
                      <StatusPill label="Parenthetical stripped" tone="neutral" />
                    </span>
                  ) : null}
```

with:

```typescript
                  {row.issueCount > 0 ? (
                    <span title="At least one solve step in this run had a detected model-response issue — see the run's detail view for which.">
                      <StatusPill
                        label={`${row.issueCount} issue${row.issueCount === 1 ? "" : "s"}`}
                        tone="neutral"
                      />
                    </span>
                  ) : null}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run GuessChainVisualizer.test.tsx StrategyPuzzlePage.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend test suite to check for regressions**

Run: `cd frontend && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/data/benchmark/types.ts frontend/src/components/benchmark/GuessChainVisualizer.tsx frontend/src/components/benchmark/RunHistoryTable.tsx frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx frontend/src/pages/benchmark/__tests__/StrategyPuzzlePage.test.tsx
git commit -m "feat: render issueTags/issueCount in the run detail and history views"
```

## Final Verification

- [ ] Run the full backend suite: `cd backend && npm test`
- [ ] Run the full frontend suite: `cd frontend && npx vitest run`
- [ ] Run `cd backend && npm run migration:run` then `npm run migration:revert` then `npm run migration:run` again against a scratch DB to confirm both directions execute without error (already done in Task 1, re-verify after all tasks in case a later task's changes affected the entity's TypeORM sync expectations).
- [ ] Manually trigger a local strategy run against a puzzle and skim its `SolvePrompt` rows (or the run's detail page) to confirm `issueTags` populates correctly end to end — the unit tests above cover each detection path individually, but only a real run exercises the full parse → evaluate → persist → render chain together.
