import { formatDuration } from "../../data/benchmark/metrics";
import { runStatusLabel, runStatusTone } from "../../data/benchmark/runStatus";
import type { RunRecord } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface RunsTableProps {
  runs: RunRecord[];
  selectedRunId: number | null;
  onSelectRun: (runId: number) => void;
}

/** Individual runs for one strategy + puzzle. Selecting a row hands its runId
 * up to the page, which renders the guess-chain visualizer for it. */
export function RunsTable({ runs, selectedRunId, onSelectRun }: RunsTableProps) {
  return (
    <table className="bench-table">
      <caption className="bench-table__caption">Runs · {runs.length}</caption>
      <thead>
        <tr>
          <th scope="col">Run #</th>
          <th scope="col">Outcome</th>
          <th scope="col">Total steps</th>
          <th scope="col">Duration</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const isSelected = run.runId === selectedRunId;
          return (
            <tr
              key={run.runId}
              className={`bench-row bench-row--selectable${isSelected ? " bench-row--selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onClick={() => onSelectRun(run.runId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRun(run.runId);
                }
              }}
            >
              <td className="bench-mono">{run.runNumber === 0 ? "—" : `#${run.runNumber}`}</td>
              <td>
                <StatusPill label={runStatusLabel(run.status)} tone={runStatusTone(run.status)} />
              </td>
              <td className="bench-mono">{run.totalSteps ?? "—"}</td>
              <td className="bench-mono">
                {run.durationMs === null ? "—" : formatDuration(run.durationMs)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
