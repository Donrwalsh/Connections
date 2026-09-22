# NVIDIA NIM Provider — Design

## Problem

The strategy runner supports seven LLM providers (OpenAI, Ollama, Google, Groq, OpenRouter, Mistral, SambaNova), each wired through the same multi-registry pattern: an AI SDK factory in the orchestrator, a strategy constant in the backend, a `PROVIDER_POOLS` row, a frontend filter row, and seeded `SupportedModel` rows. We're adding an eighth: **NVIDIA NIM**, NVIDIA's hosted, OpenAI-compatible inference API at `build.nvidia.com`, with an initial batch of models to get it running end-to-end (settled at 6, after live verification — see "Initial model batch" below).

This doc captures the decisions reached during requirements review, so the implementation plan can execute against a settled design rather than re-litigating them mid-build.

## Goals

- Add `nvidia` as a full provider: orchestrator wiring, backend strategy, a dedicated BullMQ pool, and seeded models — indistinguishable in shape from how OpenAI or Ollama are wired today.
- Seed an initial batch of NIM-hosted models that this app can actually use, given it exclusively relies on structured (`generateObject`) output.

## Non-goals (explicitly deferred, not oversights)

- **Automatic free-tier dispatch rotation.** NVIDIA is seeded and manually dispatchable, but excluded from `FREE_TIER_POOLS`-driven automation (free-dispatch service, RPD-resume, the daily-automation burn sequence). The user wants to control dispatch by hand until the provider's real-world behavior is understood.
- **A real 429 classifier.** NIM's actual rate-limit signal shape (headers/body/reset semantics) is unverified — third-party sources disagreed on the free-tier's exact numbers. Ships as `null` (generic retry handling) per this codebase's established "never guess — verify against a real captured error" convention (see the SambaNova design doc, §11).
- **Full metadata/pricing backfill for models with no OpenRouter catalog match.** `ModelMetadataRefreshService` backfills `contextWindow`/pricing asynchronously via `openRouterSlug`; a model with no confirmed match ships with that field `NULL` and stays metadata-blank until manually confirmed or the daily refresh finds a match later.

## Provider shape

| | |
|---|---|
| Deployment | Hosted `build.nvidia.com` API — not self-hosted NIM containers |
| Base URL | `https://integrate.api.nvidia.com/v1` |
| Auth | Bearer token, `NVIDIA_API_KEY` |
| API shape | OpenAI-compatible `/v1/chat/completions` (vLLM-backed); NVIDIA's own docs note "response fields, tool-calling behavior, structured output... can vary by model" — this is the lowest common denominator, not a uniform guarantee |
| AI SDK integration | `@ai-sdk/openai-compatible`'s `createOpenAICompatible` — NIM has no dedicated community package (unlike SambaNova's `sambanova-ai-provider`), but is documented as an AI SDK "OpenAI-compatible provider" |
| Provider id / strategy | `nvidia` / `llm-nvidia`, following the `sambanova`/`llm-sambanova` naming convention |

## Initial model batch

Both of the two non-Nemotron models originally identified via documentation research (`meta/llama-3.3-70b-instruct`, `mistralai/mixtral-8x22b-instruct-v0.1`) turned out to be genuinely dead by the time of live implementation — NVIDIA's live API returned HTTP 410 Gone with explicit end-of-life dates (2026-08-26 and 2026-05-21 respectively) for both, despite documentation-era research finding no deprecation notice for either. This is exactly the scenario the "never guess — verify live" convention exists for: a live probe against the real NIM API caught a real-world drift that static research missed.

Rather than re-guess replacements from documentation again, the actual, empirically-verified NIM model catalog for this account (`GET /v1/models`) was fetched live and every plausible chat/instruct candidate (50 of the catalog's 81 entries, after filtering out embedding/vision/translation/parsing/safety-classifier models) was probed directly with a real `generateObject` call. Only 6 succeeded — NVIDIA Build's per-account model entitlements turned out to be a real, specific allowlist (not a single account-wide toggle, and not "every catalog-listed model is callable"), so a live catalog probe was the only reliable way to know what's actually usable:

| Model ID | Notes |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 256K context (up to 1M configurable), flagship Nemotron 3 tier |
| `nvidia/nemotron-3-super-120b-a12b` | mid-tier Nemotron 3 |
| `mistralai/mistral-nemotron` | Mistral-branded, NVIDIA-tuned — replaces the dead Mixtral pick as the "compare against existing Mistral conventions" model |
| `google/gemma-4-31b-it` | Google, via NIM — same underlying model already mapped for SambaNova's row (`google/gemma-4-31b-it` OpenRouter slug, confirmed in `1796000000000-add-sambanova-models.ts`) |
| `openai/gpt-oss-20b` | open-weight OpenAI model, also served via this codebase's Groq integration (`DEFAULT_GROQ_MODEL`) |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | smaller reasoning-tuned model — its structured-output call validated against the schema, but the `answer` field's content looked slightly off in testing (extra text bled in alongside the answer); worth extra scrutiny once real puzzle-solving traffic hits it, not a blocker |

`meta/llama-3.2-90b-vision-instruct`, `moonshotai/kimi-k3`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `z-ai/glm-5.3`, and `z-ai/glm-5.3-flash` timed out during the concurrent probe (one sibling call hit a "Worker local total request limit reached" error, suggesting the probe's own 6-way concurrency caused contention) — they are unconfirmed, not confirmed-dead, and were left out of this batch rather than guessed into it either way.

Since this app calls `generateObject` exclusively (no free-text chat path exists), a model that cannot reliably return schema-conformant JSON is useless to it regardless of other qualities. All 6 seeded models passed a live structured-output probe.

## Dispatch / queue architecture

A full `PROVIDER_POOLS` row, matching OpenAI/Ollama's shape exactly:

- `freeTier: null` — no free-tier config object, so it's automatically excluded from `FREE_TIER_POOLS` (which every automation consumer filters on) without any extra flag.
- Its own dedicated BullMQ queue, `llm-nvidia-runs`, and worker — `worker.ts`'s `for (const pool of PROVIDER_POOLS)` loop registers this automatically once the row exists, no separate worker-registration code needed.
- Manual/admin-triggered dispatch (`StrategyDispatch.triggerRun`) works independently of `PROVIDER_POOLS` membership — it only gates on `SupportedModelService.assertSupported`, so seeding the models is what makes them runnable; the pool row is what gives them queue isolation.

This is more setup than the minimal "just seed `SupportedModel`, ride the shared queue" alternative, but the user preferred dedicated queue isolation from the start over deferring it as a later upgrade.

## Rate-limit handling

`RATE_LIMIT_429_CLASSIFIERS.nvidia = null` in `orchestrator/src/solver.ts` — a 429 falls through to generic `model_error` handling (the AI SDK's own retry logic still applies before that). This is a deliberate placeholder: once real runs have been dispatched and a real 429 response captured (headers + body), a proper classifier can be written the way Google/Groq/OpenRouter/Mistral/SambaNova's were — by pattern-matching an actual response, not a guess from disputed third-party blog numbers.

## Model registration

A single TypeORM migration inserts `SupportedModel` rows only (`strategyName`, `modelName`, `supported`, `openRouterSlug`) — no `ModelPrice` row, matching the established convention for every other provider's seed migration (Groq, Mistral, SambaNova all omit it and let `ModelMetadataRefreshService` backfill real per-token pricing asynchronously via the OpenRouter match, even though the tier itself costs nothing to use).

`openRouterSlug` is set only where confirmed:
- `google/gemma-4-31b-it` → `google/gemma-4-31b-it` (the same underlying model already mapped for SambaNova's row in `1796000000000-add-sambanova-models.ts`).
- `openai/gpt-oss-20b` → `openai/gpt-oss-20b`, inferred from that migration's `gpt-oss-120b` row using its own model id verbatim as its OpenRouter slug — the same publisher/family, one size down, following the same convention rather than an independent OpenRouter lookup.
- The four NVIDIA-exclusive/NIM-tuned models (`nemotron-3-ultra-550b-a55b`, `nemotron-3-super-120b-a12b`, `mistral-nemotron`, `nemotron-3-nano-omni-30b-a3b-reasoning`) are left `NULL` — no confirmed OpenRouter catalog match exists for any of them.

## Registries touched

Following the multi-registry pattern this codebase already uses for every provider:

1. `orchestrator/package.json` — new `@ai-sdk/openai-compatible` dependency.
2. `orchestrator/src/provider.ts` — `ModelProvider` union, `getModel`/`getModelName`/`defaultProvider` branches, `DEFAULT_NVIDIA_MODEL`.
3. `orchestrator/src/solver.ts` — `RATE_LIMIT_429_CLASSIFIERS.nvidia = null`.
4. `backend/src/strategies.ts` — `LLM_NVIDIA`, `SUPPORTED_STRATEGIES`, `LLM_STRATEGIES`.
5. `backend/src/modules/provider-pool/provider-pool.config.ts` — `ProviderPoolId` union, new `PROVIDER_POOLS` row.
6. `backend/src/modules/queue/strategy.queue.ts`, `queue.module.ts`, `strategy-dispatch.service.ts`, `strategy-read.service.ts`, `app.setup.ts` — the manual per-provider queue wiring every existing provider requires (queue export, DI token, injection, Bull Board registration).
7. `frontend/src/data/benchmark/providerPools.ts` — the UI filter row.
8. `backend/src/config/env.ts` — `JUDGE_PROVIDERS`, so NVIDIA can also ride as a judge provider (mirrors every other pool, per that array's own stated invariant).
9. A new migration seeding `SupportedModel` rows.
10. `README.md` / `.env.sample` — `NVIDIA_API_KEY`, `NVIDIA_MODEL`, `LLM_NVIDIA_CONCURRENCY` documentation.

## Documentation placement

This design doc is placed at `docs/specs/` rather than `docs/superpowers/specs/` (where the SambaNova precedent doc lives) per the user's standing preference to keep AI-authored design docs out of that directory. The paired implementation plan stays at the default `docs/superpowers/plans/` location.
