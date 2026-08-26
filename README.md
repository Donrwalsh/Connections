[![Frontend Tests](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml)
[![Backend Tests](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml)
[![Orchestrator Tests](https://github.com/donrwalsh/Connections/actions/workflows/orchestrator-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/orchestrator-tests.yml)

# Connections

A multi-service application for playing and solving [NYT Connections](https://www.nytimes.com/games/connections) puzzles. Play the 4×4 word-grouping puzzle in your browser, use an LLM (GPT-4o or a local Ollama model) for AI-powered guesses, or watch brute-force strategies (deterministic orderings plus randomized shuffle-smart and shuffle-foolish trials) work through every puzzle step-by-step.

## Features

- **Playable puzzle board** — 16 words, select 4, submit; color-coded reveals (yellow/green/blue/purple), up to 4 mistakes
- **AI Assist** — GPT-4o (by default) proposes one group of 4 from the remaining words, answering by index and never repeating a previously-guessed wrong group
- **Dual LLM strategies** — `llm-openai` (GPT-4o) and `llm-ollama` (local model via Ollama) run side-by-side as independent strategy trials, so the two providers can be compared on the same puzzle
- **Date navigation** — browse any puzzle from 2023-06-12 to today, plus a random picker
- **Deterministic strategies** — four brute-force strategies (`alphabetical`, `reverse-alphabetical`, `order`, `reverse-order`) run automatically on every puzzle, with full guess-by-guess results viewable in a side panel
- **Shuffle strategies** — `shuffle-smart` guesses random groups without repeating, `shuffle-foolish` guesses random groups and may repeat them
- **Automatic puzzle ingestion** — a daily cron fetches new puzzles from NYT and queues the deterministic and shuffle strategies (LLM strategies are dispatched by hand, to control token spend)
- **Share results** — copy an NYT-style emoji grid to your clipboard

## Architecture

| Service | Directory | Framework | Port | Role |
|---------|-----------|-----------|------|------|
| **Backend** | `backend/` | NestJS | 4000 | REST API, Swagger, Bull Board |
| **Frontend** | `frontend/` | Vite + React 19 | 5173 | Single-page app |
| **Orchestrator** | `orchestrator/` | Hono + AI SDK | 3001 | AI puzzle solving (OpenAI + Ollama) |
| **Worker** | `backend/src/worker.ts` | BullMQ | — | Processes strategy, per-provider LLM, and puzzle queues |
| **Database** | — | Postgres 15 | 5432 | Schema via TypeORM migrations |
| **Redis** | — | Redis 7 | 6379 | BullMQ message broker |
| **Ollama** | — | — | 11434 | Local LLM provider (default: `llama3.2`) |

Production also runs an `adminer` service for database review — see [Production deployment](#production-deployment).

The worker runs as a separate process from the NestJS server (started via `npx tsx --watch src/worker.ts` in dev). It bootstraps its own NestJS app context to access services. Both LLM providers are configured and used simultaneously: the `llm-openai` strategy consults OpenAI, `llm-ollama` an Ollama service. The two LLM strategies run on separate queues (`llm-openai-runs` / `llm-ollama-runs`) with their own per-provider concurrency (`LLM_OPENAI_CONCURRENCY` / `LLM_OLLAMA_CONCURRENCY`), so the providers never block each other or the deterministic strategies. Provider-less requests (e.g. the in-game AI Assist) use the `MODEL_PROVIDER` default (`openai`).

This table and diagram describe local dev (`docker-compose.yml`), where Ollama runs bundled alongside everything else. The production setup (`docker-compose.prod.yml`) has no Ollama service and splits the worker in two by role — see [Production deployment](#production-deployment) below.

### Puzzle solving flow

```
Daily cron (06:00 UTC)
  └─ puzzle-population queue ──► worker ──► fetches NYT puzzle ──► Postgres
       └─ queues strategy runs ──► strategy-runs queue ──► worker ──► solve
            (4 deterministic + SHUFFLE_TRIALS shuffle-smart trials + SHUFFLE_TRIALS shuffle-foolish trials)
            (LLM strategies are never queued automatically — dispatch them by hand, below)

Frontend "AI Assist" button
  └─ POST /api/diagnose ──► backend ──► POST /diagnose ──► orchestrator ──► default provider (openai)

Frontend strategy panel (llm-openai / llm-ollama buttons)
  └─ POST /dispatch/model/:model/:date ──► worker ──► POST /solve-assist ──► orchestrator ──► OpenAI or Ollama
       (strategy is resolved from the model's SupportedModel row; queues one new trial of
       `model` per call, up to LLM_TRIALS_PER_MODEL trials for that model)
```

## Getting Started

### Prerequisites

- Docker and Docker Compose
- An [OpenAI API key](https://platform.openai.com/api-keys) (for AI Assist)

### Setup

1. Copy the example environment file and fill in your values:

```bash
cp .env.sample .env
```

You must set at least `INTERNAL_API_KEY` (any shared secret) and `OPENAI_API_KEY` (for AI Assist). `GOOGLE_API_KEY` is only required if you plan to dispatch `llm-google` runs. All variables are documented in `.env.sample`.

2. Start all services:

```bash
docker compose up
```

3. Open the app:

| URL | What |
|-----|------|
| `http://localhost:5173` | Frontend |
| `http://localhost:4000/api/docs` | Swagger API docs |
| `http://localhost:4000/bull/login` | Bull Board queue dashboard login (`BULL_BOARD_USER` / `BULL_BOARD_PASS`, defaults `admin` / `bullboard`) |

On first startup the worker fetches all historical puzzles and runs every deterministic and shuffle strategy on each (four deterministic runs plus `SHUFFLE_TRIALS` shuffle-smart trials and `SHUFFLE_TRIALS` shuffle-foolish trials). This can take a while for large backlogs. LLM strategies are never dispatched automatically, and `/dispatch/strategy` does not accept them either — dispatch a supported model explicitly via `/dispatch/model/:modelName/:date` when you want to spend tokens.

## Configuration

Environment variables are defined in `.env` at the project root (see [`.env.sample`](.env.sample) for the full list with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_API_KEY` | — | Shared secret for backend↔orchestrator communication (`x-internal-api-key` header) — **required** |
| `OPENAI_API_KEY` | — | OpenAI API key (orchestrator only) |
| `GOOGLE_API_KEY` | — | Google AI Studio API key (orchestrator only) |
| `MODEL_PROVIDER` | `openai` | Default provider for provider-less requests (e.g. in-game AI Assist): `openai`, `ollama`, or `google`. Strategy runs pick their provider via strategy name (`llm-openai` / `llm-ollama` / `llm-google`), so all three are always active |
| `OPENAI_MODEL` | `gpt-4.1-nano` | OpenAI model id (used by the `llm-openai` strategy and provider-less requests) |
| `GOOGLE_MODEL` | `gemini-2.5-flash` | Google AI Studio model id (used by the `llm-google` strategy and provider-less requests) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server base URL (used by the `llm-ollama` strategy) |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model id (used by the `llm-ollama` strategy) |
| `MODEL_CONTEXT_WINDOW` | `8192` | Hard ceiling (in tokens) on Ollama's `num_ctx`, never exceeded regardless of a model's real `contextWindow` (see `SupportedModel`) — llama.cpp reserves `num_ctx`'s full KV-cache footprint at model-load time rather than scaling it to actual usage, so requesting a model's true context in full (e.g. 131K) can OOM-kill Ollama on memory-constrained hardware even though real prompts never come close to using it. Also the fallback when no per-model `contextWindow` is known at all (e.g. the provider-less AI Assist path) |
| `BULL_BOARD_USER` / `BULL_BOARD_PASS` | `admin` / `bullboard` | Login credentials for the Bull Board dashboard's login page at `/bull/login` (must be set together, or not at all) |
| `DISPATCH_PASSWORD` | — | Password checked against the `password` field on `POST /dispatch/model/:modelName/:date`, `POST /dispatch/model/:modelName/runs/:n`, `POST /dispatch/free-tier/:tier`, `DELETE /dispatch/run/:runId`, and `POST /dispatch/refresh-model-metadata` — the dispatch routes that queue paid LLM calls, permanently delete a run, or trigger an on-demand metadata refresh. Only enforced when `NODE_ENV=production` (baked into `backend/Dockerfile`); **required** once it is — the backend/worker refuse to boot without it |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed frontend origins |
| `ORCHESTRATOR_URL` | `http://orchestrator:3001` | Backend's URL for reaching the orchestrator |
| `ORCHESTRATOR_TIMEOUT_MS` | `600000` | Per-attempt HTTP timeout for solve calls, since timeouts are not retried — a firing timeout now also cancels the orchestrator's in-flight OpenAI call |
| `PUZZLE_POPULATION_CRON` | `0 6 * * *` | Cron pattern for daily puzzle fetch (UTC by default) |
| `PUZZLE_POPULATION_TZ` | `UTC` | Timezone for the puzzle population cron |
| `MODEL_METADATA_REFRESH_CRON` | `0 7 * * *` | Cron pattern for the daily OpenRouter model-metadata/pricing refresh (UTC by default) |
| `PUZZLE_CACHE_DIR` | `/app/.puzzle-cache` | Directory used as a local cache of raw NYT puzzle payloads (bound to `./.puzzle-cache` on the host) |
| `SHUFFLE_TRIALS` | `3` | Number of trials run per puzzle for each shuffle strategy — shuffle-smart and shuffle-foolish share this one value. shuffle-foolish keeps sampling (repeats included) with no duplicate limit until it solves |
| `LLM_TRIALS_PER_MODEL` | `3` | Maximum number of independent trials a single LLM model may accumulate per puzzle. Applies per model, not per strategy run — each LLM dispatch queues one new trial (rejecting once a model hits this cap), and a different model gets its own independent budget |
| `LLM_MAX_DUPLICATE_GUESSES` | `10` | Maximum repeated groups an LLM run may propose before it ends with a `duplicate` status (applies to both `llm-openai` and `llm-ollama`) |
| `LLM_MAX_MALFORMED_RESPONSES` | `3` | Maximum consecutive malformed LLM responses before a run ends with a `malformedResponse` status |
| `LLM_MAX_MODEL_ERRORS` | `5` | Maximum consecutive transient model failures before a run ends with an `error` status |
| `LLM_MAX_PROMPTS` | `19` | Maximum prompts a single solve step makes before the orchestrator accepts a duplicate |
| `LLM_NUM_RESPONSES` | `1` | Number of candidate groups the LLM proposes per solve step (clamped to 10); the orchestrator asks for one more on each duplicate re-prompt |
| `LLM_TEMPERATURE_BASE` | `0.2` | Fixed sampling temperature for every LLM solve step — the temperature never ramps; only the requested candidate count escalates on re-prompts |
| `LLM_OPENAI_CONCURRENCY` | `1` | Maximum `llm-openai` runs the worker processes at once (own queue, so it never blocks Ollama, Google, or the deterministic strategies) |
| `LLM_OLLAMA_CONCURRENCY` | `1` | Maximum `llm-ollama` runs the worker processes at once (own queue, so it never blocks OpenAI, Google, or the deterministic strategies) |
| `LLM_GOOGLE_CONCURRENCY` | `1` | Maximum `llm-google` runs the worker processes at once (own queue, so it never blocks OpenAI, Ollama, or the deterministic strategies) |
| `PORT` | `3001` | Orchestrator listen port |
| `POSTGRES_USER` | `postgres` | Postgres user (compose-level; the backend reads it as `DB_USER`) |
| `POSTGRES_PASSWORD` | `postgres` | Postgres password (compose-level; the backend reads it as `DB_PASSWORD`) |
| `POSTGRES_DB` | `mydb` | Postgres database name (compose-level; the backend reads it as `DB_NAME`) |
| `WORKER_ROLE` | `all` | Which BullMQ queues a worker process consumes: `all` (dev), `cloud` (every queue except `llm-ollama-runs`), or `ollama` (only `llm-ollama-runs`) — see [Production deployment](#production-deployment) |
| `DB_MIGRATIONS_RUN` | `true` | Whether this process runs pending TypeORM migrations at startup — set `false` on a worker sharing a database with another instance that already owns migrations |
| `REDIS_PASSWORD` | — | Redis auth password; unset (unauthenticated) by default, matching local dev — required whenever Redis is reachable beyond the trusted deploy network |
| `VITE_API_URL` | `http://localhost:4000` | Backend origin baked into the frontend bundle at build time (not a runtime env var — passed as a Docker build arg) |

Postgres and Redis connection settings (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `REDIS_HOST`, `REDIS_PORT`) are read from the same `.env` — see [`.env.sample`](.env.sample) for defaults.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/game/puzzle/today` | Today's puzzle |
| `GET` | `/game/puzzle/:date` | Puzzle for a `YYYY-MM-DD` date |
| `GET` | `/game/data/latest_date` | Most recent puzzle date |
| `POST` | `/dispatch/strategy/:strategyName/:date` | Enqueue a strategy run (or `all`; the LLM strategies are not accepted) |
| `POST` | `/dispatch/model/:modelName/:date` | Enqueue an LLM trial for a supported model — strategy is resolved from the model's `SupportedModel` row |
| `POST` | `/dispatch/model/:modelName/runs/:n` | Enqueue `n` trials for a supported model, one on each of `n` randomly chosen puzzle dates that model hasn't run yet — rejects if fewer than `n` such dates exist |
| `DELETE` | `/dispatch/run/:runId` | Permanently delete a strategy run and everything tied to it (guesses, solve prompts, LLM proposals) — rejects a still-`running` run |
| `GET` | `/strategy/:strategyName/puzzle/:date` | All runs for a strategy — ordered guesses per trial |
| `POST` | `/api/diagnose` | AI Assist — proxy to orchestrator (throttled to 5/min/IP) |
| `GET` | `/health` | Liveness/readiness probe (503 when the DB is down) |

## Development & Testing

Requires Node 24.

```bash
# Backend (Jest)
cd backend && npm test

# Backend end-to-end tests — needs a running Postgres + Redis (see below)
cd backend && npm run test:e2e

# Backend lint / format
cd backend && npm run lint && npm run format

# Frontend (Vitest — use test:run for single pass)
cd frontend && npm run test:run

# Orchestrator (Vitest)
cd orchestrator && npm run test:run

# Full typecheck
cd backend && npm run build
cd frontend && npm run build
cd orchestrator && npm run typecheck
```

There is no single "test all" command — run each package separately. Backend unit tests require `--forceExit` (already in the script) because BullMQ and TypeORM connections stay open after tests complete.

The backend E2E suite (`backend/test/app.e2e-spec.ts`) boots the real NestJS app against a dedicated Postgres database and Redis. It reuses the compose Postgres (`docker compose up -d db redis`) but connects to a separate `connections_test` database that is created and migrated on first run, so it never touches the dev data:

## Project Structure

```
├── backend/                   # NestJS API server + worker
│   ├── src/
│   │   ├── main.ts            # Bootstrap (loads env, starts server)
│   │   ├── app.setup.ts       # Shared HTTP pipeline (CORS, validation, Bull Board, Swagger)
│   │   ├── app.controller.ts  # /health, /api/diagnose
│   │   ├── app.service.ts     # Orchestrator proxy, health checks
│   │   ├── config/env.ts      # Typed env loading — fails fast on missing secrets
│   │   ├── migrations/        # TypeORM migrations (initial schema baseline)
│   │   ├── worker.ts          # Standalone BullMQ worker process
│   │   ├── strategies.ts      # Strategy name constants
│   │   └── modules/
│   │       ├── game/          # Puzzle CRUD, evaluation, NYT ingestion, cron
│   │       ├── strategy/      # Brute-force + shuffle strategies
│   │       └── queue/         # BullMQ queue definitions + Redis config
│   └── test/                  # jest-e2e config + app.e2e-spec.ts (needs Postgres/Redis)
├── frontend/                  # Vite + React 19 SPA
│   ├── Dockerfile             # Production multi-stage build (Vite → nginx)
│   ├── Dockerfile.dev         # Dev image used by docker compose (hot reload)
│   ├── nginx.conf             # SPA fallback + immutable asset caching
│   └── src/
│       ├── components/        # Board, Tiles, GameOverModal, ShareResult, etc.
│       ├── pages/             # PuzzlePage (the only route)
│       ├── lib/               # gameReducer, aiAssistPrompts, shareResult
│       └── hooks/             # useConnectionsGame
├── orchestrator/              # Hono + AI SDK
│   └── src/
│       ├── index.ts           # Server bootstrap
│       ├── app.ts             # Hono routes + auth middleware (testable)
│       ├── solver.ts          # generateObject call to the selected model
│       ├── prompt.ts          # Prompt builder
│       └── types.ts           # Zod schemas (request/response/model output)
├── docker-compose.yml          # Local dev — all services including Ollama, bind-mounted source
├── docker-compose.prod.yml     # Production (e.g. Coolify) — built images, no Ollama
└── docker-compose.local-ollama-worker.yml  # Runs on your machine — Ollama + local orchestrator + WORKER_ROLE=ollama worker
```

## Production deployment

`docker-compose.yml` is dev-only (bind-mounted source, `npm run dev`/watch commands, DB/Redis ports published to the host). Production deploys — e.g. to [Coolify](https://coolify.io) — use `docker-compose.prod.yml` instead, which builds the real images (`backend/Dockerfile`, `orchestrator/Dockerfile`, and `frontend/Dockerfile`, all multi-stage) and runs them without bind mounts.

```bash
cp .env.sample .env   # fill in INTERNAL_API_KEY, OPENAI_API_KEY, POSTGRES_PASSWORD,
                       # CORS_ORIGIN, VITE_API_URL, REDIS_PASSWORD, DISPATCH_PASSWORD —
                       # see .env.sample
docker compose -f docker-compose.prod.yml up -d --build
```

`backend/Dockerfile` bakes in `NODE_ENV=production`, which turns on `DispatchAuthGuard` (`backend/src/modules/dispatch/dispatch-auth.guard.ts`): the paid-provider dispatch routes — `POST /dispatch/model/:modelName/:date`, `POST /dispatch/model/:modelName/runs/:n`, `POST /dispatch/free-tier/:tier` — and the run-deletion route, `DELETE /dispatch/run/:runId`, then reject any request whose JSON body doesn't include a matching `"password"` field. `loadEnv()` fails the backend/worker processes at boot if `DISPATCH_PASSWORD` isn't set once `NODE_ENV=production`, so there's no way to accidentally deploy prod without it. Local dev (`docker-compose.yml`, no `NODE_ENV=production`) never requires a password on these routes.

### Reviewing production data (Adminer)

`docker-compose.prod.yml` also runs [Adminer](https://www.adminer.org/), a lightweight Postgres browser, at `http://<host>:8091`. It reuses the existing `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` from `.env` — no separate credentials to set up. Unlike Bull Board (`/bull/login`, gated by a login form checked against `BULL_BOARD_USER`/`BULL_BOARD_PASS` before the dashboard itself is reachable), Adminer runs as its own container and relies solely on its own DB-login form — publishing port 8091 makes that login page reachable by anyone with the URL, though real access still requires the Postgres password. Don't publish this port on a host without other network-level protection (a private tunnel, or Coolify/firewall access rules) — the same caution as the commented-out `db`/`redis` ports in `docker-compose.prod.yml`.

### No Ollama in the cloud — Option B (a local worker pulls jobs to your machine)

The deployed stack has no Ollama service at all. Rather than exposing a local Ollama install to the internet, a second BullMQ worker runs on your own machine and *pulls* `llm-ollama-runs` jobs from the deployed Redis/Postgres over an outbound connection — nothing on your machine needs to be reachable from outside your network.

This works because `backend/src/worker.ts` reads a `WORKER_ROLE` env var (see `workerRole()` in `backend/src/strategies.ts`):

| Role | Queues processed | Used by |
|------|-------------------|---------|
| `all` (default) | everything, including `llm-ollama-runs` | local dev (`docker-compose.yml`, unchanged) |
| `cloud` | everything *except* `llm-ollama-runs` | `docker-compose.prod.yml`'s `worker` service |
| `ollama` | only `llm-ollama-runs` | your machine's worker (`docker-compose.local-ollama-worker.yml`) |

One subtlety: neither worker ever calls a model API directly — `LlmStrategyRunner` always calls out to an orchestrator's `POST /solve-assist` (see `backend/src/modules/strategy/orchestrator.service.ts`), and the orchestrator is what actually talks to OpenAI or Ollama. So `docker-compose.local-ollama-worker.yml` runs *three* services on your machine: `ollama`, a second small `orchestrator` instance configured with `OLLAMA_BASE_URL=http://ollama:11434`, and the `WORKER_ROLE=ollama` worker — the worker only ever calls its local orchestrator, which is the only thing that talks to Ollama. Nothing on your machine listens on a port reachable from the internet.

Setup:

1. On the Coolify host: deploy `docker-compose.prod.yml` as above.
2. On your machine: `cp .env.local-ollama-worker.sample .env.local-ollama-worker`, fill in `REMOTE_DB_*`/`REMOTE_REDIS_*` (pointing at the deployed Postgres/Redis) and a `LOCAL_INTERNAL_API_KEY` (any random string — it's local-only, shared only between your machine's worker and orchestrator, and doesn't need to match the deployed stack's `INTERNAL_API_KEY`), then:
   ```bash
   docker compose -f docker-compose.local-ollama-worker.yml --env-file .env.local-ollama-worker up -d --build
   ```

Two things worth taking seriously before you do this:

- **Reachability.** The local worker needs your deployed Postgres *and* Redis reachable from your machine — not just Redis. Prefer a private tunnel (Tailscale, WireGuard) between your machine and the Coolify host over publishing their ports to the public internet. If you do publish them, `REDIS_PASSWORD` (set in the deployed stack's `.env`) is mandatory, and use a strong `POSTGRES_PASSWORD` too — see the commented-out `ports:` blocks on `db`/`redis` in `docker-compose.prod.yml`.
- **Migrations.** Both workers boot the same `AppModule`, which normally runs pending TypeORM migrations at startup. Two independent processes doing that against the same database — possibly from different code versions — is asking for trouble, so the local worker sets `DB_MIGRATIONS_RUN=false` (see `backend/src/config/env.ts`): only the deployed backend/worker ever applies schema changes. Keep your local checkout reasonably close to whatever's deployed, since the local worker's compiled entities still need to match the live schema.
- **Parallelism.** `LLM_OLLAMA_CONCURRENCY` only controls how many jobs *this worker* pulls at once — it does nothing to make Ollama itself serve them in parallel. `docker-compose.local-ollama-worker.yml`'s `ollama` service also sets `OLLAMA_NUM_PARALLEL` (default 3, matching `LLM_OLLAMA_CONCURRENCY`'s default) so requests actually run concurrently instead of queueing inside Ollama. Each parallel slot needs its own `MODEL_CONTEXT_WINDOW`-sized KV cache, so raise both together with your machine's RAM/VRAM in mind — a large `num_ctx` multiplied across several parallel slots is a common way to OOM-kill Ollama's `llama-server` (`signal: killed` in its logs).

If your machine is off or Ollama isn't running, `llm-ollama` runs just fail after their existing retry/backoff (`LLM_MAX_MODEL_ERRORS`) and end in an `error` status — nothing else in the deployed stack depends on Ollama being reachable.

## Notes

- The frontend `package.json` proxy setting (`"proxy": "http://nest_backend:4000"`) is for Docker networking only — local dev uses `VITE_API_URL` instead.
- Database schema is managed entirely by TypeORM migrations in `backend/src/migrations/` (baseline: `1754400000000-initial-schema.ts`). The app runs with `synchronize: false`; `migrationsRun` defaults to `true` (see `DB_MIGRATIONS_RUN`), so an empty database (CI, fresh local Postgres, `docker-compose down -v`) is bootstrapped automatically on backend/worker startup — there's no separate SQL init script.
- For a production frontend image, build with the multi-stage `frontend/Dockerfile` (Vite build served by nginx). Pass the API base at build time: `docker build --build-arg VITE_API_URL=https://api.example.com -f frontend/Dockerfile frontend/`. `docker-compose.prod.yml` does this automatically from `VITE_API_URL` in `.env`.
