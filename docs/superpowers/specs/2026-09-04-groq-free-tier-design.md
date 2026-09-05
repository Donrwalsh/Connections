# Groq free-tier support

## Problem

The repo burns two providers' free quotas every day — OpenAI's token-budgeted
**mini/nano** tier (`FreeTierDispatchService`) and **Google AI Studio's**
requests-per-day quota (`GoogleFreeDispatchService` + the RPD-hold/resume
machinery). Groq (GroqCloud, `api.groq.com`) is a third provider whose free
tier is especially attractive for this workload: no credit card, extremely
high inference throughput (280–1,000 tokens/s on LPU hardware), and an
OpenAI-compatible API. But nothing in the app can call Groq today:

- The orchestrator's `ModelProvider` union is `"openai" | "ollama" |
  "google"` (`orchestrator/src/provider.ts`), with no Groq branch in `getModel`
  / `getModelName` / `defaultProvider`.
- The backend strategy list (`SUPPORTED_STRATEGIES`) and per-provider queues
  have no `llm-groq` strategy.
- There is no `llm-groq` model registered in `SupportedModel`, no dispatch
  cycle for Groq's free quota, and no free-tier summary row for it.

Two things make Groq notably different from the two providers already wired
up, which is exactly why this deserves its own spec:

1. **Rate limits, not a token budget.** Groq's free tier is governed by
   org-level **per-model** rate limits (RPM/RPD/TPM/TPD) that reset daily —
   there is no pool of "free tokens" to measure against a percentage. That is
   the Google model (`dispatch until every model is RPD-held`), not the OpenAI
   model (`burn toward a % of a daily token budget`). See "Which existing
   pattern" below.
2. **Open-router metadata is misleading for pricing.** These are open-weight
   models hosted by many providers, and OpenRouter's list-level price is the
   *minimum* across endpoints — not Groq's rate. The existing
   `ModelMetadataRefreshService` would therefore show the wrong cost for every
   Groq model unless we scope pricing to Groq's endpoint.

## Goals

1. Register a set of `llm-groq` models in `SupportedModel` (via migration,
   per repo convention) with live-verified OpenRouter slugs and Groq-accurate
   pricing.
2. Add Groq as a first-class inference provider in the orchestrator so
   `llm-groq` strategy runs and judge calls can target it.
3. Add a free-tier dispatch cycle for Groq's daily quota in the style of
   `GoogleFreeDispatchService`: a self-chaining tick that dispatches `llm-groq`
   trials on unrun puzzles until every Groq model is daily-held or the unrun
   backlog dries up.
4. Fold that cycle into the existing daily automation chain as a fourth leg
   (`groqBurn`), surfaced in the Activity page alongside the Google widget.
5. Handle Groq 429s the same way Google's are: per-minute throttles are
   retried with the server-provided wait; daily-quota hits park the run and
   set a hold that a resume sweep lifts after the daily window resets.

## Non-goals

- Changing the OpenAI `FreeTierDispatchService` token-budget accounting or its
  `flagship`/`mini` `freeTier` column semantics. Groq models get `freeTier =
  NULL` and are consumed via the strategy-based burn (like Google models), not
  the OpenAI token tiers.
- Changing `GoogleFreeDispatchService`'s behavior. This spec *generalizes the
  shared RPD hold/resume machinery* so it can serve both `llm-google` and
  `llm-groq`, but the Google burn cycle itself is untouched.
- Routing Groq calls through OpenRouter. We call `api.groq.com` directly via
  `@ai-sdk/groq`; OpenRouter is used only for read-only metadata (context
  window, pricing — see the pricing scoping work below).
- Whisper (speech-to-text), `groq/compound*` agentic systems, or any
  non-text-chat Groq offering. This is a text-solving workload only.

## Design

### Which existing pattern: Google

Groq's free tier is a set of daily, per-model request caps, exactly like
Google AI Studio. There is nothing to express as "X% of a daily token budget",
so `GoogleFreeDispatchService` is the template for the new
`GroqFreeDispatchService`, and the Google RPD-hold flow is the template for
Groq's 429 handling. We reuse the existing `FREE_TIER_DISPATCH_*` pacing knobs
(`freeTierDispatchTickMs` / `MaxBatch` / `MaxInFlight`) rather than minting a
parallel env family, matching the decision the Google service already made.

### Models to register

All rows go under `strategyName = 'llm-groq'`, `supported = true`,
`freeTier = NULL`. `modelName` must be Groq's **own** model id (that is what
`modelOverride` sends to the API); `openRouterSlug` is a separate column used
only for metadata.

| `modelName` (Groq id) | `openRouterSlug` | Context | Groq $/1M in/out | Free RPD / TPM / TPD |
| --- | --- | --- | --- | --- |
| `llama-3.1-8b-instant` | `meta-llama/llama-3.1-8b-instruct` ✅ | 131,072 | 0.05 / 0.08 | 14,400 / 6K / 500K |
| `llama-3.3-70b-versatile` | `meta-llama/llama-3.3-70b-instruct` ✅ | 131,072 | 0.59 / 0.79 | 1,000 / 12K / 100K |
| `openai/gpt-oss-20b` | `openai/gpt-oss-20b` ✅ | 131,072 | 0.075 / 0.30 | 1,000 / 8K / 200K |
| `openai/gpt-oss-120b` | `openai/gpt-oss-120b` ✅ | 131,072 | 0.15 / 0.60 | 1,000 / 8K / 200K |
| `qwen/qwen3.6-27b` ⚠️ preview | — (hand-seeded, no slug) | 131,072 | 0.60 / 3.00 | 1,000 / 8K / 200K |
| `qwen/qwen3.8-27b` ⚠️ preview | — (hand-seeded, no slug) | 131,042 | 0.80 / 4.00 | 1,000 / 8K / 200K |

**Slug verification (repo policy: never guess a slug).** Each of the four
production slugs was confirmed live via `GET
https://openrouter.ai/api/v1/models/{slug}/endpoints` — every one returns a
non-empty `endpoints` array containing a `provider_name: "Groq"` entry whose
`pricing` matches Groq's published rates (`$0.05/$0.08`, `$0.59/$0.79`,
`$0.075/$0.30`, `$0.15/$0.60`). Note the slug maps are under the *author* id
OpenRouter catalogues the model under (e.g. Groq's `llama-3.3-70b-versatile`
→ `meta-llama/llama-3.3-70b-instruct`), not a `groq/…` slug.

**Preview models are not slugged on purpose.** `qwen/qwen3.6-27b` was checked
live and has **no Groq endpoint** on OpenRouter (endpoints: Chutes,
SiliconFlow, Phala, DeepInfra, Venice, Alibaba), and OpenRouter reports a
262,144 context / multimodal modality that disagrees with Groq's published
131,072 text-only spec. Seeding that slug would make
`ModelMetadataRefreshService` overwrite the context window and price with
wrong values on its next run. So the two previews are hand-seeded
(`contextWindow`, `providerDescription`, `releaseDate`, and a `ModelPrice`
row with Groq's rates) and given **no** `openRouterSlug`, which the refresher
already treats as "skip, leave existing data untouched". See the sequencing
section for the tradeoff this creates around groq-priced refresh coverage.

### Phase 1 — Orchestrator inference path

- `orchestrator/package.json`: add `@ai-sdk/groq` (v4.x — `ai` v7's Groq
  provider, same generation as the existing `@ai-sdk/openai`/`@ai-sdk/google`).
- `orchestrator/src/provider.ts`:
  - `ModelProvider` union → `"openai" | "ollama" | "google" | "groq"`.
  - `DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"`.
  - `getModel`: a `groq` branch —
    `return groq(modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);`
    using the default instance imported once from `@ai-sdk/groq` (it reads
    `GROQ_API_KEY`; Groq manages context automatically, so no `num_ctx`-style
    cap — no use for `effectiveContextWindow`).
  - `getModelName`: groq branch (`GROQ_MODEL` env → default).
  - `defaultProvider`: accept `"groq"` in `MODEL_PROVIDER`.
- `orchestrator/src/solver.ts` — add Groq 429 classification alongside
  `parseGoogleRateLimit`, keyed on `err.responseHeaders` (Groq's error *body*
  is OpenAI-compatible JSON with no quota detail; the headers carry the
  signal):
  - `x-ratelimit-remaining-requests === "0"` → `rate_limited_daily` (park +
    hold; the daily bucket is exhausted for the rest of the window).
  - otherwise a `429` with a `retry-after` header (or a
    `x-ratelimit-remaining-tokens === "0"` token-throttle) → `rate_limited`
    with `retryAfterSeconds` parsed from the header, per-minute retryable.
  - Mirrors `classifyModelCallError`'s Google branch (which unwraps
    `RetryError.lastError`, so the recognition must happen against the wrapped
    `APICallError`, not `RetryError` itself).

### Phase 2 — Backend strategy, queues, worker

- `backend/src/strategies.ts`: add `llm-groq` to `SUPPORTED_STRATEGIES` and
  `LLM_STRATEGIES` (which automatically keeps it out of `AUTOMATIC_STRATEGIES`),
  `export const LLM_GROQ = "llm-groq"`, `DEFAULT_LLM_GROQ_CONCURRENCY = 1`,
  `llmGroqConcurrency(env)` (reads `LLM_GROQ_CONCURRENCY`).
- `backend/src/modules/queue/strategy.queue.ts`: add
  `llmGroqQueue = new Queue("llm-groq-runs", …)` (same default job options as
  its siblings); branch in `queueForStrategy`; widen `queueForJudgeProvider`
  ('s provider union to include `"groq"`).
- `backend/src/modules/queue/queue.module.ts`: `LLM_GROQ_QUEUE` provider +
  export.
- `backend/src/worker.ts`: extend `createLlmWorker`'s queue-name union to
  `"llm-groq-runs"` and start an `llmGroqWorker` in the `role !== "ollama"`
  block (Groq is a cloud provider, so it falls under `WORKER_ROLE=cloud`
  naturally).
- `backend/src/modules/strategy/llm-strategy-runner.service.ts`:
  - the strategy→provider map (`LLM_OLLAMA → "ollama"`, `LLM_GOOGLE →
    "google"`, else `"openai"`) gains `LLM_GROQ → "groq"`;
  - the top-of-run RPD gate, currently `strategyName === LLM_GOOGLE`-only, and
    the hold-on-`rate_limited_daily` block, both generalize to cover
    `LLM_GROQ` via the shared hold service (Phase 3), because Groq daily-quota
    hits must also park the run and set a hold rather than rolling it into
    `ERROR`.
- `/dispatch/model/:modelName/…` needs no new code: `resolveSupportedStrategy`
  resolves `llm-groq` models automatically once the strategy exists.

### Phase 3 — Generalize the RPD hold/resume machinery

`GoogleRateLimitHoldService` and the google-rpd-resume sweep are already
strategy-keyed (`hold/heldModels/isHeld/clearExpired/nextResetAt` all take
`strategyName`), so Groq slots into the same machinery — the only
google-specific behavior is the reset instant (`nextPacificMidnight()`). To
keep one source of truth for "which models are daily-quota-held" and one
resume sweep, generalize rather than clone:

- Rename the entity class + table `GoogleRateLimitHold` → `RateLimitHold`
  (via migration `ALTER TABLE "GoogleRateLimitHold" RENAME TO "RateLimitHold"`),
  and rename `google-rate-limit-hold.service.ts` /
  `GoogleRateLimitHoldService` → `rate-limit-hold.service.ts` /
  `RateLimitHoldService`. Column set is unchanged — it already stores
  `(strategyName, modelName)` with a per-row `resetAt`, so no data
  transformation.
- `hold(strategyName, modelName)` computes `resetAt` per strategy instead of
  always Pacific midnight:
  - `llm-google` → next Pacific midnight (existing DST-safe two-pass math);
  - `llm-groq` → next UTC midnight (default — see open questions; adjust per a
    live 429's `x-ratelimit-reset-requests` value if it differs).
- Rename `google-rpd-resume.service.ts` / `GoogleRpdResumeService` /
  `google-rpd-resume` queue → shared `rpd-resume` (or keep file names and
  just retarget the class). `runResume()` sweeps **both** strategies: clears
  expired holds, then for each `RATE_LIMITED_DAILY` run whose model is no
  longer held, enqueues onto the run's own strategy queue (`LLM_GOOGLE_QUEUE`
  or `LLM_GROQ_QUEUE`) and flips it to `RUNNING`, re-arming via
  `RateLimitHoldService.nextResetAt`. The re-arm's job-id stamp and the
  startup catch-up collapse behavior are unchanged.
- Bootstrap: keep the 00:01 America/Los_Angeles cron for google holds and add
  a matching 00:01 UTC cron (or one sweep that processes both strategy groups
  and sleeps until the soonest relevant reset).

### Phase 4 — Database migrations

- `1780000000000-add-groq-models.ts` — insert the six `llm-groq` rows above,
  and a `ModelPrice` row per model with Groq's rates; set
  `priceScopeProvider = 'groq'` on the four slugged rows (see Phase 5). Adds
  the `priceScopeProvider` column to `SupportedModel` (nullable, `text`).
- `1781000000000-add-groq-dispatch-state.ts` — `GroqDispatchState`, mirroring
  `GoogleDispatchState`: single-row keyed by constant id `"groq"`, columns
  `active`, `startedAt`, `updatedAt`.
- `1782000000000-add-groq-automation-leg.ts` — add `groqBurnOutcome`
  (`varchar`, nullable) and `groqBurnMessage` (`text`, nullable) to
  `AutomationRunLog`.

### Phase 5 — Groq-accurate pricing in the metadata refresh

`ModelMetadataRefreshService` prices from `match.pricing` — OpenRouter's
*list-level* price, which for an open-weight model reflects the cheapest
third-party host (e.g. `meta-llama/llama-3.3-70b-instruct` lists $0.10/$0.32
via DeepInfra while Groq charges $0.59/$0.79). Two of its three botters
(OpenAI/Google models) happen to have a single provider on OpenRouter so the
list price is right; the four slugged Groq models would all be wrong.
Fix by scoping price to the Groq endpoint:

- `SupportedModel.priceScopeProvider` (new nullable column) — when set, the
  refresher uses that provider's endpoint pricing instead of the list price.
  Null → current behavior. Add to `SupportedModelWithRate` DTO.
- `openrouter-client.ts` — add `getModelEndpoints(id)` hitting
  `https://openrouter.ai/api/v1/models/{id}/endpoints` (single-model, public,
  no key), returning the endpoint array with `provider_name` and `pricing`.
- `model-metadata-refresh.service.ts`:
  - context window / param count / provider description / release date still
    come from the list-level match (already correct for 131,072);
  - when `priceScopeProvider` is set, fetch that model's endpoints (parallel
    across the slug-bearing models) and take the endpoint whose
    `provider_name === priceScopeProvider`; if none exists (e.g. a
    groq-tagged model whose OpenRouter endpoints dropped Groq), skip the price
    write and log a warning — never overwrite with the list price;
  - otherwise keep list-level pricing as today.
- Effect: the previews (no slug) are skipped entirely and keep their hand-seeded
  rows; the four production models get Groq-accurate price updates on every
  refresh.

### Phase 6 — Groq free dispatch + daily automation

- New `backend/src/modules/groq-free-dispatch/` module mirroring
  `google-free-dispatch/`:
  - `groq-free-dispatch.service.ts` — `GroqFreeDispatchService` with
    `start` / `stop` / `getStatus` / `runTick`, the same self-rescheduling tick
    chain on a new `groq-free-dispatch` queue. Stop conditions, in order: cycle
    deactivated; no `llm-groq` models configured
    (`supportedModelService.findModelNamesByStrategy(LLM_GROQ)`); every model
    RPD-held (via the shared `RateLimitHoldService`); out of unrun puzzles.
    `start()` returns `{ status, outcome: "started" | "alreadyExhausted" }`
    and refuses while another cycle is active (same
    `BadRequestException` guard as Google). Reuses
    `freeTierDispatchTickMs()` / `freeTierDispatchMaxBatch()` /
    `freeTierDispatchMaxInFlight()` and `freshTickJobId()` (random suffix,
    never a fixed id — BullMQ dedupes by jobId).
  - `entities/groq-dispatch-state.entity.ts`, `groq-free-dispatch.queue.ts`,
    `groq-free-dispatch.module.ts`.
- `backend/src/modules/dispatch/dispatch.controller.ts` (+ module import):
  - `GET /dispatch/groq` — status `{ active, startedAt }` (un-gated, like
    Google);
  - `DELETE /dispatch/groq` — stop (un-gated);
  - no `POST` route, for exact parity with Google: the cycle is started by the
    daily automation leg (or a manual `runTick`/`start()` service call from
    tests / admin).
- `backend/src/modules/automation/daily-automation.service.ts` — add a
  `runGroqBurnLeg(date)` that mirrors `runGoogleBurnLeg` exactly (status-first
  check for "already active", then `start()`, mapping
  `started` / `alreadyActive` / `alreadyExhausted` / `error` into
  `groqBurnOutcome` + `groqBurnMessage`), and call it in `run()` after the
  Google leg.
- `backend/src/worker.ts` — add the `groq-free-dispatch` tick worker
  (concurrency 1, same shape as `google-free-dispatch`).
- `backend/src/modules/automation/automation.controller.ts` — `GET
  /automation/status` gains `groqBurn: { outcome, message }`.

**Pacing sanity check.** At the default knobs (60s ticks, `MaxBatch = 5`,
`MaxInFlight = 5`) and `LLM_GROQ_CONCURRENCY = 1`, Groq's 30 RPM *per model*
cap is comfortably respected (≈5 requests/min/model worst case at current
concurrency), and a single solve run's few calls are nowhere near the 6–12K
TPM buckets. The existing per-minute → `rate_limited` → wait-and-retry path in
the runner absorbs the rest.

### Phase 7 — Frontend

- `frontend/src/data/benchmark/types.ts` — `GroqDispatchStatus` (mirror of
  `GoogleDispatchStatus`), `groqBurn: AutomationLegDisplay` on
  `AutomationStatus`.
- `frontend/src/data/benchmark/api.ts` — `fetchGroqDispatchStatus` /
  `stopGroqDispatch` against `/dispatch/groq`.
- `frontend/src/components/benchmark/GroqDispatchWidget.tsx` — visual clone of
  `GoogleDispatchWidget` (poll status ~30s, stop button, auto-run "last/next"
  line fed by `/automation/status`'s `groqBurn`).
- `frontend/src/pages/benchmark/ActivityPage.tsx` — render it (alongside
  `GoogleDispatchWidget`) and build its `groqBurnAutomation` from
  `automationStatus`.
- `frontend/src/components/benchmark/automationFormat.ts` — include the groq
  leg in the auto-run summary line.
- Strategy labels: `frontend/src/components/GuessSequencePanel.tsx`,
  `frontend/src/data/benchmark/useStrategyMeta.ts`, and
  `frontend/src/data/benchmark/mockData.ts` get `"LLM · Groq"` for
  `llm-groq`.

### Phase 8 — Secrets & config

`GROQ_API_KEY` is orchestrator-only, exactly like `OPENAI_API_KEY` /
`GOOGLE_API_KEY`:

- `.env.sample` and root `.env` — `GROQ_API_KEY`, `GROQ_MODEL`
  (default `llama-3.3-70b-versatile`), `LLM_GROQ_CONCURRENCY`.
- `docker-compose.yml` + `docker-compose.prod.yml` orchestrator env block —
  `GROQ_API_KEY: ${GROQ_API_KEY}`, `GROQ_MODEL: ${GROQ_MODEL:-llama-3.3-70b-versatile}`.

## Data flow & error handling

The daily cron fires `DailyAutomationService.run()`. The new `groqBurn` leg
follows the existing per-leg contract: it is awaited in sequence with the other
legs, each wrapped in its own try/catch so one failing never blocks the rest,
and its outcome is upserted into today's `AutomationRunLog` row the moment it
resolves (`started` / `alreadyActive` / `alreadyExhausted` / `error`).

A `llm-groq` run that hits a Groq 429 flows through `classifyModelCallError`'s
new Groq branch:

- **Per-minute throttle** (`retry-after` / remaining-tokens exhausted) —
  classified `rate_limited`; the runner waits the server-specified duration
  and retries the identical request (existing `rateLimitWaitMs` path).
- **Daily quota exhausted** (`x-ratelimit-remaining-requests: 0`) — classified
  `rate_limited_daily`; the runner parks the run at `RATE_LIMITED_DAILY` and
  writes a hold via the shared `RateLimitHoldService`, whose `resetAt` is
  Groq's next daily-window instant. The generalized `rpd-resume` sweep lifts
  the hold and re-dispatches after the window resets, with the same
  re-arm/startup-catch-up collapse behavior the Google sweep already has.

## Testing

- **Backend unit**
  - `groq-free-dispatch.service.spec.ts` — clone of
    `google-free-dispatch.service.spec.ts`: already-active guard; the
    already-exhausted no-op; runs-til-held stop; runs-out-of-puzzles stop;
    tick batch allocation.
  - `daily-automation.service.spec.ts` — extend for the `groqBurn` leg across
    all four outcome variants (mock `GroqFreeDispatchService`).
  - `rate-limit-hold.service.spec.ts` — generalized reset-instant selection
    (Pacific for `llm-google`, UTC-midnight for `llm-groq`); the existing
    google-specific suites port over.
  - `llm-strategy-runner.service.spec.ts` — groq provider mapping + the
    generalized hold gate / hold-on-failure blocks.
  - `model-metadata-refresh.service.spec.ts` — `priceScopeProvider`-scoped
    pricing (price taken from the named endpoint; skip + warn when that
    endpoint is absent; unchanged list-price path when the column is null).
  - `SupportedModelService` — `findModelNamesByStrategy` already covered; no
    change needed beyond the new DTO field.
- **Orchestrator** — `solver.test.ts`: Groq 429 classification from
  `responseHeaders` (remaining-requests=0 → daily; retry-after → per-minute).
  `provider.test.ts` / `app.test.ts`: `groq` provider resolves
  `GROQ_MODEL`/`DEFAULT_GROQ_MODEL` and constructs via `@ai-sdk/groq`.
- **Frontend** — `GroqDispatchWidget.test.tsx` (clone of the Google widget's
  suite); `ActivityPage.test.tsx` groq-burn additions.
- **E2E** — no new integration surface beyond what the existing
  free-tier-dispatch / rpd-resume suites exercise; the migrations are covered
  by the standard `connections_test` boot.

## Sequencing

1. Phases 1–2 first (provider + strategy), then Phase 4's model migration —
   manual smoke via `POST /dispatch/model/llama-3.3-70b-versatile/…` and
   `POST /dispatch/refresh-model-metadata`.
2. Phase 5 (pricing scoping) immediately after, then re-run the refresh and
   confirm: four production models show Groq prices + 131,072 context; the
   previews keep their hand-seeded rows untouched.
3. Phases 3, 6, 7, 8. Manual smoke: `GET /dispatch/groq`, trigger the daily
   automation (or call `start()`), watch `llm-groq-runs` fill across the six
   models, force a 429 and verify park + hold + resume.
4. Deploy checklist: run migrations, add `GROQ_API_KEY` to prod env, restart
   worker + orchestrator.

## Open questions for implementation planning

- **Groq's daily-window reset instant.** Spec assumed next UTC midnight. Groq
  returns `x-ratelimit-reset-requests` on 429s; verify against a live key
  whether requests and tokens both reset at UTC midnight or on a rolling
  window, and adjust `RateLimitHoldService.hold`'s groq reset computation (and
  the resume cron) accordingly.
- **Preview-model churn.** `qwen/qwen3.6-27b` / `qwen3.8-27b` are markedly
  cheaper than the Llama/GPT-OSS production models on speed but are preview
  and may be discontinued on short notice (Groq explicitly warns previews are
  evaluate-only). If they're dropped, delete their `SupportedModel` rows (or
  flip `supported = false`) — no code change needed.
- **Per-minute token throttling under a sustained burn.** If a burn cycle runs
  hot enough to ride the TPM ceiling (6K TPM on `llama-3.1-8b-instant`), the
  runner's wait-and-retry should suffice, but it may be worth a Groq-specific
  tick pacing (e.g. `MaxBatch = 2`) if actual usage shows churn. Default to the
  shared knobs first.
- **Whether to expose a manual `POST /dispatch/groq`.** Google intentionally
  has none (cycle started only by automation). Kept symmetric here; revisit if
  manual starts are wanted.