import { formatTimestamp } from "../../data/benchmark/metrics";
import type { AutomationLegDisplay } from "../../data/benchmark/types";

/** Builds the "Auto-run: ... · Next: ..." line shared by the mini
 * FreeTierBudgetWidget, CategoryJudgingWidget, and GoogleDispatchWidget —
 * one shared format so all three daily-automation legs read consistently on
 * the page. */
export function formatAutomationLine(leg: AutomationLegDisplay): string {
  const last =
    leg.lastRunAt === null || leg.message === null
      ? "hasn't run yet today"
      : `${leg.message} (${formatTimestamp(leg.lastRunAt)})`;
  return `Auto-run: ${last} · Next: ${formatTimestamp(leg.nextRunAt)}`;
}
