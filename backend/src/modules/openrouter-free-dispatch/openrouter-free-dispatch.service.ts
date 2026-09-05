import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { OPENROUTER_FREE_DISPATCH_QUEUE } from "../queue/queue.module";
import { OpenRouterDispatchState } from "./entities/openrouter-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { OpenRouterRateLimitHoldService } from "../strategy/openrouter-rate-limit-hold.service";
import {
  LLM_OPENROUTER,
  openRouterCallsPerTrialEstimate,
  openRouterDispatchMaxBatch,
  openRouterDispatchMaxInFlight,
  openRouterDispatchRpmCooldownSeconds,
  openRouterDispatchTickMs,
  openRouterFreeDailyBudget,
} from "../../strategies";

const TICK_JOB_NAME = "tick";
const STATE_ID = "openrouter";

export interface OpenRouterDispatchStatusDto {
  active: boolean;
  startedAt: Date | null;
  callsToday: number;
  dailyBudget: number;
}

/**
 * The OpenRouter counterpart to GroqFreeDispatchService — same
 * self-rescheduling tick chain and least-allocated-model round-robin, but
 * three OpenRouter-specific adaptations, because OpenRouter's free tier is
 * account-wide, not per-model:
 *  1. Stop condition is a self-counted daily *call* budget
 *     (StrategyService.countTodayLlmCalls, from SolvePrompt rows) against
 *     OPENROUTER_FREE_DAILY_BUDGET — not "every model held". The
 *     account-wide 'daily' hold is the hard backstop.
 *  2. Global pacing via the dedicated OPENROUTER_DISPATCH_* knobs, sized
 *     for the fixed 20 req/min account-wide ceiling.
 *  3. A live 'per-minute-cooldown' hold (written by the runner on a 20 RPM
 *     429) makes a tick dispatch nothing and reschedule after the cooldown.
 * See docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §5.
 */
@Injectable()
export class OpenRouterFreeDispatchService {
  private readonly logger = new Logger(OpenRouterFreeDispatchService.name);

  constructor(
    @InjectRepository(OpenRouterDispatchState)
    private readonly stateRepo: Repository<OpenRouterDispatchState>,
    @Inject(OPENROUTER_FREE_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(OpenRouterRateLimitHoldService)
    private readonly holdService: OpenRouterRateLimitHoldService,
  ) {}

  async start(): Promise<{
    status: OpenRouterDispatchStatusDto;
    outcome: "started" | "alreadyExhausted";
  }> {
    const existing = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    if (existing?.active) {
      throw new BadRequestException(
        "OpenRouter free-tier dispatch is already running. Stop it first to restart it.",
      );
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_OPENROUTER);
    const held = await this.holdService.isHeld();
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);
    const budget = openRouterFreeDailyBudget();

    if (models.length === 0 || held || callsToday >= budget) {
      await this.stateRepo.save({ id: STATE_ID, active: false, startedAt: null });
      this.logger.log(
        `openrouter free-tier dispatch: not starting (models=${models.length}, held=${held}, ` +
          `callsToday=${callsToday}/${budget})`,
      );
      return { status: await this.getStatus(), outcome: "alreadyExhausted" };
    }

    const startedAt = new Date();
    await this.stateRepo.save({ id: STATE_ID, active: true, startedAt });
    await this.queue.add(TICK_JOB_NAME, {}, { delay: 0, jobId: this.freshTickJobId() });
    this.logger.log("openrouter free-tier dispatch started");
    return { status: await this.getStatus(), outcome: "started" };
  }

  async stop(): Promise<OpenRouterDispatchStatusDto> {
    await this.stateRepo.update({ id: STATE_ID }, { active: false });
    this.logger.log("openrouter free-tier dispatch stopped");
    return this.getStatus();
  }

  async getStatus(): Promise<OpenRouterDispatchStatusDto> {
    const state = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);
    return {
      active: state?.active ?? false,
      startedAt: state?.startedAt ?? null,
      callsToday,
      dailyBudget: openRouterFreeDailyBudget(),
    };
  }

  async runTick(): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { id: STATE_ID } });
    if (!state?.active) {
      this.logger.log("openrouter free-tier dispatch tick: not active, nothing to do");
      return;
    }

    const reason = await this.holdService.heldReason();
    if (reason === "daily") {
      await this.deactivate("account is daily-held");
      return;
    }
    if (reason === "per-minute-cooldown") {
      await this.rescheduleAfterCooldown();
      this.logger.log("openrouter free-tier dispatch tick: per-minute cooldown live — skipped");
      return;
    }

    const models = await this.supportedModelService.findModelNamesByStrategy(LLM_OPENROUTER);
    if (models.length === 0) {
      await this.deactivate("no OpenRouter models configured");
      return;
    }

    const budget = openRouterFreeDailyBudget();
    const callsPerTrial = openRouterCallsPerTrialEstimate();
    const callsToday = await this.strategyService.countTodayLlmCalls(LLM_OPENROUTER);

    const maxInFlight = openRouterDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_OPENROUTER, models);
    const inFlightTotal = [...inFlight.values()].reduce((sum, c) => sum + c, 0);
    const estimatedInFlightCalls = inFlightTotal * callsPerTrial;

    if (callsToday + estimatedInFlightCalls >= budget) {
      await this.deactivate(
        `daily budget reached (${callsToday} logged + ~${estimatedInFlightCalls} in-flight >= ${budget})`,
      );
      return;
    }

    if (inFlightTotal >= maxInFlight) {
      this.logger.log(
        `openrouter free-tier dispatch tick: ${inFlightTotal} trial(s) in flight (cap ${maxInFlight}) — waiting`,
      );
      await this.scheduleNextTick();
      return;
    }

    const callsRemaining = budget - callsToday - estimatedInFlightCalls;
    const trialsAffordable = Math.max(0, Math.floor(callsRemaining / callsPerTrial));
    const maxNewTrials = Math.min(
      openRouterDispatchMaxBatch(),
      maxInFlight - inFlightTotal,
      trialsAffordable,
    );

    if (maxNewTrials <= 0) {
      this.logger.log(
        "openrouter free-tier dispatch tick: no budget headroom for a whole trial — waiting",
      );
      await this.scheduleNextTick();
      return;
    }

    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_OPENROUTER, models);
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < models.length) {
      const model = OpenRouterFreeDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_OPENROUTER, model, 1);
      } catch (err) {
        this.logger.warn(
          `openrouter free-tier dispatch tick: puzzle lookup failed for '${model}': ${(err as Error).message}`,
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
          LLM_OPENROUTER,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `openrouter free-tier dispatch tick: failed to queue a trial for '${model}': ${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`openrouter free-tier dispatch tick: queued ${dispatched} new trial(s)`);

    if (exhausted.size === models.length) {
      await this.deactivate("out of unrun puzzles for every configured model");
      return;
    }

    await this.scheduleNextTick();
  }

  private async deactivate(why: string): Promise<void> {
    await this.stateRepo.update({ id: STATE_ID }, { active: false });
    this.logger.log(`openrouter free-tier dispatch: stopping — ${why}`);
  }

  private async scheduleNextTick(): Promise<void> {
    await this.queue.add(
      TICK_JOB_NAME,
      {},
      { delay: openRouterDispatchTickMs(), jobId: this.freshTickJobId() },
    );
  }

  private async rescheduleAfterCooldown(): Promise<void> {
    const resetAt = await this.holdService.nextResetAt();
    const delay = resetAt
      ? Math.max(0, resetAt.getTime() - Date.now())
      : openRouterDispatchRpmCooldownSeconds() * 1000;
    await this.queue.add(TICK_JOB_NAME, {}, { delay, jobId: this.freshTickJobId() });
  }

  private freshTickJobId(): string {
    return `openrouter-free-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
