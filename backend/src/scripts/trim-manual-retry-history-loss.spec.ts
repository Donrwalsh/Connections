import { GuessResult } from "../modules/strategy/entities/guess.entity";
import type { Guess } from "../modules/strategy/entities/guess.entity";
import { LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import type { LlmProposal } from "../modules/strategy/entities/llm-proposal.entity";
import { SolvePromptStatus, SolvePromptType } from "../modules/strategy/entities/solve-prompt.entity";
import type { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { planManualRetryHistoryRepair } from "./trim-manual-retry-history-loss";

// Fixture builders mirror trim-resume-corrupted-runs.spec.ts's.

function makeSolvePrompt(overrides: Partial<SolvePrompt>): SolvePrompt {
  return {
    id: 0,
    strategyRunId: 1,
    promptNumber: 0,
    attemptNumber: 1,
    promptType: SolvePromptType.INITIAL_SOLVE,
    status: SolvePromptStatus.PARSED,
    manualRetry: false,
    rawResponseText: null,
    promptText: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    latencyMs: null,
    temperature: 0.2,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    errorName: null,
    errorMessage: null,
    statusCode: null,
    isRetryable: null,
    requestBody: null,
    responseBody: null,
    issueTags: [],
    ...overrides,
  } as SolvePrompt;
}

function makeProposal(overrides: Partial<LlmProposal>): LlmProposal {
  return {
    id: 0,
    strategyRunId: 1,
    guessId: null,
    solvePromptId: 0,
    words: [],
    category: "",
    status: LlmProposalStatus.NOT_SELECTED,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  } as LlmProposal;
}

function makeGuess(overrides: Partial<Guess>): Guess {
  return {
    id: 0,
    puzzleId: 1,
    strategyRunId: 1,
    words: [],
    result: GuessResult.FAILURE,
    sequenceNumber: 0,
    guessedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  } as Guess;
}

const chatMessages = [{ role: "user", content: "solve this puzzle" }];

describe("planManualRetryHistoryRepair", () => {
  const originalWords = ["A", "B", "C", "D", "E", "F", "G", "H"];

  it("returns null when the run has no manual-retry history loss", () => {
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1 });

    expect(planManualRetryHistoryRepair(originalWords, [prompt1], [], new Map())).toBeNull();
  });

  it("plans a repair that keeps the last real success and drops everything from the trigger row on", () => {
    // Step 1: succeeds, locking in group 1 — this must survive the repair.
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1 });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.SUCCESS });

    // Step 2: the trigger — a client-side failure with no captured
    // requestBody. This row itself must be dropped too (it's the row
    // reconstructMessages can never seed history from).
    const prompt2 = makeSolvePrompt({
      id: 102,
      promptNumber: 2,
      status: SolvePromptStatus.CALL_ERROR,
      requestBody: null,
    });

    // Step 3: the manual retry that went out with an empty history, but
    // still produced a real (now-discarded) guess.
    const prompt3 = makeSolvePrompt({ id: 103, promptNumber: 3, manualRetry: true });
    const proposal3 = makeProposal({
      id: 3,
      solvePromptId: 103,
      words: ["E", "F", "G", "H"],
      status: LlmProposalStatus.USED,
      guessId: 3,
    });
    const guess3 = makeGuess({ id: 3, sequenceNumber: 2, words: ["E", "F", "G", "H"], result: GuessResult.SUCCESS });

    const repair = planManualRetryHistoryRepair(
      originalWords,
      [prompt1, prompt2, prompt3],
      [proposal1, proposal3],
      new Map([
        [1, guess1],
        [3, guess3],
      ]),
    );

    expect(repair).toEqual({
      cutoffPromptNumber: 2,
      availableWordsBeforeCutoff: ["E", "F", "G", "H"],
      taintedGuessIds: [3],
    });
  });

  it("does not flag a run whose trigger row's requestBody is reconstructable", () => {
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1 });
    const prompt2 = makeSolvePrompt({
      id: 102,
      promptNumber: 2,
      status: SolvePromptStatus.CALL_ERROR,
      requestBody: { messages: chatMessages },
    });
    const prompt3 = makeSolvePrompt({ id: 103, promptNumber: 3, manualRetry: true });

    expect(
      planManualRetryHistoryRepair(originalWords, [prompt1, prompt2, prompt3], [], new Map()),
    ).toBeNull();
  });
});
