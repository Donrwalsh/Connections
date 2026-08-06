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

# Backend end-to-end tests — requires a running Postgres + Redis (see "E2E tests" below)
cd backend && npm run test:e2e

# Backend lint / format (flat ESLint config + Prettier)
cd backend && npm run lint && npm run format

# Frontend (Vitest) — use test:run for single run, test opens watch mode
cd frontend && npm run test:run

# Orchestrator (Vitest)
cd orchestrator && npm run test:run

# There is no single-command "test all" — run each package separately.
```

Node 24 is required (per CI).

### E2E tests

`backend/test/app.e2e-spec.ts` boots the real NestJS app against Postgres + Redis. It connects to a dedicated `connections_test` database (created + migrated on first run) so it never touches dev data. Local run:

```bash
docker compose up -d db redis
docker exec postgres_db psql -U postgres -c "CREATE DATABASE connections_test"
cd backend && npm run test:e2e
```

The default env for E2E lives in `backend/test/setup-env.ts` (hosts/ports/creds). CI runs the same suite with Postgres 15 + Redis 7 service containers.

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
- **Database schema** lives in `database/01-schema.sql`, which the TypeORM baseline migration (`backend/src/migrations/1754400000000-initial-schema.ts`) mirrors idempotently. The app runs with `synchronize: false`, `migrationsRun: true`, so an empty database is bootstrapped by migrations (CI, fresh local Postgres). Generate new migrations with `npm run migration:generate` (typeorm CLI) and run them with `npm run migration:run`.
- **Orchestrator routes live in `src/app.ts`** (pure Hono app, unit-testable via `app.request()`) while `src/index.ts` only bootstraps the server — keep it that way so tests don't bind a port.
- **Backend has both unit (`*.spec.ts`) and e2e (`test/app.e2e-spec.ts`, jest-e2e.json) suites.** The E2E suite uses `backend/test/setup-env.ts` defaults (localhost Postgres/Redis, `connections_test` DB) and can be overridden with real env vars.

## Gotchas

- `npm test` in `frontend/` opens vitest in watch mode. Use `npm run test:run` for a single pass.
- Backend tests need `--forceExit` (already in the script) because BullMQ and TypeORM connections stay open after tests complete.
- The frontend `package.json` has `"proxy": "http://nest_backend:4000"` — this is for Docker networking, not local dev.
- `scripting/` is a standalone utility package (CommonJS, OpenAI + Postgres). Not part of the main app.
- On WSL, `node`/`npm` resolve to the Windows binaries via `~/bin` shims, and custom env vars set inline (`DB_PORT=5432 npm …`) do NOT reach `node.exe` unless listed in `WSLENV`. Rely on `backend/test/setup-env.ts` defaults for E2E rather than shell overrides.
