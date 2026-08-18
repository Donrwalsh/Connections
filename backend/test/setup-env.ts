// Runs before the test framework and test files are loaded, so module-level
// env reads (redis.config, strategy/puzzle queues, loadEnv) see valid values.
// These match the project's compose Postgres/Redis; the E2E suite uses a
// dedicated Postgres database name (never touches the dev "mydb" data) and a
// dedicated Redis logical database (never shares queue traffic with the live
// dev worker — see the REDIS_DB comment below). CI can override via
// service-container env vars.
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= "5432";
process.env.DB_USER ??= "postgres";
process.env.DB_PASSWORD ??= "postgres";
process.env.DB_NAME ??= "connections_test";
process.env.REDIS_HOST ??= "localhost";
process.env.REDIS_PORT ??= "6379";
// Forced (not ??=) unlike everything else here: this Redis instance is the
// same one the live dev worker polls, and any job the e2e suite enqueues
// under the default database (0) would be visible to — and dispatchable
// by — that real worker, which can call a real, billed LLM API. A distinct
// logical database keeps the e2e suite's queue traffic in a keyspace no
// live worker ever reads, regardless of what a shell/CI environment already
// has REDIS_DB set to.
process.env.REDIS_DB = "15";
process.env.INTERNAL_API_KEY ??= "test-internal-key";
process.env.BULL_BOARD_USER ??= "test-user";
process.env.BULL_BOARD_PASS ??= "test-pass";
process.env.ORCHESTRATOR_URL ??= "http://localhost:3999";
process.env.PUZZLE_POPULATION_CRON ??= "0 6 * * *";
