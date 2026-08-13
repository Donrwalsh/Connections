import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  filterPuzzleBreakdowns,
  sortPuzzleBreakdowns,
  type GuessSortDirection,
  type PuzzleStatusFilter,
} from "../../data/benchmark/metrics";
import {
  puzzleStatusLabel,
  puzzleStatusTone,
} from "../../data/benchmark/runStatus";
import type { PuzzleBreakdown } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface PuzzleBreakdownTableProps {
  strategyId: string;
  puzzles: PuzzleBreakdown[];
}

const STATUS_OPTIONS: { value: PuzzleStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

/** Per-puzzle results for one strategy, with sort (avg guesses, best/worst
 * first) and run-status filter controls. Rows navigate to
 * /leaderboard/:strategyId/:puzzleId. */
export function PuzzleBreakdownTable({ strategyId, puzzles }: PuzzleBreakdownTableProps) {
  const navigate = useNavigate();
  const [sortDirection, setSortDirection] = useState<GuessSortDirection>("asc");
  const [statusFilter, setStatusFilter] = useState<PuzzleStatusFilter>("all");

  const rows = filterPuzzleBreakdowns(
    sortPuzzleBreakdowns(puzzles, sortDirection),
    statusFilter,
  );

  return (
    <section className="bench-page__section" aria-label="Puzzles">
      <div className="bench-controls">
        <button
          type="button"
          className="bench-sort-btn"
          onClick={() =>
            setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))
          }
          aria-label={`Sort by average guesses, ${sortDirection === "asc" ? "best first" : "worst first"}`}
        >
          Avg guesses {sortDirection === "asc" ? "↑" : "↓"}
        </button>
        <label className="bench-filter">
          Status
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as PuzzleStatusFilter)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <table className="bench-table">
        <caption className="bench-table__caption">
          Puzzles · {puzzles.length} ingested
        </caption>
        <thead>
          <tr>
            <th scope="col">Puzzle</th>
            <th scope="col">Run progress</th>
            <th scope="col">Avg guesses</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((puzzle) => (
            <tr
              key={puzzle.puzzleId}
              className="bench-row"
              role="link"
              tabIndex={0}
              onClick={() => navigate(`/leaderboard/${strategyId}/${puzzle.puzzleId}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${strategyId}/${puzzle.puzzleId}`);
                }
              }}
              aria-label={`View runs for ${puzzle.label}`}
            >
              <td>
                <span className="bench-puzzle-id bench-mono">#{puzzle.puzzleId}</span>
                <span className="bench-puzzle-label">{puzzle.label}</span>
              </td>
              <td className="bench-mono">
                {puzzle.completedRuns} / {puzzle.runsPerPuzzle} runs complete
              </td>
              <td className="bench-mono">
                {puzzle.avgGuessesToSolve === null
                  ? "—"
                  : puzzle.avgGuessesToSolve.toFixed(1)}
              </td>
              <td>
                <StatusPill
                  label={puzzleStatusLabel(puzzle.status)}
                  tone={puzzleStatusTone(puzzle.status)}
                />
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="bench-muted">
                No puzzles match this filter.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
