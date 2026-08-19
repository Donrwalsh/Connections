import { useNavigate } from "react-router-dom";
import { formatDateLabel, humanizeStrategyName } from "../../data/benchmark/mockData";
import { formatTimestamp } from "../../data/benchmark/metrics";
import { runStatusLabel, runStatusTone } from "../../data/benchmark/runStatus";
import type { RecentRun } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface RecentRunsTableProps {
  runs: RecentRun[];
}

/** Live feed of the most recent runs across every strategy/model (see
 * ActivityPage, which polls fetchRecentRuns) — model, puzzle, started-at,
 * and status only, no sorting/filtering; that's what the per-strategy
 * RunHistoryTable is for. Clicking a row goes to that run's puzzle-run
 * page, same target a RunHistoryTable row for the same run would navigate
 * to: the model name for LLM rows (the leaderboard's :strategyId is keyed
 * by model there, not strategy — see useStrategyMeta), the strategy name
 * otherwise. */
export function RecentRunsTable({ runs }: RecentRunsTableProps) {
  const navigate = useNavigate();

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">Recent runs · {runs.length}</caption>
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Puzzle</th>
          <th scope="col">Started</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const routeId = run.modelName ?? run.strategyName;
          const modelLabel = run.modelName ?? humanizeStrategyName(run.strategyName);

          const goToRun = () => navigate(`/leaderboard/${routeId}/${run.puzzleId}`);

          return (
            <tr
              key={run.id}
              className="bench-row"
              role="link"
              tabIndex={0}
              onClick={goToRun}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  goToRun();
                }
              }}
              aria-label={`View run for puzzle #${run.puzzleId}`}
            >
              <td className="bench-mono">{modelLabel}</td>
              <td className="bench-mono">{formatDateLabel(run.puzzleDate)}</td>
              <td className="bench-mono">{formatTimestamp(run.startedAt)}</td>
              <td>
                <StatusPill label={runStatusLabel(run.status)} tone={runStatusTone(run.status)} />
              </td>
            </tr>
          );
        })}
        {runs.length === 0 ? (
          <tr>
            <td colSpan={4} className="bench-muted">
              No runs yet.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
