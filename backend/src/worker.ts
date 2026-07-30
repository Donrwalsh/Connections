import { Worker } from "bullmq";
import { redisConnection } from "./modules/queue/redis.config";
import axios from "axios";

const worker = new Worker(
  "strategy-runs",
  async (job) => {
    const { puzzleId, strategyName } = job.data;

    // call your orchestrator container
    const response = await axios.post(
      "http://orchestrator:3001/run-strategy",
      { puzzleId, strategyName },
      { headers: { "x-api-key": process.env.INTERNAL_API_KEY } },
    );

    // write result to Postgres (via your existing TypeORM/Prisma service,
    // or a lightweight direct DB call here)
    return response.data;
  },
  { connection: redisConnection, concurrency: 2 },
);

worker.on("completed", (job) => console.log(`Job ${job.id} done`));
worker.on("failed", (job, err) => console.error(`Job ${job?.id} failed`, err));
