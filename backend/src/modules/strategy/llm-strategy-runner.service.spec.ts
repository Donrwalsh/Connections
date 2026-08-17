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
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

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

      // Proposals: 4 per prompt (2 prompts) = 8 total
      const proposalRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "LlmProposal")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(proposalRows).toHaveLength(8);
      // First proposal is 'used'
      expect(proposalRows[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          status: LlmProposalStatus.USED,
        }),
      );
      // Rest are 'not_selected'
      expect(proposalRows[1]).toEqual(
        expect.objectContaining({
          words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          status: LlmProposalStatus.NOT_SELECTED,
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

    it("should send conversation history with prior guesses as RETRY prompts", async () => {
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

      await runner.runLlmStrategy(100, "llm-openai");

      // First call: user message only
      const firstMessages = mockOrchestratorService.solveAssist.mock.calls[0][0] as ChatMessage[];
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0].role).toBe("user");
      expect(firstMessages[0].content).toContain("ANSWER:");

      // Second call: user, assistant, user (RETRY)
      const secondMessages = mockOrchestratorService.solveAssist.mock.calls[1][0] as ChatMessage[];
      expect(secondMessages).toHaveLength(3);
      expect(secondMessages[0].role).toBe("user");
      expect(secondMessages[1].role).toBe("assistant");
      expect(secondMessages[2].role).toBe("user");
      expect(secondMessages[2].content).toContain("Feedback on your last guess");
    });

    it("should consult the Ollama provider for the llm-ollama strategy", async () => {
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

      await runner.runLlmStrategy(100, "llm-ollama");

      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);
    });

    it("should resume with prior guesses loaded from the database", async () => {
      mockGuessRepo.find.mockResolvedValueOnce([
        { words: ["APPLE", "BANANA", "EGGPLANT", "FIG"], result: GuessResult.FAILURE },
      ]);
      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 3 });
      // The persisted wrong guess should be reflected in the RETRY prompt
      const firstMessages = mockOrchestratorService.solveAssist.mock.calls[0][0] as ChatMessage[];
      expect(firstMessages).toHaveLength(2); // prior guess feedback + new prompt
      expect(firstMessages[0].content).toContain("incorrect");
    });

    it("should terminate with 'duplicate' once the duplicate limit is hit", async () => {
      process.env.LLM_MAX_DUPLICATE_GUESSES = "3";
      try {
        mockGuessRepo.find.mockResolvedValueOnce([
          { words: ["APPLE", "BANANA", "CHERRY", "DATE"], result: GuessResult.FAILURE },
        ]);
        // Every response proposes the same first group
        mockOrchestratorService.solveAssist.mockResolvedValue(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 4 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
              }>,
          );
        expect(inserted.map((g) => g.result)).toEqual([
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
        ]);
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
      expect(mockManager.insert).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce(
          makeAssistResponse([["APPLE", "BANANA", "CHERRY", "DATE"], ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        )
        .mockResolvedValueOnce(
          makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
        );

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
