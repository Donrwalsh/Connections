import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { LLM_OPENROUTER_QUEUE } from "../queue/queue.module";
import { runStrategyJobId } from "../queue/strategy.queue";
import { LLM_OPENROUTER } from "../../strategies";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { OpenRouterRateLimitHoldService } from "./openrouter-rate-limit-hold.service";

/**
 * The OpenRouter counterpart to GoogleRpdResumeService. Clears the single
 * OpenRouterRateLimitHold row once its resetAt has passed, then flips every
 * llm-openrouter run parked at RATE_LIMITED_DAILY back to RUNNING and
 * re-dispatches it. Driven by a fixed 00:05 UTC cron (see
 * OpenRouterRpdResumeBootstrap) — OpenRouter's daily quota resets on a fixed
 * UTC-midnight clock, so there is no per-hit self-rescheduling the way
 * Groq's resume sweep needs. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §6.
 */
@Injectable()
export class OpenRouterRpdResumeService {
  private readonly logger = new Logger(OpenRouterRpdResumeService.name);

  constructor(
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @Inject(OpenRouterRateLimitHoldService)
    private readonly holdService: OpenRouterRateLimitHoldService,
    @Inject(LLM_OPENROUTER_QUEUE) private readonly llmOpenRouterQueue: Queue,
  ) {}

  async runResume(): Promise<{ cleared: boolean; redispatched: number }> {
    const cleared = await this.holdService.clearExpired();

    if (await this.holdService.isHeld()) {
      this.logger.log("openrouter-rpd resume: account still held — nothing to resume");
      return { cleared, redispatched: 0 };
    }

    const parked = await this.strategyRunRepo.find({
      where: { status: StrategyRunStatus.RATE_LIMITED_DAILY, strategyName: LLM_OPENROUTER },
      relations: { puzzle: true },
    });

    if (parked.length === 0) {
      this.logger.log(`openrouter-rpd resume: cleared=${cleared}, no parked runs`);
      return { cleared, redispatched: 0 };
    }

    // One UTC-day stamp for the whole sweep: a fresh id relative to each
    // run's original completed job (the runner returns rather than throws
    // when it parks, so BullMQ still holds that hash), but stable across a
    // retried sweep so duplicate enqueues collapse. Same reasoning as
    // Google's pacificDateStamp, in UTC.
    const stamp = new Date().toISOString().slice(0, 10);

    let redispatched = 0;
    for (const run of parked) {
      try {
        // Enqueue before the status flip: if the add throws, the run stays
        // RATE_LIMITED_DAILY for the next sweep rather than being stranded
        // flipped-but-not-queued.
        await this.llmOpenRouterQueue.add(
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
          `openrouter-rpd resume: failed to re-dispatch run ${run.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `openrouter-rpd resume: cleared=${cleared}, re-dispatched ${redispatched}/${parked.length}`,
    );
    return { cleared, redispatched };
  }
}
