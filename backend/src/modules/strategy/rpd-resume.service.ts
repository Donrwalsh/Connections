import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { LLM_GOOGLE, LLM_GROQ } from "../../strategies";
import { LLM_GOOGLE_QUEUE, LLM_GROQ_QUEUE, RPD_RESUME_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { RateLimitHoldService, strategyDateStamp } from "./rate-limit-hold.service";

/** Longest a re-armed sweep ever waits before looking again. */
const REARM_MAX_DELAY_MS = 15 * 60_000;

/** The RPD-gated strategies whose parked runs this sweep revives. */
const RPD_STRATEGIES = [LLM_GOOGLE, LLM_GROQ] as const;

/**
 * Runs on a daily cron per RPD strategy (see RpdResumeBootstrap). Clears
 * every RateLimitHold row whose resetAt has passed, then flips each run
 * parked at RATE_LIMITED_DAILY (whose model is no longer held) back to
 * RUNNING and re-dispatches it. The runner resumes each from its flushed
 * guesses. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md and
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class RpdResumeService {
  private readonly logger = new Logger(RpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(RateLimitHoldService)
    private readonly holdService: RateLimitHoldService,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
    @Inject(LLM_GROQ_QUEUE) private readonly llmGroqQueue: Queue,
    @Inject(RPD_RESUME_QUEUE) private readonly resumeQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }> {
    const cleared = await this.holdService.clearExpired();

    let redispatched = 0;
    let skipped = 0;
    for (const strategyName of RPD_STRATEGIES) {
      const queue = strategyName === LLM_GROQ ? this.llmGroqQueue : this.llmGoogleQueue;
      const stillHeld = new Set(await this.holdService.heldModels(strategyName));

      const parked = await this.strategyRunRepo.find({
        where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName },
        relations: { puzzle: true },
      });

      // One stamp per strategy per sweep: the resume job ids below must be
      // fresh relative to each run's *original* job (which completed normally
      // — the runner returns rather than throws when it parks — so BullMQ
      // still holds its hash and would treat a re-add under the same id as a
      // no-op), while still colliding between two sweeps on the same
      // provider-day so a retried sweep collapses to one job per run instead
      // of piling up duplicates.
      const stamp = strategyDateStamp(strategyName);

      for (const run of parked) {
        if (!run.modelName) {
          // Can never be safely gated: re-dispatching with a null model means
          // the runner's top gate is skipped and the call goes out ungated.
          // Both RPD strategies always dispatch with a validated model, so
          // this is a data anomaly worth surfacing rather than silently
          // reviving.
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
            jobId: `${runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber)}-resume-${stamp}`,
          },
        );

        run.status = StrategyRunStatus.RUNNING;
        await this.strategyRunRepo.save(run);
        redispatched++;
      }
    }

    // Work still parked (a hold whose resetAt is somehow still future, or a
    // run with no model) means the once-a-day cron alone would leave it
    // waiting a further 24h. Re-arm a short delayed sweep instead.
    const rearmedInMs = skipped > 0 ? await this.rearm() : undefined;

    this.logger.log(
      `rpd-resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined
          ? ""
          : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  /**
   * Schedules another sweep at the soonest still-future reset across all RPD
   * strategies (capped, so a hold with a bad far-future resetAt still gets
   * looked at regularly). The job id buckets to the target minute, so several
   * re-arms aiming at the same moment collapse into one job.
   */
  private async rearm(): Promise<number> {
    const resets = await Promise.all(
      RPD_STRATEGIES.map((strategyName) => this.holdService.nextResetAt(strategyName)),
    );
    const soonest = resets
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>(
        (acc, d) => (acc === null || d.getTime() < acc.getTime() ? d : acc),
        null,
      );
    const untilReset = soonest ? soonest.getTime() - Date.now() : REARM_MAX_DELAY_MS;
    const delay = Math.min(Math.max(untilReset, 0), REARM_MAX_DELAY_MS);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await this.resumeQueue.add(
      "resume-rpd",
      {},
      {
        jobId: `rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }
}
