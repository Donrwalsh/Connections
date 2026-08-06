// Runs before the test framework and test files are loaded, so module-level
// env reads (redis.config, strategy/puzzle queues, loadEnv) see valid values.
// These match the project's compose Postgres/Redis; the E2E suite uses a
// dedicated database name so it never touches the dev "mydb" data. CI can
// override via service-container env vars.
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= "5432";
process.env.DB_USER ??= "postgres";
process.env.DB_PASSWORD ??= "postgres";
process.env.DB_NAME ??= "connections_test";
process.env.REDIS_HOST ??= "localhost";
process.env.REDIS_PORT ??= "6379";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.BULL_BOARD_USER ??= "test-user";
process.env.BULL_BOARD_PASS ??= "test-pass";
process.env.ORCHESTRATOR_URL ??= "http://localhost:3999";
process.env.PUZZLE_POPULATION_CRON ??= "0 6 * * *";
