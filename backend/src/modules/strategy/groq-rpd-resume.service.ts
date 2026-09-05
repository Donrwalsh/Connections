import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GROQ_RPD_RESUME_QUEUE, LLM_GROQ_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_GROQ } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GroqRateLimitHoldService } from "./groq-rate-limit-hold.service";

/** Longest a re-armed sweep ever waits before looking again. */
const REARM_MAX_DELAY_MS = 15 * 60_000;

/**
 * The Groq counterpart to GoogleRpdResumeService. Clears every
 * GroqRateLimitHold row whose resetAt has passed, then flips each
 * llm-groq run parked at RATE_LIMITED_DAILY (whose model is no longer
 * held) back to RUNNING and re-dispatches it. Unlike Google, there is no
 * fixed daily cron driving this — GroqRpdResumeBootstrap only enqueues one
 * startup catch-up run; rearm() below (self-scheduling at the soonest live
 * hold's resetAt) is the sole ongoing scheduling mechanism, since Groq
 * holds don't share one daily reset clock the way Google's Pacific-midnight
 * holds do. See docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRpdResumeService {
  private readonly logger = new Logger(GroqRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(GroqRateLimitHoldService) private readonly holdService: GroqRateLimitHoldService,
    @Inject(LLM_GROQ_QUEUE) private readonly llmGroqQueue: Queue,
    @Inject(GROQ_RPD_RESUME_QUEUE) private readonly resumeQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }> {
    const cleared = await this.holdService.clearExpired();
    const stillHeld = new Set(await this.holdService.heldModels(LLM_GROQ));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_GROQ },
      relations: { puzzle: true },
    });

    // One stamp for the whole sweep — see runStrategyJobId's callers below:
    // the same reasoning as Google's pacificDateStamp (a fresh id relative
    // to the run's original completed job, but stable across a retried
    // sweep so duplicate enqueues collapse) without the calendar-day
    // semantics, since Groq's resume sweeps aren't tied to a shared daily
    // clock the way Google's are.
    const stamp = Date.now().toString(36);

    let redispatched = 0;
    let skipped = 0;
    for (const run of parked) {
      if (!run.modelName) {
        this.logger.warn(`Skipping parked run ${run.id}: no modelName to check the hold against`);
        skipped++;
        continue;
      }
      if (stillHeld.has(run.modelName)) {
        skipped++;
        continue;
      }

      await this.llmGroqQueue.add(
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

    const rearmedInMs = skipped > 0 ? await this.rearm() : undefined;

    this.logger.log(
      `groq-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined ? "" : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  private async rearm(): Promise<number> {
    const soonest = await this.holdService.nextResetAt(LLM_GROQ);
    const untilReset = soonest ? soonest.getTime() - Date.now() : REARM_MAX_DELAY_MS;
    const delay = Math.min(Math.max(untilReset, 0), REARM_MAX_DELAY_MS);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await this.resumeQueue.add(
      "resume-groq-rpd",
      {},
      {
        jobId: `groq-rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }
}
