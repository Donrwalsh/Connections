import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { HeroHeader } from "../../components/benchmark/HeroHeader";
import { MetricSelector } from "../../components/benchmark/MetricSelector";
import { ProviderFilter } from "../../components/benchmark/ProviderFilter";
import { StatusStrip } from "../../components/benchmark/StatusStrip";
import { StrategyTable } from "../../components/benchmark/StrategyTable";
import { fetchLeaderboard } from "../../data/benchmark/api";
import type { LeaderboardMetricKey } from "../../data/benchmark/metrics";
import { poolFromStrategyName, selectedProviderPools } from "../../data/benchmark/providerPools";

/** Homepage of the benchmark area: two DB-driven leaderboard tables (LLM
 * strategies above deterministic/shuffle strategies — see StrategyTable's
 * `variant`) sharing one configurable sort metric. A strategy or model only
 * gets a row once it has an actual run — see GET /strategy/leaderboard.
 * Rows navigate to /leaderboard/:id. A `?provider=` filter (see
 * ProviderFilter) narrows the LLM table to selected provider pools and
 * hides the deterministic table, which has no pool. */
export function LeaderboardPage() {
  const [metricKey, setMetricKey] = useState<LeaderboardMetricKey>("successRate");
  const [searchParams] = useSearchParams();
  const selectedPools = selectedProviderPools(searchParams);
  const isFiltered = selectedPools.size > 0;

  const {
    data: leaderboard,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: ({ signal }) => fetchLeaderboard(signal),
  });
  const error = queryError instanceof Error ? queryError.message : null;

  const allRows = leaderboard ? [...leaderboard.deterministic, ...leaderboard.llm] : [];
  const active = allRows.reduce((sum, row) => sum + row.progress.active, 0);
  const queued = allRows.reduce((sum, row) => sum + row.progress.queued, 0);

  const llmRows = leaderboard
    ? isFiltered
      ? leaderboard.llm.filter((row) => {
          const pool = poolFromStrategyName(row.strategyName);
          return pool !== null && selectedPools.has(pool);
        })
      : leaderboard.llm
    : [];

  return (
    <div className="bench-page">
      <HeroHeader />
      <StatusStrip running={active} queued={queued} />

      {isLoading ? <p className="bench-muted">Loading leaderboard…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && leaderboard ? (
        <>
          <section className="bench-page__section" aria-label="LLM leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">LLM Strategies</h2>
              <MetricSelector value={metricKey} onChange={setMetricKey} />
            </div>
            <ProviderFilter />
            {llmRows.length === 0 ? (
              <p className="bench-muted">
                {isFiltered ? "No LLM runs for the selected providers." : "No LLM runs yet."}
              </p>
            ) : (
              <StrategyTable rows={llmRows} metricKey={metricKey} variant="llm" />
            )}
          </section>

          {isFiltered ? null : (
            <section
              className="bench-page__section"
              aria-label="Deterministic and shuffle leaderboard"
            >
              <div className="bench-page__section-head">
                <h2 className="bench-page__section-title">Deterministic &amp; Shuffle</h2>
              </div>
              {leaderboard.deterministic.length === 0 ? (
                <p className="bench-muted">No deterministic or shuffle runs yet.</p>
              ) : (
                <StrategyTable
                  rows={leaderboard.deterministic}
                  metricKey={metricKey}
                  variant="deterministic"
                />
              )}
            </section>
          )}
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
