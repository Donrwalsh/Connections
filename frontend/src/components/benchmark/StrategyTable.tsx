import { useId } from "react";
import { useNavigate } from "react-router-dom";
import {
  formatDuration,
  formatGuessCount,
  formatSuccessRate,
  getMetricDefinition,
  metricValue,
  sortStrategiesByMetric,
  type LeaderboardMetricKey,
} from "../../data/benchmark/metrics";
import { describeLeaderboardRow } from "../../data/benchmark/mockData";
import type { LeaderboardRow } from "../../data/benchmark/types";
import { ProviderPill } from "./ProviderPill";
import { StatusPill } from "./StatusPill";

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
 * "leading" treatment. Rows navigate to /leaderboard/:id.
 *
 * Built on CSS Grid rather than a native <table>: the Progress readout
 * (puzzles covered + queue/active/failed badges) needs to run as a full-width
 * band underneath a row's other values, still inside that same row rather
 * than a separate sibling row. A native table can't do that (a cell can only
 * span columns within its own row's single line), but a grid item declaring
 * `grid-column: 1 / -1` naturally wraps to a second line within its own
 * row's grid once the preceding cells have filled the first — see
 * .bench-progress-band. Because each row lays out its own independent grid
 * (not one grid shared across rows), column widths are fixed per variant
 * (see .bench-grid--llm/.bench-grid--deterministic in benchmark.css) rather
 * than content-sized, so they still line up from row to row. ARIA roles
 * (table/row/columnheader) stand in for the table semantics the native
 * elements used to provide for free. */
export function StrategyTable({ rows, metricKey, variant }: StrategyTableProps) {
  const navigate = useNavigate();
  const metric = getMetricDefinition(metricKey);
  const sorted = sortStrategiesByMetric(rows, metricKey);
  const isDeterministic = variant === "deterministic";
  const captionId = useId();
  const gridClass = isDeterministic ? "bench-grid--deterministic" : "bench-grid--llm";

  return (
    <div className="bench-table-wrap bench-table-wrap--fluid">
      <p id={captionId} className="bench-table__caption">
        {variant === "llm" ? "LLM strategies" : "Deterministic & shuffle strategies"} ·{" "}
        {metric.label} — {metric.higherIsBetter ? "best first" : "fewest guesses first"}
      </p>
      <div className="bench-table" role="table" aria-labelledby={captionId}>
        <div className={`bench-grid-header ${gridClass}`} role="row">
          <div role="columnheader">Strategy</div>
          {variant === "llm" ? <div role="columnheader">Success rate</div> : null}
          <div role="columnheader">{variant === "llm" ? "Avg duration" : "Avg speed"}</div>
          {isDeterministic ? (
            <>
              <div role="columnheader">Avg guesses</div>
              <div role="columnheader">Range</div>
            </>
          ) : (
            <>
              <div role="columnheader" className="bench-col--lg-only">
                Avg issues
              </div>
              <div role="columnheader">Category IQ</div>
            </>
          )}
          <div role="columnheader" className="bench-col--lg-only">
            Progress
          </div>
        </div>

        {sorted.map((row, index) => {
          const { name, description } = describeLeaderboardRow(row);
          const { progress } = row;
          const queueBadges: { label: string; count: number; tone: "queued" | "active" | "failed" }[] = [
            { label: "Queued", count: progress.queued, tone: "queued" },
            { label: "Active", count: progress.active, tone: "active" },
            { label: "Failed", count: progress.failed, tone: "failed" },
          ];
          const speed = metricValue(row, "speed");
          const successRateDisplay = row.successRate === null ? "—" : formatSuccessRate(row.successRate);
          // Unitless here — the "solves/hr" caption below the value supplies
          // the unit, so it isn't baked into this number too.
          const speedDisplay = speed === null ? "—" : Math.round(speed).toLocaleString();
          const durationDisplay =
            row.avgDurationMs === null ? "—" : formatDuration(row.avgDurationMs);
          return (
            <div
              key={row.id}
              className={`bench-grid-row ${gridClass} ${index === 0 ? "bench-row bench-row--leading" : "bench-row"}`}
              onClick={() => navigate(`/leaderboard/${encodeURIComponent(row.id)}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${encodeURIComponent(row.id)}`);
                }
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${name} details`}
            >
              <div>
                <span className="bench-model-stack">
                  <span className="bench-strategy-name">{name}</span>
                  {variant === "llm" ? <ProviderPill strategyName={row.strategyName} /> : null}
                </span>
                <span className="bench-strategy-desc bench-col--lg-only">{description}</span>
              </div>
              {variant === "llm" ? <div className="bench-mono">{successRateDisplay}</div> : null}
              {variant === "llm" ? (
                <div className="bench-mono">{durationDisplay}</div>
              ) : (
                <div>
                  <span className="bench-mono bench-metric-value">{speedDisplay}</span>
                  <span className="bench-metric-unit">solves/hr</span>
                </div>
              )}
              {isDeterministic ? (
                <>
                  <div className="bench-mono">
                    {row.avgGuessesToSolve === null ? "—" : formatGuessCount(row.avgGuessesToSolve)}
                  </div>
                  <div className="bench-mono">
                    {formatRange(row.minGuesses, row.maxGuesses, formatGuessCount)}
                  </div>
                </>
              ) : (
                <>
                  <div className="bench-mono bench-col--lg-only">
                    {row.avgIssues === null ? "—" : row.avgIssues.toFixed(1)}
                  </div>
                  <div
                    className="bench-mono"
                    title={
                      row.categoryEvaluated === 0
                        ? "No successful guesses evaluated yet"
                        : `${row.categoryCorrect} of ${row.categoryEvaluated} correct · ${row.categoryPartial} partial · ${row.categoryLucky} lucky`
                    }
                  >
                    {row.categoryAccuracy === null
                      ? "—"
                      : formatSuccessRate(row.categoryAccuracy)}
                  </div>
                </>
              )}
              <div className="bench-progress-band">
                <div className="bench-progress-band__row">
                  <span className="bench-progress-band__label">Progress</span>
                  <span className="bench-mono">
                    {row.puzzlesCovered.toLocaleString()} of {row.totalPuzzles.toLocaleString()} puzzles
                  </span>
                </div>
                <span className="bench-badges bench-badges--float-end">
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
