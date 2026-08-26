# Google AI Studio support — design

## Problem

The app currently supports two LLM providers for solving Connections puzzles:
OpenAI (`llm-openai`, cloud, paid) and Ollama (`llm-ollama`, local, free but
requires hardware to run models). There's no free cloud-hosted option, and
Google AI Studio offers exactly that — a free tier (Gemini models, generous
per-day/per-minute quotas, no billing required) that's well suited to
evaluating additional models on this puzzle without local hardware.

## Goals

- A new `llm-google` strategy, given the same full treatment as `llm-openai`
  and `llm-ollama`: dispatchable benchmark runs, its own BullMQ queue and
  concurrency setting, leaderboard entries, per-run guess history.
- Two initial models registered: `gemini-2.5-flash` and
  `gemini-2.5-flash-lite` — both confirmed live on OpenRouter (see Data model
  below), giving them real context window, pricing, and provider description
  from day one via the existing OpenRouter metadata refresh
  ([2026-08-26-model-metadata-refresh-design.md](2026-08-26-model-metadata-refresh-design.md)),
  rather than a hand-entered, eventually-stale `ModelPrice` row.
- `MODEL_PROVIDER=google` also selectable for the provider-less AI Assist
  path (`/diagnose`), for consistency with `openai`/`ollama` — the
  orchestrator's `getModel`/`getModelName` need a google branch regardless,
  so exposing it there too is free.

## Non-goals

- No automated free-tier usage tracking or dispatch for Google. Google's
  free tier is rate/request-based (RPM, RPD, TPM per model) rather than
  OpenAI's flat daily-token-pool that `FreeTierUsageService`/
  `FreeTierDispatchService` are built around — modeling it properly is a
  separate, later effort. `SupportedModel.freeTier` stays `null` for both
  Gemini rows; runs are dispatched by hand like `llm-openai`/`llm-ollama`
  are today. If Google's own API rejects a call for exceeding the free
  tier, that surfaces as an ordinary `model_error` through the ordinary
  retry/backoff path.
- No Vertex AI / GCP service-account auth. Google AI Studio's own API key
  (`generativelanguage.googleapis.com`, via `@ai-sdk/google`) only.
- No additional Gemini models beyond the two chosen here. More can be added
  the same way `1760000000000-add-openai-mini-models.ts` added OpenAI's
  mini tier — a follow-up migration, not part of this pass.

## Design

### 1. Orchestrator (`orchestrator/src`)

- Add `@ai-sdk/google` to `orchestrator/package.json`.
- `provider.ts`: `ModelProvider` gains `"google"`. New
  `DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash"`. `getModel()` gains a google
  branch using `createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })`;
  it accepts the existing `contextWindow` parameter for signature
  consistency but doesn't use it — Gemini has no `num_ctx`-equivalent
  per-call setting (that parameter exists for Ollama only).
  `getModelName()` gains the matching branch.
  `defaultProvider()`'s env parsing (`MODEL_PROVIDER`) gains `"google"` as
  a third recognized value.
- `types.ts`: `provider` field in `SolveAssistRequestSchema` gains
  `"google"` in its enum.

### 2. Backend — strategy/queue wiring

- `strategies.ts`: `SUPPORTED_STRATEGIES` gains `"llm-google"`; new
  `LLM_GOOGLE = "llm-google"` const; `LLM_STRATEGIES` gains it (so
  `isLlmStrategy`/`AUTOMATIC_STRATEGIES` exclusion pick it up for free);
  new `DEFAULT_LLM_GOOGLE_CONCURRENCY = 1` + `llmGoogleConcurrency()`,
  mirroring the OpenAI/Ollama constants and functions exactly.
- `llm-strategy-runner.service.ts`: provider resolution becomes
  `strategyName === LLM_OLLAMA ? "ollama" : strategyName === LLM_GOOGLE ? "google" : "openai"`.
- `orchestrator.service.ts`: `solveAssist`'s `provider` parameter type
  gains `"google"`.
- `worker.ts`: new `llm-google-runs` queue, created via `createLlmWorker`
  in the `role !== "ollama"` branch alongside `llm-openai-runs` — Google is
  cloud-hosted like OpenAI, so it belongs with the "cloud" queues, not
  gated behind the Ollama-only worker role. Own concurrency
  (`llmGoogleConcurrency()`), so Google runs never block OpenAI or Ollama
  runs and vice versa.

### 3. Data model

Both models are confirmed live on OpenRouter (checked via
`GET https://openrouter.ai/api/v1/models/{slug}/endpoints` — non-empty
`endpoints` array with real pricing, per this repo's existing
never-guess-a-slug policy):

| Model | OpenRouter slug | Context | Pricing (Google AI Studio standard tier) |
|---|---|---|---|
| `gemini-2.5-flash` | `google/gemini-2.5-flash` | 1,048,576 | $0.30 / $2.50 per 1M tokens (in/out) |
| `gemini-2.5-flash-lite` | `google/gemini-2.5-flash-lite` | 1,048,576 | $0.10 / $0.40 per 1M tokens (in/out) |

A new migration inserts two `SupportedModel` rows:
`('llm-google', 'gemini-2.5-flash', true)` and
`('llm-google', 'gemini-2.5-flash-lite', true)`, both with `freeTier: null`
and `openRouterSlug` set to the slugs above. It does **not** hand-insert a
`ModelPrice` row — unlike the original OpenAI migrations (which predate the
metadata refresh), these two are mapped from the start, so
`ModelMetadataRefreshService` populates `contextWindow`, `paramCount`,
`providerDescription`, `releaseDate`, and the first `ModelPrice` row itself,
the same way it does for every other mapped model. Until that first refresh
runs (daily cron, or an on-demand `POST /dispatch/refresh-model-metadata`
right after this migration deploys), these two rows show no price/context —
consistent with the metadata-refresh design's "no data beats fake data"
rule. **Deploy note:** trigger the manual refresh endpoint once after this
migration ships, so the models aren't left blank until the next cron tick.

### 4. Frontend

Four hardcoded provider-label spots need a third case for `"llm-google"`,
each currently a 2-way `"llm-ollama" ? "Ollama" : "OpenAI"` (or equivalent)
check:

- `frontend/src/components/GuessSequencePanel.tsx` — the `STRATEGIES`
  filter-tab list (add `{ id: "llm-google", label: "LLM · Google" }`) and
  `formatStrategyName()`.
- `frontend/src/data/benchmark/mockData.ts` and
  `frontend/src/data/benchmark/useStrategyMeta.ts` — both have a
  `providerLabel` ternary that resolves a strategy row's display label;
  each becomes a 3-way switch (`"llm-ollama"` → `"Ollama"`, `"llm-google"` →
  `"Google"`, else `"OpenAI"`).

No other frontend change is needed — model dropdowns and the leaderboard
already source their model list from `GET /strategy/models`, and
`formatModelStats.ts`'s description builder is provider-agnostic (it takes
`providerLabel` as a parameter rather than deriving it itself).

### 5. Config

- `.env.sample`: new `GOOGLE_API_KEY` (secret, orchestrator-side, parallel
  to `OPENAI_API_KEY`), `GOOGLE_MODEL` doc entry (default
  `gemini-2.5-flash`, used by the provider-less AI Assist path when
  `MODEL_PROVIDER=google`), `LLM_GOOGLE_CONCURRENCY=1`. `MODEL_PROVIDER`'s
  existing doc comment gains `google` as a third option.
- `docker-compose.yml`: `GOOGLE_API_KEY: ${GOOGLE_API_KEY}` added to the
  `ai_orchestrator` service's environment, alongside `OPENAI_API_KEY`.

### 6. Testing

TDD throughout, per this repo's normal workflow:

- `orchestrator/src/provider.test.ts`: `getModel`/`getModelName` google
  branch — model resolution (override vs. `GOOGLE_MODEL` env vs.
  `DEFAULT_GOOGLE_MODEL`), api key wiring, and that `contextWindow` is
  accepted but has no effect for this provider.
- `backend/src/strategies.spec.ts`: `llmGoogleConcurrency()` default and
  env-override behavior, `isLlmStrategy("llm-google")`.
- `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`:
  provider resolution maps `"llm-google"` to `"google"`.
- Migration: up/down against a real database (this repo's existing
  convention — migrations aren't unit-tested).
- Frontend: `formatStrategyName`/`providerLabel` 3-way cases in the
  existing test files for `GuessSequencePanel.tsx`, `mockData.ts`, and
  `useStrategyMeta.ts`.
