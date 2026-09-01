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
  | "error"
  | "rateLimitedDaily";

export type PuzzleRunStatus = "in_progress" | "completed" | "failed";

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

/** Per-status run counts for one leaderboard row. `queued` is read live from
 * BullMQ (a queued job has no StrategyRun row yet), everything else from
 * Postgres. See LeaderboardRow. */
export interface LeaderboardProgress {
  completed: number;
  active: number;
  failed: number;
  queued: number;
}

/** One row of GET /strategy/leaderboard: a strategy (deterministic,
 * shuffle-smart, shuffle-foolish) or, for LLM strategies, one model —
 * aggregated across every puzzle it has ever actually run against. Only
 * strategies/models with at least one real run appear at all — there's no
 * static catalog backing this the way StrategyMeta's mock list does, so a
 * strategy nobody has run yet simply has no row. `name`/`description` aren't
 * included (the backend has no strategy-catalog concept, only run data) —
 * callers resolve display copy via getStrategyMeta/buildDynamicMeta, same as
 * the rest of this page already does for unknown models. */
export interface LeaderboardRow {
  /** modelName for LLM rows (several models can share one strategyName), the
   * strategyName itself otherwise — matches StrategyMeta.id/RunRecord
   * conventions used elsewhere on this page. */
  id: string;
  strategyName: string;
  modelName: string | null;
  /** shuffle-smart/shuffle-foolish are grouped under 'deterministic' here —
   * neither is bound by the LLM's 4-mistake failure cap. */
  kind: "deterministic" | "llm";
  puzzlesCovered: number;
  totalPuzzles: number;
  progress: LeaderboardProgress;
  successRate: number | null;
  avgGuessesToSolve: number | null;
  minGuesses: number | null;
  maxGuesses: number | null;
  avgDurationMs: number | null;
  /** USD cost of this model's runs, from its configured per-million-token
   * rates applied to actual token usage. Null for deterministic/shuffle rows
   * and for LLM rows with no priceable runs yet. Unlike avgGuessesToSolve,
   * this covers every run regardless of outcome — a failed run still spent
   * tokens. */
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  /** Mean count of issue-tagged solve steps per run (see
   * SolvePromptRecord.issueTags) across every run this model has
   * attempted, regardless of outcome. null for deterministic/shuffle rows
   * (no SolvePrompt rows at all), same as avgCostUsd. */
  avgIssues: number | null;
  /** Category-reasoning quality for this model's successful guesses, from
   * the LLM judge. correct/partial/lucky are raw verdict counts;
   * categoryEvaluated is their sum. categoryAccuracy is
   * correct / categoryEvaluated * 100, or null when nothing has been
   * evaluated (also the case for every deterministic/shuffle row). */
  categoryCorrect: number;
  categoryPartial: number;
  categoryLucky: number;
  categoryEvaluated: number;
  categoryAccuracy: number | null;
  /** Current model metadata (not run-time-historical, unlike cost) — see
   * SupportedModel on the backend. null until the model has been through a
   * metadata refresh, or for deterministic/shuffle rows. */
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
}

export interface Leaderboard {
  deterministic: LeaderboardRow[];
  llm: LeaderboardRow[];
}

export type RunHistorySortBy = "puzzleDate" | "startedAt" | "guessCount" | "duration" | "tokenCost";
export type RunHistorySortDir = "asc" | "desc";

/** One row of GET /strategy/:strategyName/runs: a single StrategyRun (not a
 * per-puzzle aggregate) — the /leaderboard/:strategyId page renders one of
 * these per actual run, across every puzzle, instead of one row per puzzle. */
export interface RunHistoryRow {
  id: number;
  puzzleId: number;
  puzzleDate: string;
  strategyName: string;
  modelName: string | null;
  trialNumber: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  guessCount: number;
  /** USD cost of this run's LLM calls, from the model's configured
   * per-million-token rates. Null for non-LLM strategies and for a run whose
   * model's rate can no longer be resolved. */
  tokenCostUsd: number | null;
  /** Count of this run's solve steps with at least one issue tag (see
   * SolvePromptRecord.issueTags). Always 0 for non-LLM strategies. */
  issueCount: number;
  /** This run's category-judge verdict tallies — one per successful used
   * proposal that has been judged (see CategoryEvaluationRecord). `callError`
   * rows count toward none. All 0 for non-LLM strategies and for LLM runs
   * not yet evaluated. */
  categoryCorrect: number;
  categoryPartial: number;
  categoryLucky: number;
}

export interface RunHistoryMeta {
  total: number;
  page: number;
  limit: number;
}

export interface RunHistory {
  rows: RunHistoryRow[];
  meta: RunHistoryMeta;
}

/** Events from GET /strategy/activity/recent: the Activity page's live feed,
 * one reverse-chronological stream across *every* strategy/model that mixes
 * a StrategyRun starting with a CategoryEvaluation (category-judge) verdict
 * landing. `occurredAt` is the run's startedAt or the judgment's
 * evaluatedAt. Deliberately slim (no guessCount/tokenCostUsd/rationale/
 * diagnostics) since it is polled repeatedly — the run page carries detail. */
interface RecentActivityEventBase {
  id: number;
  puzzleId: number;
  puzzleDate: string;
  strategyName: string;
  modelName: string | null;
  occurredAt: string;
}

export interface RecentActivityRunEvent extends RecentActivityEventBase {
  kind: "run";
  trialNumber: number;
  status: RunStatus;
}

export interface RecentActivityJudgmentEvent extends RecentActivityEventBase {
  kind: "judgment";
  status: "judged" | "callError";
  verdict: CategoryVerdictValue | null;
  proposedCategory: string;
  actualCategory: string;
}

export type RecentActivityEvent = RecentActivityRunEvent | RecentActivityJudgmentEvent;

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
  inputCostPerMillionTokens: number | null;
  outputCostPerMillionTokens: number | null;
  supported: boolean;
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
  releaseDate: string | null;
}

/** The backend tracks two separate, non-overlapping free-token programs —
 * model membership lives on SupportedModel.freeTier (see
 * backend/src/modules/supported-model/entities/supported-model.entity.ts)
 * — each with its own daily limit and model list. "flagship" covers the full-size
 * models (gpt-5.4, gpt-4o, o1, ...); "mini" covers the mini/nano variants
 * plus gpt-5-nano. Kept as a union (not a free-form string) so a caller
 * can't accidentally ask for a tier that doesn't exist. */
export type FreeTierId = "flagship" | "mini";

/** GET /strategy/free-tier-usage/:tier — today's (UTC) token spend against
 * one of the two free-token programs above (see FreeTierId), tracked
 * server-side. `label` is the backend's own description of which models
 * `tier` covers; `models` lists them explicitly. */
export interface FreeTierUsage {
  tier: FreeTierId;
  label: string;
  usedTokens: number;
  dailyLimitTokens: number;
  remainingTokens: number;
  models: string[];
}

/** GET /category-evaluation/coverage — how much of the LLM
 * category-judge backlog is done. `eligible` is every successful used
 * proposal; `judged` is how many already have a verdict row; `pending`
 * (eligible − judged) is what the next `evaluate-categories` dispatch
 * would enqueue. Backs the Activity page's Category judging widget. */
export interface CategoryEvaluationCoverage {
  eligible: number;
  judged: number;
  pending: number;
}

/** GET /dispatch/free-tier/:tier — whether a continuous free-tier dispatch
 * cycle (see the backend's FreeTierDispatchService) is currently running
 * for `tier`, and at what threshold. Both tiers are dispatchable; a tier
 * with no cycle ever started reports `active: false` with null
 * threshold/startedAt rather than an error. */
export interface FreeTierDispatchStatus {
  tier: FreeTierId;
  active: boolean;
  thresholdPercent: number | null;
  startedAt: string | null;
}

/** POST /dispatch/free-tier/both's per-tier result: unlike a single-tier
 * start (which rejects the whole request via a thrown error), starting
 * 'both' never fails outright — each tier's own outcome is reported
 * independently here instead, so one tier already running doesn't prevent
 * the other from starting. */
export interface FreeTierDispatchOutcome {
  tier: FreeTierId;
  status: FreeTierDispatchStatus | null;
  error: string | null;
}

export interface FreeTierDispatchBothStartResult {
  flagship: FreeTierDispatchOutcome;
  mini: FreeTierDispatchOutcome;
}

/** DELETE /dispatch/free-tier/both's result — stopping can't fail (it's a
 * no-op for a tier that isn't running), so unlike the start-both result
 * this is just the plain per-tier status, no error field. */
export interface FreeTierDispatchBothStopResult {
  flagship: FreeTierDispatchStatus;
  mini: FreeTierDispatchStatus;
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

export type CategoryVerdictValue = "correct" | "partial" | "lucky";

/** One LLM-judge verdict on a used proposal's category — see
 * CategoryEvaluationDto on the backend. Present only on a submitted
 * proposal whose guess succeeded and that has been evaluated. `verdict` is
 * null on a `callError` row. */
export interface CategoryEvaluationRecord {
  verdict: CategoryVerdictValue | null;
  status: "judged" | "callError";
  proposedCategory: string;
  actualCategory: string;
  rationale: string | null;
  judgeModel: string;
  judgeProvider: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  statusCode: number | null;
  errorName: string | null;
  errorMessage: string | null;
  requestBody: unknown | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown | null;
  rawResponseText: string | null;
  evaluatedAt: string;
}

/** One candidate group parsed out of a solve step's response. `guess` is
 * populated only when this proposal was actually submitted (status "used"). */
export interface LlmProposalRecord {
  id: number;
  words: string[];
  category: string;
  status: LlmProposalStatusValue;
  guess: { sequenceNumber: number; result: GuessResultValue; guessedAt: string } | null;
  categoryEvaluation: CategoryEvaluationRecord | null;
}

export type SolvePromptTypeValue = "initialSolve" | "retry";

export type SolvePromptStatusValue =
  | "parsed"
  | "malformedNoAnswerBlock"
  // The OpenAI call itself never produced usable model text (backend:
  // SolvePromptStatus.CALL_ERROR). Shown inline in the guess chain like
  // any other step — see errorName/errorMessage/etc. below.
  | "callError";

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
  /** Every model-response quality issue detected for this prompt — see
   * SolvePromptIssueTag on the backend (solve-prompt.entity.ts).
   * rawResponseText above is always the untouched original text regardless
   * of what's flagged here. */
  issueTags: string[];
  reconstructedPrompt: string | null;
  proposals: LlmProposalRecord[];
  // Populated only when status is 'callError'. requestBody/responseBody
  // are the raw payloads captured at the orchestrator.
  errorName: string | null;
  errorMessage: string | null;
  statusCode: number | null;
  isRetryable: boolean | null;
  requestBody: unknown | null;
  responseBody: unknown | null;
}

/** Full detail from GET /strategy/run/:runId. `solvePrompts` is empty for
 * non-LLM strategies. */
export interface StrategyRunDetail extends StrategyRunListItem {
  guesses: GuessRecord[];
  solvePrompts: SolvePromptRecord[];
  meta: { total: number; page: number; limit: number };
}

/** Response from DELETE /dispatch/run/:runId — counts confirm exactly what
 * was purged, per table. */
export interface DeleteRunResult {
  message: string;
  runId: number;
  deletedGuesses: number;
  deletedSolvePrompts: number;
  deletedLlmProposals: number;
}
