import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { MISTRAL_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { MistralDispatchState } from "./entities/mistral-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import {
  LLM_MISTRAL,
  freeTierDispatchMaxBatch,
  freeTierDispatchMaxInFlight,
  freeTierDispatchTickMs,
} from "../../strategies";

const TICK_JOB_NAME = "tick";
const MISTRAL_DISPATCH_STATE_ID = "mistral";

export interface MistralDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
}

/**
 * The Mistral counterpart to GroqFreeDispatchService — identical shape.
 * Mistral's free tier exposes no usage counter, so like Groq the stop
 * condition is simply "every configured model held or out of unrun
 * puzzles"; there is no token/call budget. Concurrency=1
 * (LLM_MISTRAL_CONCURRENCY) plus the shared FREE_TIER_DISPATCH_* pacing
 * keeps request volume under Mistral's global 1 req/sec ceiling. See
 * docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §5.
 */
@Injectable()
export class MistralFreeDispatchService {
  private readonly logger = new Logger(MistralFreeDispatchService.name);

  constructor(
    @InjectRepository(MistralDispatchState)
    private readonly stateRepo: Repository<MistralDispatchState>,
    @Inject(MISTRAL_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(RateLimitHoldService) private readonly holdService: RateLimitHoldService,
  ) {}

  /**
   * Starts the cycle. Rejects if it's already running. If every configured
   * Mistral model is already held, this is a clean no-op (no tick is
   * queued) rather than spinning up a cycle that would immediately find
   * nothing to do — the caller learns this via the returned `outcome`
   * rather than a thrown error, since it isn't a failure.
   */
  async start(): Promise<{
    status: MistralDispatchStatusDto;
    outcome: "started" | "alreadyExhausted";
  }> {
    const existing = await this.stateRepo.findOne({ where: { id: MISTRAL_DISPATCH_STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "Mistral free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_MISTRAL);
    const held = new Set(await this.holdService.heldModels(LLM_MISTRAL));
    const allExhausted = models.length === 0 || models.every((model) => held.has(model));

    if (allExhausted) {
      await this.stateRepo.save({ id: MISTRAL_DISPATCH_STATE_ID, active: false, startedAt: null });
      this.logger.log(
        "mistral free-tier dispatch: every model is already held — not starting a cycle",
      );
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: MISTRAL_DISPATCH_STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });

    this.logger.log("mistral free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<MistralDispatchStatusDto> {
    await this.stateRepo.update({ id: MISTRAL_DISPATCH_STATE_ID }, { active: false });
    this.logger.log("mistral free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<MistralDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: MISTRAL_DISPATCH_STATE_ID } });
    return { active: state?.active ?? false, startedAt: state?.startedAt ?? null };
  }

  /**
   * One tick: stops if the cycle was deactivated, no Mistral models are
   * configured, or every configured model is currently held. Otherwise
   * paces itself against the in-flight cap (same knob the OpenAI tiers use)
   * and dispatches a batch spread across whichever eligible (non-held)
   * models are currently behind.
   */
  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: MISTRAL_DISPATCH_STATE_ID } });
    if (!state?.active) {
      this.logger.log("mistral free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_MISTRAL);
    if (models.length === 0) {
      await this.stateRepo.update({ id: MISTRAL_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("mistral free-tier dispatch: no Mistral models configured — stopping");
      return;
    }

    const held = new Set(await this.holdService.heldModels(LLM_MISTRAL));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.stateRepo.update({ id: MISTRAL_DISPATCH_STATE_ID }, { active: false });
      this.logger.log("mistral free-tier dispatch: every model is held — stopping");
      return;
    }

    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_MISTRAL, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `mistral free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick();
      return;
    }

    const maxNewTrials = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);
    const allocation = await this.strategyService.countTodayDispatchByModel(
      LLM_MISTRAL,
      eligibleModels,
    );
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < eligibleModels.length) {
      const model = MistralFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_MISTRAL, model, 1);
      } catch (err) {
        this.logger.warn(
          `mistral free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
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
          LLM_MISTRAL,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `mistral free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`mistral free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === eligibleModels.length) {
      await this.stateRepo.update({ id: MISTRAL_DISPATCH_STATE_ID }, { active: false });
      this.logger.log(
        "mistral free-tier dispatch: ran out of unrun puzzles for every eligible model — stopping",
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

  private freshTickJobId(): string {
    return `mistral-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
