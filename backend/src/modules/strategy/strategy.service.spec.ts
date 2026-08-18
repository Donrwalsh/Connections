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

describe("StrategyService", () => {
  let service: StrategyService;
  let mockQueue: { add: jest.Mock; addBulk: jest.Mock };
  let mockOpenAIQueue: { add: jest.Mock; addBulk: jest.Mock };
  let mockOllamaQueue: { add: jest.Mock; addBulk: jest.Mock };
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let mockGuessRepo: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockSolvePromptRepo: {
    count: jest.Mock;
    find: jest.Mock;
  };
  let mockLlmProposalRepo: {
    find: jest.Mock;
  };
  let mockGameService: {
    resolveDateToPuzzleId: jest.Mock;
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
    };
    mockOpenAIQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
    };
    mockOllamaQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
    };
    mockStrategyRunRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    mockPuzzleRepo = {
      findOne: jest.fn(),
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
    };
    mockLlmProposalRepo = {
      find: jest.fn().mockResolvedValue([]),
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
        },
        { jobId: "run-100-order-0" },
      );
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
        },
        { jobId: "run-100-order-0" },
      );
    });

    it("should route llm-openai runs to the OpenAI queue", async () => {
      await service.triggerRun(100, "llm-openai", "2024-01-02");

      expect(mockOpenAIQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openai",
          date: "2024-01-02",
          trialNumber: 0,
        },
        { jobId: "run-100-llm-openai-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-ollama runs to the Ollama queue", async () => {
      await service.triggerRun(100, "llm-ollama", "2024-01-02");

      expect(mockOllamaQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-ollama",
          date: "2024-01-02",
          trialNumber: 0,
        },
        { jobId: "run-100-llm-ollama-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
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
          },
          opts: { jobId: "run-100-order-0" },
        },
      ]);
    });

    it("should queue one job per shuffle-smart trial", async () => {
      process.env.SHUFFLE_SMART_TRIALS = "3";
      try {
        await service.triggerStrategyRuns(100, "shuffle-smart", "2024-01-02");
      } finally {
        delete process.env.SHUFFLE_SMART_TRIALS;
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
          },
          opts: { jobId: "run-100-shuffle-smart-3" },
        },
      ]);
    });

    it("should queue one job per shuffle-foolish trial", async () => {
      process.env.SHUFFLE_FOOLISH_TRIALS = "2";
      try {
        await service.triggerStrategyRuns(100, "shuffle-foolish", "2024-01-02");
      } finally {
        delete process.env.SHUFFLE_FOOLISH_TRIALS;
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
          },
          opts: { jobId: "run-100-shuffle-foolish-2" },
        },
      ]);
    });

    it("should queue one job per llm-openai trial on the OpenAI queue", async () => {
      process.env.LLM_TRIALS = "2";
      try {
        await service.triggerStrategyRuns(100, "llm-openai", "2024-01-02");
      } finally {
        delete process.env.LLM_TRIALS;
      }

      expect(mockOpenAIQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOllamaQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.addBulk).toHaveBeenCalledWith([
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "llm-openai",
            date: "2024-01-02",
            trialNumber: 1,
          },
          opts: { jobId: "run-100-llm-openai-1" },
        },
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "llm-openai",
            date: "2024-01-02",
            trialNumber: 2,
          },
          opts: { jobId: "run-100-llm-openai-2" },
        },
      ]);
    });

    it("should queue one job per llm-ollama trial on the Ollama queue", async () => {
      process.env.LLM_TRIALS = "2";
      try {
        await service.triggerStrategyRuns(100, "llm-ollama", "2024-01-02");
      } finally {
        delete process.env.LLM_TRIALS;
      }

      expect(mockOllamaQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.addBulk).not.toHaveBeenCalled();
      expect(mockOllamaQueue.addBulk).toHaveBeenCalledWith([
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "llm-ollama",
            date: "2024-01-02",
            trialNumber: 1,
          },
          opts: { jobId: "run-100-llm-ollama-1" },
        },
        {
          name: "run-strategy",
          data: {
            puzzleId: 100,
            strategyName: "llm-ollama",
            date: "2024-01-02",
            trialNumber: 2,
          },
          opts: { jobId: "run-100-llm-ollama-2" },
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
        // such, still under the default duplicate limit of 3). The next draw
        // (random()=0.99) samples the pool tail [EGGPLANT, FIG, GRAPE, HONEY],
        // which is an answer group, and the leftover words solve the puzzle.
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

      it("should terminate with 'duplicate' once the duplicate limit is hit", async () => {
        // The duplicate limit defaults to 3; constant random()=0 makes every
        // draw the same non-answer group, so the third repeat ends the run.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(
          makePuzzle([
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            ["APPLE", "BANANA", "CHERRY", "DATE"],
          ]),
        );

        const result = await service.runDeterministicStrategy(100, "shuffle-foolish");

        expect(result).toEqual({
          status: StrategyRunStatus.DUPLICATE,
          guessCount: 4,
        });
        const inserted = mockManager.insert.mock.calls[0][1] as Array<{
          result: GuessResult;
        }>;
        // First draw is a fresh (off-by-one) guess; the next three repeats hit
        // the default duplicate limit of 3 and terminate the run.
        expect(inserted.map((g) => g.result)).toEqual([
          GuessResult.OFF_BY_ONE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
          GuessResult.DUPLICATE,
        ]);
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.DUPLICATE }),
        );
      });
    });
  });
});
