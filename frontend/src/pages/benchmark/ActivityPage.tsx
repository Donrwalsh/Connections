import { useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { FreeTierBudgetWidget } from "../../components/benchmark/FreeTierBudgetWidget";
import { FreeTierDispatchModal } from "../../components/benchmark/FreeTierDispatchModal";
import { RecentRunsTable } from "../../components/benchmark/RecentRunsTable";
import type { FreeTierModelSets } from "../../components/benchmark/StrategyTable";
import { fetchFreeTierUsage, fetchLeaderboard, fetchRecentRuns } from "../../data/benchmark/api";
import { sumSpendUsd } from "../../data/benchmark/metrics";

// How often the recent-runs table refetches. Frequent enough to feel "live"
// while a dispatch cycle is running without hammering the endpoint — same
// order of magnitude as FreeTierBudgetWidget's dispatch-status poll (30s),
// just faster since new rows here are the whole point of the table.
const RECENT_RUNS_POLL_MS = 10_000;

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

  const {
    data: recentRuns,
    isLoading: isLoadingRuns,
    error: recentRunsError,
  } = useQuery({
    queryKey: ["recent-runs"],
    queryFn: ({ signal }) => fetchRecentRuns(signal),
    refetchInterval: RECENT_RUNS_POLL_MS,
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
        <FreeTierBudgetWidget tier="mini" spentUsd={miniSpentUsd} refreshSignal={dispatchRefreshSignal} />
      </div>

      {isDispatchModalOpen ? (
        <FreeTierDispatchModal
          onClose={() => setIsDispatchModalOpen(false)}
          onDispatchChanged={() => setDispatchRefreshSignal((current) => current + 1)}
        />
      ) : null}

      <section className="bench-page__section" aria-label="Recent runs">
        <div className="bench-page__section-head">
          <h2 className="bench-page__section-title">Recent Runs</h2>
        </div>

        {isLoadingRuns ? <p className="bench-muted">Loading runs…</p> : null}
        {recentRunsError ? <p className="bench-error">Couldn&apos;t load recent runs.</p> : null}
        {!isLoadingRuns && !recentRunsError ? <RecentRunsTable runs={recentRuns ?? []} /> : null}
      </section>
    </div>
  );
}
