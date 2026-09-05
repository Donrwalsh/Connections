import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { GOOGLE_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { GoogleDispatchState } from "./entities/google-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import {
  LLM_GOOGLE,
  freeTierDispatchMaxBatch,
  freeTierDispatchMaxInFlight,
  freeTierDispatchTickMs,
} from "../../strategies";

const TICK_JOB_NAME = "tick";
const GOOGLE_DISPATCH_STATE_ID = "google";

export interface GoogleDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
}

/**
 * The Google counterpart to FreeTierDispatchService: a self-rescheduling
 * tick chain that dispatches llm-google trials against unrun puzzles until
 * every configured Google model is RPD-held (see RateLimitHoldService)
 * or out of unrun puzzles. Unlike the OpenAI tiers, there is no per-token
 * free budget to burn toward a threshold — Google enforces a per-day request
 * cap of its own, so "keep dispatching until held" is the whole stop
 * condition. Reuses the OpenAI tiers' FREE_TIER_DISPATCH_* pacing knobs
 * rather than introducing a parallel env family (see
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md).
 */
@Injectable()
export class GoogleFreeDispatchService {
  private readonly logger = new Logger(GoogleFreeDispatchService.name);

  constructor(
    @InjectRepository(GoogleDispatchState)
    private readonly stateRepo: Repository<GoogleDispatchState>,
    @Inject(GOOGLE_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(RateLimitHoldService) private readonly holdService: RateLimitHoldService,
  ) {}

  /**
   * Starts the cycle. Rejects if it's already running. If every configured
   * Google model is already RPD-held, this is a clean no-op (no tick is
   * queued) rather than spinning up a cycle that would immediately find
   * nothing to do — the caller learns this via the returned `outcome`
   * rather than a thrown error, since it isn't a failure.
   */
  async start(): Promise<{
    status: GoogleDispatchStatusDto;
    outcome: "started" | "alreadyExhausted";
  }> {
    const existing = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "Google free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GOOGLE);
    const held = new Set(await this.holdService.heldModels(LLM_GOOGLE));
    const allExhausted = models.length === 0 || models.every((model) => held.has(model));

    if (allExhausted) {
      await this.stateRepo.save({ id: GOOGLE_DISPATCH_STATE_ID, active: false, startedAt: null });
      this.logger.log(
        "google free-tier dispatch: every model is already RPD-held — not starting a cycle",
      );
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: GOOGLE_DISPATCH_STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });

    this.logger.log("google free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<GoogleDispatchStatusDto> {
    await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
    this.logger.log("google free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<GoogleDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    return { active: state?.active ?? false, startedAt: state?.startedAt ?? null };
  }

  /**
   * One tick: stops if the cycle was deactivated, no Google models are
   * configured, or every configured model is currently RPD-held. Otherwise
   * paces itself against the in-flight cap (same knob the OpenAI tiers use)
   * and dispatches a budget-safe batch spread across whichever eligible
   * (non-held) models are currently behind.
   */
  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: GOOGLE_DISPATCH_STATE_ID } });
    if (!state?.active) {
      this.logger.log("google free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_GOOGLE);
    if (models.length === 0) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("google free-tier dispatch: no Google models configured — stopping");
      return;
    }

    const held = new Set(await this.holdService.heldModels(LLM_GOOGLE));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("google free-tier dispatch: every model is RPD-held — stopping");
      return;
    }

    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_GOOGLE, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `google free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick();
      return;
    }

    const maxNewTrials = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);
    const allocation = await this.strategyService.countTodayDispatchByModel(
      LLM_GOOGLE,
      eligibleModels,
    );
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < eligibleModels.length) {
      const model = GoogleFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_GOOGLE, model, 1);
      } catch (err) {
        this.logger.warn(
          `google free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyService.triggerStrategyRuns(
          target.puzzleId,
          LLM_GOOGLE,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `google free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`google free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === eligibleModels.length) {
      await this.stateRepo.update({ id: GOOGLE_DISPATCH_STATE_ID }, { active: false });
      this.logger.log(
        "google free-tier dispatch: ran out of unrun puzzles for every eligible model — stopping",
      );
      return;
    }

    await this.scheduleNextTick();
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(
      TICK_JOB_NAME,
      {},
      { delay: freeTierDispatchTickMs(), jobId: this.freshTickJobId() },
    );
  }

  // See FreeTierDispatchService.freshTickJobId's comment — same reasoning:
  // BullMQ dedupes queue.add() by jobId even against a completed job, so
  // this must always be fresh, never a fixed id reused across cycles.
  private freshTickJobId(): string {
    return `google-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private static leastAllocatedModel(
    allocation: Map<string, number>,
    exhausted: Set<string>,
  ): string {
    let best: string | null = null;
    let bestCount = Infinity;

    for (const [model, count] of allocation) {
      if (exhausted.has(model)) continue;
      if (count < bestCount) {
        best = model;
        bestCount = count;
      }
    }

    if (best === null) {
      throw new Error("leastAllocatedModel called with every model already exhausted");
    }

    return best;
  }
}
