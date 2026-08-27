import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE } from "../queue/queue.module";
import { StrategyService } from "./strategy.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { LlmProposal } from "./entities/llm-proposal.entity";
import { GameService } from "../game/game.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { ModelPrice } from "../supported-model/entities/model-price.entity";

describe("StrategyService", () => {
  let service: StrategyService;
  let mockQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockOpenAIQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockOllamaQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock; count: jest.Mock; createQueryBuilder: jest.Mock };
  let mockGuessRepo: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockSolvePromptRepo: {
    count: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockLlmProposalRepo: {
    find: jest.Mock;
  };
  let mockGameService: {
    resolveDateToPuzzleId: jest.Mock;
  };
  let mockSupportedModelService: {
    assertSupported: jest.Mock;
    getDefaultModel: jest.Mock;
    findAll: jest.Mock;
    findPriceHistory: jest.Mock;
  };
  let mockManager: { insert: jest.Mock; save: jest.Mock; count: jest.Mock; delete: jest.Mock };
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

  // Puzzle whose answer words never appear in makeRun()'s pool, so every
  // guess against that pool evaluates to FAILURE.
  const unsolvablePuzzle = makePuzzle([
    ["ALPHA", "BRAVO", "CHARLIE", "DELTA"],
    ["ECHO", "FOXTROT", "GOLF", "HOTEL"],
  ]);

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockOpenAIQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockOllamaQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockStrategyRunRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    mockPuzzleRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    mockGuessRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    mockGameService = {
      resolveDateToPuzzleId: jest.fn(),
    };
    mockSolvePromptRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      // Default: no token-usage rows, so tests that don't care about LLM
      // cost (most of them) get avgCostUsd/totalCostUsd: null for free.
      // Tests that do care override this per-test.
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };
    mockLlmProposalRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockSupportedModelService = {
      assertSupported: jest.fn().mockResolvedValue(undefined),
      getDefaultModel: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findPriceHistory: jest.fn().mockResolvedValue([]),
    };
    mockManager = {
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      save: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyService,
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: STRATEGY_QUEUE, useValue: mockQueue },
        { provide: LLM_OPENAI_QUEUE, useValue: mockOpenAIQueue },
        { provide: LLM_OLLAMA_QUEUE, useValue: mockOllamaQueue },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
        { provide: getRepositoryToken(LlmProposal), useValue: mockLlmProposalRepo },
        { provide: GameService, useValue: mockGameService },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
      ],
    }).compile();

    service = module.get<StrategyService>(StrategyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("triggerRun", () => {
    it("should enqueue a run-strategy job with date", async () => {
      await service.triggerRun(100, "order", "2024-01-02");

      expect(mockQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "order",
          date: "2024-01-02",
          trialNumber: 0,
          model: null,
        },
        { jobId: "run-100-order-0" },
      );
      expect(mockSupportedModelService.assertSupported).not.toHaveBeenCalled();
    });

    it("should enqueue a run-strategy job without a date", async () => {
      await service.triggerRun(100, "order");

      expect(mockQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "order",
          date: undefined,
          trialNumber: 0,
          model: null,
        },
        { jobId: "run-100-order-0" },
      );
    });

    it("should route llm-openai runs to the OpenAI queue after validating the model", async () => {
      await service.triggerRun(100, "llm-openai", "2024-01-02", 0, "gpt-4.1-nano-2025-04-14");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-openai",
        "gpt-4.1-nano-2025-04-14",
      );
      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-02",
          trialNumber: 0,
          model: "gpt-4.1-nano-2025-04-14",
        },
        { jobId: "run-100-llm-openai-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-ollama runs to the Ollama queue after validating the model", async () => {
      await service.triggerRun(100, "llm-ollama", "2024-01-02", 0, "mistral");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith("llm-ollama", "mistral");
      expect(mockOllamaQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-ollama",
          date: "2024-01-02",
          trialNumber: 0,
          model: "mistral",
        },
        { jobId: "run-100-llm-ollama-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });

    it("should not enqueue anything when the model is rejected", async () => {
      mockSupportedModelService.assertSupported.mockRejectedValueOnce(
        new BadRequestException("Model 'bogus' is not a supported model for strategy 'llm-openai'."),
      );

      await expect(
        service.triggerRun(100, "llm-openai", "2024-01-02", 0, "bogus"),
      ).rejects.toThrow(BadRequestException);
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });
  });

  describe("getRunDetail", () => {
    it("should surface a BadRequestException for an invalid date", async () => {
      mockGameService.resolveDateToPuzzleId.mockRejectedValueOnce(
        new BadRequestException("Invalid date format: '2024-13-40'"),
      );

      await expect(service.getRunDetail("2024-13-40", "alphabetical")).rejects.toThrow(
        BadRequestException,
      );
      expect(mockGameService.resolveDateToPuzzleId).toHaveBeenCalledWith("2024-13-40");
    });

    it("should throw NotFoundException when the run does not exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getRunDetail("2024-01-02", "alphabetical")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should look up the run by trial number", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ trialNumber: 3 }));
      mockGuessRepo.count.mockResolvedValueOnce(0);
      mockGuessRepo.find.mockResolvedValueOnce([]);

      await service.getRunDetail("2024-01-02", "shuffle-smart", 3);

      expect(mockStrategyRunRepo.findOne).toHaveBeenCalledWith({
        where: { puzzleId: 5, strategyName: "shuffle-smart", trialNumber: 3 },
      });
    });

    it("should map the run and its guesses into a paginated detail DTO", async () => {
      const startedAt = new Date("2024-01-02T01:00:00Z");
      const guessedAt = new Date("2024-01-02T01:01:00Z");

      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce({
        id: 9,
        strategyName: "order",
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        startedAt,
        finishedAt: new Date("2024-01-02T02:00:00Z"),
      });
      mockGuessRepo.count.mockResolvedValueOnce(2);
      mockGuessRepo.find.mockResolvedValueOnce([
        {
          sequenceNumber: 1,
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
          guessedAt,
        },
        {
          sequenceNumber: 2,
          words: ["A", "B", "C", "D"],
          result: GuessResult.FAILURE,
          guessedAt,
        },
      ]);

      const result = await service.getRunDetail("2024-01-02", "order");

      expect(result).toEqual({
        id: 9,
        strategyName: "order",
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        startedAt,
        finishedAt: new Date("2024-01-02T02:00:00Z"),
        guesses: [
          {
            sequenceNumber: 1,
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            result: GuessResult.SUCCESS,
            guessedAt,
          },
          {
            sequenceNumber: 2,
            words: ["A", "B", "C", "D"],
            result: GuessResult.FAILURE,
            guessedAt,
          },
        ],
        solvePrompts: [],
        meta: { total: 2, page: 1, limit: 200 },
      });
      expect(mockGuessRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 9 },
        order: { sequenceNumber: "ASC" },
        skip: 0,
        take: 200,
        select: {
          strategyRunId: true,
          sequenceNumber: true,
          words: true,
          result: true,
          guessedAt: true,
        },
      });
    });

    it("should page through a run's guesses", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun());
      mockGuessRepo.count.mockResolvedValueOnce(450);
      mockGuessRepo.find.mockResolvedValueOnce([]);

      await service.getRunDetail("2024-01-02", "alphabetical", 0, 2, 100);

      expect(mockGuessRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 100, take: 100 }),
      );
    });

    it("should clamp out-of-range page/limit values", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun());
      mockGuessRepo.count.mockResolvedValueOnce(0);
      mockGuessRepo.find.mockResolvedValueOnce([]);

      await service.getRunDetail("2024-01-02", "alphabetical", 0, 0, 9999);

      expect(mockGuessRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 500 }),
      );
    });
  });

  describe("getRunDetailByRunId", () => {
    it("should throw NotFoundException when the run does not exist", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getRunDetailByRunId(999)).rejects.toThrow(NotFoundException);
      expect(mockStrategyRunRepo.findOne).toHaveBeenCalledWith({ where: { id: 999 } });
    });

    it("should look the run up directly by id, without any date resolution", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ id: 42, trialNumber: 0 }));
      mockGuessRepo.count.mockResolvedValueOnce(0);
      mockGuessRepo.find.mockResolvedValueOnce([]);

      const result = await service.getRunDetailByRunId(42);

      expect(result.id).toBe(42);
      expect(result.solvePrompts).toEqual([]);
      expect(mockGameService.resolveDateToPuzzleId).not.toHaveBeenCalled();
    });

    it("should assemble the reconstructed guess chain for an LLM run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ id: 7, strategyName: "llm-openai", availableWords: [] }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(1);
      mockGuessRepo.find
        // First call: the paginated `guesses` field.
        .mockResolvedValueOnce([
          {
            sequenceNumber: 1,
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            result: GuessResult.SUCCESS,
            guessedAt: new Date("2024-01-02T00:00:00Z"),
          },
        ])
        // Second call: the unpaginated guesses used for reconstruction.
        .mockResolvedValueOnce([
          {
            id: 1,
            sequenceNumber: 1,
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            result: GuessResult.SUCCESS,
            guessedAt: new Date("2024-01-02T00:00:00Z"),
          },
        ]);
      mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);
      mockSolvePromptRepo.find.mockResolvedValueOnce([
        {
          id: 501,
          strategyRunId: 7,
          promptNumber: 1,
          promptType: "initialSolve",
          status: "parsed",
          rawResponseText: "raw",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 500,
          temperature: 0.2,
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
      ]);
      mockLlmProposalRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyRunId: 7,
          guessId: 1,
          solvePromptId: 501,
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          category: "Fruit",
          status: "used",
          createdAt: new Date("2024-01-02T00:00:00Z"),
        },
      ]);

      const result = await service.getRunDetailByRunId(7);

      expect(result.solvePrompts).toHaveLength(1);
      expect(result.solvePrompts[0]!.proposals).toEqual([
        {
          id: 1,
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          category: "Fruit",
          status: "used",
          guess: {
            sequenceNumber: 1,
            result: GuessResult.SUCCESS,
            guessedAt: new Date("2024-01-02T00:00:00Z"),
          },
        },
      ]);
      expect(typeof result.solvePrompts[0]!.reconstructedPrompt).toBe("string");
      expect(result.solvePrompts[0]!.reconstructedPrompt).toContain("APPLE");
    });

    it("should fetch every SolvePrompt row for the run, including CALL_ERROR ones, with a deterministic attemptNumber tiebreak", async () => {
      // CALL_ERROR rows (an OpenAI call attempt that never produced usable
      // model text) are shown on the run detail page alongside successful
      // steps — reconstructSolvePrompts knows to skip them when advancing
      // conversation state, so the query here fetches everything.
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ id: 7, strategyName: "llm-openai", availableWords: [] }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(0);
      mockGuessRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);
      mockSolvePromptRepo.find.mockResolvedValueOnce([]);

      await service.getRunDetailByRunId(7);

      expect(mockSolvePromptRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 7 },
        order: { promptNumber: "ASC", attemptNumber: "ASC" },
      });
    });
  });

  describe("deleteRun", () => {
    it("should delegate to the run store and return its deleted counts", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ id: 7, status: StrategyRunStatus.ERROR }));
      mockManager.count
        .mockResolvedValueOnce(3) // Guess
        .mockResolvedValueOnce(5) // SolvePrompt
        .mockResolvedValueOnce(2); // LlmProposal

      const result = await service.deleteRun(7);

      expect(result).toEqual({ deletedGuesses: 3, deletedSolvePrompts: 5, deletedLlmProposals: 2 });
      expect(mockStrategyRunRepo.findOne).toHaveBeenCalledWith({ where: { id: 7 } });
    });
  });

  describe("getRunsForPuzzleId", () => {
    it("should look runs up directly by puzzleId, without any date resolution", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      const result = await service.getRunsForPuzzleId(5, "shuffle-smart");

      expect(result).toEqual([]);
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 5, strategyName: "shuffle-smart" },
        order: { trialNumber: "ASC" },
      });
      expect(mockGameService.resolveDateToPuzzleId).not.toHaveBeenCalled();
    });
  });

  describe("getGuessDetail", () => {
    it("should throw NotFoundException when the run does not exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getGuessDetail("2024-01-02", "llm-openai", 0, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException when the guess does not exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm-openai" }));
      mockGuessRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getGuessDetail("2024-01-02", "llm-openai", 0, 99)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should look up the guess scoped to the run and sequence number", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm-openai" }));
      mockGuessRepo.findOne.mockResolvedValueOnce({
        sequenceNumber: 1,
        words: ["APPLE", "BANANA", "CHERRY", "DATE"],
        result: GuessResult.SUCCESS,
        guessedAt: new Date("2024-01-02T01:01:00Z"),
      });

      await service.getGuessDetail("2024-01-02", "llm-openai", 0, 1);

      expect(mockGuessRepo.findOne).toHaveBeenCalledWith({
        where: { strategyRunId: 7, sequenceNumber: 1 },
      });
    });

    it("should map the guess into a detail DTO", async () => {
      const guessedAt = new Date("2024-01-02T01:01:00Z");

      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm-openai" }));
      mockGuessRepo.findOne.mockResolvedValueOnce({
        sequenceNumber: 2,
        words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        result: GuessResult.DUPLICATE,
        guessedAt,
      });

      const result = await service.getGuessDetail("2024-01-02", "llm-openai", 0, 2);

      expect(result).toEqual({
        sequenceNumber: 2,
        words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        result: GuessResult.DUPLICATE,
        guessedAt,
      });
    });
  });

  describe("getRunsForPuzzle", () => {
    it("should surface a BadRequestException for an invalid date", async () => {
      mockGameService.resolveDateToPuzzleId.mockRejectedValueOnce(
        new BadRequestException("Invalid date format: '2024-13-40'"),
      );

      await expect(service.getRunsForPuzzle("2024-13-40", "shuffle-smart")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should return an empty list when no runs exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      const result = await service.getRunsForPuzzle("2024-01-02", "shuffle-smart");

      expect(result).toEqual([]);
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 5, strategyName: "shuffle-smart" },
        order: { trialNumber: "ASC" },
      });
    });

    it("should map every trial run ordered by trialNumber with a guess count", async () => {
      const startedAt = new Date("2024-01-02T01:00:00Z");

      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 9,
          strategyName: "shuffle-smart",
          trialNumber: 2,
          status: StrategyRunStatus.FAILED,
          startedAt,
          finishedAt: new Date("2024-01-02T02:00:00Z"),
        },
        {
          id: 8,
          strategyName: "shuffle-smart",
          trialNumber: 1,
          status: StrategyRunStatus.COMPLETED,
          startedAt,
          finishedAt: new Date("2024-01-02T01:30:00Z"),
        },
      ]);
      mockGuessRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 9, count: "120" },
          { strategyRunId: 8, count: "40" },
        ]),
      });

      const result = await service.getRunsForPuzzle("2024-01-02", "shuffle-smart");

      expect(result.map((r) => r.trialNumber)).toEqual([2, 1]);
      expect(result).toEqual([
        {
          id: 9,
          strategyName: "shuffle-smart",
          trialNumber: 2,
          status: StrategyRunStatus.FAILED,
          startedAt,
          finishedAt: new Date("2024-01-02T02:00:00Z"),
          guessCount: 120,
        },
        {
          id: 8,
          strategyName: "shuffle-smart",
          trialNumber: 1,
          status: StrategyRunStatus.COMPLETED,
          startedAt,
          finishedAt: new Date("2024-01-02T01:30:00Z"),
          guessCount: 40,
        },
      ]);
      // One grouped COUNT query for all runs instead of one COUNT per run and
      // no per-run guess loads.
      expect(mockGuessRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(mockGuessRepo.createQueryBuilder).toHaveBeenCalledWith("guess");
      expect(mockGuessRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("triggerStrategyRuns", () => {
    it("should queue a single trial for deterministic strategies", async () => {
      await service.triggerStrategyRuns(100, "order", "2024-01-02");

      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).toHaveBeenCalledWith([
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "order",
            date: "2024-01-02",
            trialNumber: 0,
            model: null,
          },
          opts: { jobId: "run-100-order-0" },
        },
      ]);
      expect(mockSupportedModelService.assertSupported).not.toHaveBeenCalled();
    });

    it("should queue one job per shuffle-smart trial", async () => {
      process.env.SHUFFLE_TRIALS = "3";
      try {
        await service.triggerStrategyRuns(100, "shuffle-smart", "2024-01-02");
      } finally {
        delete process.env.SHUFFLE_TRIALS;
      }

      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).toHaveBeenCalledWith([
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "shuffle-smart",
            date: "2024-01-02",
            trialNumber: 1,
            model: null,
          },
          opts: { jobId: "run-100-shuffle-smart-1" },
        },
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "shuffle-smart",
            date: "2024-01-02",
            trialNumber: 2,
            model: null,
          },
          opts: { jobId: "run-100-shuffle-smart-2" },
        },
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "shuffle-smart",
            date: "2024-01-02",
            trialNumber: 3,
            model: null,
          },
          opts: { jobId: "run-100-shuffle-smart-3" },
        },
      ]);
    });

    it("should queue one job per shuffle-foolish trial", async () => {
      process.env.SHUFFLE_TRIALS = "2";
      try {
        await service.triggerStrategyRuns(100, "shuffle-foolish", "2024-01-02");
      } finally {
        delete process.env.SHUFFLE_TRIALS;
      }

      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).toHaveBeenCalledWith([
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "shuffle-foolish",
            date: "2024-01-02",
            trialNumber: 1,
            model: null,
          },
          opts: { jobId: "run-100-shuffle-foolish-1" },
        },
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "shuffle-foolish",
            date: "2024-01-02",
            trialNumber: 2,
            model: null,
          },
          opts: { jobId: "run-100-shuffle-foolish-2" },
        },
      ]);
    });

    it("should queue exactly one new llm-openai trial on the OpenAI queue after validating the model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      await service.triggerStrategyRuns(100, "llm-openai", "2024-01-02", "gpt-4.1-nano-2025-04-14");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-openai",
        "gpt-4.1-nano-2025-04-14",
      );
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 100, strategyName: "llm-openai" },
        select: { trialNumber: true, modelName: true },
      });
      expect(mockOpenAIQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-02",
          trialNumber: 1,
          model: "gpt-4.1-nano-2025-04-14",
        },
        { jobId: "run-100-llm-openai-1" },
      );
    });

    it("should queue exactly one new llm-ollama trial on the Ollama queue after validating the model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      await service.triggerStrategyRuns(100, "llm-ollama", "2024-01-02", "mistral");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith("llm-ollama", "mistral");
      expect(mockOllamaQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-ollama",
          date: "2024-01-02",
          trialNumber: 1,
          model: "mistral",
        },
        { jobId: "run-100-llm-ollama-1" },
      );
    });

    it("should advance the trial number on repeated calls for the same model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        { trialNumber: 1, modelName: "gpt-4.1-nano-2025-04-14" },
      ]);

      await service.triggerStrategyRuns(100, "llm-openai", "2024-01-02", "gpt-4.1-nano-2025-04-14");

      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-02",
          trialNumber: 2,
          model: "gpt-4.1-nano-2025-04-14",
        },
        { jobId: "run-100-llm-openai-2" },
      );
    });

    it("should give a different model its own independent trial budget", async () => {
      // Two prior trials already exist for gpt-4.1-nano; a request for a
      // different model should still be allowed (its own count is 0) and
      // should not reuse gpt-4.1-nano's trial numbers.
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        { trialNumber: 1, modelName: "gpt-4.1-nano-2025-04-14" },
        { trialNumber: 2, modelName: "gpt-4.1-nano-2025-04-14" },
      ]);

      await service.triggerStrategyRuns(100, "llm-openai", "2024-01-02", "gpt-4.1-mini-2025-04-14");

      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-02",
          trialNumber: 3,
          model: "gpt-4.1-mini-2025-04-14",
        },
        { jobId: "run-100-llm-openai-3" },
      );
    });

    it("should reject dispatch once a model has reached LLM_TRIALS_PER_MODEL", async () => {
      process.env.LLM_TRIALS_PER_MODEL = "2";
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        { trialNumber: 1, modelName: "gpt-4.1-nano-2025-04-14" },
        { trialNumber: 2, modelName: "gpt-4.1-nano-2025-04-14" },
      ]);

      try {
        await expect(
          service.triggerStrategyRuns(100, "llm-openai", "2024-01-02", "gpt-4.1-nano-2025-04-14"),
        ).rejects.toThrow(BadRequestException);
      } finally {
        delete process.env.LLM_TRIALS_PER_MODEL;
      }

      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });

    it("should not enqueue anything when no model is given for an LLM strategy", async () => {
      mockSupportedModelService.assertSupported.mockRejectedValueOnce(
        new BadRequestException("A 'model' is required to dispatch strategy 'llm-openai'."),
      );

      await expect(service.triggerStrategyRuns(100, "llm-openai", "2024-01-02")).rejects.toThrow(
        BadRequestException,
      );
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });

    it("should not enqueue anything when the model is not supported", async () => {
      mockSupportedModelService.assertSupported.mockRejectedValueOnce(
        new BadRequestException(
          "Model 'gpt-3.5-turbo' is not a supported model for strategy 'llm-openai'.",
        ),
      );

      await expect(
        service.triggerStrategyRuns(100, "llm-openai", "2024-01-02", "gpt-3.5-turbo"),
      ).rejects.toThrow(BadRequestException);
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
    });
  });

  describe("findUnrunPuzzleDatesForModel", () => {
    function mockUnrunPuzzleQuery(rawRows: unknown[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rawRows),
      };
      mockPuzzleRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it("should return randomly ordered unrun puzzle dates for the strategy/model pair", async () => {
      const qb = mockUnrunPuzzleQuery([
        { puzzleId: 10, date: "2024-01-01" },
        { puzzleId: 11, date: "2024-01-02" },
      ]);

      const result = await service.findUnrunPuzzleDatesForModel(
        "llm-openai",
        "gpt-4.1-nano-2025-04-14",
        2,
      );

      expect(result).toEqual([
        { puzzleId: 10, date: "2024-01-01" },
        { puzzleId: 11, date: "2024-01-02" },
      ]);
      expect(mockPuzzleRepo.createQueryBuilder).toHaveBeenCalledWith("puzzle");
      // Cast to text for the same reason as getRunHistory's puzzle.date cast.
      expect(qb.addSelect).toHaveBeenCalledWith("puzzle.date::text", "date");
      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining("NOT EXISTS"), {
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano-2025-04-14",
      });
      expect(qb.orderBy).toHaveBeenCalledWith("RANDOM()");
      expect(qb.limit).toHaveBeenCalledWith(2);
    });

    it("should return fewer rows than requested when fewer eligible puzzles exist", async () => {
      mockUnrunPuzzleQuery([{ puzzleId: 10, date: "2024-01-01" }]);

      const result = await service.findUnrunPuzzleDatesForModel("llm-openai", "gpt-5-nano", 5);

      expect(result).toEqual([{ puzzleId: 10, date: "2024-01-01" }]);
    });

    it("should return an empty array when every puzzle has already been run by this model", async () => {
      mockUnrunPuzzleQuery([]);

      const result = await service.findUnrunPuzzleDatesForModel("llm-openai", "gpt-5-nano", 3);

      expect(result).toEqual([]);
    });
  });

  describe("countTodayDispatchByModel", () => {
    function mockDbCountsQuery(rows: { modelName: string; count: string }[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      mockStrategyRunRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it("should return zero for every model when there is no activity today", async () => {
      mockDbCountsQuery([]);
      mockOpenAIQueue.getJobs.mockResolvedValueOnce([]);

      const result = await service.countTodayDispatchByModel("llm-openai", ["gpt-4.1-nano", "o3-mini"]);

      expect(result).toEqual(
        new Map([
          ["gpt-4.1-nano", 0],
          ["o3-mini", 0],
        ]),
      );
    });

    it("should combine today's StrategyRun rows with waiting/delayed queue jobs, per model", async () => {
      const qb = mockDbCountsQuery([{ modelName: "gpt-4.1-nano", count: "2" }]);
      mockOpenAIQueue.getJobs.mockResolvedValueOnce([
        { data: { model: "gpt-4.1-nano" } },
        { data: { model: "o3-mini" } },
        { data: { model: "o3-mini" } },
        // A different strategy's job (e.g. llm-ollama) or a model outside
        // the requested set must never bleed into these counts.
        { data: { model: "mistral" } },
      ]);

      const result = await service.countTodayDispatchByModel("llm-openai", ["gpt-4.1-nano", "o3-mini"]);

      expect(result).toEqual(
        new Map([
          ["gpt-4.1-nano", 3],
          ["o3-mini", 2],
        ]),
      );
      expect(qb.where).toHaveBeenCalledWith("run.strategyName = :strategyName", {
        strategyName: "llm-openai",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("run.modelName IN (:...models)", {
        models: ["gpt-4.1-nano", "o3-mini"],
      });
    });

    it("should return an empty map without querying anything for an empty model list", async () => {
      const result = await service.countTodayDispatchByModel("llm-openai", []);

      expect(result).toEqual(new Map());
      expect(mockStrategyRunRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.getJobs).not.toHaveBeenCalled();
    });
  });

  describe("countInFlightByModel", () => {
    function mockRunningCountsQuery(rows: { modelName: string; count: string }[]) {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      mockStrategyRunRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it("should count RUNNING rows plus waiting/delayed queue jobs, excluding finished runs", async () => {
      const qb = mockRunningCountsQuery([{ modelName: "gpt-4.1-nano", count: "1" }]);
      mockOpenAIQueue.getJobs.mockResolvedValueOnce([{ data: { model: "o3-mini" } }]);

      const result = await service.countInFlightByModel("llm-openai", ["gpt-4.1-nano", "o3-mini"]);

      expect(result).toEqual(
        new Map([
          ["gpt-4.1-nano", 1],
          ["o3-mini", 1],
        ]),
      );
      expect(qb.andWhere).toHaveBeenCalledWith("run.status = :status", {
        status: StrategyRunStatus.RUNNING,
      });
    });

    it("should not double-count a completed run — only RUNNING rows are in flight", async () => {
      // The mock DB query itself is what enforces the RUNNING filter in
      // production (see the andWhere assertion above); here it simply
      // returns nothing, standing in for "no RUNNING rows" regardless of
      // how many completed runs exist for this model today.
      mockRunningCountsQuery([]);
      mockOpenAIQueue.getJobs.mockResolvedValueOnce([]);

      const result = await service.countInFlightByModel("llm-openai", ["gpt-4.1-nano"]);

      expect(result).toEqual(new Map([["gpt-4.1-nano", 0]]));
    });

    it("should return an empty map without querying anything for an empty model list", async () => {
      const result = await service.countInFlightByModel("llm-openai", []);

      expect(result).toEqual(new Map());
      expect(mockStrategyRunRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe("getLeaderboard", () => {
    function mockGuessCounts(rows: { strategyRunId: number; count: string }[]) {
      mockGuessRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      });
    }

    it("should treat a lost LLM run (hit the mistake cap) as a normal completed attempt for progress/averages, while success rate still counts it as a loss", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:30Z"),
        },
        // FAILED = played the whole puzzle out and hit the mistake cap —
        // still a real, full playthrough.
        {
          id: 2,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.FAILED,
          puzzleId: 2,
          startedAt: new Date("2024-01-02T00:00:00Z"),
          finishedAt: new Date("2024-01-02T00:01:00Z"),
        },
        // DUPLICATE is a genuinely broken outcome, not a full playthrough —
        // it must NOT count toward guesses/duration, and must still show as
        // "Failed" on the Progress column.
        {
          id: 3,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.DUPLICATE,
          puzzleId: 3,
          startedAt: new Date("2024-01-03T00:00:00Z"),
          finishedAt: new Date("2024-01-03T00:00:05Z"),
        },
      ]);
      mockGuessCounts([
        { strategyRunId: 1, count: "4" },
        { strategyRunId: 2, count: "8" },
        { strategyRunId: 3, count: "2" },
      ]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);

      const result = await service.getLeaderboard();

      const row = result.llm.find((r) => r.id === "gpt-4.1-nano")!;
      // Progress: the FAILED run is folded into "completed" and dropped from
      // "failed" — only the DUPLICATE run still counts as Failed.
      expect(row.progress).toEqual({ completed: 2, active: 0, failed: 1, queued: 0 });
      // Success rate still reflects the real 1 win out of 2 real outcomes
      // (COMPLETED + FAILED) — DUPLICATE doesn't count as either a win or a
      // "real" playthrough loss here since it never got that far. 1/3.
      expect(row.successRate).toBeCloseTo(33.333, 2);
      // Guesses/duration include the FAILED run (8 guesses, 60s) alongside
      // the COMPLETED one (4 guesses, 30s) — DUPLICATE's 2 guesses/5s are
      // excluded entirely.
      expect(row.avgGuessesToSolve).toBe(6);
      expect(row.minGuesses).toBe(4);
      expect(row.maxGuesses).toBe(8);
      expect(row.avgDurationMs).toBe(45_000);
    });

    it("should aggregate rows into deterministic vs llm, keyed by strategy/model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "alphabetical",
          modelName: null,
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:00.100Z"),
        },
        {
          id: 2,
          strategyName: "alphabetical",
          modelName: null,
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 2,
          startedAt: new Date("2024-01-02T00:00:00Z"),
          finishedAt: new Date("2024-01-02T00:00:00.200Z"),
        },
        {
          id: 3,
          strategyName: "shuffle-smart",
          modelName: null,
          status: StrategyRunStatus.FAILED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:05Z"),
        },
        {
          id: 4,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:30Z"),
        },
        {
          id: 5,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.RUNNING,
          puzzleId: 2,
          startedAt: new Date("2024-01-02T00:00:00Z"),
          finishedAt: null,
        },
        {
          id: 6,
          strategyName: "llm-ollama",
          modelName: "mistral",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:40Z"),
        },
      ]);
      mockGuessCounts([
        { strategyRunId: 1, count: "3" },
        { strategyRunId: 2, count: "5" },
        { strategyRunId: 4, count: "2" },
        { strategyRunId: 6, count: "4" },
      ]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);

      const result = await service.getLeaderboard();

      expect(result.deterministic.map((row) => row.id)).toEqual(["alphabetical", "shuffle-smart"]);
      expect(result.llm.map((row) => row.id)).toEqual(["gpt-4.1-nano", "mistral"]);

      const alphabetical = result.deterministic.find((row) => row.id === "alphabetical")!;
      expect(alphabetical).toMatchObject({
        strategyName: "alphabetical",
        modelName: null,
        kind: "deterministic",
        puzzlesCovered: 2,
        totalPuzzles: 10,
        progress: { completed: 2, active: 0, failed: 0, queued: 0 },
        successRate: 100,
        avgGuessesToSolve: 4,
        minGuesses: 3,
        maxGuesses: 5,
        avgDurationMs: 150,
      });

      const shuffleSmart = result.deterministic.find((row) => row.id === "shuffle-smart")!;
      expect(shuffleSmart).toMatchObject({
        kind: "deterministic",
        progress: { completed: 0, active: 0, failed: 1, queued: 0 },
        successRate: 0,
        avgGuessesToSolve: null,
      });

      const gptRow = result.llm.find((row) => row.id === "gpt-4.1-nano")!;
      expect(gptRow).toMatchObject({
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano",
        kind: "llm",
        puzzlesCovered: 2,
        progress: { completed: 1, active: 1, failed: 0, queued: 0 },
        successRate: 100,
        avgGuessesToSolve: 2,
      });

      const mistralRow = result.llm.find((row) => row.id === "mistral")!;
      expect(mistralRow).toMatchObject({
        strategyName: "llm-ollama",
        modelName: "mistral",
        kind: "llm",
        progress: { completed: 1, active: 0, failed: 0, queued: 0 },
      });
    });

    it("should compute avg/total cost per model from token usage and rates, leaving deterministic rows and unpriceable models null", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "alphabetical",
          modelName: null,
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:00.100Z"),
        },
        {
          id: 2,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:30Z"),
        },
        // Failed runs still spent tokens, so they still count toward cost
        // even though they're excluded from avgGuessesToSolve/avgDurationMs.
        {
          id: 3,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.FAILED,
          puzzleId: 2,
          startedAt: new Date("2024-01-02T00:00:00Z"),
          finishedAt: new Date("2024-01-02T00:00:30Z"),
        },
        // No SupportedModel row for this one below -> cost stays unpriced.
        {
          id: 4,
          strategyName: "llm-openai",
          modelName: "gpt-4o-mini",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 3,
          startedAt: new Date("2024-01-03T00:00:00Z"),
          finishedAt: new Date("2024-01-03T00:00:30Z"),
        },
      ]);
      mockGuessCounts([]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);
      mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 2, promptTokens: "1000000", completionTokens: "500000", issueCount: "3" },
          { strategyRunId: 3, promptTokens: "1000000", completionTokens: "500000" },
          { strategyRunId: 4, promptTokens: "1000000", completionTokens: "0", issueCount: "2" },
        ]),
      });
      mockSupportedModelService.findPriceHistory.mockResolvedValueOnce([
        {
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          createdAt: new Date("2023-01-01T00:00:00Z"),
          inputCostPerMillionTokens: 0.1,
          outputCostPerMillionTokens: 0.4,
        },
      ]);

      const result = await service.getLeaderboard();

      const alphabetical = result.deterministic.find((row) => row.id === "alphabetical")!;
      expect(alphabetical.avgCostUsd).toBeNull();
      expect(alphabetical.totalCostUsd).toBeNull();
      expect(alphabetical.avgIssues).toBeNull();

      // 2 runs at $0.30 each ((1 * 0.1) + (0.5 * 0.4)) = $0.60 total, $0.30 avg.
      const gptNano = result.llm.find((row) => row.id === "gpt-4.1-nano")!;
      expect(gptNano.totalCostUsd).toBeCloseTo(0.6);
      expect(gptNano.avgCostUsd).toBeCloseTo(0.3);
      // issueCount 3 on run 2, no issueCount field (defaults to 0 via the
      // ?? fallback) on run 3 -> (3 + 0) / 2 = 1.5.
      expect(gptNano.avgIssues).toBeCloseTo(1.5);

      const gptMini = result.llm.find((row) => row.id === "gpt-4o-mini")!;
      expect(gptMini.avgCostUsd).toBeNull();
      expect(gptMini.totalCostUsd).toBeNull();
      // gpt-4o-mini has no priceable rate (avgCostUsd/totalCostUsd stay
      // null above), but its run's issueCount of 2 still counts -> issue
      // counting is never gated on cost being resolvable.
      expect(gptMini.avgIssues).toBe(2);
    });

    it("should price each run at the rate in effect when that run started, not the current rate", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2026-03-01T00:00:00Z"),
          finishedAt: new Date("2026-03-01T00:01:00Z"),
        },
      ]);
      mockGuessCounts([]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);
      mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 1, promptTokens: "1000000", completionTokens: "1000000" },
        ]),
      });
      mockSupportedModelService.findPriceHistory.mockResolvedValueOnce([
        {
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          inputCostPerMillionTokens: 0.05,
          outputCostPerMillionTokens: 0.2,
        },
        {
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          createdAt: new Date("2026-06-01T00:00:00Z"),
          inputCostPerMillionTokens: 0.1,
          outputCostPerMillionTokens: 0.4,
        },
      ]);

      const result = await service.getLeaderboard();

      const row = result.llm.find((r) => r.id === "gpt-4.1-nano")!;
      // 1M prompt tokens * 0.05 + 1M completion tokens * 0.2 = 0.25, the
      // January rate (in effect at startedAt) — not the June rate, which
      // would give 0.05 + 0.4 = 0.45.
      expect(row.totalCostUsd).toBeCloseTo(0.25);
    });

    it("should leave a run's cost null when it predates the model's first price row", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2025-01-01T00:00:00Z"),
          finishedAt: new Date("2025-01-01T00:01:00Z"),
        },
      ]);
      mockGuessCounts([]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);
      mockSolvePromptRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { strategyRunId: 1, promptTokens: "1000000", completionTokens: "1000000" },
        ]),
      });
      mockSupportedModelService.findPriceHistory.mockResolvedValueOnce([
        {
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          inputCostPerMillionTokens: 0.05,
          outputCostPerMillionTokens: 0.2,
        },
      ]);

      const result = await service.getLeaderboard();

      const row = result.llm.find((r) => r.id === "gpt-4.1-nano")!;
      expect(row.totalCostUsd).toBeNull();
      expect(row.avgCostUsd).toBeNull();
    });

    it("should include each row's current context window, param count, and provider description", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          finishedAt: new Date("2026-01-01T00:01:00Z"),
        },
      ]);
      mockGuessCounts([]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);
      mockSupportedModelService.findAll.mockResolvedValueOnce([
        {
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          contextWindow: 128000,
          paramCount: null,
          providerDescription: "Fast and cheap.",
        },
      ]);

      const result = await service.getLeaderboard();

      const row = result.llm.find((r) => r.id === "gpt-4.1-nano")!;
      expect(row).toMatchObject({
        contextWindow: 128000,
        paramCount: null,
        providerDescription: "Fast and cheap.",
      });
    });

    it("should merge queued BullMQ counts onto existing rows only, never inventing new ones", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "alphabetical",
          modelName: null,
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:00.100Z"),
        },
      ]);
      mockGuessCounts([{ strategyRunId: 1, count: "3" }]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);

      mockQueue.getJobs.mockResolvedValueOnce([
        { data: { strategyName: "alphabetical", model: null } },
        // 'order' has never actually run — its queued job must not conjure a
        // leaderboard row for it.
        { data: { strategyName: "order", model: null } },
      ]);

      const result = await service.getLeaderboard();

      expect(result.deterministic).toHaveLength(1);
      expect(result.deterministic[0]).toMatchObject({
        id: "alphabetical",
        progress: { completed: 1, active: 0, failed: 0, queued: 1 },
      });
      expect(mockQueue.getJobs).toHaveBeenCalledWith(["waiting", "delayed"], 0, 999);
    });

    it("should tally queued jobs from both LLM provider queues too", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:30Z"),
        },
        {
          id: 2,
          strategyName: "llm-ollama",
          modelName: "mistral",
          status: StrategyRunStatus.COMPLETED,
          puzzleId: 1,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:30Z"),
        },
      ]);
      mockGuessCounts([
        { strategyRunId: 1, count: "2" },
        { strategyRunId: 2, count: "2" },
      ]);
      mockPuzzleRepo.count.mockResolvedValueOnce(10);

      mockOpenAIQueue.getJobs.mockResolvedValueOnce([
        { data: { strategyName: "llm-openai", model: "gpt-4.1-nano" } },
      ]);
      mockOllamaQueue.getJobs.mockResolvedValueOnce([
        { data: { strategyName: "llm-ollama", model: "mistral" } },
        { data: { strategyName: "llm-ollama", model: "mistral" } },
      ]);

      const result = await service.getLeaderboard();

      expect(result.llm.find((row) => row.id === "gpt-4.1-nano")?.progress.queued).toBe(1);
      expect(result.llm.find((row) => row.id === "mistral")?.progress.queued).toBe(2);
    });
  });

  describe("getRunHistory", () => {
    function mockRunHistoryQuery(total: number, rawRows: unknown[]) {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        clone: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(total),
        getRawMany: jest.fn().mockResolvedValue(rawRows),
      };
      mockStrategyRunRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    // tokenCostUsd is computed by the SQL query itself (a CASE over each
    // row's own model's current ModelPrice — see getRunHistory's doc
    // comment), so the raw row fixture carries it directly rather than a
    // separate token-cost lookup being mocked.
    function rawRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        puzzleId: 10,
        puzzleDate: "2024-01-01",
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        modelName: null,
        startedAt: new Date("2024-01-01T00:00:00Z"),
        finishedAt: new Date("2024-01-01T00:00:05Z"),
        guessCount: 4,
        issueCount: 0,
        tokenCostUsd: null,
        ...overrides,
      };
    }

    it("should return paginated rows with the default page/limit/sort", async () => {
      const qb = mockRunHistoryQuery(1, [rawRun()]);

      const result = await service.getRunHistory("alphabetical", {});

      expect(mockStrategyRunRepo.createQueryBuilder).toHaveBeenCalledWith("run");
      expect(qb.where).toHaveBeenCalledWith("run.strategyName = :strategyName", {
        strategyName: "alphabetical",
      });
      expect(qb.andWhere).not.toHaveBeenCalled();
      // Cast to text: getRawMany() bypasses Puzzle.date's entity-level
      // string transformer, so left uncast the raw driver value serializes
      // as a full ISO datetime instead of a plain "YYYY-MM-DD" string (the
      // frontend's date parsing broke on this — see git history).
      expect(qb.addSelect).toHaveBeenCalledWith("puzzle.date::text", "puzzleDate");
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('array_length(sp."issueTags", 1) > 0'),
        "issueCount",
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('"inputCostPerMillionTokens" IS NULL'),
        "tokenCostUsd",
      );
      expect(qb.orderBy).toHaveBeenCalledWith('"puzzleDate"', "DESC");
      expect(qb.addOrderBy).toHaveBeenCalledWith("run.id", "DESC");
      // limit()/offset(), not skip()/take() — see the comment in
      // StrategyService.getRunHistory: skip/take are silently ignored once a
      // JOIN is present, which was the actual bug behind "every page returns
      // the full unpaginated result set".
      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.limit).toHaveBeenCalledWith(100);
      expect(result.meta).toEqual({ total: 1, page: 1, limit: 100 });
      expect(result.rows).toEqual([
        {
          id: 1,
          puzzleId: 10,
          puzzleDate: "2024-01-01",
          strategyName: "alphabetical",
          modelName: null,
          trialNumber: 0,
          status: StrategyRunStatus.COMPLETED,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:05Z"),
          guessCount: 4,
          tokenCostUsd: null,
          issueCount: 0,
        },
      ]);
    });

    it("should surface issueCount from the row", async () => {
      mockRunHistoryQuery(1, [rawRun({ issueCount: 3 })]);

      const result = await service.getRunHistory("alphabetical", {});

      expect(result.rows[0].issueCount).toBe(3);
    });

    it("should filter by model and honor a given sortBy/sortDir/page/limit", async () => {
      const qb = mockRunHistoryQuery(0, []);

      await service.getRunHistory("llm-openai", {
        model: "gpt-4.1-nano",
        page: 2,
        limit: 25,
        sortBy: "guessCount",
        sortDir: "asc",
      });

      expect(qb.andWhere).toHaveBeenCalledWith("run.modelName = :model", { model: "gpt-4.1-nano" });
      expect(qb.orderBy).toHaveBeenCalledWith('"guessCount"', "ASC");
      expect(qb.addOrderBy).toHaveBeenCalledWith("run.id", "ASC");
      expect(qb.offset).toHaveBeenCalledWith(25);
      expect(qb.limit).toHaveBeenCalledWith(25);
    });

    it("should sort by startedAt, duration, or tokenCost when asked", async () => {
      const qb = mockRunHistoryQuery(0, []);

      await service.getRunHistory("alphabetical", { sortBy: "startedAt" });
      expect(qb.orderBy).toHaveBeenLastCalledWith('run."startedAt"', "DESC");

      await service.getRunHistory("alphabetical", { sortBy: "duration" });
      expect(qb.orderBy).toHaveBeenLastCalledWith('(run."finishedAt" - run."startedAt")', "DESC");

      await service.getRunHistory("llm-openai", { sortBy: "tokenCost", sortDir: "asc" });
      expect(qb.orderBy).toHaveBeenLastCalledWith('"tokenCostUsd"', "ASC");
    });

    it("should fall back to puzzleDate desc for an unrecognized sortBy/sortDir", async () => {
      const qb = mockRunHistoryQuery(0, []);

      await service.getRunHistory("alphabetical", { sortBy: "bogus", sortDir: "sideways" });

      expect(qb.orderBy).toHaveBeenCalledWith('"puzzleDate"', "DESC");
    });

    it("should clamp an out-of-range page/limit", async () => {
      const qb = mockRunHistoryQuery(0, []);

      await service.getRunHistory("alphabetical", { page: 0, limit: 10000 });

      expect(qb.offset).toHaveBeenCalledWith(0);
      expect(qb.limit).toHaveBeenCalledWith(500);
    });

    it("should filter by status when a real StrategyRunStatus is given", async () => {
      const qb = mockRunHistoryQuery(0, []);

      await service.getRunHistory("alphabetical", { status: "failed" });

      expect(qb.andWhere).toHaveBeenCalledWith("run.status = :status", { status: "failed" });
    });

    it("should ignore an unrecognized status value instead of filtering by it", async () => {
      const qb = mockRunHistoryQuery(0, []);

      // "queued" is a client-side-only RunStatus — the backend never sets
      // it on a real StrategyRun row (see the doc comment) — and plain
      // garbage should be equally harmless rather than erroring.
      await service.getRunHistory("alphabetical", { status: "queued" });
      await service.getRunHistory("alphabetical", { status: "bogus" });

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        "run.status = :status",
        expect.anything(),
      );
    });

    it("should cast the SQL-computed tokenCostUsd to a number, leaving NULL as null", async () => {
      mockRunHistoryQuery(2, [
        rawRun({ id: 1, modelName: "gpt-4.1-nano", tokenCostUsd: "0.5" }),
        rawRun({ id: 2, modelName: "gpt-4o-mini", tokenCostUsd: null }),
      ]);

      const result = await service.getRunHistory("llm-openai", {});

      expect(result.rows[0].tokenCostUsd).toBe(0.5);
      expect(result.rows[1].tokenCostUsd).toBeNull();
    });

    it("should price each row's ModelPrice as of its own startedAt, not the current price", async () => {
      const qb = mockRunHistoryQuery(1, [rawRun()]);

      await service.getRunHistory("llm-openai", {});

      expect(qb.leftJoin).toHaveBeenCalledWith(
        ModelPrice,
        "mp",
        expect.stringContaining('"createdAt" <= run."startedAt"'),
      );
    });

    it("should not run a separate token-cost lookup query — cost comes from the main query's join", async () => {
      mockRunHistoryQuery(1, [rawRun()]);

      await service.getRunHistory("llm-openai", {});

      expect(mockSolvePromptRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockSupportedModelService.findAll).not.toHaveBeenCalled();
    });
  });

  describe("getRecentRuns", () => {
    function mockRecentRunsQuery(rawRows: unknown[]) {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rawRows),
      };
      mockStrategyRunRepo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    function rawRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        puzzleId: 10,
        puzzleDate: "2024-01-01",
        strategyName: "alphabetical",
        modelName: null,
        trialNumber: 0,
        status: StrategyRunStatus.COMPLETED,
        startedAt: new Date("2024-01-01T00:00:00Z"),
        finishedAt: new Date("2024-01-01T00:00:05Z"),
        ...overrides,
      };
    }

    it("should query without a strategyName filter, newest first with a stable tiebreaker, capped at 100", async () => {
      const qb = mockRecentRunsQuery([rawRun()]);

      await service.getRecentRuns();

      expect(mockStrategyRunRepo.createQueryBuilder).toHaveBeenCalledWith("run");
      expect(qb.orderBy).toHaveBeenCalledWith("run.startedAt", "DESC");
      expect(qb.addOrderBy).toHaveBeenCalledWith("run.id", "DESC");
      expect(qb.limit).toHaveBeenCalledWith(100);
    });

    it("should map raw rows across strategies, including LLM modelName", async () => {
      mockRecentRunsQuery([
        rawRun({ id: 1, strategyName: "alphabetical", modelName: null }),
        rawRun({
          id: 2,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          status: StrategyRunStatus.FAILED,
          finishedAt: null,
        }),
      ]);

      const result = await service.getRecentRuns();

      expect(result).toEqual([
        {
          id: 1,
          puzzleId: 10,
          puzzleDate: "2024-01-01",
          strategyName: "alphabetical",
          modelName: null,
          trialNumber: 0,
          status: StrategyRunStatus.COMPLETED,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: new Date("2024-01-01T00:00:05Z"),
        },
        {
          id: 2,
          puzzleId: 10,
          puzzleDate: "2024-01-01",
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          trialNumber: 0,
          status: StrategyRunStatus.FAILED,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          finishedAt: null,
        },
      ]);
    });
  });

  describe("runDeterministicStrategy", () => {
    it("should short-circuit for an already completed run", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ status: StrategyRunStatus.COMPLETED }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(42);

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.COMPLETED,
        guessCount: 42,
      });
      // A completed run short-circuits before any transaction is opened.
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should solve a running puzzle with consecutive successful guesses", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun());
      mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.COMPLETED,
        guessCount: 2,
      });
      // Guesses are evaluated in memory against the puzzle loaded once, so no
      // per-guess gameService round trips happen.
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
      const inserted = mockManager.insert.mock.calls[0][1] as Array<{
        words: string[];
        result: GuessResult;
      }>;
      expect(inserted.map((g) => g.words)).toEqual([
        ["APPLE", "BANANA", "CHERRY", "DATE"],
        ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
      ]);
      expect(inserted.map((g) => g.result)).toEqual([GuessResult.SUCCESS, GuessResult.SUCCESS]);
      expect(mockManager.insert).toHaveBeenCalledWith(
        "Guess",
        expect.arrayContaining([
          expect.objectContaining({
            puzzle: { id: 100 },
            strategyRun: { id: 7 },
            source: GuessSource.STRATEGY,
            sequenceNumber: 1,
            result: GuessResult.SUCCESS,
          }),
          expect.objectContaining({ sequenceNumber: 2 }),
        ]),
      );
      expect(mockManager.save).toHaveBeenCalledWith(
        StrategyRun,
        expect.objectContaining({ status: StrategyRunStatus.COMPLETED }),
      );
    });

    it("should fail the run after every combination has been tried", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun());
      // None of the pool words match an answer group, so every combination is
      // a FAILURE and the run exhausts all C(8, 4) combinations.
      mockPuzzleRepo.findOne.mockResolvedValueOnce(unsolvablePuzzle);

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.FAILED,
        guessCount: 70, // C(8, 4)
      });
      // One flush at the 50-guess batch limit, one at completion.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
      expect(mockManager.insert).toHaveBeenNthCalledWith(1, "Guess", expect.any(Array));
      expect(mockManager.insert).toHaveBeenNthCalledWith(2, "Guess", expect.any(Array));
    });

    it("should throw BadRequestException for an unsupported strategy", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "bogus" }));
      mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);

      await expect(service.runDeterministicStrategy(100, "bogus")).rejects.toThrow(
        new BadRequestException("Unsupported strategy name: 'bogus'"),
      );
      expect(mockManager.insert).not.toHaveBeenCalled();
    });

    describe("shuffle-smart strategy", () => {
      beforeEach(() => {
        mockStrategyRunRepo.findOne.mockResolvedValue(makeRun());
        mockGuessRepo.find.mockResolvedValue([]);
        mockGuessRepo.count.mockResolvedValue(0);
      });

      it("should solve a puzzle by sampling random groups", async () => {
        // random()=0 makes the first sample the pool tail ([FIG, GRAPE,
        // HONEY, APPLE]) and the second sample the leftover group, so the
        // answer groups are set to match those two draws.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["FIG", "GRAPE", "HONEY", "APPLE"],
            ["CHERRY", "DATE", "EGGPLANT", "BANANA"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-smart");

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 2,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          words: string[];
        }>;
        expect(inserted.map((g) => g.words)).toEqual([
          ["FIG", "GRAPE", "HONEY", "APPLE"],
          ["CHERRY", "DATE", "EGGPLANT", "BANANA"],
        ]);
        expect(mockGuessRepo.find).toHaveBeenCalledWith({
          where: { strategyRunId: 7 },
          select: { words: true },
        });
        expect(mockManager.insert).toHaveBeenCalledWith(
          "Guess",
          expect.arrayContaining([
            expect.objectContaining({
              puzzle: { id: 100 },
              strategyRun: { id: 7 },
              source: GuessSource.STRATEGY,
              sequenceNumber: 1,
            }),
            expect.objectContaining({ sequenceNumber: 2 }),
          ]),
        );
      });

      it("should re-roll when a sampled group was already guessed in this run", async () => {
        // Prior flushed guess that random()=0 would re-sample first.
        mockGuessRepo.find.mockResolvedValue([{ words: ["FIG", "GRAPE", "HONEY", "APPLE"] }]);
        mockGuessRepo.count.mockResolvedValueOnce(1);

        const randomValues = [0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
        jest.spyOn(Math, "random").mockImplementation(() => randomValues.shift() ?? 0.5);
        // First sample re-rolls to [EGGPLANT, FIG, GRAPE, HONEY], which is an
        // answer group; the leftover words then solve the second group.
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            ["APPLE", "BANANA", "CHERRY", "DATE"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-smart");

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 3,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          words: string[];
        }>;
        // First sample ([FIG, GRAPE, HONEY, APPLE]) is in the tried set, so the
        // strategy must skip it and submit a fresh group instead.
        const firstGuess = inserted[0].words;
        expect(new Set(firstGuess)).not.toEqual(new Set(["FIG", "GRAPE", "HONEY", "APPLE"]));
        expect(new Set(firstGuess)).toEqual(new Set(["EGGPLANT", "FIG", "GRAPE", "HONEY"]));
      });

      it("should fail the run once no fresh group can be sampled", async () => {
        // Constant random() means the same group is sampled every time; after
        // the first guess it is always in the tried set, so sampling gives up.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(solvePuzzle);

        const result = await service.runDeterministicStrategy(100, "shuffle-smart");

        expect(result).toEqual({
          status: StrategyRunStatus.FAILED,
          guessCount: 1,
        });
        // The sampled group shares 3 words with an answer group, so it
        // evaluates to OFF_BY_ONE — never SUCCESS, so the pool never shrinks.
        expect(mockManager.insert).toHaveBeenCalledWith(
          "Guess",
          expect.arrayContaining([expect.objectContaining({ result: GuessResult.OFF_BY_ONE })]),
        );
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.FAILED }),
        );
      });
    });

    describe("shuffle-foolish strategy", () => {
      beforeEach(() => {
        mockStrategyRunRepo.findOne.mockResolvedValue(makeRun());
        mockGuessRepo.find.mockResolvedValue([]);
        mockGuessRepo.count.mockResolvedValue(0);
      });

      it("should solve a puzzle by sampling random groups", async () => {
        // random()=0 makes the first sample the pool tail ([FIG, GRAPE,
        // HONEY, APPLE]) and the second sample the leftover group, so the
        // answer groups are set to match those two draws.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["FIG", "GRAPE", "HONEY", "APPLE"],
            ["CHERRY", "DATE", "EGGPLANT", "BANANA"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-foolish");

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 2,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          words: string[];
        }>;
        expect(inserted.map((g) => g.words)).toEqual([
          ["FIG", "GRAPE", "HONEY", "APPLE"],
          ["CHERRY", "DATE", "EGGPLANT", "BANANA"],
        ]);
        // The tried set is rebuilt from flushed guesses (as for shuffle-smart)
        // so duplicate detection survives a worker restart.
        expect(mockGuessRepo.find).toHaveBeenCalledWith({
          where: { strategyRunId: 7 },
          select: { words: true },
        });
      });

      it("should mark repeated groups as duplicates and still solve", async () => {
        // Constant random()=0 keeps sampling [FIG, GRAPE, HONEY, APPLE], which
        // is not an answer group. The second draw is a duplicate (recorded as
        // such — shuffle-foolish has no duplicate limit, so this doesn't end
        // the run). The next draw (random()=0.99) samples the pool tail
        // [EGGPLANT, FIG, GRAPE, HONEY], which is an answer group, and the
        // leftover words solve the puzzle.
        const randomValues = [0, 0, 0, 0, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99, 0.5, 0.5, 0.5, 0.5];
        jest.spyOn(Math, "random").mockImplementation(() => randomValues.shift() ?? 0.5);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            ["APPLE", "BANANA", "CHERRY", "DATE"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-foolish");

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 4,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          words: string[];
          result: GuessResult;
        }>;
        // The first two guesses are the exact same group; the repeat is
        // recorded as a 'duplicate' instead of a plain failure.
        expect(inserted[0].words).toEqual(inserted[1].words);
        expect(inserted[0].words).toEqual(["FIG", "GRAPE", "HONEY", "APPLE"]);
        expect(inserted[1].result).toBe(GuessResult.DUPLICATE);
        expect(inserted[2].words).toEqual(["EGGPLANT", "FIG", "GRAPE", "HONEY"]);
        expect(new Set(inserted[3].words)).toEqual(new Set(["APPLE", "BANANA", "CHERRY", "DATE"]));
      });

      it("should never terminate for piled-up duplicates — it keeps sampling until it solves", async () => {
        // Constant random()=0 for the first six draws makes every one of them
        // the same non-answer group: one fresh (off-by-one) guess followed by
        // five straight duplicates — more than the old default duplicate
        // limit of 3 ever allowed. The run must survive all of them. The next
        // draw (random()=0.99) samples the pool tail [EGGPLANT, FIG, GRAPE,
        // HONEY], which is an answer group, and the leftover words solve the
        // puzzle.
        const randomValues = [
          ...Array(24).fill(0),
          ...Array(4).fill(0.99),
          ...Array(4).fill(0.5),
        ];
        jest.spyOn(Math, "random").mockImplementation(() => randomValues.shift() ?? 0.5);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            ["APPLE", "BANANA", "CHERRY", "DATE"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-foolish");

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 8,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          result: GuessResult;
        }>;
        expect(inserted.map((g) => g.result)).toEqual([
          GuessResult.OFF_BY_ONE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.SUCCESS,
          GuessResult.SUCCESS,
        ]);
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.COMPLETED }),
        );
      });
    });
  });
});
