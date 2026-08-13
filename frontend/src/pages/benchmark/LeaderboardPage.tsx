import { useState } from "react";
import { HeroHeader } from "../../components/benchmark/HeroHeader";
import { MetricSelector } from "../../components/benchmark/MetricSelector";
import { StatusStrip } from "../../components/benchmark/StatusStrip";
import { StrategyTable } from "../../components/benchmark/StrategyTable";
import {
  getStrategyAggregates,
  summarizeProgress,
} from "../../data/benchmark/mockData";
import type { LeaderboardMetricKey } from "../../data/benchmark/metrics";

/** Homepage of the benchmark area: strategy aggregates with a configurable
 * sort metric. Strategy rows navigate to /leaderboard/:strategyId. */
export function LeaderboardPage() {
  const strategies = getStrategyAggregates();
  const [metricKey, setMetricKey] = useState<LeaderboardMetricKey>("avgGuesses");
  const { active, queued } = summarizeProgress(strategies);

  return (
    <div className="bench-page">
      <HeroHeader />
      <StatusStrip running={active} queued={queued} />

      <section className="bench-page__section" aria-label="Strategy leaderboard">
        <div className="bench-page__section-head">
          <h2 className="bench-page__section-title">Leaderboard</h2>
          <MetricSelector value={metricKey} onChange={setMetricKey} />
        </div>
        <StrategyTable strategies={strategies} metricKey={metricKey} />
      </section>

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
