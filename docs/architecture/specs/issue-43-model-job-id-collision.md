# Issue #43 — Bulk model dispatch job-id collision: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill),
addressing [GitHub issue #43](https://github.com/Donrwalsh/Connections/issues/43) directly —
there is no corresponding `docs/architecture/NN-*.html` candidate behind it, so it isn't numbered
into that sequence.

**Branch:** `fix/dispatch-model-job-id-collision`, off `master`.

---

## Goal

`runStrategyJobId(puzzleId, strategyName, trialNumber)` builds a BullMQ job id with no model
component (`backend/src/modules/queue/strategy.queue.ts:140-146`). Since BullMQ's `add()` is a
no-op when a job with the same id already exists (waiting included), two different models
dispatched against the same puzzle date before the worker drains collide on the same job id and
the second one silently disappears — `POST /dispatch/model/:modelName/runs/:n` for model B
against a puzzle that already has a waiting job for model A queues nothing for that date. Put the
model in the job id so cross-model dispatches never collide.

Doing that in isolation would trade a loud problem for a silent one: `triggerNextLlmTrial`
computes the next trial number from `MAX(StrategyRun.trialNumber)` with no locking
(`strategy-dispatch.service.ts:363-364`), and `StrategyRunStore.loadOrCreateRun`'s existing-run
lookup keys on `(puzzleId, strategyName, trialNumber)` only, not model
(`strategy-run-store.service.ts:84-86`) — matching the DB's own unique constraint, which is the
same three columns (`strategy-run.entity.ts:40-44`). Once the job-id fix lets two different-model
jobs for the same trial number both get queued, whichever is processed second would silently
attach to the first job's `StrategyRun` row and run under the wrong model's name. This spec closes
that race at the same time as the job-id fix, since shipping one without the other converts a
"jobs get dropped" bug into a "jobs run under the wrong model" data-corruption bug.

---

## Scope

### In scope

- Add `model` to `runStrategyJobId`'s signature and every call site.
- Make `triggerNextLlmTrial`'s trial-number allocation atomic against concurrent calls for
  different models on the same `(puzzleId, strategyName)`, via a Postgres advisory lock.
- Make `StrategyRunStore.loadOrCreateRun` assert the existing run's `modelName` matches the
  incoming model, throwing instead of silently reusing a mismatched row.
- Update every affected spec file's job-id and call-site expectations.

### Out of scope (confirmed in grilling)

| Item | Why deferred |
|---|---|
| Making `findUnrunPuzzleDatesForModel` exclude puzzles with an already-queued job for the model ("Option 2" in the issue) | Not required for correctness — see below. Repeat bulk-dispatch calls before drain may re-select an already-queued puzzle date, which now correctly collapses to the existing job for that model instead of erroring or duplicating. That re-roll is an accepted, pre-existing tradeoff (already called out in the code at `strategy-dispatch.service.ts:147-151`), not new behavior this fix introduces. |
| DB schema change | Not needed — the existing `UQ_StrategyRun_puzzle_strategyName_trialNumber` constraint stays exactly as-is; the fix makes allocation race-safe so that constraint is never contended, rather than loosening it to include model. |
| Any change to `strategyTrialNumbers`' deterministic/shuffle trial path (`triggerStrategyRuns`'s `addBulk` branch) | Those trial numbers are a fixed set computed with no DB lookback, so there's no race to fix there. |
| A compatibility shim for the old job-id format | Confirmed no external tooling (dashboards, scripts, runbooks) parses BullMQ job ids for this queue; Bull Board just displays them, and the only in-repo consumer of the id shape (`rpd-resume.service.ts`) only appends a suffix, never parses. |

### Why "Option 1 only" (job-id fix) is sufficient once the race is closed

Repeat bulk-dispatch calls for the *same* model, issued before drain, already collapse correctly
without any selection-side change: `triggerNextLlmTrial` recomputes the same trial number from
the DB (unchanged since nothing drained) for the same re-selected puzzle, producing the same job
id, which BullMQ no-ops. That satisfies the issue's second acceptance criterion
("re-issuing the same bulk call for model A does not create duplicate jobs") as a side effect of
the id fix, not because of any dedicated queue-awareness — a fact confirmed against the actual
code, not assumed.

---

## Design

### 1. `runStrategyJobId` — add the model segment

**File:** `backend/src/modules/queue/strategy.queue.ts:140-146`

```ts
export function runStrategyJobId(
  puzzleId: number | string,
  strategyName: string,
  model: string | null,
  trialNumber: number,
): string {
  return `run-${puzzleId}-${strategyName}-${model ?? "none"}-${trialNumber}`;
}
```

Fixed literal placeholder `"none"` for strategies with no model (deterministic/shuffle), so the
id is always 5 hyphen-joined segments regardless of strategy type. Nothing downstream parses the
id back into components, so there's no ambiguity risk from model names that themselves contain
hyphens or colons (e.g. `qwen2.5:14b`).

**Call sites to update (all pass their existing model value positionally):**

- `backend/src/modules/strategy/strategy-dispatch.service.ts:107` (`triggerRun`)
- `backend/src/modules/strategy/strategy-dispatch.service.ts:133` (`triggerStrategyRuns`'s
  `addBulk` branch — passes `model ?? null`, same as the job `data.model` already on that line)
- `backend/src/modules/strategy/strategy-dispatch.service.ts:369` (`triggerNextLlmTrial` — passes
  `model`, always defined here since `triggerStrategyRuns` only reaches this branch for LLM
  strategies after `assertSupported`)
- `backend/src/modules/game/puzzle-ingestion.service.ts:295` (passes the same `model` variable
  already in scope there)
- `backend/src/modules/provider-pool/rpd-resume.service.ts:139,229` (pass `run.modelName` — the
  `StrategyRun` entity field, already loaded on `run` at both call sites)

### 2. Atomic trial-number allocation

**File:** `backend/src/modules/strategy/strategy-dispatch.service.ts:342-371`

Wrap the read-then-reserve sequence in a transaction holding a Postgres advisory lock scoped to
`(puzzleId, strategyName)`, so two concurrent calls (different models, same puzzle+strategy)
serialize instead of racing:

```ts
private async triggerNextLlmTrial(
  puzzleId: number,
  strategyName: string,
  date: string,
  model: string,
): Promise<void> {
  await this.strategyRunRepo.manager.transaction(async (manager) => {
    // Serializes concurrent allocation for the same (puzzleId, strategyName) — released
    // automatically at transaction end. hashtext() gives a stable int4 from strategyName;
    // pg_advisory_xact_lock takes two int4 keys rather than one bigint so puzzleId doesn't
    // need to be packed into a wider key by hand.
    await manager.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      puzzleId,
      strategyName,
    ]);

    const existingRuns = await manager.find(StrategyRun, {
      where: { puzzleId, strategyName },
      select: { trialNumber: true, modelName: true },
    });

    const limit = llmMaxTrialsPerModel();
    const modelRunCount = existingRuns.filter((run) => run.modelName === model).length;

    if (modelRunCount >= limit) {
      throw new BadRequestException(
        `Model '${model}' has already reached its limit of ${limit} trial(s) for strategy` +
          ` '${strategyName}' on this puzzle (see LLM_TRIALS_PER_MODEL).`,
      );
    }

    const nextTrialNumber =
      existingRuns.reduce((max, run) => Math.max(max, run.trialNumber), 0) + 1;

    await this.queueFor(strategyName).add(
      "run-strategy",
      { puzzleId, strategyName, date, trialNumber: nextTrialNumber, model },
      { jobId: runStrategyJobId(puzzleId, strategyName, model, nextTrialNumber) },
    );
  });
}
```

Note the lock is held for the read-check-reserve sequence, including the `queue.add()` call —
BullMQ's own `add()` is fast and this method is only ever called once per puzzle per dispatch
request (never in a tight loop), so holding the lock that long is not a contention concern. The
`BadRequestException` thrown inside `manager.transaction`'s callback rolls the transaction back
(no partial writes) and propagates out of `transaction()` unchanged — Nest's exception filter
still turns it into the same 400 response as today.

### 3. Defense-in-depth: model-aware guard in `loadOrCreateRun`

**File:** `backend/src/modules/strategy/strategy-run-store.service.ts:70-110`

```ts
const existing = await this.strategyRunRepo.findOne({
  where: { puzzle: { id: puzzleId }, strategyName, trialNumber },
});

if (existing) {
  if (existing.modelName !== (model ?? null)) {
    throw new Error(
      `StrategyRun ${existing.id} (puzzle ${puzzleId}, strategy '${strategyName}', trial` +
        ` ${trialNumber}) was created for model '${existing.modelName}', but this job is for` +
        ` model '${model}'. Refusing to run the wrong model against an existing run — this` +
        ` indicates a trial-number allocation race (see triggerNextLlmTrial's advisory lock).`,
    );
  }
  return { run: existing, puzzle };
}
```

This should be unreachable given the advisory lock, with one exception: the deploy transition
window, where a job already queued under the *old* job-id format (no model segment) sits waiting
across the deploy. A fresh dispatch call after deploy can allocate the same trial number for a
different model (the advisory lock only protects calls made after deploy; it has no way to know
about a job enqueued before it existed). Without this guard, that scenario would silently corrupt
the older job's run row; with it, whichever of the two jobs is processed second throws and is
marked `error` via the queue processor's existing catch-all — a one-time, self-resolving fringe
case at the moment of deploy, not an ongoing risk.

### 4. Non-goals confirmed safe as-is

- `findUnrunPuzzleDatesForModel` (`strategy-dispatch.service.ts:153-178`) — unchanged. Its
  `NOT EXISTS` query against `StrategyRun` still only sees started/running runs; a puzzle with
  only a queued job for a model can be re-selected, but re-selection now safely collapses to the
  existing job (point made under Scope above).
- `dispatch.controller.ts`'s two endpoints (`queueModel` at `:136-149`, `queueModelRuns` at
  `:151-203`) — neither needs a code change; both already funnel through `triggerStrategyRuns` →
  `triggerNextLlmTrial`, so they inherit the fix automatically.

---

## Tests

TDD per the `test-driven-development` skill — write the failing test first for each behavior
change:

1. **`strategy.queue.spec.ts`** (new): `runStrategyJobId` includes the model segment, and falls
   back to `"none"` when model is `null`/`undefined`.
2. **`strategy-dispatch.service.spec.ts`**: update every existing `jobId`/`opts.jobId` expectation
   (21 call sites — see below) to the new 5-segment format. Add a new case: two `triggerRun`/
   `triggerNextLlmTrial` calls for the same puzzle+strategy with different models produce two
   distinct job ids (regression test for the exact repro in the issue). Add a case for the
   `LLM_TRIALS_PER_MODEL` cap still applying per model with the new allocation path.
3. **`strategy-dispatch.service.spec.ts`**: a concurrency test for `triggerNextLlmTrial` —
   two simultaneous calls (different models, same puzzle+strategy) against a real or
   transaction-mocked repo must not allocate the same trial number. If the existing spec's
   `strategyRunRepo` mock can't express `manager.transaction`/advisory-lock semantics
   meaningfully, this may need an e2e-level test instead (see next point) rather than a forced
   unit-test simulation of Postgres locking.
4. **`app.e2e-spec.ts`**: an end-to-end regression for the issue's exact repro — dispatch model A
   for a puzzle, then dispatch model B for the same puzzle before either drains, assert both jobs
   are present on the queue (or both `StrategyRun` rows exist, depending on what the existing e2e
   suite already asserts against). This is the test that actually exercises the Postgres advisory
   lock for real, since the unit-test mocks can't.
5. **`strategy-run-store.service.spec.ts`**: `loadOrCreateRun` returns the existing run when the
   model matches; throws when an existing run's `modelName` doesn't match the incoming model.
6. **`rpd-resume.service.spec.ts`**: update the `runStrategyJobId` call-site expectations (lines
   133, 148-149, 311, 344) to pass `run.modelName` as the new positional argument.

**Existing `jobId` assertions to update in `strategy-dispatch.service.spec.ts`** (line numbers as
of this spec — re-grep before editing, they will shift as tests are added): 208, 225, 245, 267,
289, 312, 336, 358, 381, 415, 440, 451, 462, 486, 497, 527, 552, 581, 601, 625.

---

## Risks

- **Advisory lock scoping.** `pg_advisory_xact_lock(int, int)` keys are session/transaction-local
  bigint-pair locks scoped to the whole Postgres session, not to a table or row — using
  `(puzzleId, hashtext(strategyName))` as the key pair is safe here because the only contention
  we need to prevent is exactly "two calls for the same puzzle+strategy," which is precisely what
  that key pair identifies. A `hashtext()` collision between two different `strategyName` values
  would cause harmless *over*-serialization (unrelated strategies briefly blocking each other),
  never incorrect allocation — acceptable given the small, fixed set of strategy names in this
  codebase.
- **No existing locking/retry-on-conflict precedent in this backend** (confirmed by search) — this
  is a new pattern for the codebase. Keep it contained to this one method rather than generalizing
  it into a shared helper prematurely.
- **The deploy transition window** (old-format queued jobs colliding with newly-computed trial
  numbers) is handled by the guard in `loadOrCreateRun` failing loudly, not by preventing the
  collision outright — see Design §3. Acceptable given it's a narrow, one-time window and the
  failure mode is a single job erroring (visible in Bull Board / run history as `status: error`),
  not silent corruption.
