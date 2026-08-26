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

// One candidate group parsed out of a solve step's response. `status` says
// whether it was submitted as a guess ('used') or left on the table; the
// frontend uses that to give unused suggestions less visual weight.
export interface LlmProposalDto {
  id: number;
  words: string[];
  category: string;
  status: LlmProposalStatus;
  guess: LlmProposalGuessRefDto | null;
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
  // True when this response's "Words:" line had a trailing parenthetical
  // explanation the parser had to strip before it would parse as 4 clean
  // words (see llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE).
  // rawResponseText above always keeps the untouched original text.
  wordsHadParenthetical: boolean;
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
  // True if any SolvePrompt in this run had the trailing-parenthetical
  // parsing issue (see SolvePromptDto.wordsHadParenthetical) — a run can hit
  // it on some calls and not others, so this is an OR across every prompt,
  // not a property of the run as a whole. Always false for non-LLM
  // strategies (no SolvePrompt rows at all).
  hadWordsParenthetical: boolean;
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

// One row of GET /strategy/runs/recent: the most recent StrategyRun rows
// across *every* strategy/model (unlike RunHistoryRowDto, which is scoped
// to one strategy) — backs the Activity page's live feed. Deliberately
// slimmer than RunHistoryRowDto (no guessCount/tokenCostUsd/
// hadWordsParenthetical) since this is polled repeatedly.
export interface RecentRunDto {
  id: number;
  puzzleId: number;
  puzzleDate: string;
  strategyName: string;
  modelName: string | null;
  trialNumber: number;
  status: StrategyRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
}

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
}
