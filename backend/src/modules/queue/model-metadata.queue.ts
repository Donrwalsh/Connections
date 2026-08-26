import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";

export const modelMetadataQueue = new Queue("model-metadata-refresh", {
  connection: redisConnection,
});
