import { useNavigate } from "react-router-dom";
import {
  formatCostUsd,
  formatDuration,
  formatGuessCount,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
import { describeLeaderboardRow } from "../../data/benchmark/mockData";
import type { LeaderboardRow } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

/** Which models belong to each free-token program (see FreeTierId) — used
 * only to badge LLM rows on this table, so a model missing from both sets
 * (or the fetch that populates them still being in flight) just renders with
 * no badge rather than an error. */
export interface FreeTierModelSets {
  flagship: Set<string>;
  mini: Set<string>;
}

export interface StrategyTableProps {
  rows: LeaderboardRow[];
  metricKey: LeaderboardMetricKey;
  /** 'llm' shows Success rate and Avg duration (the raw average time an LLM
   * call took, in ms/s as appropriate) — an LLM run's wall-clock time is
   * itself the meaningful number, unlike deterministic/shuffle runs which
   * finish in single-digit milliseconds and are more legible as a derived
   * "solves/hr" rate. 'deterministic' covers deterministic *and*
   * shuffle-smart/shuffle-foolish rows — instead of Success rate it shows
   * Avg speed, Avg guesses, and Range: none of these strategies are bound by
   * the LLM's 4-mistake failure cap, so a brute-force run can rack up
   * hundreds or thousands of guesses, formatted here as whole numbers with
   * thousands separators. */
  variant: "llm" | "deterministic";
  /** Only consulted for variant 'llm'; omit for 'deterministic' rows, which
   * never belong to a free tier. */
  freeTierModels?: FreeTierModelSets;
}

function formatRange(
  min: number | null,
  max: number | null,
  formatGuesses: (value: number) => string,
): string {
  if (min === null || max === null) return "—";
  return `${formatGuesses(min)}–${formatGuesses(max)}`;
}

/** Leaderboard table of aggregated strategy/model rows (see LeaderboardRow).
 * The leading (top-ranked) row per the active metric gets the accent
 * "leading" treatment. Rows navigate to /leaderboard/:id. */
export function StrategyTable({ rows, metricKey, variant, freeTierModels }: StrategyTableProps) {
  const navigate = useNavigate();
  const metric = getMetricDefinition(metricKey);
  const sorted = sortStrategiesByMetric(rows, metricKey);
  const isDeterministic = variant === "deterministic";

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">
        {variant === "llm" ? "LLM strategies" : "Deterministic & shuffle strategies"} ·{" "}
        {metric.label} — {metric.higherIsBetter ? "best first" : "fewest guesses first"}
      </caption>
      <thead>
        <tr>
          <th scope="col">Strategy</th>
          {variant === "llm" ? <th scope="col">Success rate</th> : null}
          <th scope="col">{variant === "llm" ? "Avg duration" : "Avg speed"}</th>
          {isDeterministic ? (
            <>
              <th scope="col">Avg guesses</th>
              <th scope="col">Range</th>
            </>
          ) : (
            <th scope="col">Avg cost</th>
          )}
          <th scope="col">Progress</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row, index) => {
          const { name, description } = describeLeaderboardRow(row);
          const { progress } = row;
          const queueBadges: { label: string; count: number; tone: "queued" | "active" | "failed" }[] = [
            { label: "Queued", count: progress.queued, tone: "queued" },
            { label: "Active", count: progress.active, tone: "active" },
            { label: "Failed", count: progress.failed, tone: "failed" },
          ];
          const speed = metricValue(row, "speed");
          const successRateDisplay = row.successRate === null ? "—" : `${Math.round(row.successRate)}%`;
          // Unitless here — the "solves/hr" caption below the value supplies
          // the unit, so it isn't baked into this number too.
          const speedDisplay = speed === null ? "—" : Math.round(speed).toLocaleString();
          const durationDisplay =
            row.avgDurationMs === null ? "—" : formatDuration(row.avgDurationMs);
          const freeTier =
            row.modelName && freeTierModels?.flagship.has(row.modelName)
              ? "flagship"
              : row.modelName && freeTierModels?.mini.has(row.modelName)
                ? "mini"
                : null;
          return (
            <tr
              key={row.id}
              className={index === 0 ? "bench-row bench-row--leading" : "bench-row"}
              onClick={() => navigate(`/leaderboard/${row.id}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${row.id}`);
                }
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${name} details`}
            >
              <td>
                <span className="bench-strategy-name-row">
                  <span className="bench-strategy-name">{name}</span>
                  {freeTier ? (
                    <span
                      title={`Counts toward the ${freeTier === "flagship" ? "flagship" : "mini"} free-token budget.`}
                    >
                      <StatusPill label={freeTier === "flagship" ? "Flagship" : "Mini"} tone={freeTier} />
                    </span>
                  ) : null}
                </span>
                <span className="bench-strategy-desc">{description}</span>
              </td>
              {variant === "llm" ? <td className="bench-mono">{successRateDisplay}</td> : null}
              {variant === "llm" ? (
                <td className="bench-mono">{durationDisplay}</td>
              ) : (
                <td>
                  <span className="bench-mono bench-metric-value">{speedDisplay}</span>
                  <span className="bench-metric-unit">solves/hr</span>
                </td>
              )}
              {isDeterministic ? (
                <>
                  <td className="bench-mono">
                    {row.avgGuessesToSolve === null ? "—" : formatGuessCount(row.avgGuessesToSolve)}
                  </td>
                  <td className="bench-mono">
                    {formatRange(row.minGuesses, row.maxGuesses, formatGuessCount)}
                  </td>
                </>
              ) : (
                <td className="bench-mono">
                  {row.avgCostUsd === null ? "—" : formatCostUsd(row.avgCostUsd)}
                </td>
              )}
              <td>
                <span className="bench-progress">
                  <span className="bench-mono">
                    {row.puzzlesCovered.toLocaleString()} of {row.totalPuzzles.toLocaleString()} puzzles
                  </span>
                  <span className="bench-badges">
                    {queueBadges.map((badge) =>
                      badge.count > 0 ? (
                        <StatusPill
                          key={badge.label}
                          label={`${badge.label} ${badge.count.toLocaleString()}`}
                          tone={badge.tone}
                        />
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
