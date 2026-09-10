import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { SAMBANOVA_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { SambaNovaDispatchState } from "./entities/sambanova-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import {
  LLM_SAMBANOVA,
  sambaNovaDispatchMaxBatch,
  sambaNovaDispatchMaxInFlight,
  sambaNovaDispatchTickMs,
} from "../../strategies";

const TICK_JOB_NAME = "tick";
const SAMBANOVA_DISPATCH_STATE_ID = "sambanova";

export interface SambaNovaDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
}

/**
 * The SambaNova counterpart to GroqFreeDispatchService — identical shape.
 * SambaNova's free tier exposes no usable usage counter, so like Groq the
 * stop condition is simply "every configured model held or out of unrun
 * puzzles"; there is no token/call budget. Its own dedicated
 * SAMBANOVA_DISPATCH_* pacing knobs (not the shared FREE_TIER_DISPATCH_*
 * family) are sized for the fixed 20 req/min + 20 req/day per-model free
 * tier; raising them unlocks SambaNova's Developer tier with no code
 * change. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §5.
 */
@Injectable()
export class SambaNovaFreeDispatchService {
  private readonly logger = new Logger(SambaNovaFreeDispatchService.name);

  constructor(
    @InjectRepository(SambaNovaDispatchState)
    private readonly stateRepo: Repository<SambaNovaDispatchState>,
    @Inject(SAMBANOVA_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(RateLimitHoldService)
    private readonly holdService: RateLimitHoldService,
  ) {}

  /**
   * Starts the cycle. Rejects if it's already running. If every configured
   * SambaNova model is already held, this is a clean no-op (no tick is
   * queued) — the caller learns this via the returned `outcome` rather than
   * a thrown error, since it isn't a failure.
   */
  async start(): Promise<{
    status: SambaNovaDispatchStatusDto;
    outcome: "started" | "alreadyExhausted";
  }> {
    const existing = await this.stateRepo.findOne({ where: { id: SAMBANOVA_DISPATCH_STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "SambaNova free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_SAMBANOVA);
    const held = new Set(await this.holdService.heldModels(LLM_SAMBANOVA));
    const allExhausted = models.length === 0 || models.every((model) => held.has(model));

    if (allExhausted) {
      await this.stateRepo.save({ id: SAMBANOVA_DISPATCH_STATE_ID, active: false, startedAt: null });
      this.logger.log(
        "sambanova free-tier dispatch: every model is already held — not starting a cycle",
      );
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: SAMBANOVA_DISPATCH_STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });

    this.logger.log("sambanova free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<SambaNovaDispatchStatusDto> {
    await this.stateRepo.update({ id: SAMBANOVA_DISPATCH_STATE_ID }, { active: false });
    this.logger.log("sambanova free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<SambaNovaDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: SAMBANOVA_DISPATCH_STATE_ID } });
    return { active: state?.active ?? false, startedAt: state?.startedAt ?? null };
  }

  /**
   * One tick: stops if the cycle was deactivated, no SambaNova models are
   * configured, or every configured model is currently RPD-held. Otherwise
   * paces itself against the in-flight cap and dispatches a batch spread
   * across whichever eligible (non-held) models are currently behind.
   */
  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: SAMBANOVA_DISPATCH_STATE_ID } });
    if (!state?.active) {
      this.logger.log("sambanova free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_SAMBANOVA);
    if (models.length === 0) {
      await this.stateRepo.update({ id: SAMBANOVA_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("sambanova free-tier dispatch: no SambaNova models configured — stopping");
      return;
    }

    const held = new Set(await this.holdService.heldModels(LLM_SAMBANOVA));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.stateRepo.update({ id: SAMBANOVA_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("sambanova free-tier dispatch: every model is RPD-held — stopping");
      return;
    }

    const maxInFlight = sambaNovaDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_SAMBANOVA, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `sambanova free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick();
      return;
    }

    const maxNewTrials = Math.min(sambaNovaDispatchMaxBatch(), maxInFlight - inFlightTotal);
    const allocation = await this.strategyService.countTodayDispatchByModel(
      LLM_SAMBANOVA,
      eligibleModels,
    );
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < eligibleModels.length) {
      const model = SambaNovaFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_SAMBANOVA, model, 1);
      } catch (err) {
        this.logger.warn(
          `sambanova free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
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
          LLM_SAMBANOVA,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `sambanova free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`sambanova free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === eligibleModels.length) {
      await this.stateRepo.update({ id: SAMBANOVA_DISPATCH_STATE_ID }, { active: false });
      this.logger.log(
        "sambanova free-tier dispatch: ran out of unrun puzzles for every eligible model — stopping",
      );
      return;
    }

    await this.scheduleNextTick();
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(
      TICK_JOB_NAME,
      {},
      { delay: sambaNovaDispatchTickMs(), jobId: this.freshTickJobId() },
    );
  }

  private freshTickJobId(): string {
    return `sambanova-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
