import { GuessResult } from "../modules/strategy/entities/guess.entity";
import type { Guess } from "../modules/strategy/entities/guess.entity";
import { LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import type { LlmProposal } from "../modules/strategy/entities/llm-proposal.entity";
import { SolvePromptStatus, SolvePromptType } from "../modules/strategy/entities/solve-prompt.entity";
import type { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { formatConversation, reconstructPromptTexts } from "./backfill-prompt-text";
import { buildInitialPrompt, buildRetryPrompt } from "../modules/strategy/llm-strategy-runner.service";

// Repurposed from prompt-reconstruction.spec.ts (that module and its spec
// are deleted now that every SolvePrompt row carries promptText directly —
// see docs/architecture/specs/08-persist-prompt-text.md). Every fidelity
// assertion from the original spec carries over unchanged: the backfill's
// correctness bar is identical to reconstruction's original bar, just
// exercised against reconstructPromptTexts's Map<promptId, text> output
// instead of reconstructSolvePrompts's full read-model DTOs (this script has
// no need to also re-derive proposals/promptType/error detail — those
// already live untouched in their own columns/tables).

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

describe("reconstructPromptTexts", () => {
  const originalWords = ["A", "B", "C", "D", "E", "F", "G", "H"];

  it("returns nothing when there are no solve prompts", () => {
    expect(reconstructPromptTexts(originalWords, [], [], new Map())).toEqual(new Map());
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
    const guess1 = makeGuess({ id: 1, sequenceNumber: 1, words: ["A", "B", "C", "D"], result: GuessResult.FAILURE });

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
    const guess2 = makeGuess({ id: 2, sequenceNumber: 2, words: ["E", "F", "G", "H"], result: GuessResult.SUCCESS });

    // Step 3 (INITIAL again — a successful step resets lastFailedGuess, so
    // the runner goes back to the INITIAL branch even mid-run): solves the
    // remaining 4 words.
    const prompt3 = makeSolvePrompt({ id: 103, promptNumber: 3, promptType: SolvePromptType.INITIAL_SOLVE });
    const proposal4 = makeProposal({
      id: 4,
      solvePromptId: 103,
      words: ["A", "B", "C", "D"],
      category: "Cat1",
      status: LlmProposalStatus.USED,
      guessId: 3,
    });
    const guess3 = makeGuess({ id: 3, sequenceNumber: 3, words: ["A", "B", "C", "D"], result: GuessResult.SUCCESS });

    const guessesById = new Map([
      [1, guess1],
      [2, guess2],
      [3, guess3],
    ]);

    const result = reconstructPromptTexts(
      originalWords,
      [prompt1, prompt2, prompt3],
      [proposal1, proposal2, proposal3, proposal4],
      guessesById,
    );

    expect(result.size).toBe(3);

    const initialPrompt = buildInitialPrompt(originalWords, 2);
    const retryPrompt = buildRetryPrompt(
      originalWords,
      [],
      { items: ["A", "B", "C", "D"], result: "incorrect" },
      2,
    );
    const finalPrompt = buildInitialPrompt(["A", "B", "C", "D"], 1);

    // Step 1: no history yet, so it's just this step's own message.
    expect(result.get(101)).toBe(formatConversation([{ role: "user", content: initialPrompt }]));

    // Step 2: the full transcript so far — step 1's prompt and response —
    // plus this step's own RETRY prompt referencing the failed guess.
    expect(result.get(102)).toBe(
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
    expect(result.get(103)).toBe(
      formatConversation([
        { role: "user", content: initialPrompt },
        { role: "assistant", content: "response-1" },
        { role: "user", content: retryPrompt },
        { role: "assistant", content: "response-2" },
        { role: "user", content: finalPrompt },
      ]),
    );
  });

  it("labels an off-by-one guess as 'one away' guidance in the retry prompt", () => {
    const prompt1 = makeSolvePrompt({ id: 1, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE });
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

    const result = reconstructPromptTexts(
      originalWords,
      [prompt1, prompt2],
      [proposal1],
      new Map([[1, guess1]]),
    );

    expect(result.get(2)).toBe(
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

  it("includes a CALL_ERROR row's own reconstructed text, but never lets it corrupt later steps", () => {
    // A CALL_ERROR row (the call itself failed, no model text at all) still
    // needs its own backfilled promptText — but it never produced a real
    // assistant reply, so it must not be folded into `history`: doing that
    // would inject a phantom duplicated user turn plus an empty assistant
    // turn, corrupting every later step's reconstructed text for the rest of
    // the run.
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
    });
    const prompt2 = makeSolvePrompt({
      id: 3,
      promptNumber: 2,
      promptType: SolvePromptType.INITIAL_SOLVE,
      rawResponseText: "response-2",
    });

    const result = reconstructPromptTexts(originalWords, [prompt1, callErrorPrompt, prompt2], [], new Map());

    // All three rows get an entry, in call order.
    expect(result.size).toBe(3);

    // The CALL_ERROR row still gets reconstructed text reflecting the
    // conversation up to that point (prompt1's turn, then its own attempted
    // message). No guess ever failed before this row (no proposals were
    // passed at all), so lastFailedGuess is still null when it's built — the
    // function's defensive fallback uses buildInitialPrompt even though this
    // row's own promptType is RETRY (see its docblock).
    expect(result.get(2)).toBe(
      formatConversation([
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
        { role: "assistant", content: "response-1" },
        { role: "user", content: buildInitialPrompt(originalWords, 2) },
      ]),
    );

    // ...and, critically, contributed no phantom turn to `history` —
    // prompt2's reconstructed text is exactly [prompt1's turn, prompt2's own
    // message], not corrupted by an extra empty-assistant turn in between
    // from the CALL_ERROR row.
    expect(result.get(3)).toBe(
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

    const result = reconstructPromptTexts(originalWords, [prompt], [], new Map());

    expect(result.get(1)).toBe(
      formatConversation([{ role: "user", content: buildInitialPrompt(originalWords, 2) }]),
    );
  });
});
