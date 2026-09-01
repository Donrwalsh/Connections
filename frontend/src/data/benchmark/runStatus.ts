// Shared display helpers for run statuses. Kept out of the component files so
// the components stay presentational and the helpers stay unit-testable.

import type { CategoryVerdictValue, GuessResultValue, PuzzleRunStatus, RunStatus } from "./types";

export type PillTone = "queued" | "active" | "completed" | "failed" | "neutral" | "flagship" | "mini";

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
  rateLimitedDaily: "Paused — daily quota",
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_STATUS_LABEL[status];
}

/** Every status a run-history row can actually have — "queued" is a valid
 * RunStatus generally (see the leaderboard's progress counts), but a
 * StrategyRun row is only ever inserted once a run has started, so it never
 * appears here. Used to build the run-history status filter's option list
 * without offering a choice that can never match anything. */
export const RUN_HISTORY_STATUSES: RunStatus[] = [
  "running",
  "completed",
  "failed",
  "duplicate",
  "malformedResponse",
  "error",
  "rateLimitedDaily",
];

export function runStatusTone(status: RunStatus): PillTone {
  if (status === "queued") return "queued";
  if (status === "running") return "active";
  if (status === "rateLimitedDaily") return "active";
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

/** Display labels/tones for an individual guess's outcome — used by the
 * guess-chain visualizer for both LLM proposals and plain guess lists. */
export function guessResultLabel(result: GuessResultValue): string {
  switch (result) {
    case "success":
      return "Correct";
    case "offBy1":
      return "One away";
    case "duplicate":
      return "Duplicate";
    case "failure":
      return "Incorrect";
  }
}

export function guessResultTone(result: GuessResultValue): PillTone {
  return result === "success" ? "completed" : "failed";
}

/** Display label/tone for an LLM category-judge verdict — used by the
 * guess-chain visualizer's per-proposal pill and the Activity feed's
 * judgment rows. A null verdict is a `callError` row (the judge call itself
 * failed). */
export function categoryVerdictLabel(verdict: CategoryVerdictValue | null): string {
  switch (verdict) {
    case "correct":
      return "Category: correct";
    case "partial":
      return "Category: partial";
    case "lucky":
      return "Category: lucky";
    default:
      return "Category: judge failed";
  }
}

export function categoryVerdictTone(verdict: CategoryVerdictValue | null): PillTone {
  if (verdict === "correct") return "completed";
  if (verdict === "partial") return "neutral";
  return "failed";
}
