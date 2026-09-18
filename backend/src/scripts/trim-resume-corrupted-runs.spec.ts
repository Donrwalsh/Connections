import { GuessResult } from "../modules/strategy/entities/guess.entity";
import type { Guess } from "../modules/strategy/entities/guess.entity";
import { LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import type { LlmProposal } from "../modules/strategy/entities/llm-proposal.entity";
import { SolvePromptStatus, SolvePromptType } from "../modules/strategy/entities/solve-prompt.entity";
import type { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { findResumeCorruption } from "./trim-resume-corrupted-runs";

// Fixture builders mirror backfill-prompt-text.spec.ts's, which replays the
// same state machine this file's findResumeCorruption is built on.

function makeSolvePrompt(overrides: Partial<SolvePrompt>): SolvePrompt {
  return {
    id: 0,
    strategyRunId: 1,
    promptNumber: 0,
    attemptNumber: 1,
    promptType: SolvePromptType.INITIAL_SOLVE,
    status: SolvePromptStatus.PARSED,
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

describe("findResumeCorruption", () => {
  const originalWords = ["A", "B", "C", "D", "E", "F", "G", "H"];

  it("returns null when there are no solve prompts", () => {
    expect(findResumeCorruption(originalWords, [], [], new Map())).toBeNull();
  });

  it("returns null for an uncorrupted run whose RETRY prompts correctly follow failed guesses", () => {
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.FAILURE });

    const prompt2 = makeSolvePrompt({ id: 102, promptNumber: 2, promptType: SolvePromptType.RETRY });
    const proposal2 = makeProposal({
      id: 2,
      solvePromptId: 102,
      words: ["E", "F", "G", "H"],
      status: LlmProposalStatus.USED,
      guessId: 2,
    });
    const guess2 = makeGuess({ id: 2, sequenceNumber: 2, words: ["E", "F", "G", "H"], result: GuessResult.SUCCESS });

    const result = findResumeCorruption(
      originalWords,
      [prompt1, prompt2],
      [proposal1, proposal2],
      new Map([
        [1, guess1],
        [2, guess2],
      ]),
    );

    expect(result).toBeNull();
  });

  it("flags the row where a resumed run sent a fresh INITIAL_SOLVE after a failed guess", () => {
    // Step 1 (correct INITIAL): fails.
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.FAILURE });

    // Step 2: the run resumed and (the bug) wrongly sent INITIAL_SOLVE
    // instead of RETRY — this call still happens to succeed.
    const prompt2 = makeSolvePrompt({ id: 102, promptNumber: 2, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal2 = makeProposal({
      id: 2,
      solvePromptId: 102,
      words: ["E", "F", "G", "H"],
      status: LlmProposalStatus.USED,
      guessId: 2,
    });
    const guess2 = makeGuess({ id: 2, sequenceNumber: 2, words: ["E", "F", "G", "H"], result: GuessResult.SUCCESS });

    // Step 3: continues from the corrupted state.
    const prompt3 = makeSolvePrompt({ id: 103, promptNumber: 3, promptType: SolvePromptType.INITIAL_SOLVE });

    const result = findResumeCorruption(
      originalWords,
      [prompt1, prompt2, prompt3],
      [proposal1, proposal2],
      new Map([
        [1, guess1],
        [2, guess2],
      ]),
    );

    expect(result).not.toBeNull();
    expect(result!.badPromptNumber).toBe(2);
    // Only group 1 (A,B,C,D) had failed and never actually succeeded before
    // the corruption point, so nothing was locked in yet — the full
    // original word list is still what should be resent.
    expect(result!.availableWordsBeforeCorruption).toEqual(originalWords);
    // Every guess from the corrupted row onward is untrustworthy, including
    // guess2 itself (it happened to succeed, but under the wrong prompt).
    expect(result!.taintedGuessIds).toEqual([2]);
  });

  it("carries forward correctly-locked-in groups from before the corruption point", () => {
    // Step 1: succeeds, locking in group 1.
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.SUCCESS });

    // Step 2 (correct INITIAL, since step 1 succeeded): fails.
    const prompt2 = makeSolvePrompt({ id: 102, promptNumber: 2, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal2 = makeProposal({
      id: 2,
      solvePromptId: 102,
      words: ["E", "F", "G", "H"],
      status: LlmProposalStatus.USED,
      guessId: 2,
    });
    const guess2 = makeGuess({ id: 2, sequenceNumber: 2, words: ["E", "F", "G", "H"], result: GuessResult.FAILURE });

    // Step 3: resumed, wrongly sent as INITIAL_SOLVE instead of RETRY.
    const prompt3 = makeSolvePrompt({ id: 103, promptNumber: 3, promptType: SolvePromptType.INITIAL_SOLVE });

    const result = findResumeCorruption(
      originalWords,
      [prompt1, prompt2, prompt3],
      [proposal1, proposal2],
      new Map([
        [1, guess1],
        [2, guess2],
      ]),
    );

    expect(result).not.toBeNull();
    expect(result!.badPromptNumber).toBe(3);
    expect(result!.availableWordsBeforeCorruption).toEqual(["E", "F", "G", "H"]);
    expect(result!.taintedGuessIds).toEqual([]);
  });

  it("flags a CALL_ERROR row itself when it's the one wrongly sent as INITIAL_SOLVE", () => {
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.FAILURE });

    // The resumed run's very first call fails outright, but was still built
    // (the bug) as an INITIAL_SOLVE rather than a RETRY.
    const prompt2 = makeSolvePrompt({
      id: 102,
      promptNumber: 2,
      promptType: SolvePromptType.INITIAL_SOLVE,
      status: SolvePromptStatus.CALL_ERROR,
    });

    const result = findResumeCorruption(
      originalWords,
      [prompt1, prompt2],
      [proposal1],
      new Map([[1, guess1]]),
    );

    expect(result).not.toBeNull();
    expect(result!.badPromptNumber).toBe(2);
    expect(result!.taintedGuessIds).toEqual([]);
  });

  it("never flags a run's genuine first prompt", () => {
    const prompt1 = makeSolvePrompt({ id: 101, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });

    const result = findResumeCorruption(originalWords, [prompt1], [], new Map());

    expect(result).toBeNull();
  });
});
