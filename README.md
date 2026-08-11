[![Frontend Tests](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml)
[![Backend Tests](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml)
[![Orchestrator Tests](https://github.com/donrwalsh/Connections/actions/workflows/orchestrator-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/orchestrator-tests.yml)

# Connections

A multi-service application for playing and solving [NYT Connections](https://www.nytimes.com/games/connections) puzzles. Play the 4×4 word-grouping puzzle in your browser, use GPT-4o for AI-powered guesses, or watch brute-force strategies (deterministic orderings plus randomized shuffle-smart and shuffle-foolish trials) work through every puzzle step-by-step.

## Features

- **Playable puzzle board** — 16 words, select 4, submit; color-coded reveals (yellow/green/blue/purple), up to 4 mistakes
- **AI Assist** — GPT-4o proposes one group of 4 from the remaining words, answering by index and never repeating a previously-guessed wrong group
- **Date navigation** — browse any puzzle from 2023-06-12 to today, plus a random picker
- **Deterministic strategies** — four brute-force strategies (`alphabetical`, `reverse-alphabetical`, `order`, `reverse-order`) run automatically on every puzzle, with full guess-by-guess results viewable in a side panel
- **Shuffle strategies** — `shuffle-smart` guesses random groups without repeating, `shuffle-foolish` guesses random groups and may repeat them
- **Automatic puzzle ingestion** — a daily cron fetches new puzzles from NYT and queues all four strategies
- **Share results** — copy an NYT-style emoji grid to your clipboard

## Architecture

| Service | Directory | Framework | Port | Role |
|---------|-----------|-----------|------|------|
| **Backend** | `backend/` | NestJS | 4000 | REST API, Swagger, Bull Board |
| **Frontend** | `frontend/` | Vite + React 19 | 5173 | Single-page app |
| **Orchestrator** | `orchestrator/` | Hono + AI SDK | 3001 | AI puzzle solving (GPT-4o or Ollama) |
| **Worker** | `backend/src/worker.ts` | BullMQ | — | Processes strategy + puzzle queues |
| **Database** | `database/` | Postgres 15 | 5432 | Schema + seeds |
| **Redis** | — | Redis 7 | 6379 | BullMQ message broker |
| **Ollama** | — | — | 11434 | Local LLM provider — optional AI Assist backend (default: `llama3.2`) |

The worker runs as a separate process from the NestJS server (started via `npx tsx --watch src/worker.ts`). It bootstraps its own NestJS app context to access services. The orchestrator uses GPT-4o by default; set `MODEL_PROVIDER=ollama` to run AI Assist against the bundled local Ollama service instead.

### Puzzle solving flow

```
Daily cron (06:00 UTC)
  └─ puzzle-population queue ──► worker ──► fetches NYT puzzle ──► Postgres
       └─ queues strategy runs ──► strategy-runs queue ──► worker ──► solve
            (4 deterministic + SHUFFLE_SMART_TRIALS shuffle-smart trials + SHUFFLE_FOOLISH_TRIALS shuffle-foolish trials)

Frontend "AI Assist" button
  └─ POST /api/solve ──► backend ──► POST /solve ──► orchestrator ──► GPT-4o
       └─ validated index-based group returned to UI
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

You must set at least `INTERNAL_API_KEY` (any shared secret) and `OPENAI_API_KEY` (for AI Assist). All variables are documented in `.env.sample`.

2. Start all services:

```bash
docker compose up
```

3. Open the app:

| URL | What |
|-----|------|
| `http://localhost:5173` | Frontend |
| `http://localhost:4000/api/docs` | Swagger API docs |
| `http://localhost:4000/admin/queues` | Bull Board queue dashboard (basic auth — `BULL_BOARD_USER` / `BULL_BOARD_PASS`, defaults `admin` / `bullboard`) |

On first startup the worker fetches all historical puzzles and runs all strategies on each (four deterministic runs plus `SHUFFLE_SMART_TRIALS` shuffle-smart trials and `SHUFFLE_FOOLISH_TRIALS` shuffle-foolish trials). This can take a while for large backlogs.

## Configuration

Environment variables are defined in `.env` at the project root (see [`.env.sample`](.env.sample) for the full list with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_API_KEY` | — | Shared secret for backend↔orchestrator communication (`x-internal-api-key` header) — **required** |
| `OPENAI_API_KEY` | — | OpenAI API key (orchestrator only) |
| `MODEL_PROVIDER` | `openai` | AI model provider: `openai` (default) or `ollama` (local, via the bundled Ollama service) |
| `OPENAI_MODEL` | `gpt-4o-2024-08-06` | OpenAI model id (used when `MODEL_PROVIDER=openai`) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server base URL (used when `MODEL_PROVIDER=ollama`) |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model id (used when `MODEL_PROVIDER=ollama`) |
| `MODEL_CONTEXT_WINDOW` | `8192` | Context window (in tokens) used to size the LLM solver prompt |
| `BULL_BOARD_USER` / `BULL_BOARD_PASS` | `admin` / `bullboard` | Basic-auth credentials for the Bull Board dashboard (must be set together, or not at all) |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated list of allowed frontend origins |
| `ORCHESTRATOR_URL` | `http://orchestrator:3001` | Backend's URL for reaching the orchestrator |
| `ORCHESTRATOR_TIMEOUT_MS` | `120000` | Per-attempt HTTP timeout for solve calls — must cover a whole multi-prompt step (up to `LLM_MAX_PROMPTS` model calls), since timeouts are not retried |
| `PUZZLE_POPULATION_CRON` | `0 6 * * *` | Cron pattern for daily puzzle fetch (UTC by default) |
| `PUZZLE_POPULATION_TZ` | `UTC` | Timezone for the puzzle population cron |
| `PUZZLE_CACHE_DIR` | `/app/.puzzle-cache` | Directory used as a local cache of raw NYT puzzle payloads (bound to `./.puzzle-cache` on the host) |
| `SHUFFLE_SMART_TRIALS` | `3` | Number of shuffle-smart trials run per puzzle |
| `SHUFFLE_FOOLISH_TRIALS` | `3` | Number of shuffle-foolish trials run per puzzle |
| `SHUFFLE_FOOLISH_DUPLICATE_LIMIT` | `3` | Maximum repeated groups a shuffle-foolish run may propose before it ends with a `duplicate` status |
| `LLM_MAX_DUPLICATE_GUESSES` | `10` | Maximum repeated groups an LLM run may propose before it ends with a `duplicate` status |
| `LLM_MAX_MALFORMED_RESPONSES` | `3` | Maximum consecutive malformed LLM responses before a run ends with a `malformedResponse` status |
| `LLM_MAX_MODEL_ERRORS` | `5` | Maximum consecutive transient model failures before a run ends with an `error` status |
| `LLM_MAX_PROMPTS` | `19` | Maximum prompts a single solve step makes before the orchestrator accepts a duplicate |
| `LLM_NUM_RESPONSES` | `1` | Number of candidate groups the LLM proposes per solve step (clamped to 10) |
| `LLM_TEMPERATURE_BASE` | `0` | Starting sampling temperature for LLM solve steps |
| `LLM_TEMPERATURE_MAX` | `3.2` | Ceiling for the LLM temperature ramp (100 increments from base to ceiling) |
| `PORT` | `3001` | Orchestrator listen port |
| `POSTGRES_USER` | `postgres` | Postgres user (compose-level; the backend reads it as `DB_USER`) |
| `POSTGRES_PASSWORD` | `postgres` | Postgres password (compose-level; the backend reads it as `DB_PASSWORD`) |
| `POSTGRES_DB` | `mydb` | Postgres database name (compose-level; the backend reads it as `DB_NAME`) |

Postgres and Redis connection settings (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `REDIS_HOST`, `REDIS_PORT`) are read from the same `.env` — see [`.env.sample`](.env.sample) for defaults.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/game/puzzle/today` | Today's puzzle |
| `GET` | `/game/puzzle/:date` | Puzzle for a `YYYY-MM-DD` date |
| `GET` | `/game/data/latest_date` | Most recent puzzle date |
| `POST` | `/strategy/queue/:strategyName/:date` | Enqueue a strategy run (or `all`) |
| `GET` | `/strategy/:strategyName/puzzle/:date` | All runs for a strategy — ordered guesses per trial |
| `POST` | `/api/solve` | AI Assist — proxy to orchestrator (throttled to 5/min/IP) |
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
│   │   ├── app.controller.ts  # /health, /api/solve
│   │   ├── app.service.ts     # Orchestrator proxy (retry/backoff), health checks
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
│       ├── lib/               # gameReducer, renderProposedGroup, shareResult
│       └── hooks/             # useConnectionsGame
├── orchestrator/              # Hono + AI SDK
│   └── src/
│       ├── index.ts           # Server bootstrap
│       ├── app.ts             # Hono routes + auth middleware (testable)
│       ├── solver.ts          # generateObject call to GPT-4o
│       ├── prompt.ts          # Prompt builder
│       └── types.ts           # Zod schemas (request/response/model output)
├── database/
│   └── 01-schema.sql          # Tables + enums (Postgres 15) — baseline for migrations
└── docker-compose.yml         # Orchestrates all services + Redis/Postgres
```

## Notes

- The frontend `package.json` proxy setting (`"proxy": "http://nest_backend:4000"`) is for Docker networking only — local dev uses `VITE_API_URL` instead.
- Database schema is managed by `database/01-schema.sql`, which TypeORM migrations treat as the baseline. The app runs with `synchronize: false` and `migrationsRun: true`; the baseline migration in `backend/src/migrations/` is idempotent so it also bootstraps empty databases (CI, fresh local Postgres).
- For a production frontend image, build with the multi-stage `frontend/Dockerfile` (Vite build served by nginx). Pass the API base at build time: `docker build --build-arg VITE_API_URL=https://api.example.com -f frontend/Dockerfile frontend/`.
