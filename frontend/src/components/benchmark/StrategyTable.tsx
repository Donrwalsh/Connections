import { useId } from "react";
import { useNavigate } from "react-router-dom";
import {
  formatDuration,
  formatGuessCount,
  formatSuccessRate,
  leaderboardSortValue,
  sortLeaderboardRows,
  type LeaderboardSortDir,
  type LeaderboardSortKey,
} from "../../data/benchmark/metrics";
import { describeLeaderboardRow } from "../../data/benchmark/mockData";
import type { LeaderboardRow } from "../../data/benchmark/types";
import { ProviderPill } from "./ProviderPill";
import { SortHeaderButton } from "./SortHeaderButton";
import { StatusPill } from "./StatusPill";

/** Caption-only label for each sort key — the column headers themselves
 * carry their own label text (see the per-variant header row below); this
 * is just for the "sorted by ..." summary line above the table. */
const SORT_LABELS: Record<LeaderboardSortKey, string> = {
  name: "Strategy",
  avgGuesses: "Avg guesses",
  successRate: "Success rate",
  duration: "Avg duration",
  speed: "Avg speed",
  categoryAccuracy: "Category IQ",
  range: "Range",
  progress: "Progress",
};

export interface StrategyTableProps {
  rows: LeaderboardRow[];
  sortBy: LeaderboardSortKey;
  sortDir: LeaderboardSortDir;
  /** Clicking a sortable column header re-requests this sort — sorting is
   * done client-side (unlike RunHistoryTable's server-side sort), so this
   * just updates the sortBy/sortDir state that drives sortLeaderboardRows
   * below. */
  onSortChange: (key: LeaderboardSortKey) => void;
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
export function StrategyTable({ rows, sortBy, sortDir, onSortChange, variant }: StrategyTableProps) {
  const navigate = useNavigate();
  // Attach the display name/description up front (rather than inside the
  // render loop below) so sortLeaderboardRows can sort the "Strategy"
  // column by the same name the row actually shows — for LLM rows that's
  // the model name, not the shared strategyName every row of that
  // provider ties on (e.g. every "llm-openai" row).
  const rowsWithMeta = rows.map((row) => ({ ...row, ...describeLeaderboardRow(row) }));
  const sorted = sortLeaderboardRows(rowsWithMeta, sortBy, sortDir);
  const isDeterministic = variant === "deterministic";
  const captionId = useId();
  const gridClass = isDeterministic ? "bench-grid--deterministic" : "bench-grid--llm";

  // A model name shared by more than one provider's row needs its
  // strategyName carried explicitly (see useStrategyMeta) — every other
  // row's URL stays exactly as it is today. Computed live from this table's
  // own rows (not a hardcoded list), so a future provider colliding with an
  // existing model name needs no code change here — only its SupportedModel
  // seed rows.
  const modelNameCounts = new Map<string, number>();
  if (variant === "llm") {
    for (const row of rows) {
      modelNameCounts.set(row.id, (modelNameCounts.get(row.id) ?? 0) + 1);
    }
  }

  function linkFor(row: LeaderboardRow): string {
    const isAmbiguous = (modelNameCounts.get(row.id) ?? 0) > 1;
    const qualifier = isAmbiguous ? `?strategy=${encodeURIComponent(row.strategyName)}` : "";
    return `/leaderboard/${encodeURIComponent(row.id)}${qualifier}`;
  }

  return (
    <div className="bench-table-wrap bench-table-wrap--fluid">
      <p id={captionId} className="bench-table__caption">
        {variant === "llm" ? "LLM strategies" : "Deterministic & shuffle strategies"} ·{" "}
        {SORT_LABELS[sortBy]} — {sortDir === "asc" ? "ascending" : "descending"}
      </p>
      <div className="bench-table" role="table" aria-labelledby={captionId}>
        <div className={`bench-grid-header ${gridClass}`} role="row">
          <div role="columnheader">
            <SortHeaderButton
              label="Strategy"
              isActive={sortBy === "name"}
              dir={sortDir}
              onClick={() => onSortChange("name")}
            />
          </div>
          {variant === "llm" ? (
            <div role="columnheader">
              <SortHeaderButton
                label="Success rate"
                isActive={sortBy === "successRate"}
                dir={sortDir}
                onClick={() => onSortChange("successRate")}
              />
            </div>
          ) : null}
          <div role="columnheader">
            <SortHeaderButton
              label={variant === "llm" ? "Avg duration" : "Avg speed"}
              isActive={sortBy === (variant === "llm" ? "duration" : "speed")}
              dir={sortDir}
              onClick={() => onSortChange(variant === "llm" ? "duration" : "speed")}
            />
          </div>
          {isDeterministic ? (
            <>
              <div role="columnheader">
                <SortHeaderButton
                  label="Avg guesses"
                  isActive={sortBy === "avgGuesses"}
                  dir={sortDir}
                  onClick={() => onSortChange("avgGuesses")}
                />
              </div>
              <div role="columnheader">
                <SortHeaderButton
                  label="Range"
                  isActive={sortBy === "range"}
                  dir={sortDir}
                  onClick={() => onSortChange("range")}
                />
              </div>
            </>
          ) : (
            <div role="columnheader">
              <SortHeaderButton
                label="Category IQ"
                isActive={sortBy === "categoryAccuracy"}
                dir={sortDir}
                onClick={() => onSortChange("categoryAccuracy")}
              />
            </div>
          )}
          <div role="columnheader" className="bench-col--lg-only">
            <SortHeaderButton
              label="Progress"
              isActive={sortBy === "progress"}
              dir={sortDir}
              onClick={() => onSortChange("progress")}
            />
          </div>
        </div>

        {sorted.map((row, index) => {
          const { name, description, progress } = row;
          const queueBadges: { label: string; count: number; tone: "queued" | "active" | "failed" }[] = [
            { label: "Queued", count: progress.queued, tone: "queued" },
            { label: "Active", count: progress.active, tone: "active" },
            { label: "Failed", count: progress.failed, tone: "failed" },
          ];
          const isComplete = row.totalPuzzles > 0 && row.puzzlesCovered >= row.totalPuzzles;
          const completionPct =
            row.totalPuzzles > 0
              ? `${((row.puzzlesCovered / row.totalPuzzles) * 100).toFixed(2)}%`
              : "0%";
          // "speed" always yields a number|null (see leaderboardSortValue) —
          // narrowed explicitly since the function's return type is shared
          // across all sort keys, including the string-valued "name" one.
          const speed = leaderboardSortValue(row, "speed") as number | null;
          const successRateDisplay = row.successRate === null ? "—" : formatSuccessRate(row.successRate);
          // Unitless here — the "solves/hr" caption below the value supplies
          // the unit, so it isn't baked into this number too.
          const speedDisplay = speed === null ? "—" : Math.round(speed).toLocaleString();
          const durationDisplay =
            row.avgDurationMs === null ? "—" : formatDuration(row.avgDurationMs);
          return (
            <div
              // row.id alone isn't a unique React key once two rows (one per
              // provider) can share the same modelName — strategyName makes
              // it unique again without needing to be parsed back out of
              // anywhere, unlike the URL (see linkFor above).
              key={`${row.strategyName}::${row.id}`}
              className={`bench-grid-row ${gridClass} ${index === 0 ? "bench-row bench-row--leading" : "bench-row"}`}
              onClick={() => navigate(linkFor(row))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(linkFor(row));
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
              )}
              <div className="bench-progress-band">
                <div className="bench-progress-band__row">
                  <span className="bench-progress-band__label">Progress</span>
                  <span className={`bench-mono${isComplete ? " bench-progress-complete" : ""}`}>
                    {row.puzzlesCovered.toLocaleString()} of {row.totalPuzzles.toLocaleString()}
                    {isComplete ? null : (
                      <>
                        {" "}
                        <span className="bench-muted">({completionPct})</span>
                      </>
                    )}
                  </span>
                </div>
                {queueBadges.some((badge) => badge.count > 0) ? (
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
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
