import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { FreeTierDispatchService } from "../free-tier-dispatch/free-tier-dispatch.service";
import { FreeDispatchService } from "../provider-pool/free-dispatch.service";
import type { ProviderPoolId } from "../provider-pool/provider-pool.config";
import { ModelMetadataRefreshService } from "../supported-model/model-metadata-refresh.service";

/** One free-tier burn leg: the dispatch service to start, the
 * AutomationRunLog column pair to record into, and the "nothing to do"
 * message. Ordered google -> groq -> openrouter -> mistral -> sambanova, the
 * sequence `run()` fires them in. */
interface BurnLeg {
  service: { getStatus(): Promise<{ active: boolean }>; start(): Promise<{ outcome: string }> };
  logKey: string;
  outcomeColumn: keyof AutomationRunLog;
  messageColumn: keyof AutomationRunLog;
  exhaustedMessage: string;
}

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
 * Runs on a daily UTC cron (see DailyAutomationBootstrap). Runs eight legs
 * in turn — each leg is awaited before the next starts, but one leg's
 * failure never prevents the next from running (see each leg's own
 * try/catch) — and records each one's outcome into today's AutomationRunLog
 * row as soon as it resolves.
 *
 * The startup catch-up run the bootstrap enqueues on every redeploy passes
 * `{ skipJudgeLeg: true }`: the judge leg enqueues a batch of up to
 * JUDGE_LEG_LIMIT category-judge calls and its spend lands in the mini-tier
 * budget, so it should fire once a day at the scheduled cron time, not
 * again every time the backend restarts. The other legs are safe to repeat
 * — each checks live status first or is naturally idempotent for the day.
 *
 * The legs:
 *
 *  - metadataRefresh: refreshes SupportedModel's OpenRouter-sourced
 *    metadata/pricing first, awaited in-process before any dispatch leg
 *    runs — the only thing that actually guarantees "metadata refresh
 *    happens before automated dispatch" rather than relying on two
 *    independent cron schedules to stay out of each other's way. A failed
 *    refresh doesn't block dispatch (stale/missing metadata only means
 *    blank leaderboard fields, not broken dispatch), so this never stops
 *    the legs below from running;
 *  - judge: enqueues the category-judge backlog (its spend already lands in
 *    the same mini-tier budget FreeTierUsageService tracks);
 *  - miniBurn: starts a FreeTierDispatchService "mini" cycle at an 80%
 *    ceiling, leaving the other 15% (of the 95% overall safety cap) as
 *    headroom for the judge leg's spend;
 *  - googleBurn/groqBurn/openRouterBurn/mistralBurn/sambaNovaBurn: each
 *    starts the unified FreeDispatchService's cycle for that pool — runs
 *    until every model is RPD-held (google/groq/mistral/sambanova) or the
 *    account-wide daily-call budget is spent or held (openrouter).
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
    @Inject(FreeDispatchService)
    private readonly freeDispatchService: FreeDispatchService,
    @Inject(ModelMetadataRefreshService)
    private readonly modelMetadataRefreshService: ModelMetadataRefreshService,
  ) {}

  private get burnLegs(): BurnLeg[] {
    return [
      {
        service: this.poolService("google"),
        logKey: "google",
        outcomeColumn: "googleBurnOutcome",
        messageColumn: "googleBurnMessage",
        exhaustedMessage: "every Google model is currently RPD-held",
      },
      {
        service: this.poolService("groq"),
        logKey: "groq",
        outcomeColumn: "groqBurnOutcome",
        messageColumn: "groqBurnMessage",
        exhaustedMessage: "every Groq model is currently RPD-held",
      },
      {
        service: this.poolService("openrouter"),
        logKey: "openrouter",
        outcomeColumn: "openRouterBurnOutcome",
        messageColumn: "openRouterBurnMessage",
        exhaustedMessage: "OpenRouter daily budget spent or account held",
      },
      {
        service: this.poolService("mistral"),
        logKey: "mistral",
        outcomeColumn: "mistralBurnOutcome",
        messageColumn: "mistralBurnMessage",
        exhaustedMessage: "every Mistral model is currently held",
      },
      {
        service: this.poolService("sambanova"),
        logKey: "sambanova",
        outcomeColumn: "sambaNovaBurnOutcome",
        messageColumn: "sambaNovaBurnMessage",
        exhaustedMessage: "every SambaNova model is currently held",
      },
    ];
  }

  /** Binds the unified FreeDispatchService to one pool id, in the shape
   * BurnLeg expects — the AutomationRunLog column pair stays named per
   * provider (a separate, deferred deepening; see docs/architecture/10), so
   * this only collapses which *service* each leg calls, not the columns. */
  private poolService(poolId: ProviderPoolId): BurnLeg["service"] {
    return {
      getStatus: () => this.freeDispatchService.getStatus(poolId),
      start: () => this.freeDispatchService.start(poolId),
    };
  }

  async run(options: { skipJudgeLeg?: boolean } = {}): Promise<void> {
    const date = todayUtcDateStamp();
    const triggeredAt = new Date();
    // Upsert only {date, triggeredAt} (not a full save()) so a defensive
    // re-run on the same UTC day refreshes triggeredAt without wiping
    // whichever legs already recorded an outcome from an earlier run today.
    await this.runLogRepo.upsert({ date, triggeredAt }, ["date"]);

    await this.runMetadataRefreshLeg(date);
    if (options.skipJudgeLeg) {
      this.logger.log("daily automation: skipping judge leg (startup catch-up run)");
    } else {
      await this.runJudgeLeg(date);
    }
    await this.runMiniBurnLeg(date);
    for (const leg of this.burnLegs) {
      await this.runPoolBurnLeg(leg, date);
    }
  }

  async getTodayStatus(): Promise<AutomationRunLog | null> {
    return this.runLogRepo.findOne({ where: { date: todayUtcDateStamp() } });
  }

  private async runMetadataRefreshLeg(date: string): Promise<void> {
    try {
      const result = await this.modelMetadataRefreshService.refreshAll();
      await this.runLogRepo.update(
        { date },
        { metadataRefreshUpdated: result.updated, metadataRefreshError: null },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to refresh model metadata";
      this.logger.error(`daily automation metadata-refresh leg failed: ${message}`);
      await this.runLogRepo.update({ date }, { metadataRefreshUpdated: null, metadataRefreshError: message });
    }
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
      await this.runLogRepo.update({ date }, { miniBurnOutcome: "error", miniBurnMessage: message });
    }
  }

  /**
   * One free-tier burn leg: start `leg.service`'s dispatch cycle unless it is
   * already running, and record the outcome into `leg`'s AutomationRunLog
   * column pair. A failure is caught and logged as this leg's outcome — it
   * never stops the next leg. Was five near-identical `run<P>BurnLeg`
   * methods before the provider-pool unification.
   */
  private async runPoolBurnLeg(leg: BurnLeg, date: string): Promise<void> {
    const record = (outcome: string, message: string) =>
      this.runLogRepo.update({ date }, {
        [leg.outcomeColumn]: outcome,
        [leg.messageColumn]: message,
      } as QueryDeepPartialEntity<AutomationRunLog>);

    try {
      const current = await leg.service.getStatus();
      if (current.active) {
        await record("alreadyActive", "already running");
        return;
      }

      const result = await leg.service.start();
      await record(
        result.outcome,
        result.outcome === "alreadyExhausted" ? leg.exhaustedMessage : "started",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to start ${leg.logKey} burn`;
      this.logger.error(`daily automation ${leg.logKey}-burn leg failed: ${message}`);
      await record("error", message);
    }
  }
}
