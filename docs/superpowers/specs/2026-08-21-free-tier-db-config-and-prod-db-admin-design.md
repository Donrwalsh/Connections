# Free-tier config in the DB, and a prod DB admin GUI — design

## Problem

Two related gaps:

1. The free-tier program lists (which OpenAI models count as "flagship" vs.
   "mini," and each tier's daily token budget) are hardcoded TypeScript
   constants in
   [free-tier-usage.service.ts](../../../backend/src/modules/strategy/free-tier-usage.service.ts).
   Adding, removing, or re-tiering a model requires a code change and a
   redeploy.
2. There is no way to browse or hand-edit the production database. The
   deployed stack (`docker-compose.prod.yml`) doesn't publish the Postgres
   port, and there's no admin GUI in front of it — only Bull Board for
   queues.

## Audit: other hardcoded-config candidates

Surveyed for other data that would make more sense DB-backed. Two things
looked like candidates and were rejected:

- **LLM tuning knobs** in
  [strategies.ts](../../../backend/src/strategies.ts) (trial counts, retry
  caps, temperature, concurrency) — already externalized as env vars
  (`SHUFFLE_TRIALS`, `LLM_MAX_DUPLICATE_GUESSES`, etc.), which is the right
  level for deploy-time tuning knobs. Moving them to the DB wouldn't add
  capability, just a second config mechanism.
- **`STRATEGY_DEFS`** in
  [mockData.ts](../../../frontend/src/data/benchmark/mockData.ts) — the
  frontend's static strategy/model name+description catalog. Its own header
  comment already documents this as UI copy, not data (the backend has no
  general "strategy catalog"; every numeric value is fetched live). Not a
  real candidate.

Nothing else in the backend held onto a hardcoded list shaped like the
free-tier program lists (multiple named items with real attributes,
requiring redeploy to change) — `SupportedModel` already solved that problem
for the model allowlist itself.

## Goals

- Free-tier model membership becomes editable without a code change or
  redeploy.
- Production data (including the newly-editable free-tier column) becomes
  reviewable and hand-editable without shelling into the DB container.
- Minimal new schema: reuse the existing `SupportedModel` table rather than
  introduce a new one.

## Non-goals

- No new backend write endpoints for free-tier config — editing happens
  directly in the DB via the new admin GUI (see below), same trust level as
  hand-editing any other table.
- No change to the free-tier *tier* concept itself — `flagship`/`mini`
  remain a fixed two-value TypeScript union. Adding a third tier is still a
  code change; only each tier's model membership moves to data.
- No Basic-Auth (or other) gate in front of the new DB admin GUI beyond its
  own DB-credential login — a deliberate simplification, not an oversight
  (see "Security note" below).
- No change to local dev (`docker-compose.yml`) — it already publishes
  Postgres's port directly, so any local DB client already works there.

## Design

### 1. `SupportedModel.freeTier` column

Add a nullable `freeTier: text` column to the existing
[SupportedModel entity](../../../backend/src/modules/supported-model/entities/supported-model.entity.ts)
(values `'flagship'`, `'mini'`, or `null` — plain text, no DB enum, matching
how `strategyName`/`modelName` are already modeled on this table). This
column describes the model itself, not the `(strategyName, modelName)` pair
the table is keyed on — a minor grain mismatch worth naming, but harmless in
practice since no model in this dataset is configured under more than one
strategy today.

`dailyLimitTokens` and `label` stay as a small code constant,
`FREE_TIER_LIMITS: Record<FreeTierId, { label: string; dailyLimitTokens:
number }>`, replacing `FLAGSHIP_FREE_TIER`/`MINI_FREE_TIER`/
`FREE_TIER_PROGRAMS`. These are tier-level, not model-level, so they have no
natural column on a model-keyed table, and as two stable numbers they don't
need DB flexibility the way an open-ended model list does.

### 2. Migration

One migration (same style as
[1760000000000-add-openai-mini-models.ts](../../../backend/src/migrations/1760000000000-add-openai-mini-models.ts)):

- `ALTER TABLE "SupportedModel" ADD COLUMN "freeTier" text NULL`.
- Backfill: `UPDATE` the 8 current flagship models
  (`gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-4.1`, `gpt-4o`, `o1`, `o3`)
  to `freeTier = 'flagship'`, and the 9 current mini models
  (`gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-mini`, `gpt-4.1-mini`,
  `gpt-4.1-nano`, `gpt-4o-mini`, `o3-mini`, `o4-mini`, `gpt-5-nano`) to
  `freeTier = 'mini'`.
- `down()` drops the column.

Behavior is identical the moment this deploys. From then on, changing a
model's tier (or adding a newly-launched model to one) is a direct edit to
this column via the new admin GUI — not a migration, not a code change.

### 3. Service changes

- `SupportedModelService` gets one new method,
  `findModelNamesByFreeTier(tier: FreeTierId): Promise<string[]>` — it
  already owns all reads of this table, so this is the natural home rather
  than another module querying the repo directly.
- `FreeTierUsageService.getUsage(tier)`: replaces the `FREE_TIER_PROGRAMS[tier]`
  lookup with `FREE_TIER_LIMITS[tier]` (label/dailyLimitTokens) plus
  `await supportedModelService.findModelNamesByFreeTier(tier)` (models). The
  returned `FreeTierUsageDto` shape is unchanged — no frontend impact.
- `FreeTierDispatchService.runTick`: already fetches the full `usage` DTO
  near the top of the method — every remaining `program.models` /
  `program.dailyLimitTokens` reference becomes `usage.models` /
  `usage.dailyLimitTokens` instead. The `FREE_TIER_PROGRAMS` import is
  deleted; no new injection is needed in this service.
- `FLAGSHIP_FREE_TIER`, `MINI_FREE_TIER`, `FREE_TIER_PROGRAMS`, and the
  `FreeTierProgram` interface's `models` field are deleted from
  `free-tier-usage.service.ts`.

### 4. Adminer for production DB access

Add an `adminer` service to
[docker-compose.prod.yml](../../../docker-compose.prod.yml):

```yaml
adminer:
  image: adminer:latest
  container_name: adminer
  restart: unless-stopped
  environment:
    ADMINER_DEFAULT_SERVER: db
  ports:
    - "8091:8080"
  depends_on:
    db:
      condition: service_healthy
```

`ADMINER_DEFAULT_SERVER=db` prefills the server field with the login form
(Adminer still requires the real Postgres user/password to get in — nothing
is auto-authenticated). No new env vars are required; it reuses
`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` already in `.env`.

**Security note:** unlike Bull Board (`/admin/queues`, gated by
`BULL_BOARD_USER`/`BULL_BOARD_PASS` Basic Auth before Adminer's own form is
even reachable), Adminer runs as its own container (PHP, not Node), so it
can't be mounted into the existing Nest Basic-Auth middleware the way Bull
Board is. Per explicit choice, this design relies solely on Adminer's own
DB-credential form — publishing its port makes that login form reachable by
anyone with the URL, though real access still requires the Postgres
password. Treat `POSTGRES_PASSWORD` as the actual gate here, and prefer not
publishing this port on a host without other network-level protection
(matches the existing "Reachability" caution already in `README.md` for the
`db`/`redis` ports).

### 5. README

Add `adminer` to the service table (mirroring the existing Bull Board row)
and a line in the URLs table:

```
| `http://localhost:8091` | Adminer (production DB browser — log in with your Postgres credentials) |
```

## Testing

- `SupportedModelService.findModelNamesByFreeTier` — unit test (returns only
  matching-tier model names, empty array when none configured).
- `FreeTierUsageService.getUsage` — existing spec updated to mock
  `SupportedModelService` instead of the deleted const; assert the returned
  DTO shape is unchanged.
- `FreeTierDispatchService` — existing spec updated to source
  `models`/`dailyLimitTokens` from the mocked `usage` DTO instead of the
  deleted `FREE_TIER_PROGRAMS` const; no behavioral test changes expected
  since the dispatch logic itself doesn't change.
- Migration: up/down check (column added and backfilled; column dropped on
  revert), following the existing migration test conventions in this repo.
- No frontend changes and no frontend tests — nothing here is user-facing.

## Files touched

- `backend/src/modules/supported-model/entities/supported-model.entity.ts`
  (new column)
- `backend/src/modules/supported-model/supported-model.service.ts` (new
  method), `supported-model.service.spec.ts`
- `backend/src/modules/strategy/free-tier-usage.service.ts` (delete consts,
  add `FREE_TIER_LIMITS`, rewrite `getUsage`), `free-tier-usage.service.spec.ts`
- `backend/src/modules/free-tier-dispatch/free-tier-dispatch.service.ts`
  (swap `program.*` for `usage.*`, drop import),
  `free-tier-dispatch.service.spec.ts`
- `backend/src/migrations/` (new migration file)
- `docker-compose.prod.yml` (new `adminer` service)
- `README.md` (service table, URLs table)
