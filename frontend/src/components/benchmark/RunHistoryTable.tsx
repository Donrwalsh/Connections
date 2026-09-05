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
import type {
  RunHistoryRow,
  RunHistorySortBy,
  RunHistorySortDir,
  RunStatus,
} from "../../data/benchmark/types";
import { RunStatusFilter } from "./RunStatusFilter";
import { StatusPill } from "./StatusPill";
import { VerdictSquares } from "./VerdictSquares";

export interface RunHistoryTableProps {
  /** The route's :strategyId — a model name for LLM rows, the strategy name
   * otherwise. Rows navigate to /leaderboard/:strategyId/:puzzleId. Passed
   * here decoded (as React Router's own useParams() hands it back); this
   * component re-encodes it into the built URL, since a Groq model id like
   * "qwen/qwen3.6-27b" contains a literal "/" that would otherwise split
   * into an extra path segment no route matches. */
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
  /** Current status filter (null = every status) and its setter — rendered
   * inside the Status column's header, alongside the label, rather than as
   * a standalone control above the table. */
  status: RunStatus | null;
  onStatusChange: (status: RunStatus | null) => void;
}

const SORTABLE_COLUMNS: { key: RunHistorySortBy; label: string }[] = [
  { key: "puzzleDate", label: "Puzzle date" },
  { key: "startedAt", label: "Run date" },
  { key: "guessCount", label: "Guesses" },
  { key: "duration", label: "Duration" },
];

const TOKEN_COST_COLUMN: { key: RunHistorySortBy; label: string } = {
  key: "tokenCost",
  label: "Token cost",
};

/** One row per individual run (not per puzzle, unlike the old mockup) — the
 * same table shape works for every strategy kind, with an extra Token cost
 * column for LLM strategies. Every column but Status doubles as a sort
 * control; Status's header instead holds the status filter (see
 * RunStatusFilter) — a control embedded in the table rather than a
 * separate widget above it. */
export function RunHistoryTable({
  strategyId,
  rows,
  sortBy,
  sortDir,
  onSortChange,
  showTokenCost,
  status,
  onStatusChange,
}: RunHistoryTableProps) {
  const navigate = useNavigate();
  const sortableColumns = showTokenCost ? [...SORTABLE_COLUMNS, TOKEN_COST_COLUMN] : SORTABLE_COLUMNS;
  const columnCount = sortableColumns.length + 1;

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">Runs · {rows.length} on this page</caption>
      <thead>
        <tr>
          {sortableColumns.map((column) => {
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
          <th scope="col">
            <RunStatusFilter value={status} onChange={onStatusChange} />
          </th>
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
              onClick={() => navigate(`/leaderboard/${encodeURIComponent(strategyId)}/${row.puzzleId}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${encodeURIComponent(strategyId)}/${row.puzzleId}`);
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
                  {row.issueCount > 0 ? (
                    <span title="At least one solve step in this run had a detected model-response issue — see the run's detail view for which.">
                      <StatusPill
                        label={`${row.issueCount} issue${row.issueCount === 1 ? "" : "s"}`}
                        tone="neutral"
                      />
                    </span>
                  ) : null}
                  <VerdictSquares
                    correct={row.categoryCorrect}
                    partial={row.categoryPartial}
                    lucky={row.categoryLucky}
                  />
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
