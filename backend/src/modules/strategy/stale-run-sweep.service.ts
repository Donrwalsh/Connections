import { Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import { Queue } from "bullmq";

import { RUNS_QUEUE_BY_POOL, STRATEGY_QUEUE } from "../queue/queue.module";
import { queueForStrategy, runStrategyJobId } from "../queue/strategy.queue";
import { providerPoolById, type ProviderPoolId } from "../provider-pool/provider-pool.config";
import { workerRole, type WorkerRole } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";

/** A RUNNING row untouched this long has no live job behind it: an active run
 * flushes (and so bumps updatedAt) on every loop iteration. Deliberately
 * conservative — with no lock or heartbeat, this is the only guard against
 * resuming a run that is merely slow. */
export const STALE_RUN_THRESHOLD_MS = 60 * 60_000;

export interface StaleRunSweepResult {
  resumed: number;
  skipped: number;
}

/**
 * Startup sweep that re-dispatches runs left at RUNNING with no live BullMQ
 * job (e.g. their worker died in a restart). Re-enqueuing is enough to resume:
 * StrategyRunStore.loadOrCreateRun picks the existing row back up from its
 * stored progress. The jobId carries a UTC date stamp so the API server and
 * worker booting the same day collapse to one job per run.
 */
@Injectable()
export class StaleRunSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StaleRunSweepService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(RUNS_QUEUE_BY_POOL)
    private readonly runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
    @Inject(STRATEGY_QUEUE) private readonly defaultQueue: Queue,
  ) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      this.logger.log("Skipping stale-run sweep (NODE_ENV=test)");
      return;
    }
    await this.sweep(workerRole());
  }

  async sweep(role: WorkerRole, now = new Date()): Promise<StaleRunSweepResult> {
    const cutoff = new Date(now.getTime() - STALE_RUN_THRESHOLD_MS);
    const stale = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RUNNING, updatedAt: LessThan(cutoff) },
      relations: { puzzle: true },
    });

    const stamp = now.toISOString().slice(0, 10);
    const ollamaQueueName = providerPoolById("ollama").queues.runs;

    let resumed = 0;
    let skipped = 0;
    for (const run of stale) {
      const queue = queueForStrategy(this.runsQueueByPool, this.defaultQueue, run.strategyName);
      const isOllama = queue.name === ollamaQueueName;
      const owned = role === "all" || (role === "ollama" ? isOllama : !isOllama);
      if (!owned) {
        skipped++;
        continue;
      }

      await queue.add(
        "run-strategy",
        {
          puzzleId: run.puzzleId,
          strategyName: run.strategyName,
          date: run.puzzle.date,
          trialNumber: run.trialNumber,
          model: run.modelName,
        },
        {
          jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.modelName, run.trialNumber)}-sweep-${stamp}`,
        },
      );
      resumed++;
    }

    this.logger.log(
      `stale-run sweep (role=${role}): resumed ${resumed} run(s), skipped ${skipped} owned by another worker role`,
    );
    return { resumed, skipped };
  }
}
