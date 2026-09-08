# SambaNova Cloud provider — design

## Problem

The app runs five LLM strategies today — `llm-openai`, `llm-ollama`,
`llm-google`, `llm-groq`, `llm-openrouter` — each dispatched against
`SupportedModel` rows. Four of the cloud providers have a free-usage
program with an automated dispatch loop so trials keep flowing without a
human re-triggering dispatch every day:

- **OpenAI flagship/mini tiers** — a shared per-tier *token* budget, reset
  at UTC midnight.
- **Google AI Studio** — a *per-model* requests-per-day (RPD) cap. A
  per-day 429 parks that one model's runs
  (`StrategyRunStatus.RATE_LIMITED_DAILY`) until the next
  `America/Los_Angeles` midnight, when a cron sweep un-parks them.
- **Groq** — *per-model* RPM + RPD caps, read from Groq's own
  `x-ratelimit-*` response headers. A per-model daily hit parks that model
  until a reset *duration* parsed from the 429 elapses; a
  self-rescheduling resume job un-parks it. A per-minute hit is not a
  failure — the run waits the header-specified delay and retries.
- **OpenRouter** — an *account-wide* (not per-model) 20 RPM / 50 RPD cap,
  classified by the reset distance carried in `X-RateLimit-Reset`, held by
  a single account-wide row, resumed by a fixed UTC-midnight cron.

The four cloud programs are wired into `DailyAutomationService`, which
fires a metadata-refresh leg, a judge leg, a mini-tier burn leg, a Google
burn leg, a Groq burn leg, and an OpenRouter burn leg once a day and
records each leg's outcome to `AutomationRunLog` for the Activity page.

There is no way to dispatch `llm-sambanova` trials, no SambaNova provider
in the orchestrator, and no SambaNova rows in `SupportedModel`.

### SambaNova Cloud's shape

Confirmed against SambaNova's public rate-limits documentation
(`docs.sambanova.ai/docs/en/models/rate-limits`) and the community
`sambanova-ai-provider` package listing as of this spec:

- The API is OpenAI-compatible. A community Vercel AI SDK provider,
  `sambanova-ai-provider` (`createSambaNova`, env `SAMBANOVA_API_KEY`),
  exists and is the intended integration path, the same way `@ai-sdk/groq`
  and `@openrouter/ai-sdk-provider` were used for their providers.
- Free-tier caps are **per-model**, like Groq and Google — not
  account-wide like OpenRouter:

  | Limit | Free tier (per model) | Developer tier (per model) |
  |---|---|---|
  | Requests per minute | 20 | 60–240 (varies by model) |
  | Requests per day | 20 | 12,000–48,000 (varies by model) |
  | Tokens per day | 200,000 | 20,000,000 across all models (account cap) |

- The **free-tier RPD of 20 per model is the binding constraint.** One
  Connections solve trial is roughly 4–8 model API calls (4 steps, each
  1–2 prompts, plus backend retries), so the free tier sustains only about
  **2–4 trials per model per day**, ~10–20 trials per day across the five
  seeded models combined. Meaningful benchmark volume needs the Developer
  tier, which is unlocked by linking a payment method on SambaNova's
  Billing page and is not charged until free limits are exceeded.
- A rate-limit hit returns HTTP 429. Response headers include
  `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-requests-day`,
  and a reset header carrying **time until reset as a duration**
  (Groq-style, e.g. `"23h59m"`), not a fixed clock boundary and not a Unix
  timestamp. The documentation does not state the reset timezone, whether
  the window is rolling, or whether `Retry-After` is present on
  per-minute hits — all three are implementation-time verification items
  (Design §11).
- Tokens-per-day (200,000 per model) is a fourth limit. A tokens-per-day
  429 carries a long reset duration and is treated identically to a
  requests-per-day hit (Design §2) — no separate token-vs-request
  dimension split.

### Tier decision

This feature ships **free-tier-safe by default, Developer-tier-ready by
configuration**. Every pacing and fallback value is an environment
variable whose default is sized for the fixed 20 RPM / 20 RPD per-model
free tier; raising those values unlocks Developer-tier throughput with no
code change and no redeploy — the same upgrade-path shape OpenRouter's
`OPENROUTER_FREE_DAILY_BUDGET` uses.

## Goals

- Add an `llm-sambanova` strategy, dispatched the same way the other cloud
  strategies are (`StrategyService.triggerStrategyRuns`, `SupportedModel`
  rows, its own worker queue and concurrency knob).
- Route the strategy through SambaNova's OpenAI-compatible API using the
  community `sambanova-ai-provider` package, the same way `@ai-sdk/groq`
  was added for Groq.
- Classify a SambaNova 429 into a per-minute retry (no failure recorded,
  wait and retry) or a per-model daily park
  (`StrategyRunStatus.RATE_LIMITED_DAILY`, reusing the provider-agnostic
  status Google introduced), using the **reset distance** parsed from
  SambaNova's duration-style reset header rather than string-matching an
  error body — the same threshold approach OpenRouter uses, adapted to a
  duration header instead of an epoch timestamp.
- Hold state is **per model**, keyed `(strategyName, modelName)` — a
  structural copy of `GroqRateLimitHold`, because SambaNova's free-tier
  caps are per model, so one model being exhausted says nothing about the
  others.
- Automatically resume every parked `llm-sambanova` run once that model's
  daily window resets, driven by a **self-rescheduling resume job** keyed
  off the parsed reset duration — a copy of `GroqRpdResumeService`,
  because SambaNova (like Groq, unlike Google and OpenRouter) delivers a
  reset *duration* rather than a fixed clock boundary, so there is no
  single daily cron time to sweep at.
- A `SambaNovaFreeDispatchService` that proactively dispatches
  `llm-sambanova` trials across the configured models until every model is
  daily-held or out of unrun puzzles — a copy of `GroqFreeDispatchService`
  (**dispatch-until-held**, no self-counted budget), with its **own
  dedicated conservative pacing knobs** sized for the fixed 20 RPM / 20
  RPD-per-model free tier rather than the reused `FREE_TIER_DISPATCH_*`
  family Groq shares with the OpenAI tiers.
- A `sambaNovaBurn` leg in the daily automation chain, alongside
  `metadataRefresh`, `judge`, `miniBurn`, `googleBurn`, `groqBurn`, and
  `openRouterBurn`.
- Seed five SambaNova free-tier chat models (Design §8), each with its
  OpenRouter catalog slug for metadata backfill:
  `DeepSeek-V3.1`, `DeepSeek-V3.2`, `Meta-Llama-3.3-70B-Instruct`,
  `gpt-oss-120b`, `gemma-4-31B-it`.

## Non-goals

- No shared token-budget tier for SambaNova (`FreeTierUsageService`'s
  per-tier token model does not fit a per-model request-count cap).
- No manual "start" endpoint for SambaNova dispatch — mirrors Google,
  Groq, and OpenRouter, which are automation-only (`GET`/`DELETE`
  status/stop, no `POST`).
- No account-wide hold row and no account-wide self-counted daily budget —
  SambaNova's free-tier caps are per model, so per-model hold rows and a
  dispatch-until-held stop condition (Groq's shape) cover it. The
  `SolvePrompt`-row self-count OpenRouter needed was specifically for its
  *account-wide* cap where failed attempts also count against one shared
  number; it does not apply here.
- No fixed daily resume cron — that was Google's and OpenRouter's answer
  to a fixed reset clock. SambaNova's reset is a duration from the hit, so
  Groq's self-rescheduling resume (rearm at the soonest live hold's
  `resetAt`) is both sufficient and the correct fit.
- No token-vs-request rate-limit dimension split in the classifier. Groq's
  branch distinguishes a tokens-per-day hit from a requests-per-day hit
  because their reset headers differ; SambaNova's threshold classifier
  treats any long-reset 429 as a daily park regardless of which quota
  tripped, which is simpler and adequate.
- No seeding of SambaNova entries that are not plain text-in / text-out
  chat models capable of structured output — audio, vision-only, and
  embedding models are excluded. Any of the five seeded models that fails
  a structured-output probe at implementation time is seeded
  `supported = false` (Design §8), the way `minimax/minimax-m2.7:free`
  was for Groq.
- No automatic detection of whether the account is on the Developer tier
  (there is no API for it). The pacing knobs are configuration values the
  operator raises after linking a payment method.
- No admin UI for inspecting or clearing `SambaNovaRateLimitHold` rows by
  hand — same as Google, Groq, and OpenRouter, direct database access
  covers it.
- No change to `llm-openai` / `llm-ollama` / `llm-google` / `llm-groq` /
  `llm-openrouter` behavior beyond the few spots that branch on provider
  for a provider-agnostic status, code, or fallback constant.

## Design

### 1. Provider — orchestrator

`orchestrator/src/provider.ts`:

- `ModelProvider` gains `"sambanova"`.
- New orchestrator dependency `sambanova-ai-provider`. `getModel()` gains
  a `"sambanova"` branch:
  `createSambaNova({ apiKey: process.env.SAMBANOVA_API_KEY })(modelOverride
  ?? process.env.SAMBANOVA_MODEL ?? DEFAULT_SAMBANOVA_MODEL)`. Unlike
  OpenRouter's `openrouter.chat(id)`, the SambaNova provider instance is
  **called directly** with the model id, like Groq's `groq(id)` and
  Google's `google(id)`. Confirm the exact factory name (`createSambaNova`)
  and whether the instance is called directly vs. via a `.chat(...)` /
  `.languageModel(...)` method against the package's current published
  version when wiring — the same way this repo avoided guessing the
  `@ai-sdk/groq` and `@openrouter/ai-sdk-provider` APIs.
- `DEFAULT_SAMBANOVA_MODEL = "Meta-Llama-3.3-70B-Instruct"` — a stable
  production model, playing the small/cheap default role
  `DEFAULT_OPENAI_MODEL` / `DEFAULT_GROQ_MODEL` /
  `DEFAULT_OPENROUTER_MODEL` play for their providers.
- `getModelName()` gains the matching `"sambanova"` branch
  (`modelOverride ?? process.env.SAMBANOVA_MODEL ??
  DEFAULT_SAMBANOVA_MODEL`).
- `defaultProvider()` gains `if (provider === "sambanova") return
  "sambanova";` so `MODEL_PROVIDER=sambanova` works for the provider-less
  AI Assist path.
- `effectiveContextWindow()` needs no SambaNova branch — like Google,
  Groq, and OpenRouter, SambaNova has no per-call context-window setting;
  the existing `provider !== "ollama"` passthrough already covers it.

### 2. Detecting the hit — orchestrator, reset-distance threshold

SambaNova attaches rate-limit state as headers on a 429:

| Header | Meaning |
|---|---|
| `x-ratelimit-remaining-requests` | Requests left in the current per-minute window |
| `x-ratelimit-remaining-requests-day` | Requests left in the current per-day window |
| `x-ratelimit-reset-requests-day` | Time until the per-day window resets, as a **duration string** (assumed; confirm exact header name and format — §11) |
| `x-ratelimit-reset-requests` | Time until the per-minute window resets, as a duration string (assumed) |
| `retry-after` | Seconds to wait — presence on per-minute 429s is unconfirmed (§11) |

`orchestrator/src/solver.ts` gains a `sambanova` branch in
`classifyModelCallError`, placed after the `openrouter` branch and modeled
on it:

- When `provider === "sambanova"` and the error is an `APICallError` with
  `statusCode === 429`: read `err.responseHeaders` (already captured into
  `apiDetails` for every provider). Normalize keys to lowercase before
  reading, as the Groq and OpenRouter branches do.
- Compute `resetSeconds` by trying, in order:
  `parseGroqResetDuration(headers["x-ratelimit-reset-requests-day"])`,
  then `parseGroqResetDuration(headers["x-ratelimit-reset-requests"])`,
  then `parseSecondsHeader(headers["retry-after"])`. `parseGroqResetDuration`
  already exists (it parses `"2h59m59.56s"`-style strings) and is reused
  as-is — SambaNova's duration format is assumed compatible; §11 confirms
  it against a real 429 and adds a dedicated parser only if the format
  differs.
- **Daily vs per-minute**, by reset distance (there is no reliable
  per-model daily signal to key on, and both free-tier caps are the same
  number, 20):
  - `resetSeconds !== undefined && resetSeconds >
    DAILY_RESET_THRESHOLD_SECONDS` (the existing non-configurable
    `solver.ts` module constant, `120`) → the per-day (requests or
    tokens) bucket is exhausted. Return
    `new SolveError("rate_limited_daily", "SambaNova daily quota
    exhausted: ...", { ...apiDetails, dailyResetSeconds: resetSeconds })`.
  - `resetSeconds !== undefined` (a short reset) → a per-minute hit.
    Return `new SolveError("rate_limited", "SambaNova rate limit hit:
    ...", { ...apiDetails, retryAfterSeconds: resetSeconds })`. This is
    the same `"rate_limited"` code and `retryAfterSeconds` field Google,
    Groq, and OpenRouter per-minute paths use; the runner's
    wait-and-retry logic (`state.rateLimitWaitMs`) is already
    provider-agnostic and needs no change.
  - `resetSeconds === undefined` (no parseable reset or retry header — a
    malformed or proxy-mangled 429) → fall through to `model_error`
    unchanged, exactly as the Groq and OpenRouter branches do when their
    headers are absent.
- No new `SolveErrorCode` value — `"rate_limited"` and
  `"rate_limited_daily"` already exist and are provider-agnostic in the
  runner. No new `SolveErrorDetails` field — `dailyResetSeconds` and
  `retryAfterSeconds` already exist (added for Groq).

### 3. Hold state — per-model Postgres rows

New entity `SambaNovaRateLimitHold`
(`backend/src/modules/strategy/entities/sambanova-rate-limit-hold.entity.ts`),
a structural copy of `GroqRateLimitHold`:

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `strategyName` | `text` | Always `'llm-sambanova'` today. |
| `modelName` | `text` | The SambaNova model id that was daily-held. |
| `heldAt` | `timestamptz` | When the hold was recorded. |
| `resetAt` | `timestamptz` | When the hold lifts. |

**Unique constraint on `(strategyName, modelName)`** — one row per held
model, identical to `GroqRateLimitHold` (and unlike
`OpenRouterRateLimitHold`, whose constraint is `(strategyName)` alone).

New `SambaNovaRateLimitHoldService`
(`backend/src/modules/strategy/sambanova-rate-limit-hold.service.ts`) — a
near-verbatim copy of `GroqRateLimitHoldService`, no timezone math (the
reset is a duration):

- `hold(strategyName, modelName, resetInSeconds)` — upsert the
  `(strategyName, modelName)` row with
  `resetAt = new Date(Date.now() + resetInSeconds * 1000)`.
- `isHeld(strategyName, modelName): Promise<boolean>` — row exists and
  `resetAt > now`.
- `heldModels(strategyName): Promise<string[]>` — model names with a live
  hold.
- `nextResetAt(strategyName): Promise<Date | null>` — the soonest
  still-future `resetAt`, or `null`. Used by the resume job to rearm.
- `clearExpired(): Promise<string[]>` — delete rows whose `resetAt` has
  passed; returns the freed model names.

### 4. Runner behavior

`backend/src/modules/strategy/llm-strategy-runner.service.ts`:

- Provider resolution: extend the existing ternary chain with
  `: strategyName === LLM_SAMBANOVA ? "sambanova"` before the `"openai"`
  default.
- Inject `SambaNovaRateLimitHoldService` alongside the Google, Groq, and
  OpenRouter hold services (explicit `@Inject(SambaNovaRateLimitHoldService)`).
- **Top gate**, extended: `... || (strategyName === LLM_SAMBANOVA &&
  await sambaNovaHold.isHeld(strategyName, modelName))` — same
  park-immediately behavior (`StrategyRunStatus.RATE_LIMITED_DAILY`, zero
  orchestrator calls) the Groq per-model gate uses.
- **On a `rate_limited_daily` outcome**: the branch's provider check
  extends to include `strategyName === LLM_SAMBANOVA`, and calls
  `sambaNovaHold.hold(strategyName, modelName,
  outcome.error.details.dailyResetSeconds ??
  llmSambaNovaDailyHoldFallbackSeconds())`.
- `classifyFailedCall`'s `rate_limited_daily` branch is already
  provider-agnostic (parks the run, touches no counter) — no change.
- The per-minute `rate_limited` branch already takes a `provider`
  parameter (added for Groq) to pick a fallback constant. Add a
  `provider === "sambanova"` case selecting
  `llmSambaNovaRateLimitFallbackSeconds()` (§7). Google's, Groq's, and
  OpenRouter's constants are untouched. **No hold is written on a
  per-minute hit** — it is wait-and-retry only, and (unlike OpenRouter's
  account-wide cooldown) there is no reason to park sibling models for one
  model's per-minute burst.

### 5. Dispatch — `SambaNovaFreeDispatchService`

New service
(`backend/src/modules/sambanova-free-dispatch/sambanova-free-dispatch.service.ts`),
backed by a new single-row `SambaNovaDispatchState` entity (mirrors
`GroqDispatchState`: `id` / `active` / `startedAt`). Its whole skeleton —
`start` / `stop` / `getStatus` / `runTick`, self-rescheduling tick chain,
least-allocated-model round-robin batching via
`StrategyService.findUnrunPuzzleDatesForModel` / `triggerStrategyRuns` /
`countInFlightByModel` / `countTodayDispatchByModel` against
`LLM_SAMBANOVA`, `leastAllocatedModel` helper — is copied from
`GroqFreeDispatchService`. The only substantive differences:

#### 5a. Stop condition: dispatch-until-held

Identical to Groq. Each tick filters the configured models down to those
**not** currently daily-held (`heldModels(LLM_SAMBANOVA)`), and dispatches
a batch spread across the eligible ones. The cycle stops (`active = false`)
when every configured model is daily-held or every eligible model is out
of unrun puzzles. `start()` short-circuits to the `alreadyExhausted`
outcome when every configured model is already held. The per-model 429
`'daily'` hold (§3) is the backstop: at the free tier a model parks itself
after ~2–4 trials, the tick sees it in `heldModels`, and the cycle winds
down naturally.

#### 5b. Dedicated conservative pacing knobs

The fixed 20 RPM / 20 RPD per-model free-tier ceiling is far tighter than
anything the `FREE_TIER_DISPATCH_*` knobs were tuned for, so SambaNova
gets its own small pacing family (§7), the way OpenRouter did:

- `SAMBANOVA_DISPATCH_TICK_MS` (default `15000`)
- `SAMBANOVA_DISPATCH_MAX_BATCH` (default `2`)
- `SAMBANOVA_DISPATCH_MAX_IN_FLIGHT` (default `2`)

With `LLM_SAMBANOVA_CONCURRENCY=1` serializing the queue, worst case is
about 2 trials per 15s tick, comfortably under 20 RPM even before models
start parking on the 20 RPD wall. Raising `MAX_BATCH` / `MAX_IN_FLIGHT`
(and `TICK_MS` downward) is the Developer-tier throughput lever. The
tick's in-flight check and batch sizing are otherwise identical to Groq's.

#### 5c. Queues

- New BullMQ queue `sambanova-free-dispatch`
  (`backend/src/modules/queue/sambanova-free-dispatch.queue.ts` +
  `SAMBANOVA_FREE_DISPATCH_QUEUE` token in `queue.module.ts`), worker
  handler in `backend/src/worker.ts` alongside `groq-free-dispatch`,
  driving `runTick()`.
- New BullMQ queue `llm-sambanova-runs`
  (`LLM_SAMBANOVA_QUEUE` token in `queue.module.ts`, registered next to
  `LLM_GROQ_QUEUE`), the strategy-run queue `triggerStrategyRuns` targets
  for `LLM_SAMBANOVA`; worker consumes it at `LLM_SAMBANOVA_CONCURRENCY`.
  Shown in Bull Board next to `llm-groq-runs`.

### 6. Resume — self-rescheduling job

New `SambaNovaRpdResumeService`
(`backend/src/modules/strategy/sambanova-rpd-resume.service.ts`) and
`SambaNovaRpdResumeBootstrap`
(`backend/src/modules/strategy/sambanova-rpd-resume.bootstrap.ts`), copied
from the Groq pair:

- `runResume(triggerJobId)`: `clearExpired()`, then for every `StrategyRun`
  with `status = RATE_LIMITED_DAILY` and `strategyName = 'llm-sambanova'`
  whose `modelName` is no longer in `heldModels(LLM_SAMBANOVA)`, flip to
  `RUNNING` and re-queue the job (resumes from flushed guesses, the
  mechanism Google, Groq, and OpenRouter already use). The resume job id
  is stamped with `triggerJobId` for retry-idempotency, exactly as
  `GroqRpdResumeService` does.
- `rearm()`: if any run is still parked under a live hold, re-enqueue the
  sweep with `delay` = time until the soonest live hold's `resetAt`
  (clamped to a `REARM_MAX_DELAY_MS` ceiling of 15 minutes) — the sole
  ongoing scheduling mechanism, since there is no fixed daily reset clock.
- `SambaNovaRpdResumeBootstrap` (`OnApplicationBootstrap`, skipped under
  `NODE_ENV=test`): enqueues one startup catch-up `runResume()` to pick up
  anything that expired while the process was down. **No cron
  registration** — unlike Google's and OpenRouter's bootstraps.
- New BullMQ queue `sambanova-rpd-resume`
  (`backend/src/modules/queue/sambanova-rpd-resume.queue.ts` +
  `SAMBANOVA_RPD_RESUME_QUEUE` token in `queue.module.ts`), worker handler
  in `backend/src/worker.ts` alongside `groq-rpd-resume`, passing its own
  `job.id` as `triggerJobId`.

### 7. Config

New environment variables, added to `.env.sample` / `backend/src/config/env.ts`
/ `docker-compose.yml` (backend + orchestrator services) / `README.md`,
mirroring the existing Groq and OpenRouter entries:

- `SAMBANOVA_API_KEY` — used by `sambanova-ai-provider` in the
  orchestrator.
- `SAMBANOVA_MODEL` — default SambaNova model id for provider-less
  requests (`MODEL_PROVIDER=sambanova`); also add `"sambanova"` to
  `MODEL_PROVIDER`'s accepted values in docs.
- `LLM_SAMBANOVA_CONCURRENCY` (default `1`) — worker concurrency for
  `llm-sambanova-runs`.
- `LLM_SAMBANOVA_RATE_LIMIT_FALLBACK_SECONDS` (default `60`) — used only
  when a per-minute 429's reset/`retry-after` headers are absent or
  unparseable.
- `LLM_SAMBANOVA_DAILY_HOLD_FALLBACK_SECONDS` (default `3600`) — used only
  when a daily 429 carries no parseable reset duration; the model is held
  for this long and the resume sweep re-checks after.
- `SAMBANOVA_DISPATCH_TICK_MS` (default `15000`)
- `SAMBANOVA_DISPATCH_MAX_BATCH` (default `2`)
- `SAMBANOVA_DISPATCH_MAX_IN_FLIGHT` (default `2`)

`backend/src/strategies.ts` additions: `LLM_SAMBANOVA = "llm-sambanova"`,
added to `SUPPORTED_STRATEGIES` and `LLM_STRATEGIES`;
`llmSambaNovaConcurrency()`; `llmSambaNovaRateLimitFallbackSeconds()`;
`llmSambaNovaDailyHoldFallbackSeconds()`; `sambaNovaDispatchTickMs()`;
`sambaNovaDispatchMaxBatch()`; `sambaNovaDispatchMaxInFlight()`. Each
numeric accessor follows the existing `positiveInt` / `positiveTrialCount`
validation pattern with a matching `DEFAULT_*` constant. `worker.ts`
routes `llm-sambanova-runs` into the `all` / `cloud` roles (never
`ollama`), same as `llm-groq-runs`, and adds the `sambanova-rpd-resume`
and `sambanova-free-dispatch` worker handlers.

### 8. Model seeding

New migration `AddSambaNovaModels<timestamp>` (timestamp after the last
OpenRouter migration, `1791000000000`), same shape as
`1788000000000-add-openrouter-models.ts`:

```sql
INSERT INTO "SupportedModel"
  ("strategyName", "modelName", "supported", "openRouterSlug", "freeTier")
VALUES
  ('llm-sambanova', 'DeepSeek-V3.1',               true, 'deepseek/deepseek-chat-v3.1',       NULL),
  ('llm-sambanova', 'DeepSeek-V3.2',               true, 'deepseek/deepseek-v3.2',            NULL),
  ('llm-sambanova', 'Meta-Llama-3.3-70B-Instruct', true, 'meta-llama/llama-3.3-70b-instruct', NULL),
  ('llm-sambanova', 'gpt-oss-120b',                true, 'openai/gpt-oss-120b',               NULL),
  ('llm-sambanova', 'gemma-4-31B-it',              true, 'google/gemma-4-31b-it',             NULL)
ON CONFLICT ("strategyName", "modelName") DO NOTHING
```

For this provider `modelName` is **SambaNova's own model id** and
`openRouterSlug` is a **separate mapping** to the OpenRouter catalog entry
— the same split Groq uses (`1785000000000-set-groq-model-openrouter-slugs.ts`),
not OpenRouter's own seeding where the two are identical.
`ModelMetadataRefreshService` reads `openRouterSlug` to fill
`contextWindow` / `releaseDate` / pricing on its next run. `freeTier`
stays `NULL` — SambaNova is not part of either OpenAI tier.

**The five models** (SambaNova free-tier catalog as of this spec; slugs
confirmed against OpenRouter model pages — re-confirm all at
implementation time):

| SambaNova id | OpenRouter slug | Context | Status | Structured output |
|---|---|---|---|---|
| `DeepSeek-V3.1` | `deepseek/deepseek-chat-v3.1` | 164K | production | likely — verify |
| `DeepSeek-V3.2` | `deepseek/deepseek-v3.2` | 164K | preview | likely — verify |
| `Meta-Llama-3.3-70B-Instruct` | `meta-llama/llama-3.3-70b-instruct` | 131K | production | likely — verify |
| `gpt-oss-120b` | `openai/gpt-oss-120b` | 131K | production | **confirmed** (JSON schema) |
| `gemma-4-31B-it` | `google/gemma-4-31b-it` | 262K | preview | `response_format` — verify |

`gpt-oss-120b` is the confirmed-good anchor. `DeepSeek-V3.2` and
`gemma-4-31B-it` are SambaNova "preview" models and may be withdrawn with
little notice; if a seeded id 404s or fails a structured-output probe at
implementation time it is seeded `supported = false` rather than dropped,
the way `minimax/minimax-m2.7:free` was for Groq.

`gemma-4-31B-it`'s OpenRouter slug (`google/gemma-4-31b-it`) is already
seeded for the OpenRouter strategy — the same catalog row backs both
strategies' metadata, and the cross-provider `llm-openrouter` vs
`llm-sambanova` comparison for that model is a useful side effect.

**Model-id encoding:** the five SambaNova ids contain no `/` or `:`, so
the leaderboard slash-encoding fix (`d540f82`) and the OpenRouter
colon-in-`:free` concern do not apply. Implementation still confirms a
`Meta-Llama-3.3-70B-Instruct`-style id round-trips through every
model-id-bearing URL (leaderboard links, backend routes taking a model id
as a path parameter, frontend `encodeURIComponent`).

### 9. Daily automation leg

`DailyAutomationService` gains `runSambaNovaBurnLeg`, a direct copy of
`runOpenRouterBurnLeg` / `runGroqBurnLeg`: check
`sambaNovaFreeDispatchService.getStatus()`, record `alreadyActive` if
already running, otherwise `start()` and record `started` or
`alreadyExhausted`, catching and recording any thrown error. Fired in
`run()` after the existing OpenRouter leg, independently (no leg blocks or
is blocked by another).

`AutomationRunLog` entity + migration gain `sambaNovaBurnOutcome` /
`sambaNovaBurnMessage` columns, same string shape as `groqBurnOutcome` /
`groqBurnMessage`. `AutomationController`'s `GET /automation/status`
assembly includes the SambaNova leg's live status alongside the others.
The service doc comment's leg list is updated to seven legs.

`dispatch.controller.ts` gains `GET /dispatch/sambanova` (status) and
`DELETE /dispatch/sambanova` (stop) — no `POST`, matching Google's,
Groq's, and OpenRouter's automation-only surface.

### 10. Frontend

- `SambaNovaDispatchWidget.tsx`
  (`frontend/src/components/benchmark/SambaNovaDispatchWidget.tsx`) — a
  copy of `GroqDispatchWidget.tsx` (same `bench-free-tier` styling, same
  30s poll cadence, same active/inactive display). **No "calls today /
  budget" line** — that was OpenRouter-specific because its cap was a
  single countable account-wide number; SambaNova's per-model caps have no
  equivalent single figure. Fed by a new `fetchSambaNovaDispatchStatus` /
  `stopSambaNovaDispatch` in `frontend/src/data/benchmark/api.ts` and a
  `SambaNovaDispatchStatus` type in `frontend/src/data/benchmark/types.ts`.
- `AutomationStatus` / `AutomationLegDisplay` types, the automation api
  client, and `formatAutomationLine` extended to cover the `sambaNovaBurn`
  leg, same pattern as `groqBurn` / `openRouterBurn`.
- Wired into the Activity page next to `OpenRouterDispatchWidget`.
- No `StrategyRunStatus` display change — `RATE_LIMITED_DAILY` already
  renders ("Paused — daily quota") and is provider-agnostic; a SambaNova
  run parked by it renders identically.

### 11. Implementation-time verification (never-guess rule)

Resolve before or during wiring, not by assumption:

- **Provider API.** Exact `sambanova-ai-provider` factory name
  (`createSambaNova` assumed), whether the provider instance is called
  directly with a model id or via a method, its current published
  version, and its peer-dependency range against the orchestrator's `ai`
  version. Confirm against the package's published docs/types.
- **429 headers.** The exact reset header name(s) and their format
  (duration string assumed, `parseGroqResetDuration`-compatible), whether
  `x-ratelimit-remaining-requests-day` is present on the hit, and whether
  `retry-after` appears on per-minute 429s — all against a real captured
  SambaNova 429. Add a dedicated reset-duration parser only if the format
  differs from Groq's.
- **Daily reset semantics.** Whether the per-day window is a fixed clock
  boundary or a rolling 24h window from first request. If it turns out to
  be a fixed clock (contradicting the duration-header assumption), the
  resume design revisits whether a fixed cron (OpenRouter's shape) fits
  better than self-rescheduling. The duration-header approach is safe
  either way; this only affects which is *simplest*.
- **Slugs and structured output.** Re-confirm all five OpenRouter slugs
  against live model pages, and probe each SambaNova model with a real
  `generateObject` solve-shaped call against SambaNova's OpenAI-compatible
  endpoint. Any model that cannot reliably return structured output is
  seeded `supported = false`.
- **Non-automated path.** Confirm no non-automated `llm-sambanova` path
  can reach the per-minute `rate_limited` branch in a way that matters
  (it writes no hold, so the risk is lower than OpenRouter's, but the
  wait-and-retry behavior should still be sane for a one-off manual
  trial).

### 12. The provider mistake — explicit guardrail

The two new entities — `SambaNovaRateLimitHold` and
`SambaNovaDispatchState` — must be added to the explicit `entities: [...]`
array of the root TypeORM connection in **both**:

- `backend/src/app.module.ts` (`TypeOrmModule.forRootAsync`) — used by the
  running app and the worker.
- `backend/src/data-source.ts` (`AppDataSource`) — used by the TypeORM
  CLI for `migration:generate` / `migration:run`.

`TypeOrmModule.forFeature([...])` in the feature modules builds the
repository providers but does **not** register entity metadata on the root
connection. Omitting either array compiles clean, passes unit tests
(mocked repos), runs migrations (glob-loaded), and can pass e2e — then
throws `EntityMetadataNotFoundError` on the first real query. This has
bitten Groq and OpenRouter the same way. Add both entities to both arrays
in the same change and verify with an `AppDataSource.initialize()` +
`AppDataSource.hasMetadata("SambaNovaRateLimitHold")` /
`hasMetadata("SambaNovaDispatchState")` check against the live dev
database.

Additionally: every new NestJS constructor parameter in this feature uses
an explicit injection decorator — `@Inject(Token)`,
`@InjectRepository(Entity)`, `@InjectDataSource()` — never bare-type
inference, which resolves to `undefined` under the worker's `tsx`/esbuild
runtime without throwing at boot.

## Testing

TDD throughout, per the repo's normal workflow. New spec files mirror
their Groq-feature counterparts 1:1 unless noted.

### Orchestrator

- `solver.test.ts`: a SambaNova 429 whose reset duration is more than the
  threshold ahead classifies as `rate_limited_daily` with
  `dailyResetSeconds` computed from it; a 429 whose reset is seconds away
  (or which carries only `retry-after`) classifies as `rate_limited` with
  `retryAfterSeconds`; a 429 with no parseable rate-limit headers falls
  through to `model_error` without throwing; a non-SambaNova provider's
  429 is unaffected by the new branch.
- `provider.test.ts`: `getModel("sambanova", ...)` and
  `getModelName("sambanova", ...)` resolve the
  `modelOverride` / `SAMBANOVA_MODEL` / `DEFAULT_SAMBANOVA_MODEL` fallback
  chain; `defaultProvider()` returns `"sambanova"` for
  `MODEL_PROVIDER=sambanova`.

### Backend

- `sambanova-rate-limit-hold.service.spec.ts` (mirrors
  `groq-rate-limit-hold.service.spec.ts`): `hold(strategy, model, n)`
  upserts the `(strategy, model)` row with `resetAt = now + n`; `isHeld` /
  `heldModels` / `nextResetAt` reflect only live rows; `clearExpired`
  removes elapsed rows and reports their model names; a second `hold` for
  the same model overwrites its `resetAt`.
- `sambanova-rpd-resume.service.spec.ts` and
  `sambanova-rpd-resume.bootstrap.spec.ts` (mirror the Groq pair): a run
  parked `RATE_LIMITED_DAILY` for `llm-sambanova` is resumed after
  `clearExpired` frees its model; a run whose model is still held is not;
  runs of other strategies are untouched; `rearm()` re-enqueues at the
  soonest live `resetAt` clamped to the ceiling; the bootstrap enqueues a
  startup catch-up and registers no cron.
- `sambanova-free-dispatch.service.spec.ts` (mirrors
  `groq-free-dispatch.service.spec.ts`): already-exhausted no-op when
  every model is held; the dispatch loop; least-allocated-model batching;
  the cycle stops when every model becomes held or runs out of unrun
  puzzles; `SAMBANOVA_DISPATCH_MAX_BATCH` / `MAX_IN_FLIGHT` / `TICK_MS`
  are honored.
- `llm-strategy-runner.service.spec.ts`: extend the existing
  Google/Groq/OpenRouter `rate_limited_daily` block with an
  `llm-sambanova` variant — top gate parks with zero orchestrator calls
  when the model is held; a daily hit writes the per-model hold using
  `dailyResetSeconds`, falling back to
  `llmSambaNovaDailyHoldFallbackSeconds()` when that field is absent; a
  per-minute `sambanova` hit records no failure and writes no hold; never
  produces `StrategyRunStatus.ERROR` regardless of repeat count.
- `daily-automation.service.spec.ts`: extend the leg-independence test
  with a `sambaNovaBurn` leg — mocked `SambaNovaFreeDispatchService`,
  asserting `started` / `alreadyActive` / `alreadyExhausted` / `error`
  outcomes are written to `AutomationRunLog`, and that a `sambaNovaBurn`
  failure neither blocks nor is blocked by the other six legs.
- Queue resolution coverage: `LLM_SAMBANOVA_QUEUE`,
  `SAMBANOVA_FREE_DISPATCH_QUEUE`, `SAMBANOVA_RPD_RESUME_QUEUE` all
  resolve from `QueueModule`.

### Frontend

- `SambaNovaDispatchWidget.test.tsx`, mirroring
  `GroqDispatchWidget.test.tsx` (active/inactive render, poll cadence,
  stop action). No "calls today" assertion — that line does not exist for
  this widget.

### Migration

Four new migrations (`SambaNovaRateLimitHold` + `SambaNovaDispatchState`
tables; the `sambaNovaBurnOutcome` / `sambaNovaBurnMessage`
`AutomationRunLog` columns; the model seed from §8). Per repo convention
migrations are not unit-tested; the up / down / up round-trip against a
real database is a manual verification pass once the branch has the dev
DB to itself.

## Open questions for implementation planning

- Exact `sambanova-ai-provider` API surface and version (§11) — confirm
  against its published docs/types when wiring
  `orchestrator/src/provider.ts`.
- Exact SambaNova 429 header names, reset-duration format, and whether the
  per-day window is fixed-clock or rolling (§11) — confirm against a real
  captured 429 before finalizing the parser and, if fixed-clock, before
  settling the resume mechanism.
- Whether `parseGroqResetDuration` covers SambaNova's reset format
  as-is or a dedicated parser is warranted.
- Final re-confirmation of the five seed slugs and their structured-output
  support against live catalog + a real `generateObject` probe at
  implementation time; mark any failure `supported = false`.
- The seam for the `sambanova-free-dispatch` module's dependency on
  `StrategyService` counting helpers — reuse
  `countTodayDispatchByModel` / `countInFlightByModel` as Groq does
  (expected), versus any SambaNova-specific query (not anticipated).
