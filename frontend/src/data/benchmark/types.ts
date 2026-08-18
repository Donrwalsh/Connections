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

/** Static identity of a strategy (no per-puzzle performance data). For "llm"
 * kind rows, `id` is a *model* name (e.g. "gpt-4.1-nano-2025-04-14") rather
 * than a strategy name — each model benchmarked gets its own leaderboard row
 * and its own /leaderboard/:id URL. `strategyName` carries the underlying
 * backend strategy identifier ("llm-openai"/"llm-ollama") that real API
 * calls need, since the backend has no per-model endpoint; for every other
 * kind, `strategyName` is just equal to `id`. */
export interface StrategyMeta {
  id: string;
  name: string;
  kind: StrategyKind;
  description: string;
  runsPerPuzzle: number;
  strategyName: string;
}

/** Row for the /leaderboard table: one strategy (or, for "llm" kind, one
 * model) across all puzzles. See StrategyMeta for the id/strategyName split. */
export interface StrategyAggregate {
  id: string;
  name: string;
  kind: StrategyKind;
  description: string;
  runsPerPuzzle: number;
  strategyName: string;
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

// ── Live backend DTOs (individual puzzle-run page) ──────────────────────
// Mirror backend/src/modules/strategy/dto/strategy.dto.ts. Unlike the types
// above (which back the mock-fixture-driven leaderboard/strategy pages),
// these describe the real /strategy API responses — see api.ts.

export type GuessResultValue = "success" | "failure" | "offBy1" | "duplicate";

/** One row from GET /strategy/models — the real allowlist of models a
 * strategy may dispatch runs against. Used to recognize a model the static
 * mock catalog (mockData.ts) doesn't know about, e.g. one added to the
 * backend after the mock list was last updated. Includes rows regardless of
 * `supported`, since an unsupported model can still have real historical
 * runs worth viewing. */
export interface SupportedModelRecord {
  id: number;
  strategyName: string;
  modelName: string;
  inputCostPerMillionTokens: number;
  cachedInputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  supported: boolean;
}

/** A run row from GET /strategy/:strategyName/puzzle-id/:puzzleId. The
 * backend never returns "queued" (a StrategyRun row only exists once a job
 * has actually started), so this is always one of the other RunStatus
 * values. */
export interface StrategyRunListItem {
  id: number;
  strategyName: string;
  trialNumber: number;
  status: RunStatus;
  modelName: string | null;
  contextWindow: number | null;
  startedAt: string;
  finishedAt: string | null;
  guessCount: number;
}

export interface GuessRecord {
  sequenceNumber: number;
  words: string[];
  result: GuessResultValue;
  guessedAt: string;
}

export type LlmProposalStatusValue =
  | "used"
  | "rejected_duplicate"
  | "not_selected"
  | "supersededByRetry"
  | "invalidItems";

/** One candidate group parsed out of a solve step's response. `guess` is
 * populated only when this proposal was actually submitted (status "used"). */
export interface LlmProposalRecord {
  id: number;
  words: string[];
  category: string;
  status: LlmProposalStatusValue;
  guess: { sequenceNumber: number; result: GuessResultValue; guessedAt: string } | null;
}

export type SolvePromptTypeValue = "initialSolve" | "retry";

export type SolvePromptStatusValue =
  | "parsed"
  | "malformedNoAnswerBlock"
  | "malformedGroupCount"
  | "malformedOther";

/** One step of an LLM run's solve loop. `reconstructedPrompt` is inferred by
 * the backend on the fly (prompt text itself isn't stored) — see
 * prompt-reconstruction.ts on the backend. */
export interface SolvePromptRecord {
  id: number;
  promptNumber: number;
  promptType: SolvePromptTypeValue;
  status: SolvePromptStatusValue;
  rawResponseText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  temperature: number | null;
  createdAt: string;
  reconstructedPrompt: string | null;
  proposals: LlmProposalRecord[];
}

/** Full detail from GET /strategy/run/:runId. `solvePrompts` is empty for
 * non-LLM strategies. */
export interface StrategyRunDetail extends StrategyRunListItem {
  guesses: GuessRecord[];
  solvePrompts: SolvePromptRecord[];
  meta: { total: number; page: number; limit: number };
}
