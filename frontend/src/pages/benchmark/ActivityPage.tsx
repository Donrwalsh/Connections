import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CategoryJudgingWidget } from "../../components/benchmark/CategoryJudgingWidget";
import { FreeTierBudgetWidget } from "../../components/benchmark/FreeTierBudgetWidget";
import { FreeTierDispatchModal } from "../../components/benchmark/FreeTierDispatchModal";
import { GoogleDispatchWidget } from "../../components/benchmark/GoogleDispatchWidget";
import { GroqDispatchWidget } from "../../components/benchmark/GroqDispatchWidget";
import { RecentActivityTable } from "../../components/benchmark/RecentActivityTable";
import type { FreeTierModelSets } from "../../components/benchmark/StrategyTable";
import { fetchAutomationStatus, fetchFreeTierUsage, fetchLeaderboard, fetchRecentActivity } from "../../data/benchmark/api";
import type { AutomationLegDisplay } from "../../data/benchmark/types";
import { sumSpendUsd } from "../../data/benchmark/metrics";

// How often the recent-activity table refetches. Frequent enough to feel
// "live" while a dispatch cycle is running without hammering the endpoint —
// same order of magnitude as FreeTierBudgetWidget's dispatch-status poll
// (30s), just faster since new rows here are the whole point of the table.
const RECENT_ACTIVITY_POLL_MS = 10_000;

/** Operational overview: daily free-token usage for both provider tiers,
 * plus a live feed of the most recent runs across every strategy/model —
 * split out of the leaderboard page (which only covers strategy/model
 * performance) since both of these are operational concerns, not
 * leaderboard metrics. */
export function ActivityPage() {
  const [isDispatchModalOpen, setIsDispatchModalOpen] = useState(false);
  // Bumped after FreeTierDispatchModal starts a cycle, so both widgets
  // refetch their dispatch status immediately instead of waiting out their
  // own poll interval — see FreeTierBudgetWidget's refreshSignal prop.
  const [dispatchRefreshSignal, setDispatchRefreshSignal] = useState(0);

  const { data: leaderboard } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: ({ signal }) => fetchLeaderboard(signal),
  });

  // Best-effort: which models belong to which free tier is only used for
  // the spend figures below, so a failed fetch here just leaves them blank
  // rather than surfacing a page-level error (see combine below).
  const freeTierModels = useQueries({
    queries: (["flagship", "mini"] as const).map((tier) => ({
      queryKey: ["free-tier-usage", tier],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchFreeTierUsage(tier, signal),
    })),
    combine: (results): FreeTierModelSets => ({
      flagship: new Set(results[0].data?.models ?? []),
      mini: new Set(results[1].data?.models ?? []),
    }),
  });

  const llmRows = leaderboard ? leaderboard.llm : null;
  const flagshipSpentUsd = sumSpendUsd(llmRows, freeTierModels.flagship);
  const miniSpentUsd = sumSpendUsd(llmRows, freeTierModels.mini);

  const { data: automationStatus } = useQuery({
    queryKey: ["automation-status"],
    queryFn: ({ signal }) => fetchAutomationStatus(signal),
    refetchInterval: 30_000,
  });

  const judgeAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.judge.error !== null
            ? `failed: ${automationStatus.judge.error}`
            : automationStatus.judge.enqueued !== null
              ? `enqueued ${automationStatus.judge.enqueued}`
              : null,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.judge.error !== null,
      }
    : null;

  const miniBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.miniBurn.outcome === "error"
            ? `failed: ${automationStatus.miniBurn.message}`
            : automationStatus.miniBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.miniBurn.outcome === "error",
      }
    : null;

  const googleBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.googleBurn.outcome === "error"
            ? `failed: ${automationStatus.googleBurn.message}`
            : automationStatus.googleBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.googleBurn.outcome === "error",
      }
    : null;

  const groqBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.groqBurn.outcome === "error"
            ? `failed: ${automationStatus.groqBurn.message}`
            : automationStatus.groqBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.groqBurn.outcome === "error",
      }
    : null;

  const {
    data: recentActivity,
    isLoading: isLoadingActivity,
    error: recentActivityError,
  } = useQuery({
    queryKey: ["recent-activity"],
    queryFn: ({ signal }) => fetchRecentActivity(signal),
    refetchInterval: RECENT_ACTIVITY_POLL_MS,
  });

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <div className="bench-page-header__title-row">
          <div className="bench-page-header__title-block">
            <h1 className="bench-page-header__title">Activity</h1>
            <p className="bench-strategy-desc">
              Daily free-token usage and the latest runs across every strategy.
            </p>
          </div>
          <button type="button" className="bench-btn-primary" onClick={() => setIsDispatchModalOpen(true)}>
            Enable Auto-Dispatch
          </button>
        </div>
      </header>

      <div className="bench-free-tiers" aria-label="Daily free-token budgets">
        <FreeTierBudgetWidget
          tier="flagship"
          spentUsd={flagshipSpentUsd}
          refreshSignal={dispatchRefreshSignal}
        />
        <FreeTierBudgetWidget
          tier="mini"
          spentUsd={miniSpentUsd}
          refreshSignal={dispatchRefreshSignal}
          automation={miniBurnAutomation}
        />
        <CategoryJudgingWidget automation={judgeAutomation} />
        <GoogleDispatchWidget automation={googleBurnAutomation} />
        <GroqDispatchWidget automation={groqBurnAutomation} />
      </div>

      {isDispatchModalOpen ? (
        <FreeTierDispatchModal
          onClose={() => setIsDispatchModalOpen(false)}
          onDispatchChanged={() => setDispatchRefreshSignal((current) => current + 1)}
        />
      ) : null}

      <section className="bench-page__section" aria-label="Recent activity">
        <div className="bench-page__section-head">
          <h2 className="bench-page__section-title">Recent Activity</h2>
        </div>

        {isLoadingActivity ? <p className="bench-muted">Loading activity…</p> : null}
        {recentActivityError ? (
          <p className="bench-error">Couldn&apos;t load recent activity.</p>
        ) : null}
        {!isLoadingActivity && !recentActivityError ? (
          <RecentActivityTable events={recentActivity ?? []} />
        ) : null}
      </section>
    </div>
  );
}
