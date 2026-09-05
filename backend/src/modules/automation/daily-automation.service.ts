import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { FreeTierDispatchService } from "../free-tier-dispatch/free-tier-dispatch.service";
import { GoogleFreeDispatchService } from "../google-free-dispatch/google-free-dispatch.service";
import { GroqFreeDispatchService } from "../groq-free-dispatch/groq-free-dispatch.service";

// The same MAX_LIMIT CategoryEvaluatorService.enqueuePending already
// enforces internally — the daily leg asks for as much as a manual dispatch
// is ever allowed to enqueue in one call.
export const JUDGE_LEG_LIMIT = 500;

// 95% overall safety cap minus a 15% reserve for judge spend landing later
// in the day — see docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
export const MINI_BURN_CEILING_PERCENT = 80;

function todayUtcDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Runs on a daily UTC cron (see DailyAutomationBootstrap). Runs three legs
 * in turn — each leg is awaited before the next starts, but one leg's
 * failure never prevents the next from running (see each leg's own
 * try/catch) — and records each one's outcome into today's AutomationRunLog
 * row as soon as it resolves:
 *
 *  - judge: enqueues the category-judge backlog (its spend already lands in
 *    the same mini-tier budget FreeTierUsageService tracks);
 *  - miniBurn: starts a FreeTierDispatchService "mini" cycle at an 80%
 *    ceiling, leaving the other 15% (of the 95% overall safety cap) as
 *    headroom for the judge leg's spend;
 *  - googleBurn: starts GoogleFreeDispatchService's cycle, which runs until
 *    every Google model is RPD-held;
 *  - groqBurn: starts GroqFreeDispatchService's cycle, which runs until
 *    every Groq model is RPD-held.
 *
 * Each leg checks the relevant service's live status first rather than
 * relying on a thrown exception's message text to distinguish "already
 * running" from a real failure — cleaner to test and to reason about than
 * string-matching a caught error.
 */
@Injectable()
export class DailyAutomationService {
  private readonly logger = new Logger(DailyAutomationService.name);

  constructor(
    @InjectRepository(AutomationRunLog)
    private readonly runLogRepo: Repository<AutomationRunLog>,
    @Inject(CategoryEvaluatorService)
    private readonly categoryEvaluatorService: CategoryEvaluatorService,
    @Inject(FreeTierDispatchService)
    private readonly freeTierDispatchService: FreeTierDispatchService,
    @Inject(GoogleFreeDispatchService)
    private readonly googleFreeDispatchService: GoogleFreeDispatchService,
    @Inject(GroqFreeDispatchService)
    private readonly groqFreeDispatchService: GroqFreeDispatchService,
  ) {}

  async run(): Promise<void> {
    const date = todayUtcDateStamp();
    const triggeredAt = new Date();
    // Upsert only {date, triggeredAt} (not a full save()) so a defensive
    // re-run on the same UTC day refreshes triggeredAt without wiping
    // whichever legs already recorded an outcome from an earlier run today.
    await this.runLogRepo.upsert({ date, triggeredAt }, ["date"]);

    await this.runJudgeLeg(date);
    await this.runMiniBurnLeg(date);
    await this.runGoogleBurnLeg(date);
    await this.runGroqBurnLeg(date);
  }

  async getTodayStatus(): Promise<AutomationRunLog | null> {
    return this.runLogRepo.findOne({ where: { date: todayUtcDateStamp() } });
  }

  private async runJudgeLeg(date: string): Promise<void> {
    try {
      const result = await this.categoryEvaluatorService.enqueuePending({ limit: JUDGE_LEG_LIMIT });
      await this.runLogRepo.update({ date }, { judgeEnqueued: result.enqueued, judgeError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enqueue judge backlog";
      this.logger.error(`daily automation judge leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { judgeEnqueued: null, judgeError: message });
    }
  }

  private async runMiniBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.freeTierDispatchService.getStatus("mini");
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          {
            miniBurnOutcome: "alreadyActive",
            miniBurnMessage: `already running at ${current.thresholdPercent}%`,
          },
        );
        return;
      }

      await this.freeTierDispatchService.start("mini", MINI_BURN_CEILING_PERCENT);
      await this.runLogRepo.update(
        { date },
        {
          miniBurnOutcome: "started",
          miniBurnMessage: `started at ${MINI_BURN_CEILING_PERCENT}%`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start mini/nano burn";
      this.logger.error(`daily automation mini-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { miniBurnOutcome: "error", miniBurnMessage: message },
      );
    }
  }

  private async runGoogleBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.googleFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { googleBurnOutcome: "alreadyActive", googleBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.googleFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted"
          ? "every Google model is currently RPD-held"
          : "started";
      await this.runLogRepo.update(
        { date },
        { googleBurnOutcome: result.outcome, googleBurnMessage: message },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Google burn";
      this.logger.error(`daily automation google-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { googleBurnOutcome: "error", googleBurnMessage: message },
      );
    }
  }

  private async runGroqBurnLeg(date: string): Promise<void> {
    try {
      const current = await this.groqFreeDispatchService.getStatus();
      if (current.active) {
        await this.runLogRepo.update(
          { date },
          { groqBurnOutcome: "alreadyActive", groqBurnMessage: "already running" },
        );
        return;
      }

      const result = await this.groqFreeDispatchService.start();
      const message =
        result.outcome === "alreadyExhausted"
          ? "every Groq model is currently RPD-held"
          : "started";
      await this.runLogRepo.update(
        { date },
        { groqBurnOutcome: result.outcome, groqBurnMessage: message },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Groq burn";
      this.logger.error(`daily automation groq-burn leg failed: ${message}`);
      await this.runLogRepo.update(
        { date },
        { groqBurnOutcome: "error", groqBurnMessage: message },
      );
    }
  }
}
