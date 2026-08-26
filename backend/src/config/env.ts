export interface AppEnv {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  INTERNAL_API_KEY: string;
  ORCHESTRATOR_URL: string;
  ORCHESTRATOR_TIMEOUT_MS: number;
  PORT: number;
  CORS_ORIGIN: string;
  BULL_BOARD_USER: string;
  BULL_BOARD_PASS: string;
  PUZZLE_POPULATION_CRON: string;
  PUZZLE_POPULATION_TZ: string;
  DB_MIGRATIONS_RUN: boolean;
  DISPATCH_PASSWORD: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable '${name}'. See .env.sample.`);
  }
  return value;
}

function optionalInt(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined ? parsed : fallback;
}

/**
 * Per-attempt HTTP timeout for backend→orchestrator solve calls, from
 * ORCHESTRATOR_TIMEOUT_MS. Some models legitimately take several minutes to
 * finish a single call, so the budget is generous — 10 minutes by default.
 * The value is applied to every attempt — timeout failures are not retried
 * by the caller (see orchestrator/app.service), which keeps the wait
 * bounded. When it does fire, the abort now propagates all the way to the
 * orchestrator's outbound OpenAI call (see orchestrator/app.ts and
 * solve-assist.ts) instead of just dropping the HTTP connection to the
 * orchestrator while that call keeps running — and billing — unseen.
 */
export function orchestratorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return optionalInt("ORCHESTRATOR_TIMEOUT_MS", env.ORCHESTRATOR_TIMEOUT_MS, 600000);
}

/**
 * Validates and normalizes the environment at bootstrap. Passed to
 * ConfigModule.forRoot({ validate }) so a missing required secret fails the
 * process fast instead of degrading silently at request time.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const bullBoardUser = env.BULL_BOARD_USER;
  const bullBoardPass = env.BULL_BOARD_PASS;

  if ((bullBoardUser && !bullBoardPass) || (!bullBoardUser && bullBoardPass)) {
    throw new Error("BULL_BOARD_USER and BULL_BOARD_PASS must be set together (or neither).");
  }

  const dispatchPassword = env.DISPATCH_PASSWORD ?? "";

  // Only enforced by DispatchAuthGuard when NODE_ENV=production (see that
  // guard for why dev/test dispatches stay password-free) — but fail fast at
  // boot rather than let a production deploy come up silently unprotected.
  if (env.NODE_ENV === "production" && !dispatchPassword) {
    throw new Error("DISPATCH_PASSWORD must be set when NODE_ENV=production. See .env.sample.");
  }

  return {
    DB_HOST: env.DB_HOST ?? "localhost",
    DB_PORT: optionalInt("DB_PORT", env.DB_PORT, 5432),
    DB_USER: env.DB_USER ?? "postgres",
    DB_PASSWORD: env.DB_PASSWORD ?? "postgres",
    DB_NAME: env.DB_NAME ?? "mydb",
    REDIS_HOST: env.REDIS_HOST ?? "localhost",
    REDIS_PORT: optionalInt("REDIS_PORT", env.REDIS_PORT, 6379),
    INTERNAL_API_KEY: required("INTERNAL_API_KEY", env.INTERNAL_API_KEY),
    ORCHESTRATOR_URL: env.ORCHESTRATOR_URL ?? "http://ai_orchestrator:3001",
    ORCHESTRATOR_TIMEOUT_MS: orchestratorTimeoutMs(env),
    PORT: optionalInt("PORT", env.PORT, 4000),
    CORS_ORIGIN: env.CORS_ORIGIN ?? "http://localhost:5173",
    BULL_BOARD_USER: bullBoardUser ?? "",
    BULL_BOARD_PASS: bullBoardPass ?? "",
    PUZZLE_POPULATION_CRON: env.PUZZLE_POPULATION_CRON ?? "0 6 * * *",
    PUZZLE_POPULATION_TZ: env.PUZZLE_POPULATION_TZ ?? "UTC",
    // Whether this process runs pending TypeORM migrations at startup.
    // Defaults to true (unchanged behavior). Set to false on any process
    // that shares a database with another instance already running
    // migrations — e.g. a local WORKER_ROLE=ollama worker pointed at a
    // deployed Postgres — so only one process (the deployed backend/worker)
    // ever applies schema changes, regardless of which one boots first or
    // which git revision the local process happens to be on.
    DB_MIGRATIONS_RUN: env.DB_MIGRATIONS_RUN !== "false",
    DISPATCH_PASSWORD: dispatchPassword,
  };
}
