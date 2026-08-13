// Shared display helpers for run statuses. Kept out of the component files so
// the components stay presentational and the helpers stay unit-testable.

import type { PuzzleRunStatus, RunStatus } from "./types";

export type PillTone = "queued" | "active" | "completed" | "failed" | "neutral";

const FAILED_STATUSES: RunStatus[] = ["failed", "duplicate", "malformedResponse", "error"];

export function isFailedStatus(status: RunStatus): boolean {
  return FAILED_STATUSES.includes(status);
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  duplicate: "Duplicate",
  malformedResponse: "Malformed",
  error: "Error",
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABEL[status];
}

export function runStatusTone(status: RunStatus): PillTone {
  if (status === "queued") return "queued";
  if (status === "running") return "active";
  if (status === "completed") return "completed";
  return "failed";
}

export function puzzleStatusLabel(status: PuzzleRunStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "in_progress":
      return "In Progress";
  }
}

export function puzzleStatusTone(status: PuzzleRunStatus): PillTone {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "in_progress":
      return "active";
  }
}
