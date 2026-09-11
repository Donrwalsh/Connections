# Candidate 8 — Persist prompt text, retire `prompt-reconstruction.ts`: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow. It realises the architecture-deepening artifact
`docs/architecture/08-persist-prompt-text.html`.

**Branch:** `refactor/persist-prompt-text`, off `master` (candidate 5 — split-strategy-service
— and candidates 6/7 — answer-grammar unification, `/diagnose` fold — are already merged; no
ordering dependency on them beyond that, as the artifact required).

**Shape of delivery:** 2 PRs, merged sequentially.

---

## Goal

`llm-strategy-runner.service.ts` builds each step's prompt (`buildRetryPrompt`/
`buildInitialPrompt`, lines 306–308) and sends it, but never stores it. Showing a run's chain in
the UI instead **replays** the run: `prompt-reconstruction.ts` (177 lines) recomputes the initial
word order, walks stored guesses to rebuild `availableWords`/`lockedInGroups`/
`lastFailedGuess` at each step, and re-invokes the same two builder functions — a second
implementation of the runner's state machine, whose correctness is defined as "produces exactly
what the runner produced." A change to either builder or to the runner's state handling silently
makes every historical run's displayed prompt wrong, with no compiler or test catching it.

Store the string the runner already built, on the row it already inserts. Deletion test: delete
`prompt-reconstruction.ts` — what replaces it is a column read.

---

## Scope

### In scope

- New nullable `promptText: text` column on `SolvePrompt`, written by the runner on every
  `pendingPrompts.push` (success rows and `CALL_ERROR` rows alike) with the full running
  transcript up to and including that attempt's prompt, in the `[User]\n...\n\n[Assistant]\n...`
  format `Game.tsx` and `prompt-reconstruction.ts` already use.
- `strategy-read.service.ts`'s chain view becomes a straight `promptText` column read —
  `reconstructSolvePrompts` call removed.
- One-time backfill script, `backend/src/scripts/backfill-prompt-text.ts` (matches this repo's
  existing convention — see `backfill-issue-tags.ts`, `backfill-image-puzzle-dates.ts`), reusing
  `prompt-reconstruction.ts`'s replay logic to fill `promptText` on historical rows.
- Deleting `prompt-reconstruction.ts` as part of the code-side cutover (Task 2), not deferred until
  the prod backfill has actually run — see Task 2's note below and the ledger's ruling: only the
  literal "run the script against prod" and "confirm zero-null count" steps are deploy-time actions
  outside a workspace's reach; the code deletion itself is not gated on them.
- Repurposing `prompt-reconstruction.spec.ts` into the backfill script's test — its fidelity
  assertions ("produces exactly what the runner produced") are exactly what the one-time backfill
  needs to prove before it's trusted against real data.

### Out of scope

| Item | Why deferred |
|---|---|
| Removing `SolvePrompt.requestBody` (jsonb) | Also contains the full transcript (as the provider request body), but is a different shape (`messages` array, not `[User]/[Assistant]` text) and serves other consumers (telemetry, debugging). Not this candidate's concern. |
| Any provider-pool candidates (1–4, 10, 11) | Separate risk surfaces. |

---

## The measurement (resolves the artifact's open gate)

The artifact gated full-transcript-per-row vs. step-only-plus-read-model-concatenation on a
worst-case size query against prod. Run (against prod, via `requestBody` length as a proxy for
transcript size — see artifact's "already there" section for why that's valid):

```sql
SELECT "strategyRunId",
       count(*) AS steps,
       sum(length(coalesce("requestBody"::text, ''))) AS full_transcript_bytes_if_stored,
       max(length(coalesce("requestBody"::text, ''))) AS worst_single_row_bytes
FROM "SolvePrompt"
GROUP BY "strategyRunId"
ORDER BY full_transcript_bytes_if_stored DESC
LIMIT 20;
```

**Result (2026-09-11, prod):** worst single row 67 KB (a 5-step run); worst run-total 2.1 MB
(a 62-step outlier). Every other run in the top 20 totals under 1 MB. Both numbers are trivial
for a Postgres `text` column (TOAST handles it transparently) — no row anywhere near a size that
would concern schema design.

**Decision: store the full transcript per row**, not step-only + concatenation. The quadratic
growth the artifact worried about is real but small in absolute terms at this data volume, and
full-transcript-per-row is the simpler design (matches the artifact's "cleanest" framing) — no
concatenation logic needed in the read model, ever.

---

## Design

### Entity

```ts
// solve-prompt.entity.ts
@Column({ type: "text", nullable: true })
promptText: string | null;   // full [User]/[Assistant] transcript through this attempt; null only for pre-migration rows pending backfill
```

Migration: add nullable `text` column (no default, no backfill in the migration itself — the
backfill is a separate one-time script run after deploy, per Q1/Q7 below).

### Runner

`llm-strategy-runner.service.ts`'s main loop already holds everything needed. Right after the
user turn is appended to `messages` (line 311), compute the transcript string once and reuse it
for both the success-path `currentPrompt` object (built at line ~355) and the `CALL_ERROR` row
(built at line ~427, after `messages.pop()` — so the transcript must be captured *before* the
pop, not re-derived from `messages` at that point):

```ts
// llm-strategy-runner.service.ts, right after messages.push({ role: "user", content: prompt })
const transcriptText = messages
  .map((m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`)
  .join("\n\n");
```

- Success row: `currentPrompt.promptText = transcriptText` (transcript through the user turn only
  — the assistant reply that arrives this same iteration is the *next* row's concern, matching
  `prompt-reconstruction.ts`'s existing step-boundary convention).
- `CALL_ERROR` row: `buildCallErrorPromptRow(...)` gains a `promptText: transcriptText` field.
  This is a **behaviour change from today's reconstruction**, accepted deliberately: reconstruction
  infers a hypothetical "what would have been sent" prompt for error rows without advancing state;
  the stored value is the actual prompt the runner built and sent for that attempt. More accurate,
  and removes reconstruction's `CALL_ERROR` special case (~40 lines of docstring caveats) entirely.

`buildInitialPrompt`/`buildRetryPrompt` are unchanged — they remain the builders. What's deleted
is the second caller that exists only to re-run them.

### Read model

`strategy-read.service.ts`: drop the `reconstructSolvePrompts` import and call; map
`reconstructedPrompt: p.promptText` directly off the row (DTO field name `reconstructedPrompt`
stays — 3 frontend files, `frontend/src/data/benchmark/types.ts`,
`GuessChainVisualizer.tsx`/`.test.tsx`, consume it under that name; no frontend change needed).

### Backfill

`backend/src/scripts/backfill-prompt-text.ts`: for every `SolvePrompt` row with
`promptText IS NULL`, replay the same logic `prompt-reconstruction.ts` uses today (walk each
run's rows in `promptNumber` order, rebuild `availableWords`/`lockedInGroups`/`lastFailedGuess`,
re-invoke `buildInitialPrompt`/`buildRetryPrompt`, format as `[User]/[Assistant]`) and `UPDATE`
`promptText` in place. Run once against prod after the migration deploys; its fidelity is proven
by the repurposed spec (see Tests) before it's trusted against real data. Committed to the repo
(not run-and-delete) as a paper trail, per this repo's existing one-time-script convention.

---

## Steps

## Task 1 — PR 1: Additive: column, runner writes, migration

- Add `promptText` column + migration.
- Runner writes `promptText` on every `pendingPrompts.push` (success and `CALL_ERROR`), per
  Design above.
- `strategy-read.service.ts` unchanged — still calls `reconstructSolvePrompts` for now, so old
  rows keep rendering correctly and new rows simply carry an unused column until PR 2. This keeps
  PR 1 a pure addition with zero read-path risk.
- Tests: `llm-strategy-runner.service.spec.ts` gains assertions that `promptText` on both a
  success row and a `CALL_ERROR` row matches the transcript format, for both the initial-prompt
  and retry-prompt cases.

## Task 2 — PR 2: Cutover: read model, backfill, delete reconstruction

**Note:** the "run it once against prod" and "confirm zero-null count in prod" sub-steps are
deploy-time actions outside this workspace's reach — implement and test the script, then flag
those two sub-steps as a manual post-merge action for the human partner rather than treating them
as a task-completion blocker.

- Deploy PR 1 first; confirm new rows are landing with non-null `promptText` in prod.
- Repurpose `prompt-reconstruction.spec.ts` into `backfill-prompt-text.spec.ts` (or keep it
  colocated with the script) — same fixtures/assertions, now verifying the backfill script's
  output matches what the runner would have produced.
- Add `backfill-prompt-text.ts`, run it once against prod. Verify: `SELECT count(*) FROM
  "SolvePrompt" WHERE "promptText" IS NULL` returns 0 (or only rows from runs still in flight at
  backfill time, re-run once more to catch stragglers).
- Switch `strategy-read.service.ts` to the direct `promptText` read; drop the
  `reconstructSolvePrompts` import.
- Delete `prompt-reconstruction.ts` and any now-unused parts of its original spec file.
- Run `npm run test` (backend); confirm `strategy-read.service.spec.ts` and
  `GuessChainVisualizer.test.tsx` still pass unchanged (DTO shape is identical from the frontend's
  perspective).

---

## Tests

Characterisation-first, matching candidates 1 and 5's approach:

- `llm-strategy-runner.service.spec.ts`: new assertions that `promptText` is written correctly
  for success rows, retry rows, and `CALL_ERROR` rows (the last is new coverage — reconstruction
  never had a test proving its `CALL_ERROR` guess was even self-consistent, only that it didn't
  crash).
- `backfill-prompt-text.spec.ts` (from repurposed `prompt-reconstruction.spec.ts`): every existing
  fidelity assertion carries over unchanged — the backfill's correctness bar is identical to
  reconstruction's original bar, just exercised once instead of on every read.
- `strategy-read.service.spec.ts`: replace any fixture that mocked `reconstructSolvePrompts` with
  a fixture row carrying `promptText` directly.

---

## Risks

- **Backfill runs once against prod, on frozen historical data.** Unlike reconstruction (which
  re-ran on every read and would have surfaced a bug immediately on the next request), a backfill
  bug ships silently into stored data. Mitigated by reusing reconstruction's existing,
  already-trusted fidelity test suite rather than writing new replay logic from scratch.
- **In-flight runs at backfill time.** A run mid-solve when the backfill executes may finish with
  a straggler row inserted after the backfill's `SELECT` but with `promptText` already set by the
  runner (PR 1 lands first) — not actually a gap, since PR 1 guarantees new rows are never null.
  The only real gap is rows that existed *before* PR 1 deployed; a second backfill pass after
  deploy settles is cheap insurance.
- **`CALL_ERROR` semantics change is intentional but user-facing** — anyone who has looked closely
  at a `CALL_ERROR` row's chain-view prompt before will see a subtly different (more accurate)
  string after this ships. No product surface currently depends on the old hypothetical framing;
  confirmed low-risk.
- **Resumed runs' replayed transcript doesn't match what was actually sent.** The runner starts
  `messages` empty on every `runLlmStrategy` invocation but continues `globalPromptNumber` from the
  DB — so a run that was parked (e.g. `RATE_LIMITED_DAILY`) and later resumed has rows whose real
  conversation restarted mid-run, while both the old `prompt-reconstruction.ts` and the new backfill
  script assume one continuous conversation across all of a run's rows. This is a pre-existing blind
  spot inherited unchanged from the deleted module, not a regression — but where reconstruction
  recomputed (and could be fixed) on every read, the backfill freezes its output into stored data
  once. A future fix to this blind spot needs a re-backfill, not just a code change.
- **The `[User]/[Assistant]` format string is now duplicated** — once in the runner
  (`llm-strategy-runner.service.ts`'s `transcriptText` construction) and once in the backfill
  script's ported `formatConversation` — with no shared test asserting the two stay identical.
  Acceptable since the backfill is a one-time script, but a future edit to either one won't get a
  compiler or test warning if it drifts from the other.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
