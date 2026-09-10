import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { SAMBANOVA_RPD_RESUME_QUEUE, LLM_SAMBANOVA_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_SAMBANOVA } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { RateLimitHoldService } from "./rate-limit-hold.service";

/** Longest a re-armed sweep ever waits before looking again. */
const REARM_MAX_DELAY_MS = 15 * 60_000;

/**
 * The SambaNova counterpart to GroqRpdResumeService — identical shape.
 * SambaNova's rate-limit headers give a per-hit reset duration, not a
 * shared clock boundary, so — like Groq, unlike Google/OpenRouter — there
 * is no fixed daily cron; rearm() self-scheduling at the soonest live
 * hold's resetAt is the sole ongoing mechanism, and
 * SambaNovaRpdResumeBootstrap only enqueues one startup catch-up. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §6.
 */
@Injectable()
export class SambaNovaRpdResumeService {
  private readonly logger = new Logger(SambaNovaRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(RateLimitHoldService)
    private readonly holdService: RateLimitHoldService,
    @Inject(LLM_SAMBANOVA_QUEUE) private readonly llmSambaNovaQueue: Queue,
    @Inject(SAMBANOVA_RPD_RESUME_QUEUE) private readonly resumeQueue: Queue,
  ) {}

  /**
   * `triggerJobId` is the BullMQ job id of whichever job (startup catch-up
   * or a rearm) invoked this sweep — see worker.ts's `sambanova-rpd-resume`
   * handler. It's used as the resume job-id stamp below instead of a
   * wall-clock timestamp: BullMQ keeps a job's id stable across that job's
   * own retries, so a retried sweep reuses the same stamp and its
   * re-dispatch enqueues collapse under the same ids rather than piling up
   * a second set. A *different* triggering job naturally gets a different
   * id, so separate sweeps never collide with each other.
   */
  async runResume(
    triggerJobId: string,
  ): Promise<{ cleared: string[]; redispatched: number; rearmedInMs?: number }> {
    const { clearedModels: cleared } = await this.holdService.clearExpired(LLM_SAMBANOVA);
    const stillHeld = new Set(await this.holdService.heldModels(LLM_SAMBANOVA));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_SAMBANOVA },
      relations: { puzzle: true },
    });

    const stamp = triggerJobId;

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

      await this.llmSambaNovaQueue.add(
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
      `sambanova-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)` +
        (rearmedInMs === undefined
          ? ""
          : `, re-armed in ${rearmedInMs}ms for ${skipped} still parked`),
    );
    return rearmedInMs === undefined
      ? { cleared, redispatched }
      : { cleared, redispatched, rearmedInMs };
  }

  private async rearm(): Promise<number> {
    const soonest = await this.holdService.nextResetAt(LLM_SAMBANOVA);
    const untilReset = soonest ? soonest.getTime() - Date.now() : REARM_MAX_DELAY_MS;
    const delay = Math.min(Math.max(untilReset, 0), REARM_MAX_DELAY_MS);
    const targetMinute = new Date(Date.now() + delay).toISOString().slice(0, 16);

    await this.resumeQueue.add(
      "resume-sambanova-rpd",
      {},
      {
        jobId: `sambanova-rpd-resume-rearm-${targetMinute}`,
        delay,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );

    return delay;
  }
}
