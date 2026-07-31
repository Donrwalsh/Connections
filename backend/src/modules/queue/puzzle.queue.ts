import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

export const puzzleQueue = new Queue("puzzle-population", {
  connection: redisConnection,
});
