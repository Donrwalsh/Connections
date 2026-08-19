import { ConnectionOptions } from "bullmq";

// REDIS_DB selects a logical database (0-15 by default) within the Redis
// instance — defaults to 0 (unchanged dev/prod behavior). The e2e test suite
// forces this to a dedicated index (see test/setup-env.ts) so any job it
// enqueues is invisible to a live worker sharing the same Redis host/port —
// without this, an e2e-enqueued LLM strategy job could be picked up by a real
// worker and spend real API money. Same host+port, disjoint keyspace.
//
// REDIS_PASSWORD is optional and omitted entirely when unset, matching the
// local-dev/compose default of an unauthenticated Redis. Set it whenever
// Redis is reachable beyond the trusted deploy network — e.g. a
// WORKER_ROLE=ollama worker connecting from outside the Coolify project.
export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  db: Number(process.env.REDIS_DB) || 0,
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
};
