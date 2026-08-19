import { RUN_HISTORY_STATUSES, runStatusLabel } from "../../data/benchmark/runStatus";
import type { RunStatus } from "../../data/benchmark/types";

export interface RunStatusFilterProps {
  value: RunStatus | null;
  onChange: (status: RunStatus | null) => void;
}

/** Narrows the run-history table to one run status, or every status when
 * unset. Doubles as the Status column's header (see RunHistoryTable) — no
 * separate "Status" label text, so the unset state's own option reads
 * "Status" (rendered "STATUS" by the same uppercase header styling as its
 * sibling columns) rather than duplicating the column name next to a
 * generic "All statuses" placeholder. */
export function RunStatusFilter({ value, onChange }: RunStatusFilterProps) {
  return (
    <select
      className="bench-filter__select"
      aria-label="Status"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value ? (event.target.value as RunStatus) : null)}
    >
      <option value="">Status</option>
      {RUN_HISTORY_STATUSES.map((status) => (
        <option key={status} value={status}>
          {runStatusLabel(status)}
        </option>
      ))}
    </select>
  );
}
