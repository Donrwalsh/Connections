import { useEffect, useState } from "react";
import { HeroHeader } from "../../components/benchmark/HeroHeader";
import { MetricSelector } from "../../components/benchmark/MetricSelector";
import { StatusStrip } from "../../components/benchmark/StatusStrip";
import { StrategyTable } from "../../components/benchmark/StrategyTable";
import { fetchLeaderboard } from "../../data/benchmark/api";
import type { LeaderboardMetricKey } from "../../data/benchmark/metrics";
import type { Leaderboard } from "../../data/benchmark/types";

/** Homepage of the benchmark area: two DB-driven leaderboard tables (one for
 * deterministic/shuffle strategies, one for LLM models — see StrategyTable's
 * `variant`) sharing one configurable sort metric. A strategy or model only
 * gets a row once it has an actual run — see GET /strategy/leaderboard.
 * Rows navigate to /leaderboard/:id. */
export function LeaderboardPage() {
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricKey, setMetricKey] = useState<LeaderboardMetricKey>("avgGuesses");

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetchLeaderboard(controller.signal)
      .then((data) => {
        setLeaderboard(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load leaderboard");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, []);

  const allRows = leaderboard ? [...leaderboard.deterministic, ...leaderboard.llm] : [];
  const active = allRows.reduce((sum, row) => sum + row.progress.active, 0);
  const queued = allRows.reduce((sum, row) => sum + row.progress.queued, 0);

  return (
    <div className="bench-page">
      <HeroHeader />
      <StatusStrip running={active} queued={queued} />

      {isLoading ? <p className="bench-muted">Loading leaderboard…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && leaderboard ? (
        <>
          <section className="bench-page__section" aria-label="Deterministic and shuffle leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">Deterministic &amp; Shuffle</h2>
              <MetricSelector value={metricKey} onChange={setMetricKey} />
            </div>
            {leaderboard.deterministic.length === 0 ? (
              <p className="bench-muted">No deterministic or shuffle runs yet.</p>
            ) : (
              <StrategyTable rows={leaderboard.deterministic} metricKey={metricKey} variant="deterministic" />
            )}
          </section>

          <section className="bench-page__section" aria-label="LLM leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">LLM Models</h2>
            </div>
            {leaderboard.llm.length === 0 ? (
              <p className="bench-muted">No LLM runs yet.</p>
            ) : (
              <StrategyTable rows={leaderboard.llm} metricKey={metricKey} variant="llm" />
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
