import { useNavigate } from "react-router-dom";
import {
  getMetricDefinition,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
import type { StrategyAggregate } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface StrategyTableProps {
  strategies: StrategyAggregate[];
  metricKey: LeaderboardMetricKey;
}

function formatRange(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—";
  return `${Math.round(min)}–${Math.round(max)}`;
}

/** Leaderboard table of strategy aggregates. The leading (top-ranked) row per
 * the active metric gets the accent "leading" treatment. Rows navigate to
 * /leaderboard/:strategyId. */
export function StrategyTable({ strategies, metricKey }: StrategyTableProps) {
  const navigate = useNavigate();
  const metric = getMetricDefinition(metricKey);
  const sorted = sortStrategiesByMetric(strategies, metricKey);

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">
        Strategies · {metric.label} — {metric.higherIsBetter ? "best first" : "fewest guesses first"}
      </caption>
      <thead>
        <tr>
          <th scope="col">Strategy</th>
          <th scope="col">Success rate</th>
          <th scope="col">Avg guesses</th>
          <th scope="col">Range</th>
          <th scope="col">Progress</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((strategy, index) => {
          const { progress } = strategy;
          const queueBadges: { label: string; count: number; tone: "queued" | "active" | "failed" }[] = [
            { label: "Queued", count: progress.queued, tone: "queued" },
            { label: "Active", count: progress.active, tone: "active" },
            { label: "Failed", count: progress.failed, tone: "failed" },
          ];
          return (
            <tr
              key={strategy.id}
              className={index === 0 ? "bench-row bench-row--leading" : "bench-row"}
              onClick={() => navigate(`/leaderboard/${strategy.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${strategy.id}`);
                }
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${strategy.name} details`}
            >
              <td>
                <span className="bench-strategy-name">{strategy.name}</span>
                <span className="bench-strategy-desc">{strategy.description}</span>
              </td>
              <td className="bench-mono">
                {strategy.successRate === null ? "—" : `${Math.round(strategy.successRate)}%`}
              </td>
              <td className="bench-mono">
                {strategy.avgGuessesToSolve === null ? "—" : metric.format(strategy.avgGuessesToSolve)}
              </td>
              <td className="bench-mono">{formatRange(strategy.minGuesses, strategy.maxGuesses)}</td>
              <td>
                <span className="bench-progress">
                  <span className="bench-mono">
                    {progress.completed} / {strategy.expectedRuns}
                  </span>
                  <span className="bench-badges">
                    {queueBadges.map((badge) =>
                      badge.count > 0 ? (
                        <StatusPill key={badge.label} label={`${badge.label} ${badge.count}`} tone={badge.tone} />
                      ) : null,
                    )}
                    {queueBadges.every((badge) => badge.count === 0) ? (
                      <span className="bench-muted">all finished</span>
                    ) : null}
                  </span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
