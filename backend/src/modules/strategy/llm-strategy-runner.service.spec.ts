import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { LlmStrategyRunner } from "./llm-strategy-runner.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess, GuessResult } from "./entities/guess.entity";
import { LlmProposalStatus } from "./entities/llm-proposal.entity";
import { OrchestratorService, type SolveOutcome } from "./orchestrator.service";

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
  let mockOrchestratorService: {
    proposeGroup: jest.Mock<Promise<SolveOutcome>, unknown[]>;
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
    mockOrchestratorService = {
      proposeGroup: jest.fn(),
    };
    mockManager = {
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
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
    const makeGroup = (
      wordIds: number[],
      overrides: Partial<{ category: string; confidence: number; reasoning: string }> = {},
    ) => ({
      word_ids: wordIds,
      category: "Fruit",
      confidence: 0.9,
      reasoning: "test",
      ...overrides,
    });

    const makeProposal = (
      wordIds: number[],
      status: "used" | "rejected_duplicate" | "not_selected" = "used",
      overrides: Partial<{
        promptNumber: number;
        category: string;
        confidence: number;
        reasoning: string;
      }> = {},
    ) => ({
      promptNumber: 1,
      word_ids: wordIds,
      category: "Fruit",
      confidence: 0.9,
      reasoning: "test",
      status,
      ...overrides,
    });

    const success = (
      wordIds: number[],
      overrides: Partial<import("./orchestrator.service").SolveSuccess> = {},
    ): SolveOutcome => ({
      ok: true,
      data: {
        proposedGroups: [makeGroup(wordIds)],
        proposals: [makeProposal(wordIds)],
        prompt: "solve step",
        model: "mistral",
        contextWindow: 8192,
        latencyMs: 500,
        temperature: 0,
        numResponses: 1,
        promptAttempts: 1,
        duplicatesRejected: 0,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        promptMetadata: [
          {
            attempt: 1,
            temperature: 0,
            numResponses: 1,
            model: "mistral",
            contextWindow: 8192,
            latencyMs: 500,
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            outcome: "accepted",
          },
        ],
        ...overrides,
      },
    });

    // The orchestrator reports a duplicate_group only after exhausting its
    // prompt budget on repeats, carrying the repeated groups in its details.
    const duplicateFailure = (
      wordIds: number[],
      overrides: Partial<import("./orchestrator.service").SolveErrorDetails> = {},
    ): SolveOutcome => ({
      ok: false,
      error: {
        error: "repeated group",
        code: "duplicate_group",
        details: {
          proposedGroups: [makeGroup(wordIds, { confidence: 0.5, reasoning: "again" })],
          proposals: [
            makeProposal(wordIds, "rejected_duplicate", {
              promptNumber: 3,
              confidence: 0.5,
              reasoning: "again",
            }),
          ],
          prompt: "solve step",
          model: "mistral",
          contextWindow: 8192,
          latencyMs: 1500,
          temperature: 0,
          numResponses: 1,
          promptAttempts: 3,
          duplicatesRejected: 3,
          usage: { promptTokens: 30, completionTokens: 60, totalTokens: 90 },
          ...overrides,
        },
      },
    });

    const malformed = (): SolveOutcome => ({
      ok: false,
      error: { error: "bad json", code: "invalid_group" },
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
      expect(mockOrchestratorService.proposeGroup).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should solve a puzzle through iterative orchestrator calls", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(2);
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(inserted).toHaveLength(2);
      expect(inserted[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 500,
          temperature: 0.2,
          numResponses: 1,
          promptAttempts: 1,
          duplicatesRejected: 0,
          llmDetails: {
            category: "Fruit",
            confidence: 0.9,
            reasoning: "test",
            prompt: "solve step",
            promptMetadata: [
              {
                attempt: 1,
                temperature: 0,
                numResponses: 1,
                model: "mistral",
                contextWindow: 8192,
                latencyMs: 500,
                usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
                outcome: "accepted",
              },
            ],
          },
        }),
      );
      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({
          status: StrategyRunStatus.COMPLETED,
          modelName: "mistral",
          contextWindow: 8192,
        }),
      );

      // Every proposed candidate is persisted, not just the winner, and the
      // 'used' proposal is linked to the guess it became.
      const proposalRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "LlmProposal")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(proposalRows).toHaveLength(2);
      expect(proposalRows[0]).toEqual({
        strategyRun: { id: 7 },
        promptNumber: 1,
        guessNumber: 1,
        words: ["APPLE", "BANANA", "CHERRY", "DATE"],
        category: "Fruit",
        confidence: 0.9,
        reasoning: "test",
        status: LlmProposalStatus.USED,
        guess: { id: 1 },
      });
      expect(proposalRows[1]).toEqual(
        expect.objectContaining({
          guessNumber: 2,
          words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          status: LlmProposalStatus.USED,
          guess: { id: 1 },
        }),
      );
    });

    it("should feed prior guess history back to the orchestrator", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      await runner.runLlmStrategy(100, "llm-openai");

      expect(mockOrchestratorService.proposeGroup.mock.calls[0][0]).toEqual({
        puzzleWords: ["APPLE", "BANANA", "CHERRY", "DATE", "EGGPLANT", "FIG", "GRAPE", "HONEY"],
        priorGuesses: [],
        modelProvider: "openai",
        temperature: 0.2,
        numResponses: 1,
        maxNumResponses: 10,
        maxPrompts: 19,
      });
      // After the first group is solved, the second call sees the remaining
      // words and the solved group mapped to the orchestrator's 'correct'.
      expect(mockOrchestratorService.proposeGroup.mock.calls[1][0]).toEqual({
        puzzleWords: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        priorGuesses: [{ words: ["APPLE", "BANANA", "CHERRY", "DATE"], result: "correct" }],
        modelProvider: "openai",
        temperature: 0.2,
        numResponses: 1,
        maxNumResponses: 10,
        maxPrompts: 19,
      });
    });

    it("should consult the Ollama provider for the llm-ollama strategy", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      await runner.runLlmStrategy(100, "llm-ollama");

      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(2);
      // The Ollama strategy uses its own provider and the same fixed
      // temperature as OpenAI — the temperature never ramps.
      const firstCall = mockOrchestratorService.proposeGroup.mock.calls[0][0] as {
        modelProvider: string;
        temperature: number;
      };
      expect(firstCall.modelProvider).toBe("ollama");
      expect(firstCall.temperature).toBe(0.2);
      expect(mockOrchestratorService.proposeGroup.mock.calls[1][0]).toMatchObject({
        modelProvider: "ollama",
      });
    });

    it("should resume with prior guesses loaded from the database", async () => {
      // A persisted wrong guess (crossing both answer groups) so neither answer
      // group is blocked as a duplicate when the run resumes.
      mockGuessRepo.find.mockResolvedValueOnce([
        { words: ["APPLE", "BANANA", "EGGPLANT", "FIG"], result: GuessResult.FAILURE },
      ]);
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 3 });
      // The persisted wrong guess is sent to the model as 'incorrect'.
      const firstCall = mockOrchestratorService.proposeGroup.mock.calls[0][0] as {
        puzzleWords: string[];
        priorGuesses: { words: string[]; result: string }[];
        temperature: number;
      };
      expect(firstCall.priorGuesses).toEqual([
        { words: ["APPLE", "BANANA", "EGGPLANT", "FIG"], result: "incorrect" },
      ]);
      expect(firstCall.temperature).toBe(0.2);
      expect(mockGuessRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 7 },
        order: { sequenceNumber: "ASC" },
        select: { words: true, result: true },
      });
    });

    it("should keep the temperature fixed and reset the candidate count per step", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(
          success([0, 1, 2, 3], {
            temperature: 1.2,
            numResponses: 3,
            promptAttempts: 2,
            duplicatesRejected: 1,
          }),
        )
        .mockResolvedValueOnce(
          success([0, 1, 2, 3], {
            temperature: 1.2,
            numResponses: 3,
            promptAttempts: 1,
            duplicatesRejected: 0,
          }),
        );

      await runner.runLlmStrategy(100, "llm-openai");

      const calls = mockOrchestratorService.proposeGroup.mock.calls;
      // The run always sends the fixed temperature.
      expect(calls[0][0]).toEqual(expect.objectContaining({ temperature: 0.2, numResponses: 1 }));
      // The candidate count resets to base for each fresh guess, but the
      // temperature does not follow the (escalated) value the orchestrator
      // echoed back — it stays at the run's fixed temperature.
      expect(calls[1][0]).toEqual(expect.objectContaining({ temperature: 0.2, numResponses: 1 }));
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      // The guess record reports the fixed temperature and the escalated
      // candidate count that actually produced the guess.
      expect(inserted[0]).toEqual(
        expect.objectContaining({
          temperature: 0.2,
          numResponses: 3,
          promptAttempts: 2,
          duplicatesRejected: 1,
        }),
      );
    });

    it("should terminate with 'duplicate' once the duplicate limit is hit", async () => {
      process.env.LLM_MAX_DUPLICATE_GUESSES = "3";
      try {
        mockGuessRepo.find.mockResolvedValueOnce([
          { words: ["APPLE", "BANANA", "CHERRY", "DATE"], result: GuessResult.FAILURE },
        ]);
        mockOrchestratorService.proposeGroup.mockResolvedValue(duplicateFailure([0, 1, 2, 3]));

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 4 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
                llmDetails: Record<string, unknown> | null;
                promptTokens: number | null;
              }>,
          );
        // The orchestrator exhausted its prompt budget on repeats three times,
        // so each step records the repeated group it returned.
        expect(inserted.map((g) => g.result)).toEqual([
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
        ]);
        expect(inserted[0].llmDetails).toEqual({
          category: "Fruit",
          confidence: 0.5,
          reasoning: "again",
          prompt: "solve step",
        });
        expect(inserted[0]).toEqual(
          expect.objectContaining({
            promptTokens: 30,
            completionTokens: 60,
            totalTokens: 90,
            latencyMs: 1500,
            temperature: 0,
            numResponses: 1,
            promptAttempts: 3,
            duplicatesRejected: 3,
          }),
        );
        // The temperature is fixed for the run, so it is the same on every
        // step regardless of the escalations inside the orchestrator.
        const temperatures = mockOrchestratorService.proposeGroup.mock.calls.map(
          (call) => (call[0] as { temperature: number }).temperature,
        );
        expect(temperatures).toEqual([0.2, 0.2, 0.2]);
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.DUPLICATE }),
        );
        // The first repeated group of the last prompt becomes the recorded
        // duplicate guess, so its proposal flips from rejected_duplicate to
        // used and is linked to that guess.
        const proposalRows = mockManager.insert.mock.calls
          .filter((call) => call[0] === "LlmProposal")
          .flatMap((call) => call[1] as Array<Record<string, unknown>>);
        expect(proposalRows).toHaveLength(3);
        expect(proposalRows[0]).toEqual({
          strategyRun: { id: 7 },
          promptNumber: 3,
          guessNumber: 2,
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          category: "Fruit",
          confidence: 0.5,
          reasoning: "again",
          status: LlmProposalStatus.USED,
          guess: { id: 1 },
        });
        expect(proposalRows[2]).toEqual(
          expect.objectContaining({
            guessNumber: 4,
            status: LlmProposalStatus.USED,
            guess: { id: 1 },
          }),
        );
      } finally {
        delete process.env.LLM_MAX_DUPLICATE_GUESSES;
      }
    });

    it("should terminate with 'failed' once the failed-guess limit is hit", async () => {
      process.env.LLM_MAX_FAILED_GUESSES = "2";
      try {
        // Both guesses cross the two answer groups (2 words each), so neither
        // is a one-away and each evaluates to FAILURE.
        mockOrchestratorService.proposeGroup
          .mockResolvedValueOnce(success([0, 1, 4, 5]))
          .mockResolvedValueOnce(success([1, 2, 5, 6]));

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.FAILED, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
                words: string[];
                sequenceNumber: number;
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
        // First guess is 3 words of an answer group -> one-away; the second is
        // a plain wrong group. Together they hit the limit, so the run fails.
        mockOrchestratorService.proposeGroup
          .mockResolvedValueOnce(success([0, 1, 2, 4]))
          .mockResolvedValueOnce(success([0, 1, 4, 5]));

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.FAILED, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                result: GuessResult;
                words: string[];
                sequenceNumber: number;
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

    it("should record the first repeated group from a duplicate_group failure", async () => {
      process.env.LLM_MAX_DUPLICATE_GUESSES = "1";
      try {
        mockGuessRepo.find.mockResolvedValueOnce([
          { words: ["APPLE", "BANANA", "CHERRY", "DATE"], result: GuessResult.FAILURE },
        ]);
        mockOrchestratorService.proposeGroup.mockResolvedValueOnce(
          duplicateFailure([0, 1, 2, 3], {
            proposedGroups: [
              makeGroup([0, 1, 2, 3], { category: "DupA", confidence: 0.5, reasoning: "a" }),
              makeGroup([3, 2, 1, 0], { category: "DupB", confidence: 0.5, reasoning: "b" }),
            ],
          }),
        );

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls
          .filter((call) => call[0] === "Guess")
          .flatMap(
            (call) =>
              call[1] as Array<{
                words: string[];
                result: GuessResult;
                llmDetails: Record<string, unknown>;
              }>,
          );
        expect(inserted).toHaveLength(1);
        expect(inserted[0].result).toBe(GuessResult.DUPLICATE);
        expect(inserted[0].words).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
        // The orchestrator owns candidate selection, so the backend records
        // whatever repeated group it returned first.
        expect(inserted[0].llmDetails.category).toBe("DupA");
      } finally {
        delete process.env.LLM_MAX_DUPLICATE_GUESSES;
      }
    });

    it("should record the model from a duplicate_group failure", async () => {
      process.env.LLM_MAX_DUPLICATE_GUESSES = "1";
      try {
        mockGuessRepo.find.mockResolvedValueOnce([]);
        mockOrchestratorService.proposeGroup.mockResolvedValue(duplicateFailure([0, 1, 2, 3]));

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 1 });
        // A run that never produced a usable candidate still records which
        // model it ran, so the run list can attribute it.
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({
            status: StrategyRunStatus.DUPLICATE,
            modelName: "mistral",
            contextWindow: 8192,
          }),
        );
      } finally {
        delete process.env.LLM_MAX_DUPLICATE_GUESSES;
      }
    });

    it("should use the candidate the orchestrator already selected", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(
          success([4, 5, 6, 7], {
            proposedGroups: [
              makeGroup([4, 5, 6, 7], {
                category: "FreshCat",
                confidence: 0.9,
                reasoning: "fresh",
              }),
            ],
          }),
        )
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      const inserted = mockManager.insert.mock.calls
        .filter((call) => call[0] === "Guess")
        .flatMap(
          (call) =>
            call[1] as Array<{
              words: string[];
              result: GuessResult;
              llmDetails: Record<string, unknown>;
            }>,
        );
      expect(inserted).toHaveLength(2);
      expect(inserted[0].words).toEqual(["EGGPLANT", "FIG", "GRAPE", "HONEY"]);
      expect(inserted[0].result).toBe(GuessResult.SUCCESS);
      expect(inserted[0].llmDetails.category).toBe("FreshCat");
    });

    it("should persist proposals that were not selected as not_selected", async () => {
      // A batch with a winner and fresh groups that were passed over: the
      // orchestrator keeps them for analysis but only the winner becomes the
      // guess.
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(
          success([0, 1, 2, 3], {
            proposals: [
              makeProposal([0, 1, 2, 3], "used"),
              makeProposal([4, 5, 6, 7], "not_selected", { category: "Veg", confidence: 0.8 }),
              makeProposal([0, 2, 4, 6], "not_selected", { category: "Veg", confidence: 0.7 }),
            ],
          }),
        )
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      const proposalRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "LlmProposal")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(proposalRows).toHaveLength(4);
      // The winner is linked to its guess; the fresh-but-skipped candidates
      // are stored unlinked with their own disposition.
      expect(proposalRows[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          status: LlmProposalStatus.USED,
          guess: { id: 1 },
        }),
      );
      expect(proposalRows[1]).toEqual({
        strategyRun: { id: 7 },
        promptNumber: 1,
        guessNumber: 1,
        words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        category: "Veg",
        confidence: 0.8,
        reasoning: "test",
        status: LlmProposalStatus.NOT_SELECTED,
      });
      expect(proposalRows[2]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "CHERRY", "EGGPLANT", "GRAPE"],
          status: LlmProposalStatus.NOT_SELECTED,
        }),
      );
    });

    it("should treat a success with no proposed group as malformed", async () => {
      mockOrchestratorService.proposeGroup.mockResolvedValue(
        success([0, 1, 2, 3], { proposedGroups: [] }),
      );

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.MALFORMED_RESPONSE, guessCount: 0 });
      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(3);
      // No usable proposal means no guess rows, but the terminal state persists.
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({ status: StrategyRunStatus.MALFORMED_RESPONSE }),
      );
    });

    it("should terminate with 'malformedResponse' after consecutive invalid responses", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(malformed())
        .mockResolvedValueOnce(malformed())
        .mockResolvedValueOnce(malformed());

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.MALFORMED_RESPONSE, guessCount: 0 });
      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(3);
      // No usable proposal means no guess rows, but the terminal state persists.
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
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce({
          ok: false,
          error: { error: "model is loading", code: "model_error" },
        })
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await runner.runLlmStrategy(100, "llm-openai");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      // The transient failure did not kill the run — it retried and solved.
      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(3);
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
        mockOrchestratorService.proposeGroup.mockResolvedValue({
          ok: false,
          error: { error: "ollama is down", code: "model_error" },
        });

        const result = await runner.runLlmStrategy(100, "llm-openai");

        expect(result).toEqual({ status: StrategyRunStatus.ERROR, guessCount: 0 });
        // 2 transient failures, each retried with backoff, then give up.
        expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(2);
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
