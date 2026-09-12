import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useAdminAuth } from "../../auth/useAdminAuth";
import { CategoryJudgingWidget } from "../../components/benchmark/CategoryJudgingWidget";
import { FreeTierBudgetWidget } from "../../components/benchmark/FreeTierBudgetWidget";
import { FreeTierDispatchModal } from "../../components/benchmark/FreeTierDispatchModal";
import { PoolDispatchWidget } from "../../components/benchmark/PoolDispatchWidget";
import { ProviderFilter } from "../../components/benchmark/ProviderFilter";
import { RecentActivityTable } from "../../components/benchmark/RecentActivityTable";
import { fetchAutomationStatus, fetchFreeTierUsage, fetchLeaderboard, fetchRecentActivity } from "../../data/benchmark/api";
import type { AutomationLegDisplay, FreeTierModelSets } from "../../data/benchmark/types";
import {
  providerPoolById,
  selectedProviderPools,
  serializeProviderParam,
} from "../../data/benchmark/providerPools";
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
  const { isAdmin } = useAdminAuth();
  const [isDispatchModalOpen, setIsDispatchModalOpen] = useState(false);
  // Bumped after FreeTierDispatchModal starts a cycle, so both widgets
  // refetch their dispatch status immediately instead of waiting out their
  // own poll interval — see FreeTierBudgetWidget's refreshSignal prop.
  const [dispatchRefreshSignal, setDispatchRefreshSignal] = useState(0);

  const { data: leaderboard } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: ({ signal }) => fetchLeaderboard(signal),
    enabled: isAdmin,
  });

  // Best-effort: which models belong to which free tier is only used for
  // the spend figures below, so a failed fetch here just leaves them blank
  // rather than surfacing a page-level error (see combine below).
  const freeTierModels = useQueries({
    queries: (["flagship", "mini"] as const).map((tier) => ({
      queryKey: ["free-tier-usage", tier],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchFreeTierUsage(tier, signal),
      enabled: isAdmin,
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
    enabled: isAdmin,
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

  const openRouterBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.openRouterBurn.outcome === "error"
            ? `failed: ${automationStatus.openRouterBurn.message}`
            : automationStatus.openRouterBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.openRouterBurn.outcome === "error",
      }
    : null;

  const mistralBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.mistralBurn.outcome === "error"
            ? `failed: ${automationStatus.mistralBurn.message}`
            : automationStatus.mistralBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.mistralBurn.outcome === "error",
      }
    : null;

  const sambaNovaBurnAutomation: AutomationLegDisplay | null = automationStatus
    ? {
        message:
          automationStatus.sambaNovaBurn.outcome === "error"
            ? `failed: ${automationStatus.sambaNovaBurn.message}`
            : automationStatus.sambaNovaBurn.message,
        lastRunAt: automationStatus.lastRunAt,
        nextRunAt: automationStatus.nextRunAt,
        isError: automationStatus.sambaNovaBurn.outcome === "error",
      }
    : null;

  const [searchParams] = useSearchParams();
  const selectedPools = selectedProviderPools(searchParams);
  // The pool filter is applied server-side now — each list comes back as
  // the newest 100 *within* the selected pools, not the newest 100 overall
  // then filtered. The serialized param is part of the query key so a
  // selection change refetches rather than reusing a differently-scoped
  // cache entry.
  const providerKey = serializeProviderParam(selectedPools) ?? "";
  const providerIds = [...selectedPools];

  const {
    data: recentActivity,
    isLoading: isLoadingActivity,
    error: recentActivityError,
  } = useQuery({
    queryKey: ["recent-activity", providerKey],
    queryFn: ({ signal }) => fetchRecentActivity(signal, providerIds),
    refetchInterval: RECENT_ACTIVITY_POLL_MS,
  });

  const solveEvents = recentActivity?.runs ?? [];
  const judgmentEvents = recentActivity?.judgments ?? [];

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
          {isAdmin ? (
            <button
              type="button"
              className="bench-btn-primary"
              onClick={() => setIsDispatchModalOpen(true)}
            >
              Enable Auto-Dispatch
            </button>
          ) : null}
        </div>
      </header>

      {isAdmin ? (
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
          <PoolDispatchWidget pool={providerPoolById("google")} automation={googleBurnAutomation} />
          <PoolDispatchWidget pool={providerPoolById("groq")} automation={groqBurnAutomation} />
          <PoolDispatchWidget
            pool={providerPoolById("openrouter")}
            automation={openRouterBurnAutomation}
          />
          <PoolDispatchWidget pool={providerPoolById("mistral")} automation={mistralBurnAutomation} />
          <PoolDispatchWidget
            pool={providerPoolById("sambanova")}
            automation={sambaNovaBurnAutomation}
          />
        </div>
      ) : null}

      {isDispatchModalOpen ? (
        <FreeTierDispatchModal
          onClose={() => setIsDispatchModalOpen(false)}
          onDispatchChanged={() => setDispatchRefreshSignal((current) => current + 1)}
        />
      ) : null}

      <div className="bench-page__section-head">
        <h2 className="bench-page__section-title">Recent Activity</h2>
      </div>
      <ProviderFilter />

      {isLoadingActivity ? <p className="bench-muted">Loading activity…</p> : null}
      {recentActivityError ? (
        <p className="bench-error">Couldn&apos;t load recent activity.</p>
      ) : null}

      {!isLoadingActivity && !recentActivityError ? (
        <>
          <section className="bench-page__section" aria-label="Puzzle solves">
            <div className="bench-page__section-head">
              <h3 className="bench-page__section-title">Puzzle Solves</h3>
            </div>
            <RecentActivityTable
              events={solveEvents}
              caption="Puzzle solves"
              emptyLabel="No puzzle solves yet."
            />
          </section>

          <section className="bench-page__section" aria-label="Category judgments">
            <div className="bench-page__section-head">
              <h3 className="bench-page__section-title">Category Judgments</h3>
            </div>
            <RecentActivityTable
              events={judgmentEvents}
              caption="Category judgments"
              emptyLabel="No category judgments yet."
            />
          </section>
        </>
      ) : null}
    </div>
  );
}
