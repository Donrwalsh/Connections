import { ConnectionOptions } from "bullmq";

// REDIS_DB selects a logical database (0-15 by default) within the Redis
// instance — defaults to 0 (unchanged dev/prod behavior). The e2e test suite
// forces this to a dedicated index (see test/setup-env.ts) so any job it
// enqueues is invisible to a live worker sharing the same Redis host/port —
// without this, an e2e-enqueued LLM strategy job could be picked up by a real
// worker and spend real API money. Same host+port, disjoint keyspace.
export const redisConnection: ConnectionOptions = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  db: Number(process.env.REDIS_DB) || 0,
};
