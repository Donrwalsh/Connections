import { GuessResult } from "../entities/guess.entity";
import { StrategyRunStatus } from "../entities/strategy-run.entity";

export interface GuessDto {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: Date;
}

// Full detail for a single guess. Currently identical to the index DTO;
// kept as a distinct type so the controller's return types stay explicit.
export type GuessDetailDto = GuessDto;

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
