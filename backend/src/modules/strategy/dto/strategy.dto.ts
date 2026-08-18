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
  // Best-effort reconstruction of the *entire* chat payload actually sent —
  // every earlier step's prompt/response plus this step's own new prompt,
  // exactly as the runner's growing `messages` array would have looked. Not
  // stored in the DB, so this is inferred from the run's starting word order
  // and the guesses/responses recorded up to this step. See
  // prompt-reconstruction.ts.
  reconstructedPrompt: string | null;
  proposals: LlmProposalDto[];
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
}

export interface LeaderboardDto {
  deterministic: LeaderboardRowDto[];
  llm: LeaderboardRowDto[];
}

// The full allowlist entry for one model — lets a caller (e.g. the
// leaderboard's per-model run page) recognize a real model it doesn't
// otherwise know about and resolve which backend strategy it belongs to.
// Includes rows regardless of `supported` — see SupportedModelService.findAll.
export interface SupportedModelDto {
  id: number;
  strategyName: string;
  modelName: string;
  inputCostPerMillionTokens: number;
  cachedInputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  supported: boolean;
}
