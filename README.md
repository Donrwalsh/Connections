[![Frontend Tests](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/frontend-tests.yml)
[![Backend Tests](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml/badge.svg?branch=master)](https://github.com/donrwalsh/Connections/actions/workflows/backend-tests.yml)

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
| `http://localhost:4000/admin/queues` | Bull Board queue dashboard |

On first startup the worker fetches all historical puzzles and runs all strategies on each (four deterministic runs plus `SHUFFLE_SMART_TRIALS` shuffle-smart trials and `SHUFFLE_FOOLISH_TRIALS` shuffle-foolish trials). This can take a while for large backlogs.

## Configuration

Environment variables are defined in `.env` at the project root (see [`.env.sample`](.env.sample) for the full list with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_API_KEY` | — | Shared secret for backend↔orchestrator communication (`x-internal-api-key` header) |
| `OPENAI_API_KEY` | — | OpenAI API key (orchestrator only) |
| `PUZZLE_POPULATION_CRON` | `0 6 * * *` | Cron pattern for daily puzzle fetch (UTC by default) |
| `PUZZLE_POPULATION_TZ` | `UTC` | Timezone for the puzzle population cron |
| `SHUFFLE_SMART_TRIALS` | `3` | Number of shuffle-smart trials run per puzzle |
| `SHUFFLE_FOOLISH_TRIALS` | `3` | Number of shuffle-foolish trials run per puzzle |
| `PORT` | `3001` | Orchestrator listen port |

Database and Redis settings (`DB_HOST`, `DB_PORT`, `REDIS_HOST`, etc.) are configured directly in `docker-compose.yml` — the defaults work out of the box.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/game/puzzle/today` | Today's puzzle |
| `GET` | `/game/puzzle/:date` | Puzzle for a `YYYY-MM-DD` date |
| `GET` | `/game/data/latest_date` | Most recent puzzle date |
| `POST` | `/strategy/queue/:strategyName/:date` | Enqueue a strategy run (or `all`) |
| `GET` | `/strategy/:strategyName/puzzle/:date` | All runs for a strategy — ordered guesses per trial |
| `POST` | `/api/solve` | AI Assist — proxy to orchestrator |
| `GET` | `/api/orchestrator/health` | Orchestrator health check |

## Development & Testing

Requires Node 24.

```bash
# Backend (Jest)
cd backend && npm test

# Frontend (Vitest — use test:run for single pass)
cd frontend && npm run test:run

# Full typecheck
cd backend && npm run build
cd frontend && npm run build
cd orchestrator && npm run typecheck
```

There is no single "test all" command — run each package separately. Backend tests require `--forceExit` (already in the script) because BullMQ and TypeORM connections stay open after tests complete.

## Project Structure

```
├── backend/                   # NestJS API server + worker
│   └── src/
│       ├── main.ts            # Bootstrap, Swagger, Bull Board
│       ├── app.controller.ts  # /api/solve, /api/orchestrator/health
│       ├── worker.ts          # Standalone BullMQ worker process
│       ├── strategies.ts      # Strategy name constants
│       └── modules/
│           ├── game/          # Puzzle CRUD, evaluation, NYT ingestion, cron
│           ├── strategy/      # Brute-force + shuffle strategies
│           └── queue/         # BullMQ queue definitions + Redis config
├── frontend/                  # Vite + React 19 SPA
│   └── src/
│       ├── components/        # Board, Tiles, GameOverModal, ShareResult, etc.
│       ├── pages/             # PuzzlePage (the only route)
│       ├── lib/               # gameReducer, renderProposedGroup, shareResult
│       └── hooks/             # useConnectionsGame
├── orchestrator/              # Hono + AI SDK
│   └── src/
│       ├── index.ts           # Hono server + auth middleware
│       ├── solver.ts          # generateObject call to GPT-4o
│       ├── prompt.ts          # Prompt builder
│       └── types.ts           # Zod schemas (request/response/model output)
├── database/
│   └── 01-schema.sql          # Tables + enums (Postgres 15)
└── docker-compose.yml         # Orchestrates all 5 services + Redis/Postgres
```

## Notes

- The frontend `package.json` proxy setting (`"proxy": "http://nest_backend:4000"`) is for Docker networking only — local dev uses `VITE_API_URL` instead.
- Database schema is managed by `database/01-schema.sql` — TypeORM runs with `synchronize: false`.
