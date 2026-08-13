// Shared types for the benchmark visualization (leaderboard) UI.
// These mirror the shapes the backend will eventually serve; until those
// aggregation endpoints exist, see mockData.ts for the mock fixtures.

export type StrategyKind = "deterministic" | "shuffle" | "llm";

/** Individual run states. `failed`, `duplicate`, `malformedResponse` and
 * `error` all count as "finished without solving". */
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "duplicate"
  | "malformedResponse"
  | "error";

export type PuzzleRunStatus = "in_progress" | "completed" | "failed";

export interface ProgressCounts {
  completed: number;
  queued: number;
  active: number;
  failed: number;
}

/** Static identity of a strategy (no per-puzzle performance data). */
export interface StrategyMeta {
  id: string;
  name: string;
  kind: StrategyKind;
  description: string;
  runsPerPuzzle: number;
}

/** Row for the /leaderboard table: one strategy across all puzzles. */
export interface StrategyAggregate {
  id: string;
  name: string;
  kind: StrategyKind;
  description: string;
  runsPerPuzzle: number;
  totalPuzzles: number;
  expectedRuns: number;
  progress: ProgressCounts;
  /** % of finished runs that solved, or null when nothing has finished. */
  successRate: number | null;
  /** Mean guesses over completed (solved) runs. */
  avgGuessesToSolve: number | null;
  minGuesses: number | null;
  maxGuesses: number | null;
  /** Mean solve duration over completed runs, in milliseconds. */
  avgDurationMs: number | null;
}

/** Row for /leaderboard/:strategyId: one puzzle's results for a strategy. */
export interface PuzzleBreakdown {
  puzzleId: number;
  date: string;
  label: string;
  runsPerPuzzle: number;
  completedRuns: number;
  status: PuzzleRunStatus;
  avgGuessesToSolve: number | null;
  minGuesses: number | null;
  maxGuesses: number | null;
}

/** Row for /leaderboard/:strategyId/:puzzleId: an individual run. */
export interface RunRecord {
  runId: number;
  /** 1-based trial number; 0 for single-run (deterministic) strategies. */
  runNumber: number;
  status: RunStatus;
  /** Only populated for completed runs. */
  totalSteps: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  modelName?: string | null;
}
