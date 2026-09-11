import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";

import {
  freeTierDispatchMaxBatch,
  freeTierDispatchMaxInFlight,
  freeTierDispatchTickMs,
} from "../../strategies";
import { FREE_DISPATCH_QUEUE_BY_POOL } from "../queue/queue.module";
import { RateLimitHoldService } from "../strategy/rate-limit-hold.service";
import { StrategyDispatch } from "../strategy/strategy-dispatch.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { DispatchState } from "./entities/dispatch-state.entity";
import {
  providerPoolById,
  type FreeTierConfig,
  type FreeTierPool,
  type ProviderPoolId,
} from "./provider-pool.config";

const TICK_JOB_NAME = "tick";

export interface DispatchStatus {
  active: boolean;
  startedAt: Date | null;
  /** Account-budget pools only (openrouter). */
  callsToday?: number;
  dailyBudget?: number;
}

interface Pacing {
  tickMs: () => number;
  maxBatch: () => number;
  maxInFlight: () => number;
}

/**
 * The background free-dispatch tick chain, unified across every free-tier
 * pool. Replaces the five per-provider `*FreeDispatchService` classes — four
 * of which (google, groq, mistral, sambanova) were the same "dispatch until
 * every model is held" cycle differing only in the pacing knobs, and one
 * (openrouter) a "dispatch until the self-counted account call budget is
 * spent" variant.
 *
 * `dispatch.stop` on the pool's `freeTier` config selects the stop
 * condition; `dispatch.pacing` (or the account-budget knobs) the cadence.
 */
@Injectable()
export class FreeDispatchService {
  private readonly logger = new Logger(FreeDispatchService.name);

  constructor(
    @InjectRepository(DispatchState)
    private readonly stateRepo: Repository<DispatchState>,
    @Inject(FREE_DISPATCH_QUEUE_BY_POOL)
    private readonly queueByPool: ReadonlyMap<ProviderPoolId, Queue>,
    @Inject(StrategyDispatch) private readonly strategyDispatch: StrategyDispatch,
    @Inject(SupportedModelService)
    private readonly supportedModelService: SupportedModelService,
    @Inject(RateLimitHoldService) private readonly holdService: RateLimitHoldService,
  ) {}

  async start(
    poolId: ProviderPoolId,
  ): Promise<{ status: DispatchStatus; outcome: "started" | "alreadyExhausted" }> {
    const pool = this.freeTierPool(poolId);
    const { strategyName } = pool;

    const existing = await this.stateRepo.findOne({ where: { id: poolId } });
    if (existing?.active) {
      throw new BadRequestException(
        `${pool.label} free-tier dispatch is already running. Stop it first to restart it.`,
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(strategyName);
    const exhausted = await this.isStartExhausted(pool, models);

    if (exhausted) {
      await this.stateRepo.save({ id: poolId, active: false, startedAt: null });
      this.logger.log(`${poolId} free-tier dispatch: not starting a cycle (nothing to do)`);
      return { status: await this.getStatus(poolId), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: poolId, active: true, startedAt });
    await this.queueByPool
      .get(poolId)!
      .add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId(poolId) });

    this.logger.log(`${poolId} free-tier dispatch started`);
    return { status: await this.getStatus(poolId), outcome: "started" };
  }

  async stop(poolId: ProviderPoolId): Promise<DispatchStatus> {
    await this.stateRepo.update({ id: poolId }, { active: false });
    this.logger.log(`${poolId} free-tier dispatch stopped`);
    return this.getStatus(poolId);
  }

  async getStatus(poolId: ProviderPoolId): Promise<DispatchStatus> {
    const pool = this.freeTierPool(poolId);
    const state = await this.stateRepo.findOne({ where: { id: poolId } });
    const status: DispatchStatus = {
      active: state?.active ?? false,
      startedAt: state?.startedAt ?? null,
    };
    if (pool.freeTier.dispatch.stop === "account-budget") {
      status.callsToday = await this.strategyDispatch.countTodayLlmCalls(pool.strategyName);
      status.dailyBudget = pool.freeTier.dispatch.budget();
    }
    return status;
  }

  async runTick(poolId: ProviderPoolId): Promise<void> {
    const pool = this.freeTierPool(poolId);
    const state = await this.stateRepo.findOne({ where: { id: poolId } });
    if (!state?.active) {
      this.logger.log(`${poolId} free-tier dispatch tick: not active, nothing to do`);
      return;
    }

    return pool.freeTier.dispatch.stop === "account-budget"
      ? this.runAccountBudgetTick(pool)
      : this.runUntilHeldTick(pool);
  }

  // --- until-held (google, groq, mistral, sambanova) --------------------------

  private async runUntilHeldTick(pool: FreeTierPool): Promise<void> {
    const { id: poolId, strategyName } = pool;
    const pacing = this.pacing(pool.freeTier);

    const models = await this.supportedModelService.findModelNamesByStrategy(strategyName);
    if (models.length === 0) {
      await this.deactivate(poolId, "no models configured");
      return;
    }

    const held = new Set(await this.holdService.heldModels(strategyName));
    const eligibleModels = models.filter((model) => !held.has(model));
    if (eligibleModels.length === 0) {
      await this.deactivate(poolId, "every model is RPD-held");
      return;
    }

    const maxInFlight = pacing.maxInFlight();
    const inFlight = await this.strategyDispatch.countInFlightByModel(strategyName, eligibleModels);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `${poolId} free-tier dispatch tick: ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear`,
      );
      await this.scheduleNextTick(pool);
      return;
    }

    const maxNewTrials = Math.min(pacing.maxBatch(), maxInFlight - inFlightTotal);
    const { dispatched, allExhausted } = await this.dispatchRoundRobin(
      poolId,
      strategyName,
      eligibleModels,
      maxNewTrials,
    );

    this.logger.log(`${poolId} free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (allExhausted) {
      await this.deactivate(poolId, "ran out of unrun puzzles for every eligible model");
      return;
    }

    await this.scheduleNextTick(pool);
  }

  // --- account-budget (openrouter) ------------------------------------------

  private async runAccountBudgetTick(pool: FreeTierPool): Promise<void> {
    const { id: poolId, strategyName } = pool;
    const dispatch = pool.freeTier.dispatch;
    if (dispatch.stop !== "account-budget") return; // narrowing

    const reason = await this.holdService.heldReason(strategyName);
    if (reason === "daily") {
      await this.deactivate(poolId, "account is daily-held");
      return;
    }
    if (reason === "per-minute-cooldown") {
      await this.rescheduleAfterCooldown(pool);
      this.logger.log(`${poolId} free-tier dispatch tick: per-minute cooldown live — skipped`);
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(strategyName);
    if (models.length === 0) {
      await this.deactivate(poolId, "no models configured");
      return;
    }

    const budget = dispatch.budget();
    const callsPerTrial = dispatch.callsPerTrial();
    const callsToday = await this.strategyDispatch.countTodayLlmCalls(strategyName);

    const maxInFlight = dispatch.maxInFlight();
    const inFlight = await this.strategyDispatch.countInFlightByModel(strategyName, models);
    const inFlightTotal = [...inFlight.values()].reduce((sum, c) => sum + c, 0);
    const estimatedInFlightCalls = inFlightTotal * callsPerTrial;

    if (callsToday + estimatedInFlightCalls >= budget) {
      await this.deactivate(
        poolId,
        `daily budget reached (${callsToday} logged + ~${estimatedInFlightCalls} in-flight >= ${budget})`,
      );
      return;
    }

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `${poolId} free-tier dispatch tick: ${inFlightTotal} trial(s) in flight (cap ${maxInFlight}) — waiting`,
      );
      await this.scheduleNextTick(pool);
      return;
    }

    const callsRemaining = budget - callsToday - estimatedInFlightCalls;
    const trialsAffordable = Math.max(0, Math.floor(callsRemaining / callsPerTrial));
    const maxNewTrials = Math.min(
      dispatch.maxBatch(),
      maxInFlight - inFlightTotal,
      trialsAffordable,
    );

    if (maxNewTrials <= 0) {
      this.logger.log(
        `${poolId} free-tier dispatch tick: no budget headroom for a whole trial — waiting`,
      );
      await this.scheduleNextTick(pool);
      return;
    }

    const { dispatched, allExhausted } = await this.dispatchRoundRobin(
      poolId,
      strategyName,
      models,
      maxNewTrials,
    );

    this.logger.log(`${poolId} free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (allExhausted) {
      await this.deactivate(poolId, "out of unrun puzzles for every configured model");
      return;
    }

    await this.scheduleNextTick(pool);
  }

  // --- shared --------------------------------------------------------------

  /** Dispatches up to `maxNewTrials` trials, round-robin over `candidateModels`
   * least-allocated first, one unrun puzzle per trial. A puzzle-lookup or
   * enqueue failure marks that model done for this tick, not the whole tick. */
  private async dispatchRoundRobin(
    poolId: ProviderPoolId,
    strategyName: string,
    candidateModels: string[],
    maxNewTrials: number,
  ): Promise<{ dispatched: number; allExhausted: boolean }> {
    const allocation = await this.strategyDispatch.countTodayDispatchByModel(
      strategyName,
      candidateModels,
    );
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < candidateModels.length) {
      const model = FreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyDispatch.findUnrunPuzzleDatesForModel(strategyName, model, 1);
      } catch (err) {
        this.logger.warn(
          `${poolId} free-tier dispatch tick: failed to look up a puzzle for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
        continue;
      }

      if (!target) {
        exhausted.add(model);
        continue;
      }

      try {
        await this.strategyDispatch.triggerStrategyRuns(
          target.puzzleId,
          strategyName,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `${poolId} free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    return { dispatched, allExhausted: exhausted.size === candidateModels.length };
  }

  private async isStartExhausted(pool: FreeTierPool, models: string[]): Promise<boolean> {
    if (models.length === 0) return true;
    if (pool.freeTier.dispatch.stop === "account-budget") {
      const held = await this.holdService.isHeld(pool.strategyName);
      const callsToday = await this.strategyDispatch.countTodayLlmCalls(pool.strategyName);
      return held || callsToday >= pool.freeTier.dispatch.budget();
    }
    const held = new Set(await this.holdService.heldModels(pool.strategyName));
    return models.every((model) => held.has(model));
  }

  private pacing(ft: FreeTierConfig): Pacing {
    const d = ft.dispatch;
    if (d.stop === "account-budget") {
      return { tickMs: d.tickMs, maxBatch: d.maxBatch, maxInFlight: d.maxInFlight };
    }
    if (d.pacing === "shared") {
      return {
        tickMs: freeTierDispatchTickMs,
        maxBatch: freeTierDispatchMaxBatch,
        maxInFlight: freeTierDispatchMaxInFlight,
      };
    }
    return d.pacing;
  }

  private async deactivate(poolId: ProviderPoolId, why: string): Promise<void> {
    await this.stateRepo.update({ id: poolId }, { active: false });
    this.logger.log(`${poolId} free-tier dispatch: stopping — ${why}`);
  }

  private async scheduleNextTick(pool: FreeTierPool): Promise<void> {
    await this.queueByPool
      .get(pool.id)!
      .add(TICK_JOB_NAME, {}, { delay: this.pacing(pool.freeTier).tickMs(), jobId: this.freshTickJobId(pool.id) });
  }

  private async rescheduleAfterCooldown(pool: FreeTierPool): Promise<void> {
    const dispatch = pool.freeTier.dispatch;
    const rpmCooldownMs =
      dispatch.stop === "account-budget" ? dispatch.rpmCooldownSeconds() * 1000 : 0;
    const resetAt = await this.holdService.nextResetAt(pool.strategyName);
    const delay = resetAt ? Math.max(0, resetAt.getTime() - Date.now()) : rpmCooldownMs;
    await this.queueByPool
      .get(pool.id)!
      .add(TICK_JOB_NAME, {}, { delay, jobId: this.freshTickJobId(pool.id) });
  }

  private freshTickJobId(poolId: ProviderPoolId): string {
    return `${poolId}-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private freeTierPool(poolId: ProviderPoolId): FreeTierPool {
    const pool = providerPoolById(poolId);
    if (!pool.freeTier) {
      throw new Error(`Pool "${poolId}" has no free tier — nothing to dispatch`);
    }
    return pool as FreeTierPool;
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
