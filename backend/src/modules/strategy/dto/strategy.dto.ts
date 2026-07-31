import { GuessResult } from "../entities/guess.entity";
import { StrategyRunStatus } from "../entities/strategy-run.entity";

export interface GuessDto {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: Date;
}

export interface StrategyRunDetailDto {
  strategyName: string;
  status: StrategyRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  guesses: GuessDto[];
}
