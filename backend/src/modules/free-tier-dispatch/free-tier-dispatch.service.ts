import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { FREE_TIER_DISPATCH_QUEUE } from "../queue/queue.module";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { StrategyDispatch } from "../strategy/strategy-dispatch.service";
import { FreeTierUsageService, FreeTierId } from "../strategy/free-tier-usage.service";
import { FreeTierBudgetService } from "../strategy/free-tier-budget.service";
import {
  LLM_OPENAI,
  freeTierDispatchMaxBatch,
  freeTierDispatchMaxInFlight,
  freeTierDispatchTickMs,
} from "../../strategies";

const TICK_JOB_NAME = "tick";

// A generous allowance for a run's input on its first call (the initial
// 16-word prompt is ~1.5 KB) — used only by the tick's *soft* "could this
// model plausibly fit" sizing. The hard guarantee is FreeTierBudgetService.reserve,
// which bounds every real call's input exactly before making it.
const SOFT_INPUT_ALLOWANCE_TOKENS = 2_000;

export interface FreeTierDispatchStatusDto {
  tier: FreeTierId;
  active: boolean;
  thresholdPercent: number | null;
  startedAt: Date | null;
}

// Both programs support continuous dispatch. Kept as an explicit allowlist
// (not "every FreeTierId") rather than deriving it from the DB-backed
// free-tier config, so adding a future program there doesn't silently start
// auto-dispatching against it before that's actually decided.
const DISPATCHABLE_TIERS: readonly FreeTierId[] = ["flagship", "mini"];

/**
 * Continuously dispatches llm-openai trials against one free-tier program's
 * models (flagship or mini — see FreeTierId) until today's usage reaches a
 * caller-chosen percentage of that tier's daily token budget — "spend the
 * free tokens" as a background process rather than something a human has to
 * keep re-triggering by hand. Each tier runs its own independent cycle;
 * running one doesn't affect or depend on the other.
 *
 * Implemented as a self-rescheduling chain of short "tick" jobs on the
 * free-tier-dispatch queue (see that queue's own comment) rather than one
 * long-running job: each tick re-derives everything it needs (current
 * usage, in-flight work, per-model allocation) from the database, so a
 * worker restart mid-cycle just resumes cleanly at the next tick instead of
 * losing progress or needing checkpoint logic. FreeTierDispatchState is the
 * single source of truth for whether a cycle is active — not BullMQ queue
 * state, which has no one job representing "the whole cycle" once ticks are
 * chained under fresh ids (see runTick).
 */
@Injectable()
export class FreeTierDispatchService {
  private readonly logger = new Logger(FreeTierDispatchService.name);

  constructor(
    @InjectRepository(FreeTierDispatchState)
    private readonly stateRepo: Repository<FreeTierDispatchState>,
    @Inject(FREE_TIER_DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(StrategyDispatch) private readonly strategyDispatch: StrategyDispatch,
    @Inject(FreeTierUsageService) private readonly freeTierUsageService: FreeTierUsageService,
    @Inject(FreeTierBudgetService) private readonly freeTierBudget: FreeTierBudgetService,
  ) {}

  /**
   * Starts a dispatch cycle for `tier` at `thresholdPercent`. Rejects if a
   * cycle for this tier is already running — stop it first to change the
   * threshold, rather than silently layering a second cycle on top.
   */
  async start(tier: FreeTierId, thresholdPercent: number): Promise<FreeTierDispatchStatusDto> {
    this.assertDispatchable(tier);
    if (!Number.isInteger(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
      throw new BadRequestException(
        `'threshold' must be a whole number greater than 0 and at most 100, got ${thresholdPercent}.`,
      );
    }

    const existing = await this.stateRepo.findOne({ where: { tier } });
    if (existing?.active) {
      throw new BadRequestException(
        `Free-tier dispatch for '${tier}' is already running at a ${existing.thresholdPercent}%` +
          " threshold. Stop it first to change the threshold.",
      );
    }

    const startedAt = new Date();
    await this.stateRepo.save({ tier, active: true, thresholdPercent, startedAt });

    // delay: 0 — the worker picks this up on its own schedule; starting the
    // cycle doesn't block the HTTP response on any dispatch actually
    // happening. A fresh id (not a fixed one) — see scheduleNextTick's
    // comment for why reusing an id across cycles is unsafe.
    await this.queue.add(TICK_JOB_NAME, { tier }, { jobId: this.freshTickJobId(tier), delay: 0 });

    this.logger.log(`free-tier dispatch for '${tier}' started at a ${thresholdPercent}% threshold`);

    return this.getStatus(tier);
  }

  /**
   * Marks `tier`'s cycle inactive. A tick already in flight when this is
   * called finishes its current (already-decided) batch normally, but
   * checks this same state at the top of its own run — see runTick — so it
   * won't schedule a further tick afterward.
   */
  async stop(tier: FreeTierId): Promise<FreeTierDispatchStatusDto> {
    await this.stateRepo.update({ tier }, { active: false });
    this.logger.log(`free-tier dispatch for '${tier}' stopped`);
    return this.getStatus(tier);
  }

  async getStatus(tier: FreeTierId): Promise<FreeTierDispatchStatusDto> {
    this.assertDispatchable(tier);
    const state = await this.stateRepo.findOne({ where: { tier } });
    return {
      tier,
      active: state?.active ?? false,
      thresholdPercent: state?.thresholdPercent ?? null,
      startedAt: state?.startedAt ?? null,
    };
  }

  // Shared by start/getStatus (and transitively stop, via its call to
  // getStatus) so an invalid tier — e.g. from the GET status route, which
  // previously cast its :tier param straight to FreeTierId with no check —
  // fails loudly instead of silently returning a default "not active"
  // status for a program that doesn't exist.
  private assertDispatchable(tier: FreeTierId): void {
    if (!DISPATCHABLE_TIERS.includes(tier)) {
      throw new BadRequestException(
        `Free-tier dispatch is only available for: ${DISPATCHABLE_TIERS.join(", ")}.`,
      );
    }
  }

  /**
   * One tick of the dispatch cycle — called by the worker processing the
   * free-tier-dispatch queue. Checks state/usage from scratch (no in-memory
   * loop state carries between ticks). Stops the cycle when it was
   * deactivated, when recorded usage has reached the threshold, when no
   * model's next call could fit in the room left and nothing is in flight
   * ("budget reached"), or when every model has run out of unrun puzzles.
   *
   * Otherwise it waits out a full in-flight backlog (freeTierDispatchMaxInFlight),
   * then fills this tick's batch: budget-paused runs first (they've already
   * spent tokens mid-puzzle), then new trials on whichever models are behind
   * — but only models with a maxOutputTokens cap whose worst-case call still
   * fits after setting one aside for every trial already in flight. That
   * sizing is soft (it just keeps new trials from starting only to pause);
   * the hard guarantee is FreeTierBudgetService.reserve, which every
   * budgeted call goes through before it's made.
   */
  async runTick(tier: FreeTierId): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { tier } });
    if (!state?.active) {
      this.logger.log(`free-tier dispatch tick for '${tier}': not active, nothing to do`);
      return;
    }

    const usage = await this.freeTierUsageService.getUsage(tier);
    const thresholdTokens = Math.floor(usage.dailyLimitTokens * (state.thresholdPercent / 100));

    if (usage.usedTokens >= thresholdTokens) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' reached its ${state.thresholdPercent}% threshold ` +
          `(${usage.usedTokens}/${thresholdTokens} tokens) — stopping`,
      );
      return;
    }

    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyDispatch.countInFlightByModel(LLM_OPENAI, usage.models);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      // A deep backlog keeps reservations and real usage far apart — wait
      // for it to drain before adding to it.
      this.logger.log(
        `free-tier dispatch tick for '${tier}': ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear before dispatching more`,
      );
      await this.scheduleNextTick(tier);
      return;
    }

    const caps = await this.freeTierBudget.modelCaps(usage.models);
    // A model's soft worst case for one call; a model with no cap is never a
    // candidate (and a manually-dispatched in-flight run on one only counts
    // its input allowance).
    const worstCase = (model: string) => (caps.get(model) ?? 0) + SOFT_INPUT_ALLOWANCE_TOKENS;
    const fits = (model: string, budget: number) =>
      caps.get(model) != null && worstCase(model) <= budget;

    const room = thresholdTokens - (await this.freeTierBudget.committedTokens(tier));

    if (inFlightTotal === 0 && !usage.models.some((model) => fits(model, room))) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' budget reached — ${room} token(s) left under the ` +
          `${state.thresholdPercent}% threshold, too few for any model's next call — stopping`,
      );
      return;
    }

    // Soft: leave room for each in-flight trial's next call too, so new
    // trials don't start only to pause mid-puzzle. reserve() is the hard limit.
    let budgetForNew = room;
    for (const [model, count] of inFlight) budgetForNew -= count * worstCase(model);

    const slots = Math.min(freeTierDispatchMaxBatch(), maxInFlight - inFlightTotal);

    // Paused runs first — they've already spent tokens mid-puzzle.
    const resumed = await this.strategyDispatch.resumeBudgetParkedRuns(
      LLM_OPENAI,
      tier,
      usage.models.filter((model) => fits(model, budgetForNew)),
      slots,
    );
    for (const model of resumed) budgetForNew -= worstCase(model);

    const allocation = await this.strategyDispatch.countTodayDispatchByModel(LLM_OPENAI, usage.models);
    // `exhausted`: no unrun puzzles / dispatch failed. `skipped`: doesn't fit
    // this tick. Only `exhausted` covering every model ends the cycle.
    const exhausted = new Set<string>();
    const skipped = new Set<string>();
    let dispatched = 0;

    while (dispatched < slots - resumed.length) {
      for (const model of usage.models) {
        if (!fits(model, budgetForNew)) skipped.add(model);
      }
      const excluded = new Set([...exhausted, ...skipped]);
      if (excluded.size >= usage.models.length) break;

      const model = FreeTierDispatchService.leastAllocatedModel(allocation, excluded);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyDispatch.findUnrunPuzzleDatesForModel(LLM_OPENAI, model, 1);
      } catch (err) {
        this.logger.warn(
          `free-tier dispatch tick for '${tier}': failed to look up a puzzle for '${model}': ` +
            `${(err as Error).message}`,
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
          LLM_OPENAI,
          target.date,
          model,
          tier,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        budgetForNew -= worstCase(model);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `free-tier dispatch tick for '${tier}': failed to queue a trial for '${model}': ` +
            `${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(
      `free-tier dispatch tick for '${tier}': resumed ${resumed.length}, queued ${dispatched} new trial(s)`,
    );

    if (exhausted.size === usage.models.length) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' ran out of unrun puzzles for every model — stopping`,
      );
      return;
    }

    await this.scheduleNextTick(tier);
  }

  private async scheduleNextTick(tier: FreeTierId): Promise<void> {
    await this.queue.add(
      TICK_JOB_NAME,
      { tier },
      { jobId: this.freshTickJobId(tier), delay: freeTierDispatchTickMs() },
    );
  }

  // A fresh id every time a tick job is added (start() and scheduleNextTick
  // both use this) — never a fixed id reused across a tier's dispatch
  // cycles. BullMQ dedupes queue.add() by jobId even once the prior job
  // with that id has completed (it doesn't silently allow a "restart" under
  // the same id — the add() call is a no-op against the old, already-
  // finished job instead of creating new work), so a fixed id would make
  // every cycle after the first for a given tier silently do nothing.
  // getStatus/isActive rely on FreeTierDispatchState, not job ids, so this
  // churn is invisible to callers.
  private freshTickJobId(tier: FreeTierId): string {
    return `free-tier-dispatch-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** The model with the fewest trials so far today, excluding any model in
   * `excluded` (no unrun puzzles, or doesn't fit this tick). Ties resolve to
   * whichever model sorts first — arbitrary but stable, not meaningful. */
  private static leastAllocatedModel(
    allocation: Map<string, number>,
    excluded: Set<string>,
  ): string {
    let best: string | null = null;
    let bestCount = Infinity;

    for (const [model, count] of allocation) {
      if (excluded.has(model)) continue;
      if (count < bestCount) {
        best = model;
        bestCount = count;
      }
    }

    if (best === null) {
      throw new Error("leastAllocatedModel called with every model excluded");
    }

    return best;
  }
}
