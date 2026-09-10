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
type HoldScope = "model" | "account";

type ResetSchedule =
  | { kind: "fixed-cron"; pattern: string; tz: string }   // google (00:01 America/Los_Angeles), openrouter (00:05 UTC)
  | { kind: "self-rearm"; maxDelayMs: number };            // groq, mistral, sambanova

type DispatchSpec =
  | { stop: "until-held"; pacing: "shared" | { tickMs: number; maxBatch: number; maxInFlight: number } }
  | { stop: "account-budget"; budget: () => number; callsPerTrial: number; tickMs: number;
      maxBatch: number; maxInFlight: number; rpmCooldownMs: () => number };

interface ProviderPool {
  id: ProviderPoolId;                  // "google" | "groq" | "openrouter" | "mistral" | "sambanova" | "openai" | "ollama"
  label: string;
  strategyName: string;                // "llm-google"
  orchestratorProvider: string;        // "google" — the provider string solver.ts expects
  queues: { runs: string; freeDispatch: string; rpdResume: string };  // existing BullMQ names, verbatim
  freeTier: null | {                   // null for openai / ollama
    holdScope: HoldScope;
    resetSchedule: ResetSchedule;
    dispatch: DispatchSpec;
    rateLimitFallbackSeconds: () => number;
    dailyHoldFallbackSeconds?: () => number;
    classifyExtra?: (state: unknown, outcome: unknown) => HoldDecision | null;  // mistral's consecutive-429 streak escalation
  };
}

export const PROVIDER_POOLS: ProviderPool[] = [ /* google, groq, openrouter, mistral, sambanova, openai, ollama */ ];
```

**Array order** is `google, groq, openrouter, mistral, sambanova` (then `openai`, `ollama`
with `freeTier: null`). This reproduces today's daily-automation burn sequence exactly when
step 6 replaces the hand-written leg calls with a loop. The order is believed incidental,
but it is preserved rather than proven.

**Knob values** (`rateLimitFallbackSeconds`, `dailyHoldFallbackSeconds`, dispatch pacing
numbers, `rpmCooldownMs`, `budget`) are held as `() => number` thunks that reference the
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
| ~481–540 | daily-hold-writing ladder (`if strategyName === LLM_GOOGLE … else if LLM_GROQ …`, plus a separate Mistral `if` gated on `effectiveErrorCode` from the streak heuristic) | one path driven by `holdScope`, `resetSchedule`, `dailyHoldFallbackSeconds`, and `classifyExtra` for the Mistral streak |
| ~804–822 | Mistral-only consecutive-429 escalation branch in `classifyFailedCall` | driven by `classifyExtra` on the pool row |

`backend/src/modules/queue/strategy.queue.ts` — `queueForStrategy` currently takes 8
injected `Queue` params and `if`-chains on `strategyName`. `QueueModule` builds a
`POOL_RUNS_QUEUES: Map<ProviderPoolId, Queue>` provider by mapping `PROVIDER_POOLS` over the
existing per-pool `new Queue(...)` instances. New signature
`queueForStrategy(map, defaultQueue, strategyName)` — one lookup, no `if`-chain.
`queueForJudgeProvider` is untouched.

`orchestrator/src/solver.ts` — `classifyModelCallError` has five
`if (provider === "<p>" && … statusCode === 429)` blocks (~317–498). Replace with
`const CLASSIFY_429: Record<ModelProvider, Classify429>` keyed by the orchestrator's own
`ModelProvider` type, so TS exhaustiveness catches a missing provider. This is
**orchestrator-local** — no shared config with the backend. Only the result codes
(`rate_limited` / `rate_limited_daily` + reset seconds) cross the wire, and those are
unchanged, so backend and orchestrator deploy independently in any order. The PR
description states this so no lockstep rollout is assumed.

### Step 4 — unify `RpdResumeService`

One generic `RpdResumeService` in `provider-pool/` with `runResume(poolId, jobId)`.
Scheduling driven by `resetSchedule`: `fixed-cron` registers a job scheduler in the
bootstrap; `self-rearm` enqueues one startup catch-up and re-arms from
`RateLimitHoldService.nextResetAt()`.

Delete the five `*-rpd-resume.service.ts` + five `*-rpd-resume.bootstrap.ts` from
`backend/src/modules/strategy/` → one service + one bootstrap. Keep the five
`<p>-rpd-resume` BullMQ queue names as config data (renaming a live queue orphans in-flight
jobs).

**Behaviour drift:** normalise cosmetic drift — the resume log wording (Groq logs
`"RPD hold set"`, Mistral logs `"hold set"`) becomes one string. Preserve functional drift
as an explicit config axis — Google stamps resume job-ids with `pacificDateStamp()`, the
others use the trigger job-id; this feeds resume dedup, so it is modelled, not flattened.
Any functional normalisation is called out in the commit body.

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

- `backend/src/worker.ts` — replace the ~10 hand-listed worker blocks with a loop over
  `PROVIDER_POOLS`, registering three workers (runs, free-dispatch, rpd-resume) per pool
  with `freeTier != null`. `createLlmWorker`'s `queueName` param widens from a hardcoded
  7-member union to `string`; the queue-name-parity test plus `providerPoolOrThrow` in the
  loop cover the lost compile-time check.
- `backend/src/modules/automation/daily-automation.service.ts` — replace the five
  hand-written `run<P>BurnLeg` calls with a loop in `PROVIDER_POOLS` order, calling the
  generic `FreeDispatchService` (drops the shim use here). `AutomationRunLog` keeps its
  per-provider column pairs; only the code loops.
- `backend/src/modules/queue/queue.module.ts` — generate the three queues per free-tier
  pool rather than hand-listing them.

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
