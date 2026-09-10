# Unified RateLimitHold — implementation notes

**Source:** written during the implementation session that acted on
`docs/architecture/02-unified-rate-limit-hold.html` (architecture deepening
candidate 2). This is the implementation record, not a Superpowers spec — it
does not live under `docs/superpowers/specs/`. Design decisions here were
settled in a grilling session before any code was written.

**Scope:** candidate 2 only. This unifies the five per-provider rate-limit
hold entities/services into one table and one service. It deliberately does
**not** add a `pool` column, merge the `*DispatchState` tables, collapse the
`*-free-dispatch` / `*-rpd-resume` / `*-bootstrap` / queue files, or introduce
pool-config-driven `holdScope` — those belong to candidates 1, 3, 4 and 11,
which build on top of this.

## What changed

### New

- `backend/src/modules/strategy/entities/rate-limit-hold.entity.ts` — one
  `RateLimitHold` table. `strategyName` discriminates the provider.
  `modelName` is nullable: a `NULL` modelName is an account-wide hold
  (OpenRouter). `reason` is nullable text (`'daily'` / `'per-minute-cooldown'`
  for OpenRouter, `NULL` for the per-model providers). `heldAt` is written but
  never read — kept for forensics.
- `backend/src/modules/strategy/rate-limit-hold.service.ts` —
  `RateLimitHoldService`, the single hold store.
- `backend/src/modules/strategy/rate-limit-reset-time.ts` — the Pacific- and
  UTC-midnight reset-clock helpers (`nextPacificMidnight`, `pacificDateStamp`,
  `secondsUntilNextUtcMidnight`), moved verbatim out of the two deleted hold
  services that used to export them.
- `backend/src/migrations/1798000000000-unify-rate-limit-hold.ts`.
- `backend/test/rate-limit-hold.e2e-spec.ts` — proves the uniqueness
  guarantees against real Postgres (unit tests use a mock repository and
  cannot).

### Deleted

- `entities/{google,groq,openrouter,mistral,sambanova}-rate-limit-hold.entity.ts`
- `{google,groq,openrouter,mistral,sambanova}-rate-limit-hold.service.ts` and
  their `.service.spec.ts` (collapsed into
  `rate-limit-hold.service.spec.ts`).

### Rewired

- `LlmStrategyRunner` injects one `RateLimitHoldService`. The per-`strategyName`
  branch survives, but only to derive `resetInSeconds` before calling
  `hold()` (Pacific-midnight delta for Google, `dailyResetSeconds ?? fallback`
  for Groq and SambaNova, a fixed fallback for Mistral, `daily` /
  `per-minute-cooldown` for OpenRouter), and to keep the per-model vs
  account-wide distinction in the top-gate.
- The four per-model `*-rpd-resume` services and the four per-model
  `*-free-dispatch` services inject the unified service. The sweeps call
  `clearExpired(strategyName)` and read `{ clearedModels }`.
- `openrouter-rpd-resume` and `openrouter-free-dispatch` pass `LLM_OPENROUTER`
  explicitly to `isHeld` / `heldReason` / `nextResetAt`; the sweep reads
  `{ clearedAccountWide }`.
- Root TypeORM registration (`app.module.ts`, `data-source.ts`) and
  `strategy.module.ts` `forFeature` / providers / exports collapsed 5 → 1.

## Service contract

| method | behaviour |
| --- | --- |
| `hold(strategyName, { modelName?, reason?, resetInSeconds })` | upsert; conflict target is `(strategyName, modelName)` when `modelName` is set, otherwise the partial index `(strategyName) WHERE modelName IS NULL`. A `per-minute-cooldown` request is a no-op while a live `daily` hold exists; this branch is `reason`-gated so per-model callers never reach it. |
| `isHeld(strategyName, modelName?)` | `modelName` given → that row is live; omitted → the account-wide row is live. |
| `heldReason(strategyName)` | the live account-wide row's `reason`, or `null`. |
| `heldModels(strategyName)` | non-null model names with a live hold; `[]` for an account-wide strategy. |
| `nextResetAt(strategyName)` | soonest still-future `resetAt` across model and account rows, or `null`. |
| `clearExpired(strategyName?)` | deletes elapsed rows for one strategy, or all pools when omitted; returns `{ clearedModels: string[]; clearedAccountWide: boolean }`. |

## Schema and uniqueness

- `UQ_RateLimitHold_strategy_model` — composite `UNIQUE (strategyName, modelName)`,
  covers per-model rows.
- `UQ_RateLimitHold_strategy_account` — partial `UNIQUE (strategyName) WHERE
  modelName IS NULL`. Needed because Postgres treats `NULL`s as distinct in a
  b-tree unique index, so the composite constraint alone does not stop two
  account-wide rows for one strategy.
- `IDX_RateLimitHold_strategy_resetAt` — `(strategyName, resetAt)`, matches
  every scoped read.
- `IDX_RateLimitHold_resetAt` — `(resetAt)`, for the all-pools `clearExpired()`
  sweep.

## Migration

`up` creates the table, the four indexes and both unique constraints, copies
live rows from all five legacy tables (`INSERT … SELECT`; OpenRouter's absent
`modelName` maps to `NULL` and its `reason` carries across; the four per-model
tables get `reason = NULL`), then drops the five legacy tables.

`down` recreates the five legacy tables with their original DDL, copies rows
back partitioned by `strategyName` (per-model tables) and by `modelName IS
NULL` (OpenRouter), then drops `RateLimitHold`. Live holds are transient
(they expire within ~24h), but the copy is cheap insurance against reviving a
parked run early into a doomed provider call.

## Verification

`npm test` (706 unit tests), `npm run test:e2e` (52 tests, both suites) and
`npm run lint` all pass locally against the `connections-dev` Postgres/Redis
stack.
