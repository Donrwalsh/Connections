import { GuessResult } from "../entities/guess.entity";
import { StrategyRunStatus } from "../entities/strategy-run.entity";

export interface GuessDto {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: Date;
}

// Full detail for a single guess, including the LLM telemetry recorded for
// strategy guesses (null for non-LLM strategies and user guesses). Fetched
// on demand per guess so the run-detail list stays index-only and slim.
// NOTE: per-prompt telemetry (tokens, latency, temperature) now lives on
// SolvePrompt; only step-level aggregates remain here.
export interface GuessDetailDto extends GuessDto {
  numResponses: number | null;
  promptAttempts: number | null;
  duplicatesRejected: number | null;
  llmDetails: Record<string, unknown> | null;
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
