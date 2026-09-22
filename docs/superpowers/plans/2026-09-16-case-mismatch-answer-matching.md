# Case-Mismatch Answer Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `evaluateProposals` from silently dropping an LLM proposal whose words are the right words in the wrong case, and purge the historical `StrategyRun` rows that were corrupted by this bug before the fix existed.

**Architecture:** A new pure, framework-free helper (`findCaseInsensitiveGroupMatch`) decides whether a proposal's words match one of a puzzle's answer groups only after lowercasing. `evaluateProposals` (in `llm-strategy-runner.service.ts`) calls it at the exact point that currently mis-tags case-differing proposals as `wordNotOnList` and drops them; on a match it normalizes the proposal to the puzzle's canonical casing, tags the prompt `caseMismatch`, and lets the (now correctly-cased) guess flow through the rest of the existing pipeline unchanged. A standalone one-off script reuses the same helper to find every historical `StrategyRun` tainted by the old behavior and deletes it outright (cascading to its `Guess`/`SolvePrompt`/`LlmProposal` rows via the FK constraints that already exist), making that puzzle+model+trial eligible for a fresh run under the fixed code.

**Tech Stack:** NestJS + TypeORM (Postgres) backend, Jest for tests, `tsx` for running standalone scripts.

**Spec:** N/A — no separate spec document. Requirements below were captured directly through an interactive grilling session with the project owner; this Global Constraints section is the durable record of what was decided.

## Global Constraints

- Fix scope is narrow: only the answer-word comparison inside `evaluateProposals` (`backend/src/modules/strategy/llm-strategy-runner.service.ts`). Do not fold this into `normalizePuzzleWord`/`applyOneOffWordFixups` (`normalize-puzzle-word.ts`) or touch category/group-name matching.
- Detection is broad: any casing difference counts (not just all-lowercase responses) — "Title Case", "MiXeD", etc. all qualify equally.
- The new issue tag is named exactly `caseMismatch` (constant `CASE_MISMATCH`), added to the existing `SolvePromptIssueTag` map (a plain `text[]` column — no DB migration needed, matching how every other tag in that map was added).
- A case-insensitive-only match still counts as a full, valid guess — it must be normalized to the puzzle's canonical casing and flow through the guess pipeline exactly like an exact-case match, including updating `run.availableWords` correctly (the pre-existing code has a related latent bug here — see Task 2).
- No historical backfill/re-tagging of the old (now-inaccurate) `wordNotOnList` tag — leave existing `wordNotOnList` rows as-is.
- Historical remediation is a hard purge, not a data fix: delete every `StrategyRun` row — regardless of status (`failed`, `completed`, `running`, `error` are all in scope) — that has at least one `not_selected` `LlmProposal` whose words match a puzzle answer group only case-insensitively. Rely on the existing `onDelete: CASCADE` FKs (`Guess`, `SolvePrompt`, `LlmProposal` → `StrategyRun`) to clean up children.
- The purge script must default to a dry run (report what it would delete) and require an explicit `--execute` flag to actually delete anything, following this repo's existing one-off-script conventions (`backend/src/scripts/*.ts`, run via `npx tsx`).
- Do not actually run the purge script against real data as part of this plan — building and testing it is in scope; executing it against the production database is a separate, explicitly-confirmed follow-up action.

---

### Task 1: Case-insensitive group-match helper + new issue tag

**Files:**
- Create: `backend/src/modules/strategy/case-insensitive-match.ts`
- Create: `backend/src/modules/strategy/case-insensitive-match.spec.ts`
- Modify: `backend/src/modules/strategy/entities/solve-prompt.entity.ts`

**Interfaces:**
- Produces: `findCaseInsensitiveGroupMatch(guessWords: string[], answerGroups: string[][]): string[] | null` — returns the matching group's own (canonical-case) words when `guessWords` matches one of `answerGroups` only after lowercasing both sides, or `null` if there's no match at all *or* the match is already exact-case (not a mismatch). Consumed by Task 2 and Task 3.
- Produces: `SolvePromptIssueTag.CASE_MISMATCH` (value `"caseMismatch"`) on the existing `SolvePromptIssueTag` const object. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests for `findCaseInsensitiveGroupMatch`**

Create `backend/src/modules/strategy/case-insensitive-match.spec.ts`:

```typescript
import { findCaseInsensitiveGroupMatch } from "./case-insensitive-match";

describe("findCaseInsensitiveGroupMatch", () => {
  const answerGroups = [
    ["APPLE", "BANANA", "CHERRY", "DATE"],
    ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
  ];

  it("returns the canonical-case group when the guess matches only after lowercasing", () => {
    const result = findCaseInsensitiveGroupMatch(["apple", "banana", "cherry", "date"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("matches regardless of word order within the guess", () => {
    const result = findCaseInsensitiveGroupMatch(["date", "apple", "cherry", "banana"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("matches mixed casing, not just fully-lowercase guesses", () => {
    const result = findCaseInsensitiveGroupMatch(["Apple", "BaNaNa", "cherry", "DATE"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("returns null for an exact case match — that's not a mismatch", () => {
    const result = findCaseInsensitiveGroupMatch(["APPLE", "BANANA", "CHERRY", "DATE"], answerGroups);
    expect(result).toBeNull();
  });

  it("returns null when no group matches even case-insensitively", () => {
    const result = findCaseInsensitiveGroupMatch(["ocean", "banana", "cherry", "date"], answerGroups);
    expect(result).toBeNull();
  });

  it("returns null when the guess is a different length than every group", () => {
    const result = findCaseInsensitiveGroupMatch(["apple", "banana", "cherry"], answerGroups);
    expect(result).toBeNull();
  });

  it("tolerates surrounding whitespace on the guess words", () => {
    const result = findCaseInsensitiveGroupMatch([" apple ", "banana", "cherry", "date"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `npx jest src/modules/strategy/case-insensitive-match.spec.ts`
Expected: FAIL — `Cannot find module './case-insensitive-match'`

- [ ] **Step 3: Implement `findCaseInsensitiveGroupMatch`**

Create `backend/src/modules/strategy/case-insensitive-match.ts`:

```typescript
function normalizeForComparison(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * Whether `guessWords` is one of `answerGroups`, ignoring case — but not
 * ignoring it vacuously: an exact-case match returns null too, since that's
 * not a mismatch and the caller already has its own path for it. Word order
 * within the guess doesn't matter (the puzzle doesn't expose a canonical
 * order either). Returns the matching group's own canonical-case words so
 * the caller can normalize the proposal to them.
 */
export function findCaseInsensitiveGroupMatch(
  guessWords: string[],
  answerGroups: string[][],
): string[] | null {
  const sortedLowerGuess = guessWords.map(normalizeForComparison).sort();
  const sortedTrimmedGuess = guessWords.map((w) => w.trim()).sort();

  for (const group of answerGroups) {
    if (group.length !== guessWords.length) continue;

    const sortedLowerGroup = group.map(normalizeForComparison).sort();
    const isCaseInsensitiveMatch = sortedLowerGuess.every((w, i) => w === sortedLowerGroup[i]);
    if (!isCaseInsensitiveMatch) continue;

    const sortedGroup = [...group].sort();
    const isExactMatch = sortedTrimmedGuess.every((w, i) => w === sortedGroup[i]);
    if (isExactMatch) continue;

    return group;
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/strategy/case-insensitive-match.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Add the `caseMismatch` issue tag**

In `backend/src/modules/strategy/entities/solve-prompt.entity.ts`, modify the `SolvePromptIssueTag` const (currently lines 36-42):

```typescript
export const SolvePromptIssueTag = {
  PARENTHETICAL_STRIPPED: "parentheticalStripped",
  GROUP_COUNT_OFF: "groupCountOff",
  WORD_NOT_ON_LIST: "wordNotOnList",
  UNCLASSIFIED: "unclassified",
  MULTIPLE_PROPOSALS: "multipleProposals",
  CASE_MISMATCH: "caseMismatch",
} as const;
```

No migration required — `issueTags` is a plain `text[]` column (see the comment directly above this const).

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/case-insensitive-match.ts backend/src/modules/strategy/case-insensitive-match.spec.ts backend/src/modules/strategy/entities/solve-prompt.entity.ts
git commit -m "feat(strategy): add case-insensitive group-match helper and caseMismatch tag"
```

---

### Task 2: Wire the helper into `evaluateProposals`

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts:666-688`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `findCaseInsensitiveGroupMatch` and `SolvePromptIssueTag.CASE_MISMATCH` from Task 1.

- [ ] **Step 1: Write the failing integration tests**

In `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`, add these two tests immediately after the existing `"should carry both parentheticalStripped and wordNotOnList when a response trips both at once"` test (which ends at line 602, just before the `"should trim conversation history..."` test):

```typescript
    it("should accept a proposal whose words match a puzzle group only after lowercasing, normalizing it to canonical case and flagging caseMismatch", async () => {
      mockOrchestratorService.requestSolveStep
        .mockResolvedValueOnce(makeAssistResponse([["apple", "banana", "cherry", "date"]]))
        .mockResolvedValueOnce(makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      // Only reaches COMPLETED if availableWords was correctly filtered by
      // the *canonical*-case words after step 1 — this is a regression
      // guard for that downstream filter, not just the tag/guess check.
      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      const insertedGuesses = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<{ words: string[] }>);
      expect(insertedGuesses[0].words).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: ["caseMismatch"] }));
    });

    it("should still flag wordNotOnList, not caseMismatch, for a proposal with a genuinely hallucinated word regardless of casing", async () => {
      mockOrchestratorService.requestSolveStep
        .mockResolvedValueOnce(makeAssistResponse([["ocean", "banana", "cherry", "date"]]))
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
      expect(promptRows[0]).toEqual(expect.objectContaining({ issueTags: ["wordNotOnList"] }));
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts -t "caseMismatch"`
Expected: FAIL — the first new test fails because `insertedGuesses[0]` is undefined or lowercase (the proposal is currently dropped, never becomes a Guess) and/or `issueTags` comes back `["wordNotOnList"]` instead of `["caseMismatch"]`.

- [ ] **Step 3: Implement the wiring in `evaluateProposals`**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, add the import (alongside the existing `applyOneOffWordFixups` import at line 33):

```typescript
import { findCaseInsensitiveGroupMatch } from "./case-insensitive-match";
```

Then replace lines 666-688 (from `const originalPuzzleWords = ...` through the closing `continue;` / `}` of the missing-word branch) with:

```typescript
    const originalPuzzleWords = new Set(
      puzzle.answerGroups.flatMap((group) => group.members.map((member) => member.word)),
    );
    const answerGroupWords = puzzle.answerGroups.map((group) => group.members.map((member) => member.word));

    for (const currentProposal of proposalEntries) {
      let guessWords = currentProposal.words!;

      // A word missing from run.availableWords is either already solved by
      // an earlier guess in this loop (expected, boring — every word in
      // state.lockedInGroups is still a real puzzle word), the right words
      // in the wrong case (tolerated below, not a hallucination), or a
      // genuine model hallucination.
      const isWordMissingFromAvailable = guessWords.some((w) => !run.availableWords.includes(w));
      if (isWordMissingFromAvailable) {
        const caseInsensitiveMatch = findCaseInsensitiveGroupMatch(guessWords, answerGroupWords);
        const isCaseMismatchStillAvailable =
          caseInsensitiveMatch?.every((w) => run.availableWords.includes(w)) ?? false;

        if (caseInsensitiveMatch && isCaseMismatchStillAvailable) {
          // Normalize to canonical casing right here, before guessWords is
          // used to build the Guess or filter run.availableWords below —
          // both of those compare case-sensitively against canonical-case
          // data, so carrying the model's raw casing any further would
          // corrupt run state even though the guess itself succeeds.
          guessWords = caseInsensitiveMatch;
          currentProposal.words = guessWords;
          const issueTags = currentProposal.solvePrompt!.issueTags;
          if (!issueTags.includes(SolvePromptIssueTag.CASE_MISMATCH)) {
            issueTags.push(SolvePromptIssueTag.CASE_MISMATCH);
          }
        } else {
          const hasHallucinatedWord = guessWords.some((w) => !originalPuzzleWords.has(w));
          if (hasHallucinatedWord) {
            const issueTags = currentProposal.solvePrompt!.issueTags;
            if (!issueTags.includes(SolvePromptIssueTag.WORD_NOT_ON_LIST)) {
              issueTags.push(SolvePromptIssueTag.WORD_NOT_ON_LIST);
            }
          }
          continue;
        }
      }
```

Leave everything from `state.guessCount++;` onward unchanged — it already reads `guessWords` (now normalized when it came through the case-mismatch branch), so the rest of the pipeline (building the `Guess`, filtering `run.availableWords`, evaluating the result) needs no further changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/strategy/llm-strategy-runner.service.spec.ts`
Expected: PASS — every test in the file, including the two new ones and all pre-existing `wordNotOnList` tests (unaffected, since a genuine hallucination never matches `findCaseInsensitiveGroupMatch`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "fix(strategy): accept case-insensitive answer matches instead of dropping them"
```

---

### Task 3: Purge script for historical case-mismatch-tainted runs

**Files:**
- Create: `backend/src/scripts/purge-case-mismatch-runs.ts`
- Create: `backend/src/scripts/purge-case-mismatch-runs.spec.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: `findCaseInsensitiveGroupMatch` from Task 1.
- Produces: `findCaseMismatchAffectedRunIds(notSelectedProposals: CaseMismatchProposalRow[], answerGroupsByPuzzleId: Map<number, string[][]>): Set<number>` and the `CaseMismatchProposalRow` type (`{ strategyRunId: number; puzzleId: number; words: string[] }`) — exported for the test in this task; not consumed elsewhere.

- [ ] **Step 1: Write the failing tests for `findCaseMismatchAffectedRunIds`**

Create `backend/src/scripts/purge-case-mismatch-runs.spec.ts`:

```typescript
import { findCaseMismatchAffectedRunIds, type CaseMismatchProposalRow } from "./purge-case-mismatch-runs";

describe("findCaseMismatchAffectedRunIds", () => {
  const answerGroupsByPuzzleId = new Map<number, string[][]>([
    [
      100,
      [
        ["APPLE", "BANANA", "CHERRY", "DATE"],
        ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
      ],
    ],
  ]);

  it("flags a run whose not_selected proposal matches a puzzle group only after lowercasing", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set([7]));
  });

  it("does not flag a run whose proposal genuinely has no matching group (real hallucination)", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["ocean", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set());
  });

  it("does not flag a run whose proposal already matches exactly (not a case mismatch)", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set());
  });

  it("skips a proposal whose puzzle has no known answer groups", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 999, words: ["apple", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, new Map())).toEqual(new Set());
  });

  it("collects multiple distinct affected run ids and dedupes repeats from the same run", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
      { strategyRunId: 8, puzzleId: 100, words: ["eggplant", "fig", "grape", "honey"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set([7, 8]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `npx jest src/scripts/purge-case-mismatch-runs.spec.ts`
Expected: FAIL — `Cannot find module './purge-case-mismatch-runs'`

- [ ] **Step 3: Implement the script**

Create `backend/src/scripts/purge-case-mismatch-runs.ts`:

```typescript
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { AppModule } from "../app.module";
import { StrategyRun } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal, LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { findCaseInsensitiveGroupMatch } from "../modules/strategy/case-insensitive-match";

/**
 * One-off purge for StrategyRun rows tainted by the pre-fix case-sensitivity
 * bug in evaluateProposals (llm-strategy-runner.service.ts): a proposal
 * whose words were the right words in the wrong case was silently dropped
 * (never became a Guess) and, depending on batching, sometimes tagged
 * wordNotOnList even though every word really was on the puzzle. The live
 * code no longer does this (see case-insensitive-match.ts) — but existing
 * runs recorded under the old behavior are unreliable, so this deletes them
 * outright (cascading to their Guess/SolvePrompt/LlmProposal rows via the
 * existing onDelete: CASCADE FKs) rather than trying to patch their
 * recorded outcome in place. Deleting a StrategyRun makes its
 * (puzzleId, strategyName, trialNumber) eligible for a fresh dispatch under
 * the fixed code (see strategy-dispatch.service.ts's "no StrategyRun row at
 * all" query) — redispatch itself is a separate, manual step.
 *
 * Every status is in scope (failed, completed, running, error) — token cost
 * of redoing them is not a concern, and even a `completed` run wasted a
 * guess on the dropped proposal before eventually solving it another way.
 *
 * Dry run by default — lists affected StrategyRun ids without deleting
 * anything. Pass --execute to actually delete.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/purge-case-mismatch-runs.ts
 *   npx tsx src/scripts/purge-case-mismatch-runs.ts --execute
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/purge-case-mismatch-runs.ts --execute
 */

const logger = new Logger("PurgeCaseMismatchRuns");

export interface CaseMismatchProposalRow {
  strategyRunId: number;
  puzzleId: number;
  words: string[];
}

/**
 * Every distinct StrategyRun id with at least one not_selected proposal
 * whose words match one of its puzzle's answer groups only after
 * lowercasing — i.e. a proposal the old code wrongly dropped for casing.
 */
export function findCaseMismatchAffectedRunIds(
  notSelectedProposals: CaseMismatchProposalRow[],
  answerGroupsByPuzzleId: Map<number, string[][]>,
): Set<number> {
  const affected = new Set<number>();
  for (const proposal of notSelectedProposals) {
    const answerGroups = answerGroupsByPuzzleId.get(proposal.puzzleId);
    if (!answerGroups) continue;
    if (findCaseInsensitiveGroupMatch(proposal.words, answerGroups)) {
      affected.add(proposal.strategyRunId);
    }
  }
  return affected;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);
    const llmProposalRepo = dataSource.getRepository(LlmProposal);
    const puzzleRepo = dataSource.getRepository(Puzzle);

    const notSelected = await llmProposalRepo.find({
      where: { status: LlmProposalStatus.NOT_SELECTED },
      select: { strategyRunId: true, words: true },
    });
    logger.log(`Checking ${notSelected.length} not_selected proposal(s) for case-mismatch matches.`);

    if (notSelected.length === 0) {
      return;
    }

    const strategyRunIds = [...new Set(notSelected.map((p) => p.strategyRunId))];
    const runs = await strategyRunRepo.find({
      where: { id: In(strategyRunIds) },
      select: { id: true, puzzleId: true, modelName: true, status: true },
    });
    const runById = new Map(runs.map((r) => [r.id, r]));

    const puzzleIds = [...new Set(runs.map((r) => r.puzzleId))];
    const puzzles = await puzzleRepo.find({
      where: { id: In(puzzleIds) },
      relations: { answerGroups: { members: true } },
    });
    const answerGroupsByPuzzleId = new Map(
      puzzles.map((puzzle) => [
        puzzle.id,
        puzzle.answerGroups.map((group) => group.members.map((member) => member.word)),
      ]),
    );

    const proposalRows: CaseMismatchProposalRow[] = notSelected
      .map((p) => {
        const run = runById.get(p.strategyRunId);
        return run ? { strategyRunId: p.strategyRunId, puzzleId: run.puzzleId, words: p.words } : null;
      })
      .filter((row): row is CaseMismatchProposalRow => row !== null);

    const affectedRunIds = findCaseMismatchAffectedRunIds(proposalRows, answerGroupsByPuzzleId);

    logger.log(`${affectedRunIds.size} StrategyRun row(s) affected by the case-mismatch bug.`);
    for (const id of affectedRunIds) {
      const run = runById.get(id);
      logger.log(`  StrategyRun ${id}: model=${run?.modelName} puzzleId=${run?.puzzleId} status=${run?.status}`);
    }

    if (affectedRunIds.size === 0) {
      return;
    }

    if (!execute) {
      logger.log("Dry run only — pass --execute to actually delete these rows.");
      return;
    }

    const result = await strategyRunRepo.delete({ id: In([...affectedRunIds]) });
    logger.log(
      `Deleted ${result.affected ?? 0} StrategyRun row(s) (cascades to their Guess/SolvePrompt/LlmProposal rows).`,
    );
  } finally {
    await appContext.close();
  }
}

// Only run when invoked directly (npx tsx / node), not when
// purge-case-mismatch-runs.spec.ts imports this file's pure exports —
// importing it must never boot a Nest application context.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(error);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/scripts/purge-case-mismatch-runs.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Register the script in package.json**

In `backend/package.json`, add a new entry to `"scripts"` (alongside the existing `"eval:categories"` entry):

```json
    "purge:case-mismatch-runs": "tsx src/scripts/purge-case-mismatch-runs.ts"
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/scripts/purge-case-mismatch-runs.ts backend/src/scripts/purge-case-mismatch-runs.spec.ts backend/package.json
git commit -m "feat(strategy): add dry-run-by-default purge script for case-mismatch-tainted runs"
```

---

### Task 4: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run (from `backend/`): `npm test`
Expected: PASS — no regressions anywhere in the suite, not just the files touched above.

- [ ] **Step 2: Run lint**

Run (from `backend/`): `npm run lint`
Expected: no errors.

- [ ] **Step 3: Typecheck via build**

Run (from `backend/`): `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Confirm the purge script's dry run is safe by default**

Run (from `backend/`): `npx tsx src/scripts/purge-case-mismatch-runs.ts` against local dev data (no `--execute`).
Expected: logs how many `not_selected` proposals it checked and how many (if any) `StrategyRun` rows would be affected, and explicitly states it is a dry run — confirm it makes no database writes (re-run `git status`/row counts are unaffected; this is a read-only pass).

Do **not** pass `--execute` here or against production data as part of this task — running the purge for real is a separate, explicitly-confirmed action outside this plan's scope.
