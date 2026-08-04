# AGENTS.md

## Architecture

Multi-service app for solving NYT Connections puzzles. All services orchestrated via `docker-compose.yml`.

| Service | Directory | Framework | Port | Role |
|---------|-----------|-----------|------|------|
| backend | `backend/` | NestJS | 4000 | REST API, Swagger, Bull Board |
| frontend | `frontend/` | Vite + React 19 | 5173 | SPA (proxies to backend) |
| orchestrator | `orchestrator/` | Hono + AI SDK | 3001 | AI puzzle solving |
| worker | `backend/src/worker.ts` | BullMQ (standalone) | — | Processes strategy + puzzle queues |
| db | `database/` | Postgres 15 | 5432 | Schema + seeds |
| redis | — | Redis 7 | 6379 | BullMQ broker |

The worker runs as a separate process from the NestJS server (`npx tsx --watch src/worker.ts`). It is NOT inside the NestJS app.

## Test commands

```bash
# Backend (Jest) — must use --forceExit due to open handles from BullMQ/TypeORM
cd backend && npm test

# Frontend (Vitest) — use test:run for single run, test opens watch mode
cd frontend && npm run test:run

# There is no single-command "test all" — run each package separately.
```

Node 24 is required (per CI).

## Build order

Backend and frontend are independent packages — no cross-package build dependency. But if you need a full typecheck:

```bash
cd backend && npm run build    # nest build
cd frontend && npm run build   # tsc -b && vite build
cd orchestrator && npm run typecheck
```

## Key conventions

- **Queue names are split across files**: `strategy-runs` queue is in `backend/src/modules/queue/strategy.queue.ts`, `puzzle-population` queue is in `backend/src/modules/queue/puzzle.queue.ts`. The queue module that provides DI tokens is in `backend/src/modules/queue/queue.module.ts`.
- **Worker imports from the same codebase** as the backend server but runs as a standalone process. It bootstraps its own NestJS app context to access services.
- **Test files use `.spec.ts` suffix** and live next to the source files (not in a separate test directory).
- **Jest config is inline** in `backend/package.json` (not a separate `jest.config.ts`).
- **Env vars** for the worker/orchestrator: `INTERNAL_API_KEY`, `OPENAI_API_KEY`. These are loaded from the root `.env` file via docker-compose.
- **Database schema** lives in `database/01-schema.sql`, seed data in `database/02-seed.sql`. Postgres container mounts `database/` as init scripts.

## Gotchas

- `npm test` in `frontend/` opens vitest in watch mode. Use `npm run test:run` for a single pass.
- Backend tests need `--forceExit` (already in the script) because BullMQ and TypeORM connections stay open after tests complete.
- The frontend `package.json` has `"proxy": "http://nest_backend:4000"` — this is for Docker networking, not local dev.
- `scripting/` is a standalone utility package (CommonJS, OpenAI + Postgres). Not part of the main app.
