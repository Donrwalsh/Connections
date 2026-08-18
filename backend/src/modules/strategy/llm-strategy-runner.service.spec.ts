import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { LlmStrategyRunner } from "./llm-strategy-runner.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess, GuessResult } from "./entities/guess.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { LlmProposalStatus } from "./entities/llm-proposal.entity";
import { OrchestratorService, type SolveAssistOutcome, type ChatMessage } from "./orchestrator.service";

describe("LlmStrategyRunner", () => {
  let runner: LlmStrategyRunner;
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock };
  let mockGuessRepo: {
    count: jest.Mock;
    find: jest.Mock;
  };
  let mockSolvePromptRepo: {
    count: jest.Mock;
  };
  let mockOrchestratorService: {
    solveAssist: jest.Mock<Promise<SolveAssistOutcome>, unknown[]>;
  };
  let mockManager: { insert: jest.Mock; save: jest.Mock };
  let mockDataSource: { transaction: jest.Mock };

  const makeRun = (overrides: Partial<StrategyRun> = {}) => ({
    id: 7,
    puzzleId: 100,
    strategyName: "alphabetical",
    trialNumber: 0,
    status: StrategyRunStatus.RUNNING,
    availableWords: ["APPLE", "BANANA", "CHERRY", "DATE", "EGGPLANT", "FIG", "GRAPE", "HONEY"],
    currentCombination: [0, 1, 2, 3],
    modelName: null,
    contextWindow: null,
    finishedAt: null,
    ...overrides,
  });

  const makePuzzle = (answerWords: string[][]) => ({
    id: 100,
    answerGroups: answerWords.map((words) => ({
      members: words.map((word) => ({ word })),
    })),
  });

  // Puzzle whose answer groups are exactly the 8 words of makeRun() split in
  // half — used when a run is expected to solve cleanly.
  const solvePuzzle = makePuzzle([
    ["APPLE", "BANANA", "CHERRY", "DATE"],
    ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
  ]);

  beforeEach(async () => {
    mockStrategyRunRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    mockPuzzleRepo = {
      findOne: jest.fn(),
    };
    mockGuessRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
    };
    mockSolvePromptRepo = {
      count: jest.fn().mockResolvedValue(0),
    };
    mockOrchestratorService = {
      solveAssist: jest.fn(),
    };
    mockManager = {
      insert: jest.fn().mockImplementation((entity: string, data?: unknown[]) => {
        if (entity === "SolvePrompt")
          return { identifiers: (data ?? []).map((_, i) => ({ id: 10 + i })) };
        if (entity === "Guess") return { identifiers: [{ id: 1 }] };
        if (entity === "LlmProposal") return { identifiers: [{ id: 20 }] };
        return { identifiers: [{ id: 1 }] };
      }),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmStrategyRunner,
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
        { provide: OrchestratorService, useValue: mockOrchestratorService },
      ],
    }).compile();

    runner = module.get<LlmStrategyRunner>(LlmStrategyRunner);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("runLlmStrategy", () => {
    const makeAssistResponse = (
      groups: string[][],
      response: string = "test reasoning",
    ): SolveAssistOutcome => ({
      ok: true,
      data: {
        response,
        groups,
        model: "mistral",
        latencyMs: 500,
      },
    });

    const malformed = (): SolveAssistOutcome => ({
      ok: false,
      error: { error: "bad response", code: "invalid_group" },
    });

    // The runner reuses a single `messages` array across the whole run,
    // mutating it in place on every call. Reading `mock.calls[N][0]` after
    // the run finishes returns the same, fully-mutated array for every
    // call index. To assert what was actually sent *at* a given call, this
    // snapshots the array's contents synchronously as each call happens.
    const captureMessages = (outcomes: SolveAssistOutcome[]) => {
      const snapshots: ChatMessage[][] = [];
      let i = 0;
      mockOrchestratorService.solveAssist.mockImplementation(async (...args: unknown[]) => {
        const messages = args[0] as ChatMessage[];
        snapshots.push(messages.map((m) => ({ ...m })));
        return outcomes[i++];
      });
      return snapshots;
    };

    beforeEach(() => {
      mockStrategyRunRepo.findOne.mockResolvedValue(makeRun({ strategyName: "llm-openai" }));
      mockGuessRepo.find.mockResolvedValue([]);
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
    });

    it("should short-circuit for a terminal run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ strategyName: "llm-openai", status: StrategyRunStatus.COMPLETED }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(5);

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 5 });
      expect(mockOrchestratorService.solveAssist).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should solve a puzzle through iterative orchestrator calls", async () => {
      // Each response proposes just one group, so the run needs a second
      // orchestrator call (with an INITIAL prompt, since nothing failed) to
      // pick up the remaining words.
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]))
        .mockResolvedValueOnce(makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);

      // Guesses
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(inserted).toHaveLength(2);
      expect(inserted[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
        }),
      );

      // One proposal per prompt (2 prompts) = 2 total, both used since each
      // call's single proposal is the one submitted as a guess.
      const proposalRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "LlmProposal")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(proposalRows).toHaveLength(2);
      expect(proposalRows[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          status: LlmProposalStatus.USED,
        }),
      );
      expect(proposalRows[1]).toEqual(
        expect.objectContaining({
          words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          status: LlmProposalStatus.USED,
        }),
      );

      // SolvePrompt rows: one per call
      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows).toHaveLength(2);
      expect(promptRows[0]).toEqual(
        expect.objectContaining({
          strategyRunId: 7,
          promptNumber: 1,
          promptType: "initialSolve",
          rawResponseText: "test reasoning",
          temperature: expect.any(Number),
        }),
      );

      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({
          status: StrategyRunStatus.COMPLETED,
          modelName: "mistral",
        }),
      );
    });

    it("should strip a trailing parenthetical from a Words: line and flag the prompt", async () => {
      // Mirrors a real Mistral response: explanatory asides glued onto the
      // Words: line instead of kept in the scratchpad. Group 1's aside has
      // no internal comma (contaminates just the last word if left in);
      // Group 2's aside has several (would otherwise push the line past 4
      // comma-separated tokens and get the whole group discarded). Both
      // must still resolve to exactly 4 clean words.
      const responseOne =
        "### GROUPS\n#### Group 1\nCategory: Fruits\n" +
        "Words: APPLE, BANANA, CHERRY, DATE (these are all fruits)\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      const responseTwo =
        "### GROUPS\n#### Group 1\nCategory: Misc\n" +
        "Words: EGGPLANT, FIG, GRAPE, HONEY (eggplant is purple, fig is sweet, " +
        "grape is small, honey is sticky)\n\n" +
        "### ANSWER\nEGGPLANT, FIG, GRAPE, HONEY";

      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], responseOne),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]], responseTwo),
        );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });

      // The contamination never reaches the guess — both submitted with
      // exactly the 4 real puzzle words.
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<{ words: string[]; result: GuessResult }>);
      expect(inserted).toEqual([
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
        }),
        expect.objectContaining({
          words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          result: GuessResult.SUCCESS,
        }),
      ]);

      // Flagged so affected runs can be found later, and rawResponseText
      // keeps the untouched original (parenthetical and all) — only the
      // parser's internal word-extraction is fixed, not what's stored.
      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows).toEqual([
        expect.objectContaining({ wordsHadParenthetical: true, rawResponseText: responseOne }),
        expect.objectContaining({ wordsHadParenthetical: true, rawResponseText: responseTwo }),
      ]);
    });

    it("should not flag a Words: line with no parenthetical", async () => {
      const response =
        "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
        "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]], response),
      );
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(expect.objectContaining({ wordsHadParenthetical: false }));
    });

    it("should send conversation history with prior guesses as RETRY prompts", async () => {
      // First call proposes a group that spans both answer categories, so
      // it fails and triggers a RETRY prompt on the next call.
      const snapshots = captureMessages([
        makeAssistResponse([["APPLE", "EGGPLANT", "CHERRY", "FIG"]]),
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      ]);

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 3 });
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);

      // First call: user message only, using the INITIAL prompt format
      expect(snapshots[0]).toHaveLength(1);
      expect(snapshots[0][0].role).toBe("user");
      expect(snapshots[0][0].content).toContain("### ANSWER");

      // Second call: user, assistant, then a RETRY user message with feedback
      expect(snapshots[1]).toHaveLength(3);
      expect(snapshots[1][0].role).toBe("user");
      expect(snapshots[1][1].role).toBe("assistant");
      expect(snapshots[1][2].role).toBe("user");
      expect(snapshots[1][2].content).toContain("Feedback on Previous Guess:");
    });

    it("should consult the Ollama provider for the llm-ollama strategy", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm-ollama" }));
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      await runner.runLlmStrategy(100, "llm-ollama", 0, "mistral");

      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(1);
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledWith(
        expect.any(Array),
        "mistral",
        "ollama",
      );
    });

    it("should pass the requested model and the openai provider for llm-openai", async () => {
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      await runner.runLlmStrategy(100, "llm-openai", 0, "gpt-4.1-nano-2025-04-14");

      // loadOrCreateRun's own tests cover setting StrategyRun.modelName from
      // this value at creation time — here just confirm the runner passes it
      // through to the orchestrator call rather than leaving it for the
      // response-based fallback.
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledWith(
        expect.any(Array),
        "gpt-4.1-nano-2025-04-14",
        "openai",
      );
    });

    it("should resume with prior guesses loaded from the database", async () => {
      mockGuessRepo.find.mockResolvedValueOnce([
        { words: ["APPLE", "BANANA", "EGGPLANT", "FIG"], result: GuessResult.FAILURE },
      ]);
      const snapshots = captureMessages([
        makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]),
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      ]);

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 3 });

      // The conversation for this resumed process starts fresh with an
      // INITIAL prompt; the runner doesn't reconstruct history from the DB.
      expect(snapshots[0]).toHaveLength(1);
      expect(snapshots[0][0].content).not.toContain("Feedback on Previous Guess:");

      // New guesses continue the sequence number after the persisted prior guess.
      const insertedGuesses = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<{ sequenceNumber: number }>);
      expect(insertedGuesses.map((g) => g.sequenceNumber)).toEqual([2, 3]);
    });

    it("should terminate with 'duplicate' once the duplicate limit is hit", async () => {
      process.env.LLM_MAX_DUPLICATE_GUESSES = "3";
      try {
        // GameService's puzzle evaluation never returns GuessResult.DUPLICATE
        // itself — duplicates are detected upstream by the orchestrator and
        // reported via the duplicate_group error code.
        mockOrchestratorService.solveAssist.mockResolvedValue({
          ok: false,
          error: { error: "duplicate group", code: "duplicate_group" },
        });

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 0 });
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
        expect(mockManager.insert).not.toHaveBeenCalled();
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.DUPLICATE }),
        );
      } finally {
        delete process.env.LLM_MAX_DUPLICATE_GUESSES;
      }
    });

    it("should terminate with 'failed' once the failed-guess limit is hit", async () => {
      process.env.LLM_MAX_FAILED_GUESSES = "2";
      try {
        // Both guesses cross the two answer groups, so neither is a one-away
        mockOrchestratorService.solveAssist
          .mockResolvedValueOnce(
            makeAssistResponse([["APPLE", "EGGPLANT", "CHERRY", "FIG"], ["BANANA", "DATE", "GRAPE", "HONEY"]]),
          )
          .mockResolvedValueOnce(
            makeAssistResponse([["BANANA", "DATE", "GRAPE", "HONEY"], ["APPLE", "EGGPLANT", "CHERRY", "FIG"]]),
          );

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.FAILED, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
              }>,
          );
        expect(inserted.map((g) => g.result)).toEqual([GuessResult.FAILURE, GuessResult.FAILURE]);
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.FAILED }),
        );
      } finally {
        delete process.env.LLM_MAX_FAILED_GUESSES;
      }
    });

    it("should count one-aways toward the failed-guess limit", async () => {
      process.env.LLM_MAX_FAILED_GUESSES = "2";
      try {
        // First guess is 3 words of an answer group -> one-away
        mockOrchestratorService.solveAssist
          .mockResolvedValueOnce(
            makeAssistResponse([["APPLE", "BANANA", "CHERRY", "EGGPLANT"], ["DATE", "FIG", "GRAPE", "HONEY"]]),
          )
          .mockResolvedValueOnce(
            makeAssistResponse([["APPLE", "EGGPLANT", "CHERRY", "FIG"], ["BANANA", "DATE", "GRAPE", "HONEY"]]),
          );

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.FAILED, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
              }>,
          );
        expect(inserted.map((g) => g.result)).toEqual([
          GuessResult.OFF_BY_ONE,
          GuessResult.FAILURE,
        ]);
      } finally {
        delete process.env.LLM_MAX_FAILED_GUESSES;
      }
    });

    it("should treat a success with no groups as malformed", async () => {
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: true,
        data: { response: "I don't know", groups: [], model: "mistral", latencyMs: 0 },
      });

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.MALFORMED_RESPONSE, guessCount: 0 });
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);

      // A SolvePrompt row is still recorded for every 'ok' response, even a
      // malformed one, but no Guess/LlmProposal rows are created since there
      // were no groups to evaluate.
      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows).toHaveLength(3);
      expect(mockManager.insert).not.toHaveBeenCalledWith("Guess", expect.anything());
      expect(mockManager.insert).not.toHaveBeenCalledWith("LlmProposal", expect.anything());
      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({ status: StrategyRunStatus.MALFORMED_RESPONSE }),
      );
    });

    it("should terminate with 'malformedResponse' after consecutive invalid responses", async () => {
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(malformed())
        .mockResolvedValueOnce(malformed())
        .mockResolvedValueOnce(malformed());

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.MALFORMED_RESPONSE, guessCount: 0 });
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({ status: StrategyRunStatus.MALFORMED_RESPONSE }),
      );
    });

    it("should retry after a transient model error and not fail the run", async () => {
      jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce({
          ok: false,
          error: { error: "model is loading", code: "model_error" },
        })
        .mockResolvedValueOnce(makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"]]))
        .mockResolvedValueOnce(makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
      expect(mockManager.save).not.toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({ status: StrategyRunStatus.ERROR }),
      );
    });

    it("should terminate with 'error' only after max consecutive model errors", async () => {
      jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      process.env.LLM_MAX_MODEL_ERRORS = "2";
      try {
        mockOrchestratorService.solveAssist.mockResolvedValue({
          ok: false,
          error: { error: "ollama is down", code: "model_error" },
        });

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.ERROR, guessCount: 0 });
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);
        expect(mockManager.insert).not.toHaveBeenCalled();
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.ERROR }),
        );
      } finally {
        delete process.env.LLM_MAX_MODEL_ERRORS;
      }
    });
  });
});
