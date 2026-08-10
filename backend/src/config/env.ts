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
 * ORCHESTRATOR_TIMEOUT_MS. A single solve step makes up to LLM_MAX_PROMPTS
 * (default 5) sequential model calls with escalating candidate counts, so the
 * budget must cover a whole multi-prompt step, not one model call. The value
 * is applied to every attempt — timeout failures are not retried by the
 * caller (see orchestrator/app.service), which keeps the wait bounded.
 */
export function orchestratorTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return optionalInt("ORCHESTRATOR_TIMEOUT_MS", env.ORCHESTRATOR_TIMEOUT_MS, 120000);
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
  };
}
