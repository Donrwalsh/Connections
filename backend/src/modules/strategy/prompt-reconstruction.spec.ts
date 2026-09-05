import { GuessResult } from "./entities/guess.entity";
import type { Guess } from "./entities/guess.entity";
import { LlmProposalStatus } from "./entities/llm-proposal.entity";
import type { LlmProposal } from "./entities/llm-proposal.entity";
import { SolvePromptStatus, SolvePromptType } from "./entities/solve-prompt.entity";
import type { SolvePrompt } from "./entities/solve-prompt.entity";
import { formatConversation, reconstructSolvePrompts } from "./prompt-reconstruction";
import { buildInitialPrompt, buildRetryPrompt } from "./llm-strategy-runner.service";

function makeSolvePrompt(overrides: Partial<SolvePrompt>): SolvePrompt {
  return {
    id: 0,
    strategyRunId: 1,
    promptNumber: 0,
    attemptNumber: 1,
    promptType: SolvePromptType.INITIAL_SOLVE,
    status: SolvePromptStatus.PARSED,
    rawResponseText: null,
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

describe("reconstructSolvePrompts", () => {
  const originalWords = ["A", "B", "C", "D", "E", "F", "G", "H"];

  it("returns nothing when there are no solve prompts", () => {
    expect(reconstructSolvePrompts(originalWords, [], [], new Map())).toEqual([]);
  });

  it("replays INITIAL -> RETRY -> INITIAL exactly like the live runner, including unused proposals", () => {
    // Step 1 (INITIAL): proposes [A,B,C,D] (fails) and [E,F,G,H] (never
    // evaluated — the runner stops at the first failure within a step).
    const prompt1 = makeSolvePrompt({
      id: 101,
      promptNumber: 1,
      promptType: SolvePromptType.INITIAL_SOLVE,
      rawResponseText: "response-1",
    });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 101,
      words: ["A", "B", "C", "D"],
      category: "Cat1",
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const proposal2 = makeProposal({
      id: 2,
      solvePromptId: 101,
      words: ["E", "F", "G", "H"],
      category: "Cat2",
      status: LlmProposalStatus.NOT_SELECTED,
      guessId: null,
    });
    const guess1 = makeGuess({
      id: 1,
      sequenceNumber: 1,
      words: ["A", "B", "C", "D"],
      result: GuessResult.FAILURE,
    });

    // Step 2 (RETRY, since step 1 ended on a failure): proposes [E,F,G,H],
    // which succeeds.
    const prompt2 = makeSolvePrompt({
      id: 102,
      promptNumber: 2,
      promptType: SolvePromptType.RETRY,
      rawResponseText: "response-2",
    });
    const proposal3 = makeProposal({
      id: 3,
      solvePromptId: 102,
      words: ["E", "F", "G", "H"],
      category: "Cat2",
      status: LlmProposalStatus.USED,
      guessId: 2,
    });
    const guess2 = makeGuess({
      id: 2,
      sequenceNumber: 2,
      words: ["E", "F", "G", "H"],
      result: GuessResult.SUCCESS,
    });

    // Step 3 (INITIAL again — a successful step resets lastFailedGuess, so
    // the runner goes back to the INITIAL branch even mid-run): solves the
    // remaining 4 words.
    const prompt3 = makeSolvePrompt({
      id: 103,
      promptNumber: 3,
      promptType: SolvePromptType.INITIAL_SOLVE,
    });
    const proposal4 = makeProposal({
      id: 4,
      solvePromptId: 103,
      words: ["A", "B", "C", "D"],
      category: "Cat1",
      status: LlmProposalStatus.USED,
      guessId: 3,
    });
    const guess3 = makeGuess({
      id: 3,
      sequenceNumber: 3,
      words: ["A", "B", "C", "D"],
      result: GuessResult.SUCCESS,
    });

    const guessesById = new Map([
      [1, guess1],
      [2, guess2],
      [3, guess3],
    ]);

    const result = reconstructSolvePrompts(
      originalWords,
      [prompt1, prompt2, prompt3],
      [proposal1, proposal2, proposal3, proposal4],
      guessesById,
    );

    expect(result).toHaveLength(3);

    const initialPrompt = buildInitialPrompt(originalWords, 2);
    const retryPrompt = buildRetryPrompt(
      originalWords,
      [],
      { items: ["A", "B", "C", "D"], result: "incorrect" },
      2,
    );
    const finalPrompt = buildInitialPrompt(["A", "B", "C", "D"], 1);

    // Step 1: no history yet, so it's just this step's own message.
    expect(result[0]!.reconstructedPrompt).toBe(
      formatConversation([{ role: "user", content: initialPrompt }]),
    );
    expect(result[0]!.proposals).toEqual([
      {
        id: 1,
        words: ["A", "B", "C", "D"],
        category: "Cat1",
        status: LlmProposalStatus.USED,
        guess: { sequenceNumber: 1, result: GuessResult.FAILURE, guessedAt: guess1.guessedAt },
        categoryEvaluation: null,
      },
      {
        id: 2,
        words: ["E", "F", "G", "H"],
        category: "Cat2",
        status: LlmProposalStatus.NOT_SELECTED,
        guess: null,
        categoryEvaluation: null,
      },
    ]);

    // Step 2: the full transcript so far — step 1's prompt and response —
    // plus this step's own RETRY prompt referencing the failed guess.
    expect(result[1]!.reconstructedPrompt).toBe(
      formatConversation([
        { role: "user", content: initialPrompt },
        { role: "assistant", content: "response-1" },
        { role: "user", content: retryPrompt },
      ]),
    );

    // Step 3: the whole transcript (steps 1 and 2, prompts and responses)
    // plus this step's own prompt — pool has shrunk to the 4 remaining
    // words, and — because step 2 succeeded — this is an INITIAL prompt
    // again, not a RETRY.
    expect(result[2]!.reconstructedPrompt).toBe(
      formatConversation([
        { role: "user", content: initialPrompt },
        { role: "assistant", content: "response-1" },
        { role: "user", content: retryPrompt },
        { role: "assistant", content: "response-2" },
        { role: "user", content: finalPrompt },
      ]),
    );
    expect(result[2]!.promptType).toBe(SolvePromptType.INITIAL_SOLVE);
  });

  it("labels an off-by-one guess as 'one away' guidance in the retry prompt", () => {
    const prompt1 = makeSolvePrompt({
      id: 1,
      promptNumber: 1,
      promptType: SolvePromptType.INITIAL_SOLVE,
    });
    const prompt2 = makeSolvePrompt({ id: 2, promptNumber: 2, promptType: SolvePromptType.RETRY });
    const proposal1 = makeProposal({
      id: 1,
      solvePromptId: 1,
      words: ["A", "B", "C", "E"],
      category: "Cat1",
      status: LlmProposalStatus.USED,
      guessId: 1,
    });
    const guess1 = makeGuess({
      id: 1,
      sequenceNumber: 1,
      words: ["A", "B", "C", "E"],
      result: GuessResult.OFF_BY_ONE,
    });

    const result = reconstructSolvePrompts(
      originalWords,
      [prompt1, prompt2],
      [proposal1],
      new Map([[1, guess1]]),
    );

    expect(result[1]!.reconstructedPrompt).toBe(
      formatConversation([
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
        { role: "assistant", content: "" }, // prompt1.rawResponseText was never set
        {
          role: "user",
          content: buildRetryPrompt(
            originalWords,
            [],
            { items: ["A", "B", "C", "E"], result: "one away" },
            2,
          ),
        },
      ]),
    );
  });

  it("includes a CALL_ERROR row in the output, with its own reconstructedPrompt, but never lets it corrupt later steps", () => {
    // A CALL_ERROR row (the call itself failed, no model text at all) is
    // now shown in the run's chain like any other step — but it never
    // produced a real assistant reply, so it must not be folded into
    // `history`: doing that would inject a phantom duplicated user turn
    // plus an empty assistant turn, corrupting every later step's
    // reconstructedPrompt for the rest of the run.
    const prompt1 = makeSolvePrompt({
      id: 1,
      promptNumber: 1,
      promptType: SolvePromptType.INITIAL_SOLVE,
      rawResponseText: "response-1",
    });
    const callErrorPrompt = makeSolvePrompt({
      id: 2,
      promptNumber: 1,
      attemptNumber: 2,
      promptType: SolvePromptType.RETRY,
      status: SolvePromptStatus.CALL_ERROR,
      rawResponseText: null,
      errorName: "AI_APICallError",
      errorMessage: "model down",
      statusCode: 502,
      isRetryable: true,
      requestBody: { model: "gpt-4.1-nano" },
      responseBody: { error: { message: "model down" } },
    });
    const prompt2 = makeSolvePrompt({
      id: 3,
      promptNumber: 2,
      promptType: SolvePromptType.INITIAL_SOLVE,
      rawResponseText: "response-2",
    });

    const result = reconstructSolvePrompts(
      originalWords,
      [prompt1, callErrorPrompt, prompt2],
      [],
      new Map(),
    );

    // All three rows appear, in call order.
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);

    // The CALL_ERROR row carries its error detail through, has no proposals,
    // and still gets a reconstructedPrompt reflecting the conversation up to
    // that point (prompt1's turn, then its own attempted message).
    const callErrorDto = result[1]!;
    expect(callErrorDto.status).toBe(SolvePromptStatus.CALL_ERROR);
    expect(callErrorDto.rawResponseText).toBeNull();
    expect(callErrorDto.proposals).toEqual([]);
    expect(callErrorDto.errorName).toBe("AI_APICallError");
    expect(callErrorDto.errorMessage).toBe("model down");
    expect(callErrorDto.statusCode).toBe(502);
    expect(callErrorDto.isRetryable).toBe(true);
    expect(callErrorDto.requestBody).toEqual({ model: "gpt-4.1-nano" });
    expect(callErrorDto.responseBody).toEqual({ error: { message: "model down" } });
    // No guess ever failed before this row (no proposals were passed at
    // all), so lastFailedGuess is still null when it's built — the
    // function's defensive fallback uses buildInitialPrompt even though
    // this row's own promptType is RETRY (see its docblock).
    expect(callErrorDto.reconstructedPrompt).toBe(
      formatConversation([
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
        { role: "assistant", content: "response-1" },
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
      ]),
    );

    // ...and, critically, contributed no phantom turn to `history` —
    // prompt2's reconstructedPrompt is exactly [prompt1's turn, prompt2's
    // own message], not corrupted by an extra empty-assistant turn in
    // between from the CALL_ERROR row.
    expect(result[2]!.reconstructedPrompt).toBe(
      formatConversation([
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
        { role: "assistant", content: "response-1" },
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
      ]),
    );
  });

  it("falls back to an INITIAL prompt if a RETRY step has no prior failure on record", () => {
    // Defensive case: shouldn't happen with real data, but guards against a
    // crash if it ever does.
    const prompt = makeSolvePrompt({ id: 1, promptNumber: 1, promptType: SolvePromptType.RETRY });

    const result = reconstructSolvePrompts(originalWords, [prompt], [], new Map());

    expect(result[0]!.reconstructedPrompt).toBe(
      formatConversation([{ role: "user", content: buildInitialPrompt(originalWords, 2) }]),
    );
  });
});
