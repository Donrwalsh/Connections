import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GOOGLE_RPD_RESUME_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_GOOGLE } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GoogleRateLimitHoldService, pacificDateStamp } from "./google-rate-limit-hold.service";

/** Longest a re-armed sweep ever waits before looking again. */
const REARM_MAX_DELAY_MS = 15 * 60_000;

/**
 * Runs on a 00:01 America/Los_Angeles cron (see GoogleRpdResumeBootstrap).
 * Clears every GoogleRateLimitHold row whose resetAt has passed, then flips
 * each llm-google run parked at RATE_LIMITED_DAILY (whose model is no longer
 * held) back to RUNNING and re-dispatches it. The runner resumes each from
 * its flushed guesses. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Injectable()
export class GoogleRpdResumeService {
  private readonly logger = new Logger(GoogleRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(GoogleRateLimitHoldService)
    private readonly holdService: GoogleRateLimitHoldService,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
    @Inject(GOOGLE_RPD_RESUME_QUEUE) private readonly resumeQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }> {
    const cleared = await this.holdService.clearExpired();
    const stillHeld = new Set(await this.holdService.heldModels(LLM_GOOGLE));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_GOOGLE },
      relations: { puzzle: true },
    });

    // One stamp for the whole sweep: the resume job ids below must be fresh
    // relative to each run's *original* job (which completed normally — the
    // runner returns rather than throws when it parks — so BullMQ still holds
    // its hash and would treat a re-add under the same id as a no-op), while
    // still colliding between two sweeps on the same Pacific day so a retried
    // sweep collapses to one job per run instead of piling up duplicates.
    const stamp = pacificDateStamp();

    let redispatched = 0;
    let skipped = 0;
    for (const run of parked) {
      if (!run.modelName) {
        // Can never be safely gated: re-dispatching with a null model means
        // the runner's top gate is skipped and the call goes out ungated.
        // llm-google always dispatches with a validated model, so this is a
        // data anomaly worth surfacing rather than silently reviving.
        this.logger.warn(`Skipping parked run ${run.id}: no modelName to check the hold against`);
        skipped++;
        continue;
      }
      if (stillHeld.has(run.modelName)) {
        skipped++;
        continue;
      }

      // Enqueue *before* the status flip: if the add throws, the run stays
      // RATE_LIMITED_DAILY so the next sweep (or the re-arm below) retries
      // it, rather than being left flipped-but-not-queued — which would
      // strand it in RUNNING with nothing to execute it.
      await this.llmGoogleQueue.add(
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

    // Work still parked (a hold whose resetAt is somehow still future, or a
    // run with no model) means the once-a-day cron alone would leave it
    // waiting a further 24h. Re-arm a short delayed sweep instead.
    const rearmedInMs = skipped > 0 ? await this.rearm() : undefined;

    this.logger.log(
      `google-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined ? "" : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  /**
   * Schedules another sweep at the soonest still-future reset (capped, so a
   * hold with a bad far-future resetAt still gets looked at regularly). The
   * job id buckets to the target minute, so several re-arms aiming at the
   * same moment collapse into one job.
   */
  private async rearm(): Promise<number> {
    const soonest = await this.holdService.nextResetAt(LLM_GOOGLE);
    const untilReset = soonest ? soonest.getTime() - Date.now() : REARM_MAX_DELAY_MS;
    const delay = Math.min(Math.max(untilReset, 0), REARM_MAX_DELAY_MS);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await this.resumeQueue.add(
      "resume-google-rpd",
      {},
      {
        jobId: `google-rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }
}
