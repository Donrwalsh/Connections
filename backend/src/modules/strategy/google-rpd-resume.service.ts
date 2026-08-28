import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_GOOGLE } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";

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
  ) {}

  async runResume(): Promise<{ cleared: string[]; redispatched: number }> {
    const cleared = await this.holdService.clearExpired();
    const stillHeld = new Set(await this.holdService.heldModels(LLM_GOOGLE));

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_GOOGLE },
      relations: { puzzle: true },
    });

    let redispatched = 0;
    for (const run of parked) {
      if (run.modelName && stillHeld.has(run.modelName)) continue;

      run.status = StrategyRunStatus.RUNNING;
      await this.strategyRunRepo.save(run);

      await this.llmGoogleQueue.add(
        "run-strategy",
        {
          puzzleId: run.puzzleId,
          strategyName: run.strategyName,
          date: run.puzzle.date,
          trialNumber: run.trialNumber,
          model: run.modelName,
        },
        { jobId: runStrategyJobId(run.puzzleId, run.strategyName, run.trialNumber) },
      );
      redispatched++;
    }

    this.logger.log(
      `google-rpd resume: cleared ${cleared.length} hold(s), re-dispatched ${redispatched} run(s)`,
    );
    return { cleared, redispatched };
  }
}
