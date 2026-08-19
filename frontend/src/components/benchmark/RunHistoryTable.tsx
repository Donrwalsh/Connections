import { useNavigate } from "react-router-dom";
import {
  computeDurationMs,
  formatCostUsd,
  formatDuration,
  formatGuessCount,
  formatTimestamp,
} from "../../data/benchmark/metrics";
import { formatDateLabel } from "../../data/benchmark/mockData";
import { runStatusLabel, runStatusTone } from "../../data/benchmark/runStatus";
import type { RunHistoryRow, RunHistorySortBy, RunHistorySortDir } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface RunHistoryTableProps {
  /** The route's :strategyId — a model name for LLM rows, the strategy name
   * otherwise. Rows navigate to /leaderboard/:strategyId/:puzzleId. */
  strategyId: string;
  rows: RunHistoryRow[];
  sortBy: RunHistorySortBy;
  sortDir: RunHistorySortDir;
  /** Clicking a sortable column header re-requests this sort from the
   * server — sorting/pagination aren't done client-side, see
   * StrategyPuzzlePage. */
  onSortChange: (sortBy: RunHistorySortBy) => void;
  /** Adds the Token cost column — only meaningful for LLM strategies. */
  showTokenCost: boolean;
}

const SORTABLE_COLUMNS: { key: RunHistorySortBy; label: string }[] = [
  { key: "puzzleDate", label: "Puzzle date" },
  { key: "startedAt", label: "Run date" },
  { key: "guessCount", label: "Guesses" },
  { key: "duration", label: "Duration" },
];

/** One row per individual run (not per puzzle, unlike the old mockup) — the
 * same table shape works for every strategy kind, with an extra Token cost
 * column for LLM strategies. The four sortable columns double as sort
 * controls; Status and Token cost aren't sortable. */
export function RunHistoryTable({
  strategyId,
  rows,
  sortBy,
  sortDir,
  onSortChange,
  showTokenCost,
}: RunHistoryTableProps) {
  const navigate = useNavigate();
  const columnCount = SORTABLE_COLUMNS.length + 1 + (showTokenCost ? 1 : 0);

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">Runs · {rows.length} on this page</caption>
      <thead>
        <tr>
          {SORTABLE_COLUMNS.map((column) => {
            const isActive = sortBy === column.key;
            return (
              <th scope="col" key={column.key}>
                <button
                  type="button"
                  className="bench-sort-btn"
                  onClick={() => onSortChange(column.key)}
                  aria-label={`Sort by ${column.label}${
                    isActive ? `, ${sortDir === "asc" ? "ascending" : "descending"}` : ""
                  }`}
                >
                  {column.label}
                  {isActive ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              </th>
            );
          })}
          {showTokenCost ? <th scope="col">Token cost</th> : null}
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const durationMs = computeDurationMs(row.startedAt, row.finishedAt);

          return (
            <tr
              key={row.id}
              className="bench-row"
              role="link"
              tabIndex={0}
              onClick={() => navigate(`/leaderboard/${strategyId}/${row.puzzleId}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${strategyId}/${row.puzzleId}`);
                }
              }}
              aria-label={`View runs for puzzle #${row.puzzleId}`}
            >
              <td className="bench-mono">{formatDateLabel(row.puzzleDate)}</td>
              <td className="bench-mono">{formatTimestamp(row.startedAt)}</td>
              <td className="bench-mono">{formatGuessCount(row.guessCount)}</td>
              <td className="bench-mono">{durationMs === null ? "—" : formatDuration(durationMs)}</td>
              {showTokenCost ? (
                <td className="bench-mono">
                  {row.tokenCostUsd === null ? "—" : formatCostUsd(row.tokenCostUsd)}
                </td>
              ) : null}
              <td>
                <span className="bench-badges">
                  <StatusPill label={runStatusLabel(row.status)} tone={runStatusTone(row.status)} />
                  {row.hadWordsParenthetical ? (
                    <span title="At least one model response tucked an explanation into the Words: line — the parser stripped it before guessing.">
                      <StatusPill label="Parenthetical stripped" tone="neutral" />
                    </span>
                  ) : null}
                </span>
              </td>
            </tr>
          );
        })}
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columnCount} className="bench-muted">
              No runs yet.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
