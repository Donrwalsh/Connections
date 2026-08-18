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
