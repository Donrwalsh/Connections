import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";

import { RPD_RESUME_QUEUE_BY_POOL, RUNS_QUEUE_BY_POOL } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { StrategyRun, StrategyRunStatus } from "../strategy/entities/strategy-run.entity";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import {
  providerPoolById,
  type FreeTierPool,
  type ProviderPoolId,
  type ResetSchedule,
} from "./provider-pool.config";

/**
 * The daily-quota (RPD) hold resume sweep, unified across every free-tier
 * pool. Replaces the five per-provider `*RpdResumeService` classes, which
 * were byte-identical for the three self-rearm pools (groq, mistral,
 * sambanova) and differed only in the resume job-id stamp for Google and in
 * the account-wide vs per-model hold shape for OpenRouter.
 *
 * `runResume(poolId, triggerJobId)`:
 *  - per-model pools (google, groq, mistral, sambanova): clear expired
 *    per-model holds, then flip each run parked at RATE_LIMITED_DAILY whose
 *    model is no longer held back to RUNNING and re-dispatch it; re-arm a
 *    short delayed sweep if anything stayed parked.
 *  - account-wide pools (openrouter): clear the single account hold, and if
 *    it has lifted, re-dispatch every parked run.
 *
 * The resume job id is stamped so it is fresh relative to each run's
 * original (normally-completed) job but stable across a retried sweep:
 * a calendar date in the reset timezone for the fixed-cron pools, the
 * triggering job's own id for the self-rearm pools.
 */
const REARM_MAX_DELAY_MS = 15 * 60_000;

export interface RpdResumeResult {
  /** Per-model pools: the model names whose hold was cleared. Account-wide
   * pools: whether the account hold was cleared. */
  cleared: string[] | boolean;
  redispatched: number;
  /** Per-model pools only: set when a follow-up sweep was re-armed. */
  rearmedInMs?: number;
}

/** A calendar-date stamp (`YYYY-MM-DD`) in the given timezone. Matches the
 * old `pacificDateStamp()` for Pacific and `toISOString().slice(0,10)` for
 * UTC. */
function dateStampInTz(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function resumeStamp(schedule: ResetSchedule, triggerJobId: string): string {
  return schedule.kind === "fixed-cron" ? dateStampInTz(schedule.tz) : triggerJobId;
}

@Injectable()
export class RpdResumeService {
  private readonly logger = new Logger(RpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(RateLimitHoldService)
    private readonly holdService: RateLimitHoldService,
    @Inject(RUNS_QUEUE_BY_POOL)
    private readonly runsQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
    @Inject(RPD_RESUME_QUEUE_BY_POOL)
    private readonly resumeQueueByPool: ReadonlyMap<ProviderPoolId, Queue>,
  ) {}

  async runResume(poolId: ProviderPoolId, triggerJobId = ""): Promise<RpdResumeResult> {
    const pool = providerPoolById(poolId);
    if (!pool.freeTier) {
      throw new Error(`Pool "${poolId}" has no free tier — nothing to resume`);
    }
    const freeTierPool = pool as FreeTierPool;
    return freeTierPool.freeTier.holdScope === "account"
      ? this.resumeAccountPool(freeTierPool)
      : this.resumeModelPool(freeTierPool, triggerJobId);
  }

  private async resumeModelPool(
    pool: FreeTierPool,
    triggerJobId: string,
  ): Promise<RpdResumeResult> {
    const { strategyName } = pool;
    const runsQueue = this.runsQueueByPool.get(pool.id)!;

    const { clearedModels: cleared } = await this.holdService.clearExpired(strategyName);
    const stillHeld = new Set(await this.holdService.heldModels(strategyName));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName },
      relations: { puzzle: true },
    });

    const stamp = resumeStamp(pool.freeTier.resetSchedule, triggerJobId);

    let redispatched = 0;
    let skipped = 0;
    for (const run of parked) {
      if (!run.modelName) {
        // Re-dispatching with a null model skips the runner's top gate and
        // sends an ungated call — a data anomaly worth surfacing.
        this.logger.warn(
          `Skipping parked run ${run.id}: no modelName to check the hold against`,
        );
        skipped++;
        continue;
      }
      if (stillHeld.has(run.modelName)) {
        skipped++;
        continue;
      }

      // Enqueue before the status flip: if the add throws, the run stays
      // RATE_LIMITED_DAILY for the next sweep rather than stranded in
      // RUNNING with nothing to execute it.
      await runsQueue.add(
        "run-strategy",
        {
          puzzleId: run.puzzleId,
          strategyName: run.strategyName,
          date: run.puzzle.date,
          trialNumber: run.trialNumber,
          model: run.modelName,
        },
        {
          jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber)}-resume-${stamp}`,
        },
      );

      run.status = StrategyRunStatus.RUNNING;
      await this.strategyRunRepo.save(run);
      redispatched++;
    }

    const rearmedInMs = skipped > 0 ? await this.rearm(pool) : undefined;

    this.logger.log(
      `${pool.id}-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined
          ? ""
          : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  /**
   * Schedules another sweep at the soonest still-future reset (capped, so a
   * hold with a bad far-future resetAt still gets looked at regularly). The
   * job id buckets to the target minute so several re-arms aiming at the
   * same moment collapse into one job.
   */
  private async rearm(pool: FreeTierPool): Promise<number> {
    const resumeQueue = this.resumeQueueByPool.get(pool.id)!;
    const cap =
      pool.freeTier.resetSchedule.kind === "self-rearm"
        ? pool.freeTier.resetSchedule.maxDelayMs
        : REARM_MAX_DELAY_MS;

    const soonest = await this.holdService.nextResetAt(pool.strategyName);
    const untilReset = soonest ? soonest.getTime() - Date.now() : cap;
    const delay = Math.min(Math.max(untilReset, 0), cap);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await resumeQueue.add(
      `resume-${pool.id}-rpd`,
      {},
      {
        jobId: `${pool.id}-rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }

  private async resumeAccountPool(pool: FreeTierPool): Promise<RpdResumeResult> {
    const { strategyName } = pool;
    const runsQueue = this.runsQueueByPool.get(pool.id)!;

    const { clearedAccountWide: cleared } = await this.holdService.clearExpired(strategyName);

    if (await this.holdService.isHeld(strategyName)) {
      this.logger.log(`${pool.id}-rpd resume: account still held — nothing to resume`);
      return { cleared, redispatched: 0 };
    }

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName },
      relations: { puzzle: true },
    });

    if (parked.length === 0) {
      this.logger.log(`${pool.id}-rpd resume: cleared=${cleared}, no parked runs`);
      return { cleared, redispatched: 0 };
    }

    const stamp = resumeStamp(pool.freeTier.resetSchedule, "");

    let redispatched = 0;
    for (const run of parked) {
      try {
        await runsQueue.add(
          "run-strategy",
          {
            puzzleId: run.puzzleId,
            strategyName: run.strategyName,
            date: run.puzzle.date,
            trialNumber: run.trialNumber,
            model: run.modelName,
          },
          {
            jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber)}-resume-${stamp}`,
          },
        );
        run.status = StrategyRunStatus.RUNNING;
        await this.strategyRunRepo.save(run);
        redispatched++;
      } catch (err) {
        this.logger.warn(
          `${pool.id}-rpd resume: failed to re-dispatch run ${run.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `${pool.id}-rpd resume: cleared=${cleared}, re-dispatched ${redispatched}/${parked.length}`,
    );
    return { cleared, redispatched };
  }
}
