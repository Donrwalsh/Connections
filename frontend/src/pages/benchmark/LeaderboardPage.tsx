import { useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { FreeTierBudgetWidget } from "../../components/benchmark/FreeTierBudgetWidget";
import { HeroHeader } from "../../components/benchmark/HeroHeader";
import { MetricSelector } from "../../components/benchmark/MetricSelector";
import { StatusStrip } from "../../components/benchmark/StatusStrip";
import { StrategyTable, type FreeTierModelSets } from "../../components/benchmark/StrategyTable";
import { fetchFreeTierUsage, fetchLeaderboard } from "../../data/benchmark/api";
import type { LeaderboardMetricKey } from "../../data/benchmark/metrics";
import type { LeaderboardRow } from "../../data/benchmark/types";

/** Total USD cost (row.totalCostUsd, which is already all-time — not
 * today-scoped like the token budget) across every LLM row whose model
 * belongs to `models`. Null while either input hasn't loaded yet, so the
 * widget can distinguish "not loaded" from "genuinely $0 spent". */
function sumSpendUsd(llmRows: LeaderboardRow[] | null, models: Set<string>): number | null {
  if (llmRows === null || models.size === 0) return null;
  return llmRows.reduce(
    (sum, row) => (row.modelName && models.has(row.modelName) ? sum + (row.totalCostUsd ?? 0) : sum),
    0,
  );
}

/** Homepage of the benchmark area: two DB-driven leaderboard tables (LLM
 * strategies above deterministic/shuffle strategies — see StrategyTable's
 * `variant`) sharing one configurable sort metric. A strategy or model only
 * gets a row once it has an actual run — see GET /strategy/leaderboard.
 * Rows navigate to /leaderboard/:id. */
export function LeaderboardPage() {
  const [metricKey, setMetricKey] = useState<LeaderboardMetricKey>("successRate");

  const {
    data: leaderboard,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: ({ signal }) => fetchLeaderboard(signal),
  });
  const error = queryError instanceof Error ? queryError.message : null;

  // Best-effort: which models belong to which free tier is only used for a
  // small badge, so a failed fetch here just leaves rows unbadged rather
  // than surfacing a page-level error (see combine below).
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

  const allRows = leaderboard ? [...leaderboard.deterministic, ...leaderboard.llm] : [];
  const active = allRows.reduce((sum, row) => sum + row.progress.active, 0);
  const queued = allRows.reduce((sum, row) => sum + row.progress.queued, 0);
  const llmRows = leaderboard ? leaderboard.llm : null;
  const flagshipSpentUsd = sumSpendUsd(llmRows, freeTierModels.flagship);
  const miniSpentUsd = sumSpendUsd(llmRows, freeTierModels.mini);

  return (
    <div className="bench-page">
      <HeroHeader />
      <StatusStrip running={active} queued={queued} />
      <div className="bench-free-tiers" aria-label="Daily free-token budgets">
        <FreeTierBudgetWidget tier="flagship" spentUsd={flagshipSpentUsd} />
        <FreeTierBudgetWidget tier="mini" spentUsd={miniSpentUsd} />
      </div>

      {isLoading ? <p className="bench-muted">Loading leaderboard…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && leaderboard ? (
        <>
          <section className="bench-page__section" aria-label="LLM leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">LLM Strategies</h2>
              <MetricSelector value={metricKey} onChange={setMetricKey} />
            </div>
            {leaderboard.llm.length === 0 ? (
              <p className="bench-muted">No LLM runs yet.</p>
            ) : (
              <StrategyTable
                rows={leaderboard.llm}
                metricKey={metricKey}
                variant="llm"
                freeTierModels={freeTierModels}
              />
            )}
          </section>

          <section className="bench-page__section" aria-label="Deterministic and shuffle leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">Deterministic &amp; Shuffle</h2>
            </div>
            {leaderboard.deterministic.length === 0 ? (
              <p className="bench-muted">No deterministic or shuffle runs yet.</p>
            ) : (
              <StrategyTable rows={leaderboard.deterministic} metricKey={metricKey} variant="deterministic" />
            )}
          </section>
        </>
      ) : null}

      {/* Out of scope for this pass — see DESIGN.md "Calendar". */}
      <section className="bench-coverage-stub" aria-label="Puzzle coverage calendar">
        <h2 className="bench-coverage-stub__title">Coverage calendar</h2>
        <p className="bench-muted">
          Placeholder — the puzzle-ingestion/coverage calendar will be built
          here next, driven by real data rather than mock fixtures.
        </p>
      </section>
    </div>
  );
}
