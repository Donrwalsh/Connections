# Model-Name Collision Disambiguation — Design

## Problem

PR #76 seeds NVIDIA NIM's model batch, including `openai/gpt-oss-20b` — a model that already exists under Groq (`1781000000000-add-groq-models.ts`). `SupportedModel` is uniquely keyed on `(strategyName, modelName)`, not `modelName` alone, so both rows are legal at the DB level and the dispatch/queue/orchestrator pipeline (which threads `strategyName` end-to-end) has no ambiguity at all. The ambiguity lives entirely in three places that key off bare `modelName`:

1. `SupportedModelService.resolveSupportedStrategy(modelName)` (`backend/src/modules/supported-model/supported-model.service.ts:86-101`) — already throws `BadRequestException` on >1 match. Used by the two admin-only `POST /dispatch/model/:modelName/*` routes.
2. `strategy-read.service.ts:562` — leaderboard row `id: acc.modelName ?? acc.strategyName` collapses Groq's and NVIDIA's `openai/gpt-oss-20b` rows onto the same `id`.
3. `frontend/src/data/benchmark/useStrategyMeta.ts:63` and `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx:64` — both do an unguarded `.find()` over a bulk-fetched list, silently picking whichever row sorts first.

This doc captures the decisions reached via an interview process (`/grill-me`) before implementation, so the plan executes against a settled design.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Fix now or fast-follow? | Fixed on `feature/nvidia-nim-provider` (PR #76) before merge. |
| 2 | Public identity scheme | Tiebreaker-only: `SupportedModel` stays keyed on `(strategyName, modelName)`; the ~30 non-colliding models get zero behavioral/URL change. Disambiguation only activates where a `modelName` actually has >1 `supported` row. |
| 3 | Admin dispatch routes (`POST /dispatch/model/:modelName/*`) | Untouched. They already fail closed via `resolveSupportedStrategy`, and have no in-repo caller (manual/curl tools with an unambiguous strategy-explicit alternative). |
| 4 | Visual distinction elsewhere | Reuse the existing `ProviderPill`/`providerPools.ts` label pattern already used on the leaderboard table, rather than inventing a new one. |
| 5/8 | URL scheme for a qualified model+provider reference | See "Routing correction" below — settled as a `?strategy=` query parameter, not a path segment. |
| 6 | Where ambiguity is enforced | The backend is the authority: a dedicated endpoint (reusing `resolveSupportedStrategy`) is what the frontend calls to resolve a bare `modelName`; it throws when there isn't a single answer. Not a purely client-side check. |
| 7 | Ambiguous-landing UI | A simple inline widget on the same page listing candidate providers (via `ProviderPill`), not a redirect or a new UI pattern. |
| 9 | Which row-clicks use the qualifier | Only rows whose `modelName` is currently duplicated in the table's own data use the qualified URL; every other row's URL is byte-for-byte unchanged. This must be computed live from data (a count, not a hardcoded list) so a *future* provider colliding with an existing model name needs zero code changes — only the seed migration adding its `SupportedModel` rows. |

## Routing correction (found during plan-time file review)

Q8 settled on two independent path segments, `/leaderboard/:strategyName/:modelName`, reasoning that real `modelName` values already contain both `/` and `:` (e.g. `openai/gpt-oss-20b`, `nvidia/nemotron-3-super-120b-a12b:free`), so no single joining character is safe for a compound string.

Reading the actual route table (`frontend/src/App.tsx:47-62`) surfaced a problem with that literal shape: `/leaderboard/:strategyId/:puzzleId` (`PuzzleRunsPage`) is *also* a 2-segment path under `/leaderboard`. React Router can't distinguish a qualified model URL (`/leaderboard/llm-nvidia/openai%2Fgpt-oss-20b`) from a puzzle-drill-down URL (`/leaderboard/openai%2Fgpt-oss-20b/482`) by segment count alone — the two route shapes collide.

Resolution: keep `modelName` exactly where it already lives (the existing `:strategyId` path segment, unencoded via `encodeURIComponent` as today), and carry the disambiguating `strategyName` as a `?strategy=` query parameter instead of a second path segment. This preserves everything Q8 was actually optimizing for — no delimiter safety problem (the two pieces of data are never concatenated), zero URL change for the ~30 unique models, the backend as the resolution authority — while avoiding the route collision entirely and requiring no new route registrations (`App.tsx` is unchanged).

Example: clicking NVIDIA's `openai/gpt-oss-20b` row navigates to `/leaderboard/openai%2Fgpt-oss-20b?strategy=llm-nvidia`; Groq's row navigates to `/leaderboard/openai%2Fgpt-oss-20b?strategy=llm-groq`; every other model's row navigates to `/leaderboard/<modelName>` exactly as it does today.

## API surface added

One new read-only endpoint, reusing existing logic verbatim:

```
GET /strategy/models/:modelName/strategy
→ 200 { modelName, strategyName }          (exactly one supported match)
→ 400 { message: "Model '<name>' is ambiguous — ..." }   (>1 supported match)
→ 400 { message: "Model '<name>' is not a supported model." }  (0 matches)
```

Implemented as a thin controller method on `StrategyController` calling `SupportedModelService.resolveSupportedStrategy` — no service-layer change, since that method is already fully unit-tested and already throws exactly the error shape needed.

## Frontend resolution flow

`useStrategyMeta(strategyId, strategyQualifier)`:
- **Qualifier present** (`?strategy=` in the URL): directly matches the already-fetched `SupportedModel` list on `(modelName, strategyName)` — no backend round-trip beyond the existing bulk fetch, since the caller already named an exact provider.
- **No qualifier**: calls the new resolve endpoint. On success, resolves normally (identical behavior to today for every unique model). On the backend's rejection, falls back to the already-fetched bulk list to compute the actual candidate rows (filtered `modelName` + `supported: true`) for display — the thrown error's role is purely to be the authority on "ambiguous or not," not to carry structured candidate data.

This means every dynamic (non-static-catalog) model page now makes one extra small GET beyond today's single bulk fetch, even for unique models. That's a deliberate trade: satisfies "the backend throws," and avoids maintaining two independent implementations of the ambiguity check (one server-side, one client-side) that could drift apart over time. Traffic on this internal benchmarking dashboard is low enough that the extra round-trip is not a concern.

## Non-goals

- No change to `SupportedModel`'s schema, uniqueness constraint, or the `strategy-read.service.ts:562` leaderboard row `id` field — Q2's tiebreaker decision means the existing `id` (bare `modelName` for LLM rows) keeps working as the primary key for the ~30 unique models exactly as today.
- No change to the two admin `POST /dispatch/model/:modelName/*` routes (Q3).
- No new frontend test infrastructure — this codebase has vitest configured but zero existing frontend test files; new frontend changes are verified by type-check + manual browser check, matching current practice, not by introducing a first test suite unprompted.
