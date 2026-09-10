# Candidate 1 — Provider Pool module: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow. It realises the architecture-deepening artifact
`docs/architecture/01-provider-pool-module.html`. Related artifacts absorbed by this work:
`03-provider-pool-lookup.html` (becomes step 3) and `04-pool-config-knobs.html` (becomes
step 7).

**Branch:** `refactor/provider-pool-module`, off `master` after PR #41 (candidate 2) merged.

**Shape of delivery:** one cohesive PR. Commits map 1:1 to the steps below; each commit
builds and passes `npm run test` + `npm run test:e2e` on its own and is independently
revertible. This spec lands as commit 1; implementation proceeds immediately without a
review gate.

---

## Goal

Adding a free-tier provider today means hand-copying ~15 near-identical files (53 files /
+2,600 lines for SambaNova). Collapse the five per-provider free-tier stacks (google, groq,
mistral, openrouter, sambanova) into one config list plus generic modules that read it, so
adding a provider becomes one config row (plus one `solver.ts` block if its 429s are
exotic, plus one frontend row — the frontend edge is out of scope here, see below).

Candidate 2 (unified `RateLimitHold` table + `RateLimitHoldService`) is step 1 of the
report's seven-step path and is already merged. This PR delivers **steps 2–7**.

---

## Scope

### In scope

- A backend provider-pool config list and lookup functions.
- Removing per-provider `strategyName` branching from `llm-strategy-runner.service.ts`,
  `queueForStrategy`, and `orchestrator/src/solver.ts`.
- Unifying `RpdResumeService` (5 → 1) and `FreeDispatchService` (5 → 1).
- Unifying the five `*DispatchState` singleton tables into one.
- Looping the worker and daily-automation wiring over the config.
- Folding the `strategies.ts` per-provider knob families into the config.

### Out of scope (deliberate deferrals)

| Item | Why deferred |
|---|---|
| `docs/architecture/05` — split the 1,696-line `strategy.service.ts` | Its own behaviour-preserving refactor with its own risk surface. This PR reaches into `llm-strategy-runner.service.ts` (a separate file) and the per-provider module directories, not `StrategyService`. |
| `docs/architecture/10` — frontend edge: one `/dispatch/pool/:poolId` route pair, one `<PoolDispatchWidget>`, one `fetchPoolDispatchStatus` | Touches the HTTP contract and React; roughly doubles the diff. Rides on this PR's config existing. Follow-up PR. |
| OpenAI `FreeTierDispatchService` (flagship/mini token-budget across named tiers) | A third `dispatch.stop` shape. Folding it in now widens scope and risk. Follow-up once the generic shape is proven. |
| `queueForJudgeProvider` (judge routing, `openai \| ollama \| google` only) | Not free-tier machinery; unrelated. Left as-is. |
| `AutomationRunLog` per-provider column unification (`googleBurnOutcome`, …) | Data migration over historical rows with near-zero payoff — the drift is only the column name. Adding a provider still needs a one-line additive migration for its column pair. |
| Full inlining of `strategies.ts` knob numbers | Step 7 folds the knob *families* into the config as referenced accessors; turning the env-reading thunks into inline literals is a further move not required here. |

---

## Design

### Config list

New module `backend/src/modules/provider-pool/`, file `provider-pool.config.ts`. This is a
standalone backend file — the backend twin of `frontend/src/data/benchmark/providerPools.ts`,
which already established "adding a provider = adding one row". The frontend row stays
minimal (`id`, `label`, `strategyName` — it is a UI filter list); the backend row carries
the behaviour config. A parity test asserts the backend `id` / `strategyName` list matches
the frontend list, so the 14 duplicated strings cannot drift.

```ts
type NumberThunk = () => number;   // reads an env-backed strategies.ts knob at call time

type HoldScope = "model" | "account";

type ResetSchedule =
  | { kind: "fixed-cron"; pattern: string; tz: string }   // google (00:01 America/Los_Angeles), openrouter (00:05 UTC)
  | { kind: "self-rearm"; maxDelayMs: number };            // groq, mistral, sambanova

type DispatchSpec =
  | { stop: "until-held"; pacing: "shared" | { tickMs: NumberThunk; maxBatch: NumberThunk; maxInFlight: NumberThunk } }
  | { stop: "account-budget"; budget: NumberThunk; callsPerTrial: NumberThunk; rpmCooldownSeconds: NumberThunk;
      tickMs: NumberThunk; maxBatch: NumberThunk; maxInFlight: NumberThunk };

interface ProviderPool {
  id: ProviderPoolId;                  // "openai" | "google" | "groq" | "openrouter" | "mistral" | "sambanova" | "ollama"
  label: string;
  strategyName: string;                // "llm-google"
  orchestratorProvider: ProviderPoolId;// "google" — the provider string solver.ts expects (same union as orchestrator ModelProvider)
  queues: { runs: string; freeDispatch?: string; rpdResume?: string };  // existing BullMQ names, verbatim; latter two present iff freeTier
  freeTier: null | {                   // null for openai / ollama
    holdScope: HoldScope;
    resetSchedule: ResetSchedule;
    dispatch: DispatchSpec;
    rateLimitFallbackSeconds: NumberThunk;
    dailyHoldFallbackSeconds: NumberThunk;                  // used as `error.dailyResetSeconds ?? this()`; for fixed-cron pools it is time-to-midnight (Pacific / UTC)
    persistentRateLimitPark?: { attempts: NumberThunk; elapsedMs: NumberThunk };  // mistral's consecutive-429 streak escalation, as data
  };
}

export const PROVIDER_POOLS: ProviderPool[] = [ /* google, groq, openrouter, mistral, sambanova, openai, ollama */ ];
export function providerPool(strategyName: string | null | undefined): ProviderPool | null;
export function providerPoolOrThrow(strategyName: string): ProviderPool;
export function providerPoolById(id: ProviderPoolId): ProviderPool;
export const FREE_TIER_POOLS: readonly (ProviderPool & { freeTier: {} })[];  // the 5 free-tier rows, in burn order
```

Refinements made against the sketch above while implementing, all to keep the config a pure
data structure that a table-driven test can assert row by row:

- The Mistral streak heuristic is modelled as **data** — `persistentRateLimitPark:
  { attempts, elapsedMs }` (the two `strategies.ts` accessors it is parameterised by) —
  rather than a `classifyExtra` closure. Step 3 passes `pool.freeTier.persistentRateLimitPark`
  into `classifyFailedCall`, which drops its `provider` parameter entirely; there is no
  `HoldDecision` type to introduce.
- `queues.freeDispatch` / `queues.rpdResume` are optional and present exactly when
  `freeTier` is non-null (openai / ollama have only a `runs` queue).
- `dailyHoldFallbackSeconds` is **required** on every `freeTier`, always applied as
  `error.dailyResetSeconds ?? dailyHoldFallbackSeconds()`. Google and OpenRouter never emit
  a `dailyResetSeconds` hint (confirmed in `solver.ts`), so for them it is simply the time
  until their clock boundary — `nextPacificMidnight` / `secondsUntilNextUtcMidnight`, which
  `provider-pool.config.ts` now imports from `strategy/rate-limit-reset-time`. Deriving the
  hold duration from the `resetSchedule` cron instead would shift Google's hold by the
  cron's one-minute offset, so the cron stays purely the step-4 resume-bootstrap input.

**Array order** is `google, groq, openrouter, mistral, sambanova` (then `openai`, `ollama`
with `freeTier: null`). This reproduces today's daily-automation burn sequence exactly when
step 6 replaces the hand-written leg calls with a loop. The order is believed incidental,
but it is preserved rather than proven.

**Knob values** (`rateLimitFallbackSeconds`, `dailyHoldFallbackSeconds`, dispatch pacing
numbers, `rpmCooldownSeconds`, `budget`) are held as `() => number` thunks that reference the
existing accessor functions in `backend/src/strategies.ts`. Runtime env override must keep
working (the Groq free-tier retry behaviour depends on reading env at call time). Step 7
moves those accessor definitions into the config module; it does not inline the numbers.

### Lookup

```ts
export function providerPool(strategyName: string): ProviderPool | null;
export function providerPoolOrThrow(strategyName: string): ProviderPool;
```

- `providerPool()` returns `null` for non-pool strategies (deterministic, shuffle,
  judge-only). Callers that have a default path today (`llm-strategy-runner.service.ts`,
  `queueForStrategy`) keep that fall-through. This null case is the report's main named
  regression risk and gets explicit tests.
- `providerPoolOrThrow()` is for structurally-always-a-pool call sites: the loops that
  iterate `PROVIDER_POOLS` (worker registration, daily automation) and the dispatch
  controller. A config gap fails loud there instead of silently defaulting.

---

## Steps

### Step 2 — add the config and lookups

Pure addition, no behaviour change. Create `provider-pool.config.ts` with `PROVIDER_POOLS`,
`providerPool()`, `providerPoolOrThrow()`. Add:

- `provider-pool.config.spec.ts` — table-driven, asserts each row's shape (queues present,
  `freeTier` shape matches `holdScope`, discriminated unions well-formed).
- Frontend-parity test — backend `id` / `strategyName` list `===` `PROVIDER_POOLS` from
  `frontend/src/data/benchmark/providerPools.ts`.
- Queue-name-parity test — the `queues` strings equal the current literal constants in
  `backend/src/modules/queue/*`.

### Step 3 — resolve provider behaviour through the lookup, not ternaries

`backend/src/modules/strategy/llm-strategy-runner.service.ts` — replace:

| Location | Today | After |
|---|---|---|
| ~196–209 | `strategyName === LLM_GOOGLE ? "google" : …` ternary chain → orchestrator provider string | `providerPool(strategyName)?.orchestratorProvider ?? "openai"` |
| ~240–244 | `isPerModelHoldProvider = strategyName === LLM_GOOGLE \|\| …` | `providerPool(strategyName)?.freeTier?.holdScope === "model"` |
| ~266–277 | `strategyName === LLM_OPENROUTER` account-wide gate | `holdScope === "account"` |
| ~318–327 | `strategyName === LLM_GROQ ? llmGroqRateLimitFallbackSeconds() : …` | `providerPool(strategyName)?.freeTier?.rateLimitFallbackSeconds() ?? …` |
| ~481–540 | daily-hold-writing ladder (`if strategyName === LLM_GOOGLE … else if LLM_GROQ …`, plus a separate Mistral `if` gated on `effectiveErrorCode` from the streak heuristic) | one path driven by `holdScope`, `resetSchedule`, and `dailyHoldFallbackSeconds` |
| ~804–822 | Mistral-only consecutive-429 escalation branch in `classifyFailedCall` | gated on `pool.freeTier.persistentRateLimitPark` and driven by its `attempts` / `elapsedMs` thunks |

`backend/src/modules/queue/strategy.queue.ts` — `queueForStrategy` currently takes 8
injected `Queue` params and `if`-chains on `strategyName`. New signature
`queueForStrategy(runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue>, defaultQueue,
strategyName)` — resolve the pool with `providerPool()`, then one `map.get(pool.id)`, no
`if`-chain. `strategy.service.ts` builds that map once from the seven `LLM_*_QUEUE` queues
it already injects (the `LLM_*_QUEUE` DI tokens stay — `category-evaluator` and the
`*-rpd-resume` services still use them; folding them into a single injected map is deferred
to keep this step's blast radius contained). `queueForJudgeProvider` is untouched.

`orchestrator/src/solver.ts` — `classifyModelCallError` has five
`if (provider === "<p>" && … statusCode === 429)` blocks. Replace with
`RATE_LIMIT_429_CLASSIFIERS: Record<ModelProvider, RateLimit429Classifier | null>` keyed by
the orchestrator's own `ModelProvider` type (`null` for openai/ollama), so TS exhaustiveness
catches a missing provider; each classifier returns a `SolveError` or `null` to fall
through to `model_error`. This is
**orchestrator-local** — no shared config with the backend. Only the result codes
(`rate_limited` / `rate_limited_daily` + reset seconds) cross the wire, and those are
unchanged, so backend and orchestrator deploy independently in any order. The PR
description states this so no lockstep rollout is assumed.

### Step 4 — unify `RpdResumeService`

One generic `RpdResumeService` + `RpdResumeBootstrap` in `provider-pool/`.
`runResume(poolId, triggerJobId)` branches on `freeTier.holdScope`: per-model pools
(google, groq, mistral, sambanova) clear expired per-model holds, revive parked runs whose
model has cleared, and re-arm a short follow-up sweep if any stayed parked; the account
pool (openrouter) clears the single account hold and, if it lifted, revives every parked
run. The bootstrap loops `FREE_TIER_POOLS`: one startup catch-up per pool, plus a job
scheduler for the `fixed-cron` pools on their `pattern`/`tz`.

Delete the five `*-rpd-resume.service.ts` + five `*-rpd-resume.bootstrap.ts` (and their ten
spec files) → one service + one bootstrap + one collapsed spec each. Keep the five
`<p>-rpd-resume` BullMQ queue names as config data (renaming a live queue orphans in-flight
jobs); `QueueModule` gains `RUNS_QUEUE_BY_POOL` and `RPD_RESUME_QUEUE_BY_POOL` map
providers.

**Behaviour drift:** the resume job-id stamp is now derived uniformly —
`dateStampInTz(resetSchedule.tz)` for the fixed-cron pools (which reproduces Google's
`pacificDateStamp()` and OpenRouter's `toISOString().slice(0,10)` exactly), the trigger
job-id for the self-rearm pools. No functional change; the only divergence flattened is log
wording.

**Deviations from the sketch:** the generic service/bootstrap are registered in
`StrategyModule` (not a new `ProviderPoolModule`) because they depend on
`RateLimitHoldService`, which lives there — a dedicated module would import `StrategyModule`
and `StrategyModule` already needs the provider-pool config, so a new module buys a
circular import for no gain. The `worker.ts` RPD-resume worker loop (five hand-written
blocks → one loop over `FREE_TIER_POOLS`) is pulled forward from step 6, since deleting the
five services forces the worker change to keep the build green.

### Step 5 — unify `FreeDispatchService` + the dispatch-state table

One generic `FreeDispatchService` in `provider-pool/` with `runTick(poolId)`. Stop
condition selected from `dispatch.stop` (`until-held` vs `account-budget`); pacing from
`dispatch.pacing`.

**Dispatch-state table:** merge the five `*DispatchState` singleton tables
(`google-dispatch-state.entity.ts`, …) into one `DispatchState` table — one row per pool,
`pool` text column as the primary key (no surrogate id; the table is a keyed singleton
set). Rows created lazily by `runTick` on first use (upsert), matching how the per-provider
singletons initialise today. Migration is **drop-and-recreate**: `up()` drops the five old
tables and creates `DispatchState`; `down()` drops `DispatchState` and recreates the five
old tables empty. Dispatch state is ephemeral (`active` / `startedAt`, rebuilt next tick),
so no row copy — worst case a dispatch leg mid-run is re-evaluated on the next tick. The
migration comment records this choice. Timestamp is picked above the current maximum (note:
`add-sambanova-dispatch-state` and `unify-rate-limit-hold` already collide on
`1798000000000` — the new migration must sort strictly after both).

Root TypeORM registration updated: the new `DispatchState` entity added to
`backend/src/app.module.ts`, `backend/src/data-source.ts`, and the `provider-pool` module's
`TypeOrmModule.forFeature([...])`; the five deleted `*DispatchState` entities removed from
all three. A registration/parity test covers this where practical.

**As built:** the generic `FreeDispatchService` (in `provider-pool/`, via a `FreeDispatchModule`)
keeps the shared round-robin dispatch loop (`leastAllocatedModel` + `countTodayDispatchByModel`
+ `findUnrunPuzzleDatesForModel` + `triggerStrategyRuns`) and branches `runTick` on
`dispatch.stop`: `until-held` (google/groq/mistral/sambanova — pacing from `dispatch.pacing`,
shared or dedicated) and `account-budget` (openrouter — self-counted call budget, per-minute
cooldown reschedule). The unified table is `DispatchState`, PK column kept as `id` (holding
the pool id, exactly the old per-table row key) rather than a renamed `pool` column, so the
per-provider specs' `{ id: "<pool>" }` assertions carry over unchanged. The `worker.ts`
free-dispatch worker loop is pulled forward from step 6. Ten per-provider spec files collapse
to one parametrised `free-dispatch.service.spec.ts`.

**Compatibility shims:** the dispatch controller
(`backend/src/modules/dispatch/dispatch.controller.ts`) has five literal route pairs
(`@Get("google")` / `@Delete("google")` …) each injecting a per-provider
`*FreeDispatchService`. Collapsing those routes is `docs/architecture/10`'s job and is out
of scope. To keep the controller — and `daily-automation.service.ts` until step 6 — 
compiling without editing them, step 5 keeps five thin `*FreeDispatchService` classes as
~3-line shims that delegate to the generic `FreeDispatchService` with their pool id. The
fat per-provider tick logic (five copies) still collapses to one implementation; only a
trivial named wrapper survives per provider. The shims are deleted in the
`docs/architecture/10` follow-up when the routes collapse.

The generic `getStatus` / `stop` return types are locked to the existing per-provider
`{P}DispatchStatus` contract (the frontend widgets are untouched). A controller spec pins
each route's response shape so drift fails loud.

### Step 6 — loop the wiring

- `backend/src/worker.ts` — the runs workers become a loop over `PROVIDER_POOLS` (ollama
  stays a separate call — it is the only queue a `role: "ollama"` worker runs, and it runs
  under `role !== "cloud"` rather than `role !== "ollama"`); `createLlmWorker`'s `queueName`
  param widens from the hardcoded 7-member union to `string`, with a local
  `llmConcurrencyByPool` map for the per-provider concurrency knobs (folded into the config
  by step 7). The free-dispatch and rpd-resume worker loops already landed in steps 5 and 4.
- `backend/src/modules/automation/daily-automation.service.ts` — the five hand-written
  `run<P>BurnLeg` methods collapse to one `runPoolBurnLeg(leg, date)` driven by a
  `burnLegs` array in `PROVIDER_POOLS` order. **Deviation:** it iterates the five injected
  shim services rather than being rewired to the generic `FreeDispatchService` directly —
  rewiring would force a full rewrite of `daily-automation.service.spec.ts`'s per-provider
  mocks for no behaviour gain; doc 10 deletes the shims and rewires this at the same time.
  `AutomationRunLog` keeps its per-provider column pairs (Q9); the loop writes them by
  computed key.
- `backend/src/modules/queue/queue.module.ts` — **not changed** in step 6. The
  `*_QUEUE_BY_POOL` map providers added in steps 3–5 are the consumable form; the
  per-provider `<p>-*.queue.ts` one-liners that construct the `Queue` singletons stay as-is
  (generating them in a loop risks the queue-name identity the whole refactor depends on
  for no real gain).

### Step 7 — fold the knob families into the config (candidate 4)

Move the ~28 per-provider accessor functions and ~28 `DEFAULT_*` consts from
`backend/src/strategies.ts` into the provider-pool config as `poolKnobs(pool)` (or inline
on the row). The accessors still read env at call time. `dispatch.pacing: "shared"` keeps
reusing the `FREE_TIER_DISPATCH_*` values; dedicated pacers move onto their rows.

---

## Tests

Characterisation-first. The five near-identical per-provider spec families are the
behaviour contract:

- `*-free-dispatch.service.spec.ts` (5, ~233–247 lines each)
- `*-rpd-resume.service.spec.ts` (5) and `*-rpd-resume.bootstrap.spec.ts` (5)

Keep all of them green against the generic implementation through each swap. Only **after**
the generic impl is landed and green, in a *following* commit, collapse them to one deep
tick/resume spec plus the table-driven `provider-pool.config.spec.ts`. The
`llm-strategy-runner.service.spec.ts` drops its five injected hold-service mocks for one
`ProviderPool` fake.

One e2e added after step 5, `backend/test/provider-pool-dispatch.e2e-spec.ts`: drives a full
`runTick → hold written → runResume → hold cleared` cycle through the generic services.
Cases: groq (self-rearm, model-scope) and openrouter (account-scope, account-budget).
Follows the `app.e2e-spec.ts` pattern — boot `AppModule`, stand up a loopback fake
orchestrator on `:3999` (`ORCHESTRATOR_URL` already resolves there via
`backend/test/setup-env.ts`), have `/solve-assist` return `429 rate_limited_daily`. Zero
real provider spend is structurally guaranteed: `setup-env.ts` forces `REDIS_DB=15` (a
keyspace no real worker reads), no provider API keys are ever set in the test env, and no
worker runs under `AppModule` so the re-enqueued resume job just sits. Assertions are on
`RateLimitHold` rows and `StrategyRun.status` transitions.

Every new migration ships a tested `down()`.

---

## Risks

- **Ternary-to-lookup is not free.** A lookup that returns `null` for a non-pool strategy
  needs the same fall-through the ternaries have today. Cover deterministic / shuffle /
  judge-only strategies explicitly.
- **Never rename a live BullMQ queue.** All 15 names stay as config data; the code goes
  generic around them.
- **OpenRouter is the widest deviation.** Account-scope hold, self-counted call budget,
  per-minute cooldown. `holdScope: "account"` and `dispatch.stop: "account-budget"` are
  first-class in the config, not special-cased in the generic code.
- **Two apps in step 3.** Backend and orchestrator change together but deploy
  independently; the wire contract (error codes) is unchanged. Stated in the PR
  description.
