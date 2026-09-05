import { Controller, Get, Inject } from "@nestjs/common";
import { DailyAutomationService } from "./daily-automation.service";
import { nextDailyAutomationRunAt } from "../../strategies";

/**
 * Read-only status for the daily free-tier-automation chain — backs the
 * "Auto-run: ... · Next: ..." line on the mini FreeTierBudgetWidget,
 * CategoryJudgingWidget, GoogleDispatchWidget, and GroqDispatchWidget. Not
 * password-gated: it enqueues nothing, same as /category-evaluation/coverage.
 */
@Controller("automation")
export class AutomationController {
  constructor(
    @Inject(DailyAutomationService) private readonly dailyAutomationService: DailyAutomationService,
  ) {}

  @Get("status")
  async getStatus() {
    const log = await this.dailyAutomationService.getTodayStatus();

    return {
      lastRunAt: log?.triggeredAt?.toISOString() ?? null,
      nextRunAt: nextDailyAutomationRunAt().toISOString(),
      judge: {
        enqueued: log?.judgeEnqueued ?? null,
        error: log?.judgeError ?? null,
      },
      miniBurn: {
        outcome: log?.miniBurnOutcome ?? null,
        message: log?.miniBurnMessage ?? null,
      },
      googleBurn: {
        outcome: log?.googleBurnOutcome ?? null,
        message: log?.googleBurnMessage ?? null,
      },
      groqBurn: {
        outcome: log?.groqBurnOutcome ?? null,
        message: log?.groqBurnMessage ?? null,
      },
    };
  }
}
