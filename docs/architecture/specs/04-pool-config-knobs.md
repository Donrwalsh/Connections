# Candidate 4 — Pool config knobs

Implements `docs/architecture/04-pool-config-knobs.html`, with one deviation
from that doc's proposed shape (see below).

## What shipped

- `backend/src/modules/provider-pool/pool-knobs.ts`: three generic env
  readers (`intEnv`, `msEnvAsSeconds`, `secondsEnvAsMs`) plus the knob
  defaults — most shared across providers (`DEFAULT_CONCURRENCY = 1`,
  `DEFAULT_RATE_LIMIT_FALLBACK_SECONDS = 60`), a few genuinely
  provider-specific (Groq's 24h daily-hold fallback, OpenRouter's budget/
  pacing defaults, Mistral's streak-park thresholds, SambaNova's daily-hold
  and dedicated pacing defaults).
- `backend/src/modules/provider-pool/provider-pool.config.ts`: every pool
  row in `PROVIDER_POOLS` now builds its `NumberThunk` fields
  (`concurrency`, `rateLimitFallbackSeconds`, `dailyHoldFallbackSeconds`,
  the dispatch-pacing/account-budget knobs, Mistral's
  `persistentRateLimitPark`) with an inline closure over `intEnv` /
  `msEnvAsSeconds` / `secondsEnvAsMs` and that knob's literal env-var name,
  instead of importing a named wrapper function per knob per provider.
- `backend/src/strategies.ts`: lost the 26 removed per-provider accessor
  functions and their 26 `DEFAULT_*` constants. Everything else in the file
  (shuffle/LLM trial counts, prompt/duplicate/failure caps, the free-tier
  dispatch knobs shared across all pools, `workerRole`,
  `strategyTrialNumbers`, the daily-automation cron helpers) is unchanged —
  those aren't per-provider and were never in scope.
- `backend/src/modules/strategy/llm-strategy-runner.service.ts`'s one
  direct accessor call (the non-pool-strategy rate-limit fallback default)
  now reads `providerPoolById("google").freeTier!.rateLimitFallbackSeconds()`
  instead of importing `llmGoogleRateLimitFallbackSeconds` from
  `strategies.ts`.

## Deviation from the proposal doc

The doc's ideal shape derives each env-var name by template
(`` `LLM_${ID}_CONCURRENCY` ``). The real names aren't uniformly
templatable — `MISTRAL_MODEL_HOLD_FALLBACK_SECONDS` has no `LLM_` prefix
and isn't `DAILY_HOLD`-shaped; `OPENROUTER_DISPATCH_RPM_COOLDOWN_MS` has no
per-ID pattern either — so this implementation keeps every env-var name as
a literal string argument at its pool's row instead. This also sidesteps
the doc's own noted risk (derived names hurt greppability): every knob's
real env-var name is still a `grep`-able literal, just co-located with its
pool row instead of living in a dedicated wrapper function.

## Tests

- `pool-knobs.spec.ts`: the coercion edge cases (missing / non-numeric /
  zero / negative / valid; ms→s rounding; s→ms conversion) tested once on
  the generic readers, replacing ~26 near-identical per-accessor spec
  blocks that used to live in `strategies.spec.ts`.
- `provider-pool.config.spec.ts`'s `"knobs read the right env var"` block
  replaces the old `"knob accessors are wired to the right provider"`
  block: since each knob is now an inline closure rather than a named,
  reference-comparable function, the copy-paste guard (e.g. groq's row
  reading google's env var) is now a behavioral env-override assertion
  instead of a `toBe(fn)` identity check.
