import { useNavigate } from "react-router-dom";
import { formatDateLabel, humanizeStrategyName } from "../../data/benchmark/mockData";
import { formatTimestamp } from "../../data/benchmark/metrics";
import {
  categoryVerdictLabel,
  categoryVerdictTone,
  runStatusLabel,
  runStatusTone,
} from "../../data/benchmark/runStatus";
import type { RecentActivityEvent } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface RecentActivityTableProps {
  events: RecentActivityEvent[];
}

/** Live feed of the most recent activity across every strategy/model (see
 * ActivityPage, which polls fetchRecentActivity) — one reverse-chronological
 * stream mixing two event kinds: a run starting, and a category-judge
 * verdict landing. No sorting/filtering; that's what the per-strategy
 * RunHistoryTable is for. Clicking a row goes to that run's puzzle-run page,
 * where the guess chain and (for judgments) the judge diagnostics live —
 * keyed by model for LLM rows (the leaderboard's :strategyId is the model
 * there, not the strategy — see useStrategyMeta), the strategy name
 * otherwise. */
export function RecentActivityTable({ events }: RecentActivityTableProps) {
  const navigate = useNavigate();

  return (
    <table className="bench-table">
      <caption className="bench-table__caption">Recent activity · {events.length}</caption>
      <thead>
        <tr>
          <th scope="col">Activity</th>
          <th scope="col">Model</th>
          <th scope="col">Puzzle</th>
          <th scope="col">When</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => {
          const routeId = event.modelName ?? event.strategyName;
          const modelLabel = event.modelName ?? humanizeStrategyName(event.strategyName);
          const goToRun = () => navigate(`/leaderboard/${encodeURIComponent(routeId)}/${event.puzzleId}`);

          return (
            <tr
              key={`${event.kind}-${event.id}`}
              className="bench-row"
              role="link"
              tabIndex={0}
              onClick={goToRun}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                  keyEvent.preventDefault();
                  goToRun();
                }
              }}
              aria-label={
                event.kind === "run"
                  ? `View run for puzzle #${event.puzzleId}`
                  : `View category judgment for puzzle #${event.puzzleId}`
              }
            >
              <td className="bench-muted">
                {event.kind === "run" ? "Run" : "Category judge"}
              </td>
              <td className="bench-mono">{modelLabel}</td>
              <td className="bench-mono">{formatDateLabel(event.puzzleDate)}</td>
              <td className="bench-mono">{formatTimestamp(event.occurredAt)}</td>
              <td>
                {event.kind === "run" ? (
                  <StatusPill label={runStatusLabel(event.status)} tone={runStatusTone(event.status)} />
                ) : (
                  <StatusPill
                    label={categoryVerdictLabel(event.verdict)}
                    tone={categoryVerdictTone(event.verdict)}
                  />
                )}
              </td>
            </tr>
          );
        })}
        {events.length === 0 ? (
          <tr>
            <td colSpan={5} className="bench-muted">
              No activity yet.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
