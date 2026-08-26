# Extensible LLM failure-tag taxonomy for strategy runs — design

## Problem

`SolvePrompt` today tracks exactly one model-response quirk:
`wordsHadParenthetical`
([solve-prompt.entity.ts:78-79](../../../backend/src/modules/strategy/entities/solve-prompt.entity.ts#L78-L79))
— a boolean flag set when a model glued a trailing parenthetical onto a
`Words:` line
([llm-strategy-runner.service.ts:37](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts#L37),
`WORDS_PARENTHETICAL_RE`). It's surfaced at the run level too, via a
computed `EXISTS` subquery in the run-history listing
([strategy.service.ts:1009-1015](../../../backend/src/modules/strategy/strategy.service.ts#L1009-L1015))
and rendered in `RunHistoryTable.tsx`.

Two other model-failure varieties happen today but leave **no trace at
all**, both silent `continue`/skip paths with no flag, no row, nothing
queryable:

- **Group count off** — `parseGroupsSection` only accepts a `Words:` line
  that splits into exactly 4 words
  ([llm-strategy-runner.service.ts:482](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts#L482),
  `if (wordsLine.length === GROUP_SIZE)`). A group with 3 or 5 words is
  silently dropped from `parsedGroupWords` — no proposal, no flag.
- **Word not on the puzzle's list** — `evaluateProposals`'s
  `isWordAlreadySolved` check
  ([llm-strategy-runner.service.ts:555](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts#L555))
  conflates two different causes under one name: a word that's missing
  from `run.availableWords` because it was **already solved** by an
  earlier guess (expected, boring), and a word that was never part of the
  puzzle at all (genuine model hallucination). Either way the proposal is
  silently `continue`d past — no distinction, no flag.

There's also a scaffolded-but-dead mechanism pointing at the same gap:
`SolvePromptStatus.MALFORMED_GROUP_COUNT` and `MALFORMED_OTHER`
([solve-prompt.entity.ts:20-21](../../../backend/src/modules/strategy/entities/solve-prompt.entity.ts#L20-L21))
exist in the enum but nothing sets them anywhere in the codebase.

The status quo means: no way to count how often either failure happens, no
way to compare it across models/providers, and — the harder problem — no
mechanism to notice when the model fails in some *fourth* way nobody has
named yet. Today a new failure mode wouldn't even show up as "something
went wrong somewhere"; it would just silently produce fewer proposals than
expected, indistinguishable from a slow day.

## Goals

- Every prompt-level model-response issue — the existing parenthetical
  case plus the two new ones (group count off, word not on the puzzle's
  list) — is recorded on `SolvePrompt` in one consistent, queryable place.
- Adding a new named issue type in the future costs a code change, not a
  schema migration.
- A failure that doesn't match any known, named check still gets flagged
  (not silently dropped), so a genuinely new failure variety is
  discoverable by querying for it rather than by someone noticing
  something felt off.
- A run's total count of issue-tagged prompts is visible in the existing
  run-history listing, the same way `guessCount` already is.

## Non-goals

- No automatic clustering/labeling of the catch-all bucket. Triage is
  manual: query for the catch-all tag, read `rawResponseText` (already
  stored in full), decide whether the pattern is common enough to earn its
  own named check.
- No coverage for malformations that still produce a well-formed 4-word
  group (e.g. a duplicate word within one group). The catch-all mechanism
  here specifically detects a group going missing from the response's
  expected slots — a genuinely different kind of anomaly (one that still
  "looks" structurally fine) needs its own named check when it's
  observed, the same way `groupCountOff`/`wordNotOnList` are being added
  now.
- No change to `SolvePromptStatus` (`parsed`/`malformedNoAnswerBlock`/
  `callError`/etc.) — that enum tracks the *outcome* of a prompt (did it
  produce usable proposals at all). The new tag list tracks *quality
  issues within* a response that otherwise still produced proposals. The
  two are orthogonal and both remain.
- `issueCount` does not include `callError` rows (a real OpenAI call
  failure). That's already visible via `run.status` transitioning to
  `ERROR`; folding it into the same number would conflate "the model
  produced a slightly malformed but readable response" with "OpenAI's API
  was down," which are different operational concerns.

## Design

### 1. Schema — `issueTags` replaces `wordsHadParenthetical`

`SolvePrompt.wordsHadParenthetical: boolean` is replaced with
`issueTags: string[]` (Postgres `text[]`, `NOT NULL DEFAULT '{}'`). Known
tags are module-level string constants, not a DB enum — a DB enum would
require a migration for every new tag, defeating the point:

```typescript
// llm-strategy-runner.service.ts
export const SolvePromptIssueTag = {
  PARENTHETICAL_STRIPPED: "parentheticalStripped",
  GROUP_COUNT_OFF: "groupCountOff",
  WORD_NOT_ON_LIST: "wordNotOnList",
  UNCLASSIFIED: "unclassified",
} as const;
```

A response can trip more than one of these at once (e.g. a parenthetical
*and* a hallucinated word in the same response), which is exactly why this
is an array rather than a single status value.

Migration `backend/src/migrations/<ts>-add-solve-prompt-issue-tags.ts`:

1. `ALTER TABLE "SolvePrompt" ADD COLUMN "issueTags" TEXT[] NOT NULL DEFAULT '{}'`
2. Backfill: `UPDATE "SolvePrompt" SET "issueTags" = ARRAY['parentheticalStripped'] WHERE "wordsHadParenthetical" = true`
3. `ALTER TABLE "SolvePrompt" DROP COLUMN "wordsHadParenthetical"`

`down()` reverses all three (recreate the boolean column, backfill it from
`'parentheticalStripped' = ANY("issueTags")`, drop `issueTags`).

Frequency metrics become a straightforward `unnest`:

```sql
SELECT unnest("issueTags") AS tag, COUNT(*)
FROM "SolvePrompt"
GROUP BY tag
ORDER BY count DESC;
```

**Enum cleanup:** `SolvePromptStatus.MALFORMED_GROUP_COUNT` and
`MALFORMED_OTHER` are removed from the enum in the same change. Both are
unused today, and this design's tag list is what actually covers the need
they were speculatively added for — leaving them in place would mean two
parallel, half-implemented mechanisms for the same problem.

### 2. Detection logic

All three new triggers mutate the same `currentPrompt.issueTags` array —
the identical in-place-mutation pattern `wordsHadParenthetical` already
uses today (`currentPrompt` is the same object instance already queued in
`pendingPrompts`, so mutating it after the fact still reflects at flush
time; see the existing comments at
[llm-strategy-runner.service.ts:1291-1293](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts#L1291-L1293)).

**`groupCountOff`** — in `parseGroupsSection`, when a `Words:` line splits
to a count other than `GROUP_SIZE` (today: the group is just dropped).
The function also records which group numbers hit this branch, so the
catch-all check below can tell "this group is missing because its count
was wrong" (already explained) apart from "this group is missing for some
other reason" (not yet explained).

**`wordNotOnList`** — in `evaluateProposals`, the existing single
`isWordAlreadySolved` check splits into two:

- word missing from `run.availableWords` **and** missing from the full
  original puzzle set (`run.availableWords ∪ flatten(state.lockedInGroups)`
  — both already held in memory, no extra query needed) → genuine
  hallucination, tag `wordNotOnList` on `currentPrompt.issueTags`.
- word missing from `run.availableWords` but present in
  `state.lockedInGroups` → already solved by an earlier guess in this run,
  same silent-skip behavior as today, **no tag** (expected, not a model
  failure).

Either way the proposal is still skipped exactly as it is today — this
only changes whether/how it gets flagged, not the solve behavior.

**`unclassified`** (the novelty catch-all) — checked against the group
numbers the response's own `Group N` headings actually mentioned, **not**
the puzzle's total remaining group count. The model normally addresses
just one group per call (the common, correct case — see the "should solve
a puzzle through iterative orchestrator calls" test) rather than every
group the puzzle still needs, so comparing against the puzzle's expected
count would misfire on every ordinary single-group response. Instead,
`parseGroupsSection` tracks the highest `Group N` heading number the
response itself mentioned (`maxGroupNum`); after the parse, for each
number from 1 to `maxGroupNum`, if no entry landed in `parsedGroupWords`
for that number *and* it wasn't already recorded as a `groupCountOff`
case, tag `unclassified`. This covers a `Group N` heading with no matching
`Words:` line, a number skipped between two real headings, or any other
shape nobody has seen yet — without needing to anticipate it, and without
false-flagging a response that simply hasn't gotten to a later group yet.
New failure varieties surface as `unclassified` first; once a pattern in
those rows' `rawResponseText` looks common enough, promote it to its own
named tag the same way `groupCountOff` and `wordNotOnList` are being added
now.

### 3. Run-level rollup: `issueCount` in the run-history listing

Matches the existing pattern at
[strategy.service.ts:1005-1015](../../../backend/src/modules/strategy/strategy.service.ts#L1005-L1015),
where `guessCount` and (today) `hadWordsParenthetical` are computed as
scalar subqueries in the same listing query — not a denormalized column on
`StrategyRun`. `issueCount` joins them as one more `addSelect`:

```sql
(SELECT COUNT(*)::int FROM "SolvePrompt" sp
 WHERE sp."strategyRunId" = run.id AND array_length(sp."issueTags", 1) > 0)
```

(`array_length(..., 1) > 0` rather than `<> '{}'` — both work, but the
former reads unambiguously as "has at least one tag" next to the
`COUNT(*)` idiom already used for `guessCount` right above it.)

This has no backfill problem and no drift risk: it's computed fresh on
every read, correct for every historical run immediately, the same way
`guessCount` already is.

`RunHistoryRowDto.hadWordsParenthetical: boolean`
([strategy.dto.ts:195](../../../backend/src/modules/strategy/dto/strategy.dto.ts#L195))
is replaced with `issueCount: number`. `RunHistoryTable.tsx`'s existing
badge (rendered when `row.hadWordsParenthetical` is true,
[RunHistoryTable.tsx:131](../../../frontend/src/components/benchmark/RunHistoryTable.tsx#L131))
becomes a badge rendered when `row.issueCount > 0`, labeled with the count.

### 4. Data flow summary

```
parseGroupsSection(responseText, fallbackGroups)
  -> tags groupCountOff / unclassified onto currentPrompt.issueTags
       -> buildProposalEntries(...)              [unchanged shape]
            -> evaluateProposals(...)
                 -> tags wordNotOnList onto currentProposal.solvePrompt.issueTags
                      -> pendingPrompts (currentPrompt, same object, all tags now applied)
                           -> StrategyRunStore.flushBatch  [unchanged mechanism]
```

No change to `StrategyRunStore.flushBatch` itself, to `OrchestratorService`,
or to the orchestrator process — this is entirely contained to
`llm-strategy-runner.service.ts`'s parsing/evaluation logic, the
`SolvePrompt` schema, and the run-history read path.

### 5. Testing

- `llm-strategy-runner.service.spec.ts`:
  - Existing parenthetical-flag assertions
    ([llm-strategy-runner.service.spec.ts:298-299,319](../../../backend/src/modules/strategy/llm-strategy-runner.service.spec.ts#L298-L319))
    switch from `wordsHadParenthetical: true/false` to
    `issueTags: expect.arrayContaining(["parentheticalStripped"])` /
    `issueTags: []`.
  - New: a 3-word `Words:` line → `groupCountOff` tagged, that group
    absent from proposals (same drop behavior as today).
  - New: a proposed word never in the puzzle at all → `wordNotOnList`
    tagged, proposal still built (4 words) but the guess is skipped, same
    as today.
  - New: a proposed word that repeats an already-solved word → **no**
    tag, confirming the `isWordAlreadySolved` split didn't regress
    existing behavior.
  - New: a `Group N` heading with no matching `Words:` line at all (no
    count mismatch — the line just never matched) → `unclassified` tagged,
    that group absent from proposals.
  - New: a response that only addresses one of the puzzle's still-unsolved
    groups (the model's normal, common behavior) → **no** `unclassified`
    tag, confirming the catch-all checks against the response's own
    headings, not the puzzle's total remaining group count.
  - New: a response tripping both `parentheticalStripped` and
    `wordNotOnList` at once → both present in `issueTags`.
- `strategy.service.spec.ts`: replace the existing
  `hadWordsParenthetical` assertions
  ([strategy.service.spec.ts:1608-1670](../../../backend/src/modules/strategy/strategy.service.spec.ts#L1608-L1670))
  with `issueCount` ones, mirroring how `guessCount` is already asserted
  in the same tests.
- Frontend: `GuessChainVisualizer.test.tsx` and
  `StrategyPuzzlePage.test.tsx` update their `wordsHadParenthetical`/
  `hadWordsParenthetical` fixtures to `issueTags`/`issueCount`.
- New TypeORM migration exercised the same way existing ones are (this
  repo's migrations don't carry dedicated tests beyond running them).
