# Broader model metadata + repeatable pricing refresh — design

## Problem

[SupportedModel](../../../backend/src/modules/supported-model/entities/supported-model.entity.ts)
today only tracks `strategyName`, `modelName`, `supported`, and `freeTier`.
Pricing lives in a separate, append-only
[ModelPrice](../../../backend/src/modules/supported-model/entities/model-price.entity.ts)
table, but every row in it — for every model — has only ever been entered by
hand in a migration. There is no refresh mechanism, so prices silently go
stale, and at least one row is outright fabricated:
[1757000000000-add-mistral-model.ts](../../../backend/src/migrations/1757000000000-add-mistral-model.ts)
gave `mistral` a placeholder price ($0.075/$0.10 per million tokens) that was
never real.

The leaderboard also has nothing to compare models on besides cost, success
rate, and duration —
[StrategyTable.tsx](../../../frontend/src/components/benchmark/StrategyTable.tsx)
has no context window, parameter count, or release-date column, and
[SupportedModelRecord](../../../frontend/src/data/benchmark/types.ts) has no
fields to carry them even if it did.

A related, previously-undiscovered issue surfaced while investigating this:
`MODEL_CONTEXT_WINDOW` is a single flat env var
([orchestrator/src/provider.ts](../../../orchestrator/src/provider.ts)) that
gets passed to Ollama as `num_ctx` regardless of which model is actually
running — so a model with a much larger real context window (e.g.
`mistral-nemo`'s 131,072 tokens) is silently capped at whatever the env var
says (8192 by default). Meanwhile the *reporting* side of this same feature —
`StrategyRun.contextWindow`, both DTOs, and even
[GuessSequencePanel.tsx](../../../frontend/src/components/GuessSequencePanel.tsx)'s
`formatModelDetail` display logic — is fully wired up but dead: nothing in
the current codebase ever writes a non-null value into that column.

## Goals

- Every `SupportedModel` row can carry a context window, a best-effort
  parameter count, and a release date, sourced from a real external API
  rather than hand-entered.
- Pricing becomes repeatable: a scheduled job (plus an on-demand trigger)
  refreshes prices from the same source, rather than only ever changing via
  a new migration.
- The fabricated Mistral pricing is gone — replaced by `mistral-nemo`
  (already switched over, see
  [1769000000000-rename-mistral-to-mistral-nemo.ts](../../../backend/src/migrations/1769000000000-rename-mistral-to-mistral-nemo.ts)),
  which has real, live pricing available from the chosen source.
- A model the source has no data for shows no data (blank) rather than
  stale or invented numbers — refreshing never destroys previously-known-good
  data on a transient miss, but also never fabricates a value it doesn't
  have.
- The leaderboard's per-model description is always built from this live
  metadata instead of hand-written strings that go stale.
- Each running model's *real* context window is used to configure Ollama's
  `num_ctx`, and is recorded on the `StrategyRun` row it actually ran with —
  retiring `MODEL_CONTEXT_WINDOW` as the source of truth (it remains only as
  a fallback default for the provider-less AI Assist path, which has no
  specific `SupportedModel` row to look a context window up from).
- A run's displayed cost always reflects the price actually in effect when
  that run happened, not today's price — a run from before a price change
  keeps showing its old cost even after the price is refreshed.

## Non-goals

- No benchmark/quality scores (MMLU, Arena Elo, etc.) in this pass. Spiked
  three candidate sources (OpenRouter itself, Hugging Face's Open LLM
  Leaderboard, Artificial Analysis) — none clear the "long-term repeatable"
  bar this feature is built around: Artificial Analysis has no public API at
  all; Hugging Face's leaderboard dataset only covers open-weight models
  (would exclude every OpenAI row entirely) and looks frozen since around
  late 2024; LMSYS Chatbot Arena has no official API. Revisit if a real API
  turns up.
- No admin UI for editing model metadata by hand. All mutation continues
  through migrations (for one-time registration/mapping) or the refresh job
  (for anything sourced from OpenRouter).
- No fuzzy/automatic matching between a `SupportedModel` row and an
  OpenRouter model. Mapping is explicit and manual — one column, set once
  per model.
- No fallback pricing source when OpenRouter has no live data for a model
  (validated against the real case: base Mistral 7B has zero live OpenRouter
  endpoints today). The model simply shows no price. A manual-override
  escape hatch was considered and explicitly declined.

## Design

### 1. Data model

Add four nullable columns to `SupportedModel`:

| Column | Type | Meaning |
|---|---|---|
| `openRouterSlug` | text | OpenRouter's model id, e.g. `"openai/gpt-4.1-nano"`. Set manually per model, same place models are already registered. `null` means "not mapped — skip on refresh." |
| `contextWindow` | int | From OpenRouter's `context_length`. |
| `paramCount` | bigint | Best-effort: parsed from the OpenRouter slug/name (e.g. `"8b"` → `8_000_000_000`) or its description text (OpenRouter sometimes states it in prose, e.g. "7.3B parameter model"). `null` when it can't be parsed — expected for most OpenAI rows, since OpenAI doesn't publish parameter counts at all. |
| `metadataUpdatedAt` | timestamptz | Set on every successful refresh match. `null` until the first successful refresh. |
| `releaseDate` | timestamptz | From OpenRouter's `created` (Unix timestamp) — this is the model's real release date, not just when OpenRouter listed it (spot-checked against `gpt-4.1-nano`'s known release date). |

`ModelPrice` is unchanged — still append-only. A refresh that finds a price
different from the current one inserts a new row; it never edits history.

A migration backfills `openRouterSlug` for every currently-registered model
that has a live OpenRouter equivalent (the full mapping is implementation
detail for the plan, not this spec — it depends on checking each of the ~18
registered OpenAI models plus `mistral-nemo` against OpenRouter at
build time).

### 2. Historical cost accuracy

Today, `getLeaderboard` and `getRunHistory`
([strategy.service.ts:555](../../../backend/src/modules/strategy/strategy.service.ts),
[:988-1002](../../../backend/src/modules/strategy/strategy.service.ts)) both
price every run using the model's *current* `ModelPrice` row (highest id) —
a run from before a price change gets silently re-priced at today's rate
every time it's queried. This barely mattered when prices only ever changed
via a rare manual migration; it matters once a daily refresh job is
routinely changing them.

Since `ModelPrice` is already timestamped (`createdAt`) and append-only,
both queries switch from "the highest-id row for this model" to "the
highest-id row for this model whose `createdAt` is ≤ the run's `startedAt`"
— the price actually in effect when the run began. A run's tokens accrue
over its full duration (possibly several prompts/attempts), but runs are
typically seconds to a couple of minutes and prices change at most daily, so
anchoring the whole run to its `startedAt` is precise enough — pricing each
individual `SolvePrompt` call at its own exact timestamp was considered and
rejected as unnecessary complexity for a case this unlikely.

- `getRunHistory`'s correlated `ModelPrice` subquery
  (`strategy.service.ts:988-994`) gains a `"createdAt" <= run."startedAt"`
  condition alongside its existing `ORDER BY id DESC LIMIT 1`.
- `getLeaderboard`'s `rateByModel` (`strategy.service.ts:555`) currently
  resolves one "current rate" per model up front and reuses it across every
  run of that model in the aggregation loop — that has to change to a
  per-run lookup (the same "price as of this run's `startedAt`" query),
  since different runs of the same model can now legitimately have priced
  differently.
- A run whose `startedAt` predates the model's very first `ModelPrice` row
  has no price that was "in effect" yet — it shows no cost (`null`), same as
  a model with no price at all today. This matches the rest of the design's
  "no data beats fake data" principle rather than borrowing a later price
  for it.
- `getRecentRuns` is unaffected — it doesn't compute cost today.

### 3. Refresh service (backend)

- `OpenRouterClient` — thin wrapper around `GET
  https://openrouter.ai/api/v1/models` (public, unauthenticated).
- `ModelMetadataRefreshService.refreshAll()` — for every `SupportedModel` row
  with a non-null `openRouterSlug`: look up the matching OpenRouter entry.
  - Found: update `contextWindow`, `paramCount` (best-effort parse),
    `releaseDate`, `metadataUpdatedAt`; insert a new `ModelPrice` row if the
    price differs from the current one.
  - Not found (slug delisted, typo'd, or the model has zero live endpoints —
    the real Mistral 7B case): log and skip. Existing data on the row is
    left untouched.
- Scheduling follows
  [puzzle-queue.bootstrap.ts](../../../backend/src/modules/game/puzzle-queue.bootstrap.ts)'s
  exact pattern: a new BullMQ queue, an `OnApplicationBootstrap` provider,
  `queue.upsertJobScheduler` for a daily cron (new env var, its own default
  distinct from `PUZZLE_POPULATION_CRON`), skipped when `NODE_ENV=test`.
- Manual trigger: `POST /dispatch/refresh-model-metadata`, guarded by the
  existing `DispatchAuthGuard` like the other admin routes. Calls the
  service directly (not via the queue — it's one fast API call) and returns
  a summary: counts of updated / skipped / errored rows.

### 4. Per-model context window replaces the flat env var

- `OrchestratorService.solveAssist` (backend) gains an optional
  `contextWindow` parameter, sourced from the `SupportedModel` row the
  strategy runner already validated the model against — no new lookup, that
  data is already in hand at call time.
- The orchestrator's `POST /solve-assist` request body carries it through;
  `provider.ts`'s `getModel()` uses it for Ollama's `num_ctx` when present,
  falling back to `MODEL_CONTEXT_WINDOW` (env, default 8192) only when it's
  absent — the provider-less AI Assist path, or an Ollama model that hasn't
  been refreshed/mapped yet.
- The value actually used gets written onto the `StrategyRun` row when the
  run is persisted, finally populating the column that's been dead since it
  was built — `GuessSequencePanel.tsx`'s `"mistral-nemo (131,072 ctx)"`
  display starts working with no frontend changes needed.

### 5. Frontend

- `GET /strategy/models` (`findAll()`) starts returning `contextWindow`,
  `paramCount`, and `releaseDate` on every row.
  `SupportedModelRecord` (types.ts) gains the matching fields.
- `STRATEGY_DEFS`' hardcoded `description` strings for LLM entries
  ([mockData.ts](../../../frontend/src/data/benchmark/mockData.ts)) are
  deleted. `useStrategyMeta`'s `buildDynamicMeta` becomes the single source
  of LLM-row descriptions — it already fetches the live model list; it now
  always does so for `kind === "llm"` rows (not just ones the static catalog
  doesn't recognize), building descriptions like `"OpenAI gpt-4.1-nano ·
  128K context"` or `"Ollama mistral-nemo · 131K context · 12B params"`,
  omitting the params clause when `null`.
- `GET /strategy/leaderboard` gets the same two columns joined into each
  row server-side, so `describeLeaderboardRow` builds its description from
  data already present on the row — no extra per-row fetch on the
  leaderboard table.

### 6. Testing

TDD throughout, per this project's normal workflow:

- `OpenRouterClient`: mocked HTTP, tests for the shape of a successful
  response and a network/non-2xx failure.
- `ModelMetadataRefreshService`: matching, skipping an unmapped/not-found
  slug, inserting a new `ModelPrice` row only when the price actually
  changed, parsing `paramCount` from a slug and from description prose.
- New endpoint: auth-guard behavior (mirrors the other `DispatchAuthGuard`
  routes' existing specs) plus the summary-counts response shape.
- `getRunHistory`/`getLeaderboard`: a run priced correctly against the
  `ModelPrice` row in effect at its `startedAt`, unaffected by a later price
  change; a run predating any price for its model shows `null` cost; two
  runs of the same model priced differently because a price change happened
  between them.
- `provider.ts`: passing an explicit `contextWindow` through to `num_ctx`
  vs. falling back to the env default.
- Frontend: updated `buildDynamicMeta`/`describeLeaderboardRow` description
  strings, including the "params omitted when null" case.
