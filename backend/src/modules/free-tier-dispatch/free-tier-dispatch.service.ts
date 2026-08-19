import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Queue } from "bullmq";
import { FREE_TIER_DISPATCH_QUEUE } from "../queue/queue.module";
import { FreeTierDispatchState } from "./entities/free-tier-dispatch-state.entity";
import { StrategyService } from "../strategy/strategy.service";
import {
  FreeTierUsageService,
  FreeTierId,
  FREE_TIER_PROGRAMS,
} from "../strategy/free-tier-usage.service";
import {
  LLM_OPENAI,
  freeTierDispatchMaxBatch,
  freeTierDispatchMaxInFlight,
  freeTierDispatchTickMs,
  freeTierDispatchTokenEstimate,
} from "../../strategies";

const TICK_JOB_NAME = "tick";

export interface FreeTierDispatchStatusDto {
  tier: FreeTierId;
  active: boolean;
  thresholdPercent: number | null;
  startedAt: Date | null;
}

// Both programs support continuous dispatch. Kept as an explicit allowlist
// (not "every FreeTierId") rather than deriving it from FREE_TIER_PROGRAMS,
// so adding a future program to that config doesn't silently start
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
    @Inject(StrategyService) private readonly strategyService: StrategyService,
    @Inject(FreeTierUsageService) private readonly freeTierUsageService: FreeTierUsageService,
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
   * loop state carries between ticks): stops if the cycle was deactivated,
   * has reached its threshold, or has run out of unrun puzzles for every
   * model in the tier. Otherwise it paces itself against two independent
   * caps — the in-flight backlog (freeTierDispatchMaxInFlight) and the
   * remaining token budget — dispatching nothing new and just rescheduling
   * if either is already saturated, or a budget-safe batch spread across
   * whichever models are currently behind if there's room under both.
   */
  async runTick(tier: FreeTierId): Promise<void> {
    const state = await this.stateRepo.findOne({ where: { tier } });
    if (!state?.active) {
      this.logger.log(`free-tier dispatch tick for '${tier}': not active, nothing to do`);
      return;
    }

    const program = FREE_TIER_PROGRAMS[tier];
    const usage = await this.freeTierUsageService.getUsage(tier);
    const thresholdTokens = Math.floor(program.dailyLimitTokens * (state.thresholdPercent / 100));

    if (usage.usedTokens >= thresholdTokens) {
      await this.stateRepo.update({ tier }, { active: false });
      this.logger.log(
        `free-tier dispatch for '${tier}' reached its ${state.thresholdPercent}% threshold ` +
          `(${usage.usedTokens}/${thresholdTokens} tokens) — stopping`,
      );
      return;
    }

    const tokenEstimate = freeTierDispatchTokenEstimate();
    const maxInFlight = freeTierDispatchMaxInFlight();
    const inFlight = await this.strategyService.countInFlightByModel(LLM_OPENAI, program.models);
    const inFlightTotal = [...inFlight.values()].reduce((sum, count) => sum + count, 0);

    if (inFlightTotal >= maxInFlight) {
      // A backlog this deep makes the token-budget estimate below stale by
      // the time it lands — real usage only updates once a trial actually
      // finishes — so don't add to it; just wait for it to drain.
      this.logger.log(
        `free-tier dispatch tick for '${tier}': ${inFlightTotal} trial(s) already queued/running` +
          ` (cap ${maxInFlight}) — waiting for the backlog to clear before dispatching more`,
      );
      await this.scheduleNextTick(tier);
      return;
    }

    const remainingBudget = thresholdTokens - usage.usedTokens;
    const safeRemainingBudget = remainingBudget - inFlightTotal * tokenEstimate;

    if (safeRemainingBudget < tokenEstimate) {
      // Enough is already queued/running to plausibly reach the threshold
      // on its own — let it land before committing to more.
      this.logger.log(
        `free-tier dispatch tick for '${tier}': ${inFlightTotal} trial(s) already in flight, ` +
          "holding off on new dispatches this tick",
      );
      await this.scheduleNextTick(tier);
      return;
    }

    const maxNewTrials = Math.min(
      freeTierDispatchMaxBatch(),
      Math.floor(safeRemainingBudget / tokenEstimate),
      // Never let a single tick's batch push the backlog past the in-flight
      // cap either, even though the check above already confirmed there's
      // room for at least one more.
      maxInFlight - inFlightTotal,
    );

    const allocation = await this.strategyService.countTodayDispatchByModel(LLM_OPENAI, program.models);
    const exhausted = new Set<string>();
    let dispatched = 0;

    while (dispatched < maxNewTrials && exhausted.size < program.models.length) {
      const model = FreeTierDispatchService.leastAllocatedModel(allocation, exhausted);

      let target: { puzzleId: number; date: string } | undefined;
      try {
        [target] = await this.strategyService.findUnrunPuzzleDatesForModel(LLM_OPENAI, model, 1);
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
        await this.strategyService.triggerStrategyRuns(
          target.puzzleId,
          LLM_OPENAI,
          target.date,
          model,
        );
        allocation.set(model, (allocation.get(model) ?? 0) + 1);
        dispatched++;
      } catch (err) {
        this.logger.warn(
          `free-tier dispatch tick for '${tier}': failed to queue a trial for '${model}': ` +
            `${(err as Error).message}`,
        );
        exhausted.add(model);
      }
    }

    this.logger.log(`free-tier dispatch tick for '${tier}': queued ${dispatched} new trial(s)`);

    if (exhausted.size === program.models.length) {
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

  /** The model with the fewest trials so far today, excluding any already
   * marked exhausted (no unrun puzzles left) this tick. Ties resolve to
   * whichever model sorts first — arbitrary but stable, not meaningful. */
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
