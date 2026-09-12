# Candidate 5 — Split strategy.service.ts: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow. It realises the architecture-deepening artifact
`docs/architecture/05-split-strategy-service.html` (round 2, `00-overview-round-2.html`).

**Branch:** `refactor/split-strategy-service`, off `master`.

**Shape of delivery:** 3 separate PRs, one per extraction step, merged sequentially. Each PR
builds and passes `npm run test` on its own; the dispatch PR (step 2) additionally needs
`npm run test:e2e` (provider-pool suite) since it touches two already-shipped consumers.

**Order-of-operations note:** the artifact recommended doing this split *before* the
provider-pool refactor (candidate 1), so `StrategyDispatch` would be carved out of a small,
focused class from the start. That didn't happen — PR #44 (candidate 1) already merged, and
`provider-pool/free-dispatch.service.ts` and `free-tier-dispatch/free-tier-dispatch.service.ts`
both now `@Inject(StrategyService)` the full 1,700-line class directly. This spec proceeds
anyway (confirmed in grilling): those are only 2 files, cheap to repoint now, and the
alternative is more consumers accreting on the monolith later.

---

## Goal

`backend/src/modules/strategy/strategy.service.ts` is 1,700 lines, one `@Injectable` class,
17 constructor dependencies (8 BullMQ queues, 6 repositories, `GameService`,
`StrategyRunStore`, `SupportedModelService`), carrying four unrelated jobs with non-overlapping
callers. Split it along those seams into three new providers + fold a small maintenance seam
into one of them. Pure mechanical extraction — no schema change, no behaviour change, no
external contract change.

---

## Scope

### In scope

- Extract `DeterministicSolver` (`deterministic-solver.service.ts`)
- Extract `StrategyDispatch` (`strategy-dispatch.service.ts`), including the 3 maintenance
  methods (`deleteRun`, `deleteErroredRuns`, `countErroredRuns`)
- Rename what remains to `RunHistoryReadModel` (`strategy-read.service.ts`)
- Update every caller; retire the `StrategyService` name entirely (no re-export shim)
- Split `strategy.service.spec.ts` into three spec files matching the new providers
- Fix 4 stale code comments that reference `StrategyService` by name

### Out of scope

| Item | Why deferred |
|---|---|
| A `CONTEXT.md` documenting the "read model" term | One term doesn't justify a new doc file; the class name `RunHistoryReadModel` carries the concept on its own (grilling decision) |
| Auditing for duplicate shared helpers before starting | The artifact already checked — `resolveDateToPuzzleId`, `isLlmStrategy`, DTO mappers either live outside the class already or move cleanly with the read model. Fix only if a real duplicate surfaces during extraction (grilling decision) |
| Splitting `StrategyModule` into per-seam Nest modules | Three providers, same folder — no independent module boundary needed yet (grilling decision) |
| `docs/architecture/06` (parser dedup), `07` (`/diagnose` fold-in), `08` (persist prompt text) | Separate candidates, separate risk surfaces |

---

## Correction to the artifact: the read model is not queue-free

The artifact's "after" picture (and its "tests improve" claim — *"no BullMQ in the fixture, so
no `--forceExit` open-handle fight for that suite"*) describes `RunHistoryReadModel` as having
no queue dependency. That's not accurate against the actual code: `getLeaderboard`'s
`progress.queued` field is populated by the private `queuedCountsByKey()`, which iterates all
8 injected queues (`this.queue` + the 7 `llm*Queue` fields) to tally waiting/delayed jobs live.
`RunHistoryReadModel` therefore keeps all 8 queue injections, same as `StrategyDispatch`, and
its spec still needs queue mocks.

The claim holds for `DeterministicSolver` only — that module genuinely has zero queue, zero
HTTP, zero LLM dependency. The locality win for the read model is still real (leaderboard SQL
no longer sits next to the shuffle solver, dispatch no longer imports 1,100 lines of read-model
code to call two methods) — it's the specific "no BullMQ in the fixture" test benefit that
doesn't apply to this module.

`buildRunDetail` also uses `this.store.countGuesses(run.id)` — so `RunHistoryReadModel` keeps
`StrategyRunStore` injected too, a dependency the artifact's table omitted.

---

## Design — exact method inventory

Verified against `strategy.service.ts` as of this spec (1,700 lines). Line numbers are from
that version; they will drift as extraction proceeds — re-grep before each step rather than
trusting these numbers past step 1.

### Module-level (top of file, lines 1–188) — all move to the read model

- `leaderboardKey()` (91–93), `computeTokenCostUsd()` (110–119), `priceAsOf()` (128–136)
- `interface ModelRate` (98–101), `interface LeaderboardAccumulator` (138–188)
- Constants: `RUN_HISTORY_SORT_EXPR`, `DEFAULT_RUN_HISTORY_LIMIT`, `MAX_RUN_HISTORY_LIMIT`,
  `RECENT_ACTIVITY_LIMIT`

`GROUP_SIZE` (55) and `BATCH_SIZE` (56) move to the solver — used only there.
`QUEUE_PAGE_SIZE` (60) is needed by both the read model (`queuedCountsByKey`) and the dispatch
module (`queuedCountsByModel`) — duplicate the `const QUEUE_PAGE_SIZE = 1000` line in both new
files rather than introducing a shared-constants module for one number.

### `DeterministicSolver` (new file `deterministic-solver.service.ts`)

**Constructor deps:** `@Inject(StrategyRunStore) store`, `@InjectRepository(Guess) guessRepo`.
Nothing else — `GameService.evaluateGuessOnPuzzle` is called as a **static** method
(`GameService.evaluateGuessOnPuzzle(puzzle, words)`, not `this.gameService...`), so import the
class but do not inject it. No `Puzzle` repo is used directly (the puzzle comes back from
`store.loadOrCreateRun`).

**Methods (verbatim move, unchanged bodies):**
- `runDeterministicStrategy(puzzleId, strategyName, trialNumber = 0)` — public, lines 1514–1648
- `pickRandomGroup(pool, tried)` — private, 1655–1670
- `sampleRandom<T>(pool, k)` — private, 1672–1680
- `groupKey(words)` — private, 1682–1684
- `combinationCount(n, k)` — private, 1686–1692
- `loadGuessesForRun(strategyRunId)` — private, 1694–1699

**Imports it needs:** `BadRequestException` (Nest), `combinationToWords`/`firstCombination`/
`nextCombination` from `./combinatorics`, `Guess`/`GuessResult`/`GuessSource` from
`./entities/guess.entity`, `Puzzle` from `../game/entities/puzzle.entity` (type-only, for the
`{ id: puzzleId } as Puzzle` casts), `StrategyRun` from `./entities/strategy-run.entity` (same
reason), `StrategyRunStatus`/`TERMINAL_STATUSES` from the same file, `SHUFFLE_SMART`/
`SHUFFLE_FOOLISH` from `../../strategies`, `GameService` from `../game/game.service`,
`StrategyRunStore` from `./strategy-run-store.service`.

**Only caller:** `backend/src/worker.ts:38,79` — `appContext.get(StrategyService)` →
`appContext.get(DeterministicSolver)`; `strategyService.runDeterministicStrategy(...)` →
`deterministicSolver.runDeterministicStrategy(...)`.

### `StrategyDispatch` (new file `strategy-dispatch.service.ts`)

**Constructor deps:** the 8 `@Inject(*_QUEUE)` params (unchanged), `@InjectRepository(StrategyRun) strategyRunRepo`, `@InjectRepository(Puzzle) puzzleRepo`, `@InjectRepository(SolvePrompt) solvePromptRepo`, `@Inject(SupportedModelService) supportedModelService`, `@Inject(StrategyRunStore) store` (for the folded-in maintenance methods).

**Methods (verbatim move):**
- `triggerRun(puzzleId, strategyName, date?, trialNumber = 0, model?)` — public, 245–273
- `triggerStrategyRuns(puzzleId, strategyName, date, model?)` — public, 284–299
- `findUnrunPuzzleDatesForModel(strategyName, modelName, limit)` — public, 316–341
- `countTodayDispatchByModel(strategyName, models)` — public, 353–376
- `countTodayLlmCalls(strategyName)` — public, 387–394
- `countInFlightByModel(strategyName, models)` — public, 407–430
- `deleteRun(runId)` — public, 912–914 (moved in, unchanged: `return this.store.deleteRun(runId)`)
- `deleteErroredRuns()` — public, 920–922 (unchanged: `return this.store.deleteErroredRuns()`)
- `countErroredRuns()` — public, 928–933 (unchanged)
- `queueFor(strategyName)` — private, 232–243, plus the `runsQueueByPool` field (225)
- `queuedCountsByModel(strategyName, models)` — private, 439–461
- `triggerNextLlmTrial(puzzleId, strategyName, date, model)` — private, 477–505

**Imports it needs:** `BadRequestException`, `Queue` from `bullmq`, the 8 `*_QUEUE` tokens from
`../queue/queue.module`, `StrategyRun`/`StrategyRunStatus` from `./entities/strategy-run.entity`,
`Puzzle` from `../game/entities/puzzle.entity`, `SolvePrompt` from
`./entities/solve-prompt.entity`, `isLlmStrategy`/`llmMaxTrialsPerModel`/`strategyTrialNumbers`/
`startOfTodayUtc` from `../../strategies`, `runStrategyJobId`/`queueForStrategy` from
`../queue/strategy.queue`, `type ProviderPoolId` from `../provider-pool/provider-pool.config`,
`StrategyRunStore` from `./strategy-run-store.service`, `SupportedModelService` from
`../supported-model/supported-model.service`.

**Callers (all 4 repointed from `StrategyService` to `StrategyDispatch`):**
- `backend/src/modules/dispatch/dispatch.controller.ts` — uses `triggerStrategyRuns` (3 call
  sites: 105, 118, 150), `findUnrunPuzzleDatesForModel` (188), `countErroredRuns` (394),
  `deleteErroredRuns` (407), `deleteRun` (430)
- `backend/src/modules/provider-pool/free-dispatch.service.ts:13,59` — `@Inject(StrategyService)`
- `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts:7,58` —
  `@Inject(StrategyService)`
- (check `triggerRun` and `countTodayDispatchByModel`/`countTodayLlmCalls`/`countInFlightByModel`
  call sites inside those two dispatch services during the step — they're the reason those
  files depend on the class at all)

### `RunHistoryReadModel` (renamed file `strategy-read.service.ts`)

**Constructor deps (everything not claimed above):** the 8 queue injects (for
`queuedCountsByKey` — see the correction above), `@InjectRepository(StrategyRun)
strategyRunRepo`, `@InjectRepository(Puzzle) puzzleRepo`, `@InjectRepository(Guess) guessRepo`,
`@InjectRepository(SolvePrompt) solvePromptRepo`, `@InjectRepository(LlmProposal)
llmProposalRepo`, `@InjectRepository(CategoryEvaluation) categoryEvaluationRepo`,
`@Inject(GameService) gameService`, `@Inject(StrategyRunStore) store`,
`@Inject(SupportedModelService) supportedModelService`.

**Methods (verbatim move):**
- `getLeaderboard()` — public, 527–826, plus `leaderboardCache` field + `LEADERBOARD_CACHE_TTL_MS`
- `getRunDetail(date, strategyName, trialNumber, page, limit)` — public, 868–888
- `getRunDetailByRunId(runId, page, limit)` — public, 897–905
- `getGuessDetail(date, strategyName, trialNumber, sequenceNumber)` — public, 1061–1095
- `getRunsForPuzzle(date, strategyName)` — public, 1104–1107
- `getRunsForPuzzleId(puzzleId, strategyName)` — public, 1115–1176
- `getRunHistory(strategyName, options)` — public, 1206–1378
- `getRecentActivity()` — public, 1392–1490
- `queuedCountsByKey()` — private, 837–866
- `buildRunDetail(run, page, limit)` — private, 935–971
- `buildSolvePromptDtos(run)` — private, 990–1029
- `toCategoryEvaluationDto(e)` — private, 1032–1054
- `mapRunDetail(run, guesses)` — private, 1492–1512

**Only caller:** `backend/src/modules/strategy/strategy.controller.ts` — repoint its
`@Inject(StrategyService)` to `@Inject(RunHistoryReadModel)`.

### Stale comments to fix in the same pass (not moved code, just wording)

- `backend/src/modules/strategy/orchestrator.service.ts:108` — "(see StrategyService)" → "(see
  `StrategyDispatch`)" (the comment is about the trigger-side pre-check, i.e. dispatch)
- `backend/src/modules/strategy/llm-job-handler.ts:12` — "(StrategyService/PuzzleIngestionService)"
  → "(`StrategyDispatch`/PuzzleIngestionService)"
- `backend/src/modules/strategy/free-tier-usage.service.ts:56` — "StrategyService's cost math" →
  "`RunHistoryReadModel`'s cost math" (the comment is about `getLeaderboard`'s cost calc)
- `backend/src/modules/strategy/dto/strategy.dto.ts:145,158` — both say
  "StrategyService.getLeaderboard" → "`RunHistoryReadModel.getLeaderboard`"

---

## Steps

### Step 1 — extract `DeterministicSolver`

Smallest, one caller, zero queue deps. Move the 6 methods + `GROUP_SIZE`/`BATCH_SIZE` verbatim
into the new file, register `DeterministicSolver` as a provider in `strategy.module.ts`, update
`worker.ts`, delete the moved methods from `strategy.service.ts`, split
`strategy.service.spec.ts`'s deterministic-solver tests into a new
`deterministic-solver.service.spec.ts` (same assertions, trimmed constructor mocks — only
`store` and `guessRepo`). Run `npm run test` (backend).

### Step 2 — extract `StrategyDispatch`

Move the 12 methods (9 public + 3 private) + `runsQueueByPool` field verbatim, register as a
provider, repoint `dispatch.controller.ts`, `free-dispatch.service.ts`,
`free-tier-dispatch.service.ts` to `@Inject(StrategyDispatch)`. Split the dispatch-related tests
out of `strategy.service.spec.ts` into `strategy-dispatch.service.spec.ts`. Run `npm run test`
+ `npm run test:e2e` (the provider-pool e2e suite boots real DI wiring and will catch a missed
repoint).

### Step 3 — rename what remains to `RunHistoryReadModel`

What's left in `strategy.service.ts` *is* the read model already — rename the file to
`strategy-read.service.ts`, rename the class, update `strategy.module.ts` and
`strategy.controller.ts`'s injection, rename `strategy.service.spec.ts` to
`strategy-read.service.spec.ts`. Fix the 4 stale comments listed above. Run `npm run test`.

### Step 4 — module wiring + final check

`strategy.module.ts` providers list: `RunHistoryReadModel`, `StrategyDispatch`,
`DeterministicSolver` replace the single `StrategyService` entry; `exports:` carries
`RunHistoryReadModel` and `StrategyDispatch` (both consumed outside the module —
`StrategyDispatch` by `provider-pool`/`free-tier-dispatch` modules, `RunHistoryReadModel` only
by this module's own controller so it doesn't strictly need exporting, but export it for
parity with the others and in case a future consumer needs it). `DeterministicSolver` is not
exported — `worker.ts` resolves it via `appContext.get()` off the whole `AppModule`, same as
today's `StrategyService` resolution, which only requires the provider to exist somewhere in
the graph. Full `npm run test` + `npm run test:e2e` green. Grep the repo for any remaining
`StrategyService` reference (should be zero outside git history).

---

## Tests

Characterisation-first, same approach as the provider-pool spec (01): no new test cases, every
existing assertion in `strategy.service.spec.ts` carries over into whichever of the three new
spec files matches where its method landed, with each spec's constructor mocks trimmed to only
that class's actual dependencies. `DeterministicSolver`'s spec drops the 8 queue mocks and the
6 unrelated repo mocks it never needed. `StrategyDispatch`'s and `RunHistoryReadModel`'s specs
both keep queue mocks (see the correction above — the read model isn't queue-free).

---

## Risks

- **The 2 already-shipped provider-pool consumers.** `free-dispatch.service.ts` and
  `free-tier-dispatch.service.ts` inject the class directly for DI, not through an interface —
  a missed repoint is a compile error, not a silent runtime bug, so this is low-risk but not
  zero-effort: re-grep both files for every method they call on `strategyService` before
  closing step 2, not just the constructor line.
- **`RunHistoryReadModel` is not the queue-free module the artifact promised.** Documented
  above. Doesn't block the split — the locality and test-isolation wins are still real for two
  of the three new modules — but don't repeat the "no BullMQ in the fixture" claim for the read
  model in the PR description.
- **No shim, no lockstep requirement.** Grilling confirmed no backwards-compat re-export of
  `StrategyService` — each step updates all of that step's callers in the same commit, so the
  build stays green at every commit without needing a transition window.
