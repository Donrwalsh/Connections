import { GuessResult } from "../entities/guess.entity";
import { StrategyRunStatus } from "../entities/strategy-run.entity";
import { LlmProposalStatus } from "../entities/llm-proposal.entity";
import { SolvePromptStatus, SolvePromptType } from "../entities/solve-prompt.entity";

export interface GuessDto {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: Date;
}

// Full detail for a single guess. Currently identical to the index DTO;
// kept as a distinct type so the controller's return types stay explicit.
export type GuessDetailDto = GuessDto;

// The outcome of the guess a 'used' proposal became. Absent (null) for
// proposals that were never submitted (status !== 'used').
export interface LlmProposalGuessRefDto {
  sequenceNumber: number;
  result: GuessResult;
  guessedAt: Date;
}

// One LLM-judge verdict on a used proposal's category (see
// 2026-08-27-llm-category-accuracy-evaluation-design.md). Present only on a
// proposal that was submitted, whose guess succeeded, and that has been
// evaluated — null everywhere else. `verdict` is null on a `callError`
// row; the error/raw fields carry the judge-call diagnostics for auditing.
export interface CategoryEvaluationDto {
  verdict: "correct" | "partial" | "lucky" | null;
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
  evaluatedAt: Date;
}

// One candidate group parsed out of a solve step's response. `status` says
// whether it was submitted as a guess ('used') or left on the table; the
// frontend uses that to give unused suggestions less visual weight.
export interface LlmProposalDto {
  id: number;
  words: string[];
  category: string;
  status: LlmProposalStatus;
  guess: LlmProposalGuessRefDto | null;
  // The LLM-judge verdict on this proposal's category, when it has been
  // evaluated (used + successful guess + judged); null otherwise.
  categoryEvaluation: CategoryEvaluationDto | null;
}

// One step of an LLM run's solve loop: the reconstructed prompt sent, the raw
// response, per-call telemetry, and every candidate group the response
// parsed out (see LlmProposalDto). Empty for non-LLM strategies.
export interface SolvePromptDto {
  id: number;
  promptNumber: number;
  promptType: SolvePromptType;
  status: SolvePromptStatus;
  rawResponseText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  temperature: number | null;
  createdAt: Date;
  // Every model-response quality issue detected for this prompt — see
  // SolvePromptIssueTag in solve-prompt.entity.ts. rawResponseText above
  // always keeps the untouched original text regardless of what's flagged
  // here.
  issueTags: string[];
  // Best-effort reconstruction of the *entire* chat payload actually sent —
  // every earlier step's prompt/response plus this step's own new prompt,
  // exactly as the runner's growing `messages` array would have looked. Not
  // stored in the DB, so this is inferred from the run's starting word order
  // and the guesses/responses recorded up to this step. See
  // prompt-reconstruction.ts.
  reconstructedPrompt: string | null;
  proposals: LlmProposalDto[];
  // Populated only when status is 'callError' — the OpenAI call itself
  // never produced usable model text. requestBody/responseBody are the raw
  // payloads captured at the orchestrator (see solve-prompt.entity.ts) —
  // shown in the same collapsible-detail style as reconstructedPrompt/
  // rawResponseText above.
  errorName: string | null;
  errorMessage: string | null;
  statusCode: number | null;
  isRetryable: boolean | null;
  requestBody: unknown | null;
  responseBody: unknown | null;
}

export interface StrategyRunDetailMeta {
  total: number;
  page: number;
  limit: number;
}

export interface StrategyRunDetailDto {
  id: number;
  strategyName: string;
  trialNumber: number;
  status: StrategyRunStatus;
  modelName: string | null;
  contextWindow: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  guesses: GuessDto[];
  solvePrompts: SolvePromptDto[];
  meta: StrategyRunDetailMeta;
}

export interface StrategyRunListItemDto {
  id: number;
  strategyName: string;
  trialNumber: number;
  status: StrategyRunStatus;
  modelName: string | null;
  contextWindow: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  guessCount: number;
}

// Per-status run counts for one leaderboard row. `queued` is the only field
// not sourced from StrategyRun — a queued job has no row yet (see
// StrategyService.getLeaderboard), so it's read live from the BullMQ queues
// instead and merged in.
export interface LeaderboardProgressDto {
  completed: number;
  active: number;
  failed: number;
  queued: number;
}

// One row of the /strategy/leaderboard response: a strategy (deterministic,
// shuffle-smart, shuffle-foolish) or, for LLM strategies, one model —
// aggregated across every puzzle it has ever run against. Only strategies/
// models with at least one real StrategyRun appear at all; see
// StrategyService.getLeaderboard for how the row set and `progress.queued`
// are assembled.
export interface LeaderboardRowDto {
  // modelName for LLM rows (several models can share one strategyName), the
  // strategyName itself for everything else.
  id: string;
  strategyName: string;
  modelName: string | null;
  // shuffle-smart/shuffle-foolish are grouped with 'deterministic' here —
  // neither is bound by the LLM's 4-mistake failure cap, so they belong on
  // the same table.
  kind: "deterministic" | "llm";
  puzzlesCovered: number;
  totalPuzzles: number;
  progress: LeaderboardProgressDto;
  // % of finished (completed + failed) runs that solved, or null when none
  // have finished yet.
  successRate: number | null;
  avgGuessesToSolve: number | null;
  minGuesses: number | null;
  maxGuesses: number | null;
  avgDurationMs: number | null;
  // USD cost of this model's runs, from its current per-million-token rate
  // (ModelPrice) applied to actual token usage — null for deterministic/
  // shuffle rows (no LLM cost concept) and for LLM rows with no priceable
  // runs yet (e.g. a model with no ModelPrice row). Unlike avgGuessesToSolve
  // above, this covers every run regardless of outcome — a failed run still
  // spent tokens.
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  // Mean count of issue-tagged SolvePrompt rows per run (see
  // SolvePromptDto.issueTags) across every run this model has attempted,
  // regardless of outcome — a failed or errored run can still carry
  // issue-tagged prompts. null for deterministic/shuffle rows (no
  // SolvePrompt rows at all), same as avgCostUsd.
  avgIssues: number | null;
  // Category-reasoning quality for this model's successful guesses, from the
  // LLM judge (see 2026-08-27-llm-category-accuracy-evaluation-design.md).
  // correct/partial/lucky are raw verdict counts across every evaluated
  // successful used proposal of this model; categoryEvaluated is their sum
  // (callError rows have verdict null and count toward none of them).
  // categoryAccuracy is correct / categoryEvaluated * 100, or null when
  // categoryEvaluated is 0 — which is also the case for deterministic/
  // shuffle rows, so those show "—" like avgCostUsd/avgIssues.
  categoryCorrect: number;
  categoryPartial: number;
  categoryLucky: number;
  categoryEvaluated: number;
  categoryAccuracy: number | null;
  // Current (not run-time-historical, unlike cost) model metadata — see
  // SupportedModel. null until the model has been through a metadata
  // refresh, or for deterministic/shuffle rows.
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
}

export interface LeaderboardDto {
  deterministic: LeaderboardRowDto[];
  llm: LeaderboardRowDto[];
}

export type RunHistorySortBy = "puzzleDate" | "startedAt" | "guessCount" | "duration" | "tokenCost";
export type RunHistorySortDir = "asc" | "desc";

// One row of GET /strategy/:strategyName/runs: a single StrategyRun (not a
// per-puzzle aggregate like StrategyRunListItemDto's siblings) — every
// strategy/model's run history renders from the same shape, one row per
// actual run, regardless of how many trials share a puzzle.
export interface RunHistoryRowDto {
  id: number;
  puzzleId: number;
  puzzleDate: string;
  strategyName: string;
  modelName: string | null;
  trialNumber: number;
  status: StrategyRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  guessCount: number;
  // Total USD cost of this run's LLM calls, from the model's current
  // per-million-token rate (ModelPrice) applied to its summed SolvePrompt
  // token usage. Null for non-LLM strategies, and for an LLM run whose
  // model's rate can no longer be resolved (e.g. since removed).
  tokenCostUsd: number | null;
  // Count of this run's SolvePrompt rows with at least one issueTags entry
  // (see SolvePromptDto.issueTags) — a run can hit issues on some calls and
  // not others, so this sums across every prompt, not a property of the run
  // as a whole. Always 0 for non-LLM strategies (no SolvePrompt rows at
  // all).
  issueCount: number;
}

export interface RunHistoryMetaDto {
  total: number;
  page: number;
  limit: number;
}

export interface RunHistoryDto {
  rows: RunHistoryRowDto[];
  meta: RunHistoryMetaDto;
}

// Events for GET /strategy/activity/recent — the Activity page's live feed,
// one reverse-chronological stream across *every* strategy/model that mixes
// two kinds of thing: a StrategyRun starting, and a CategoryEvaluation (the
// LLM category-accuracy judge) landing a verdict. `occurredAt` is the run's
// startedAt or the judgment's evaluatedAt; the feed sorts on it. Deliberately
// slim (no guessCount/tokenCostUsd/rationale/diagnostics) since it is polled
// repeatedly — the run page carries the detail.
interface RecentActivityEventBaseDto {
  id: number;
  puzzleId: number;
  puzzleDate: string;
  strategyName: string;
  modelName: string | null;
  occurredAt: Date;
}

export interface RecentActivityRunEventDto extends RecentActivityEventBaseDto {
  kind: "run";
  trialNumber: number;
  status: StrategyRunStatus;
}

export interface RecentActivityJudgmentEventDto extends RecentActivityEventBaseDto {
  kind: "judgment";
  // "judged" with a verdict, or "callError" with a null verdict (the judge
  // call itself failed) — mirrors CategoryEvalStatus / CategoryEvaluationDto.
  status: "judged" | "callError";
  verdict: "correct" | "partial" | "lucky" | null;
  proposedCategory: string;
  actualCategory: string;
}

export type RecentActivityEventDto =
  | RecentActivityRunEventDto
  | RecentActivityJudgmentEventDto;

// The full allowlist entry for one model — lets a caller (e.g. the
// leaderboard's per-model run page) recognize a real model it doesn't
// otherwise know about and resolve which backend strategy it belongs to.
// Includes rows regardless of `supported` — see SupportedModelService.findAll.
// Cost fields reflect the model's current price (ModelPrice) and are null
// until it's been given one.
export interface SupportedModelDto {
  id: number;
  strategyName: string;
  modelName: string;
  inputCostPerMillionTokens: number | null;
  outputCostPerMillionTokens: number | null;
  supported: boolean;
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
  releaseDate: Date | null;
}
