import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { StrategyService } from "./strategy.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { GameService } from "../game/game.service";
import { OrchestratorService, type SolveOutcome } from "./orchestrator.service";

describe("StrategyService", () => {
  let service: StrategyService;
  let mockQueue: { add: jest.Mock; addBulk: jest.Mock };
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
  let mockGameService: {
    resolveDateToPuzzleId: jest.Mock;
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
    mockOrchestratorService = {
      proposeGroup: jest.fn(),
    };
    mockManager = {
      insert: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: STRATEGY_QUEUE, useValue: mockQueue },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: GameService, useValue: mockGameService },
        { provide: OrchestratorService, useValue: mockOrchestratorService },
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

  describe("getGuessDetail", () => {
    it("should throw NotFoundException when the run does not exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getGuessDetail("2024-01-02", "llm", 0, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException when the guess does not exist", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm" }));
      mockGuessRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getGuessDetail("2024-01-02", "llm", 0, 99)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should look up the guess scoped to the run and sequence number", async () => {
      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm" }));
      mockGuessRepo.findOne.mockResolvedValueOnce({
        sequenceNumber: 1,
        words: ["APPLE", "BANANA", "CHERRY", "DATE"],
        result: GuessResult.SUCCESS,
        guessedAt: new Date("2024-01-02T01:01:00Z"),
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        latencyMs: 500,
        temperature: 1,
        numResponses: 1,
        promptAttempts: 1,
        duplicatesRejected: 0,
        llmDetails: { category: "Fruit", confidence: 0.9 },
      });

      await service.getGuessDetail("2024-01-02", "llm", 0, 1);

      expect(mockGuessRepo.findOne).toHaveBeenCalledWith({
        where: { strategyRunId: 7, sequenceNumber: 1 },
      });
    });

    it("should map the guess and its LLM telemetry into a detail DTO", async () => {
      const guessedAt = new Date("2024-01-02T01:01:00Z");

      mockGameService.resolveDateToPuzzleId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun({ strategyName: "llm" }));
      mockGuessRepo.findOne.mockResolvedValueOnce({
        sequenceNumber: 2,
        words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        result: GuessResult.DUPLICATE,
        guessedAt,
        promptTokens: 1027,
        completionTokens: 593,
        totalTokens: 1620,
        latencyMs: 5647,
        temperature: 1.2,
        numResponses: 3,
        promptAttempts: 2,
        duplicatesRejected: 1,
        llmDetails: {
          category: "Fruit",
          confidence: 0.9,
          reasoning: "test",
          prompt: "solve step",
        },
      });

      const result = await service.getGuessDetail("2024-01-02", "llm", 0, 2);

      expect(result).toEqual({
        sequenceNumber: 2,
        words: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        result: GuessResult.DUPLICATE,
        guessedAt,
        promptTokens: 1027,
        completionTokens: 593,
        totalTokens: 1620,
        latencyMs: 5647,
        temperature: 1.2,
        numResponses: 3,
        promptAttempts: 2,
        duplicatesRejected: 1,
        llmDetails: {
          category: "Fruit",
          confidence: 0.9,
          reasoning: "test",
          prompt: "solve step",
        },
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

    const success = (
      wordIds: number[],
      overrides: Partial<import("./orchestrator.service").SolveSuccess> = {},
    ): SolveOutcome => ({
      ok: true,
      data: {
        proposedGroups: [makeGroup(wordIds)],
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
      mockStrategyRunRepo.findOne.mockResolvedValue(makeRun({ strategyName: "llm" }));
      mockGuessRepo.find.mockResolvedValue([]);
      mockPuzzleRepo.findOne.mockResolvedValue(solvePuzzle);
    });

    it("should short-circuit for a terminal run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ strategyName: "llm", status: StrategyRunStatus.COMPLETED }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(5);

      const result = await service.runLlmStrategy(100, "llm");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 5 });
      expect(mockOrchestratorService.proposeGroup).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should solve a puzzle through iterative orchestrator calls", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await service.runLlmStrategy(100, "llm");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      expect(mockOrchestratorService.proposeGroup).toHaveBeenCalledTimes(2);
      const inserted = mockManager.insert.mock.calls.flatMap(
        (call) => call[1] as Array<Record<string, unknown>>,
      );
      expect(inserted).toHaveLength(2);
      expect(inserted[0]).toEqual(
        expect.objectContaining({
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          result: GuessResult.SUCCESS,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 500,
          temperature: 0,
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
    });

    it("should feed prior guess history back to the orchestrator", async () => {
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      await service.runLlmStrategy(100, "llm");

      expect(mockOrchestratorService.proposeGroup.mock.calls[0][0]).toEqual({
        puzzleWords: ["APPLE", "BANANA", "CHERRY", "DATE", "EGGPLANT", "FIG", "GRAPE", "HONEY"],
        priorGuesses: [],
        temperature: 0,
        numResponses: 1,
        temperatureStep: 0.032,
        maxTemperature: 3.2,
        maxNumResponses: 10,
        maxPrompts: 5,
      });
      // After the first group is solved, the second call sees the remaining
      // words and the solved group mapped to the orchestrator's 'correct'.
      expect(mockOrchestratorService.proposeGroup.mock.calls[1][0]).toEqual({
        puzzleWords: ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        priorGuesses: [{ words: ["APPLE", "BANANA", "CHERRY", "DATE"], result: "correct" }],
        temperature: 0,
        numResponses: 1,
        temperatureStep: 0.032,
        maxTemperature: 3.2,
        maxNumResponses: 10,
        maxPrompts: 5,
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

      const result = await service.runLlmStrategy(100, "llm");

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
      expect(firstCall.temperature).toBe(0);
      expect(mockGuessRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 7 },
        order: { sequenceNumber: "ASC" },
        select: { words: true, result: true },
      });
    });

    it("should hold onto the escalated temperature but reset the candidate count per step", async () => {
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

      await service.runLlmStrategy(100, "llm");

      const calls = mockOrchestratorService.proposeGroup.mock.calls;
      // The run starts at the base parameters.
      expect(calls[0][0]).toEqual(expect.objectContaining({ temperature: 0, numResponses: 1 }));
      // The first response escalated, so the second solve step starts from the
      // raised temperature, but the candidate count resets to base for each
      // fresh guess.
      expect(calls[1][0]).toEqual(expect.objectContaining({ temperature: 1.2, numResponses: 1 }));
      const inserted = mockManager.insert.mock.calls.flatMap(
        (call) => call[1] as Array<Record<string, unknown>>,
      );
      // The guess record still reports the escalated candidate count that
      // actually produced the guess.
      expect(inserted[0]).toEqual(
        expect.objectContaining({
          temperature: 1.2,
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

        const result = await service.runLlmStrategy(100, "llm");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 4 });
        const inserted = mockManager.insert.mock.calls.flatMap(
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
        // Escalation now lives in the orchestrator, so the backend sends the
        // same sticky parameters on every step.
        const temperatures = mockOrchestratorService.proposeGroup.mock.calls.map(
          (call) => (call[0] as { temperature: number }).temperature,
        );
        expect(temperatures).toEqual([0, 0, 0]);
        expect(mockManager.save).toHaveBeenCalledWith(
          StrategyRun,
          expect.objectContaining({ status: StrategyRunStatus.DUPLICATE }),
        );
      } finally {
        delete process.env.LLM_MAX_DUPLICATE_GUESSES;
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

        const result = await service.runLlmStrategy(100, "llm");

        expect(result).toEqual({ status: StrategyRunStatus.DUPLICATE, guessCount: 2 });
        const inserted = mockManager.insert.mock.calls.flatMap(
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

      const result = await service.runLlmStrategy(100, "llm");

      expect(result).toEqual({ status: StrategyRunStatus.COMPLETED, guessCount: 2 });
      const inserted = mockManager.insert.mock.calls.flatMap(
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

    it("should treat a success with no proposed group as malformed", async () => {
      mockOrchestratorService.proposeGroup.mockResolvedValue(
        success([0, 1, 2, 3], { proposedGroups: [] }),
      );

      const result = await service.runLlmStrategy(100, "llm");

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

      const result = await service.runLlmStrategy(100, "llm");

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
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      mockOrchestratorService.proposeGroup
        .mockResolvedValueOnce({
          ok: false,
          error: { error: "model is loading", code: "model_error" },
        })
        .mockResolvedValueOnce(success([0, 1, 2, 3]))
        .mockResolvedValueOnce(success([0, 1, 2, 3]));

      const result = await service.runLlmStrategy(100, "llm");

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
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      process.env.LLM_MAX_MODEL_ERRORS = "2";
      try {
        mockOrchestratorService.proposeGroup.mockResolvedValue({
          ok: false,
          error: { error: "ollama is down", code: "model_error" },
        });

        const result = await service.runLlmStrategy(100, "llm");

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

  describe("loadOrCreateRun", () => {
    const puzzle = {
      id: 100,
      answerGroups: [
        {
          members: [
            { word: "C", position: 2 },
            { word: "A", position: 0 },
          ],
        },
        {
          members: [{ word: "B", position: 1 }],
        },
      ],
    };

    it("should return the existing run with the loaded puzzle when one is found", async () => {
      const existing = makeRun();
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(existing);

      const result = await (
        service as unknown as {
          loadOrCreateRun(id: number, name: string): Promise<{ run: StrategyRun; puzzle: Puzzle }>;
        }
      ).loadOrCreateRun(100, "alphabetical");

      expect(result.run).toBe(existing);
      expect(result.puzzle).toBe(puzzle);
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
      expect(mockStrategyRunRepo.create).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when the puzzle does not exist", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        (
          service as unknown as {
            loadOrCreateRun(
              id: number,
              name: string,
            ): Promise<{ run: StrategyRun; puzzle: Puzzle }>;
          }
        ).loadOrCreateRun(999, "alphabetical"),
      ).rejects.toThrow(new NotFoundException("No puzzle with id: 999"));
    });

    it.each([
      ["order", ["A", "B", "C"]],
      ["shuffle-smart", ["A", "B", "C"]],
      ["shuffle-foolish", ["A", "B", "C"]],
      ["llm", ["A", "B", "C"]],
      ["reverse-order", ["C", "B", "A"]],
      ["reverse-alphabetical", ["C", "B", "A"]],
      ["alphabetical", ["A", "B", "C"]],
    ])(
      "should build the word pool in %s order when creating a new run",
      async (strategyName, expectedWords) => {
        mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
        const created = makeRun();
        mockStrategyRunRepo.create.mockReturnValueOnce(created);
        mockStrategyRunRepo.save.mockResolvedValueOnce(created);

        const result = await (
          service as unknown as {
            loadOrCreateRun(
              id: number,
              name: string,
            ): Promise<{ run: StrategyRun; puzzle: Puzzle }>;
          }
        ).loadOrCreateRun(100, strategyName);

        expect(result.run).toBe(created);
        expect(result.puzzle).toBe(puzzle);
        expect(mockStrategyRunRepo.create).toHaveBeenCalledWith({
          puzzle,
          strategyName,
          trialNumber: 0,
          status: StrategyRunStatus.RUNNING,
          availableWords: expectedWords,
          currentCombination: [0, 1, 2, 3],
        });
      },
    );
  });

  describe("countGuesses", () => {
    it("should count guesses scoped to the strategy run", async () => {
      mockGuessRepo.count.mockResolvedValueOnce(12);

      const result = await (
        service as unknown as { countGuesses(id: number): Promise<number> }
      ).countGuesses(7);

      expect(result).toBe(12);
      expect(mockGuessRepo.count).toHaveBeenCalledWith({
        where: { strategyRunId: 7 },
      });
    });
  });

  describe("flushBatch", () => {
    it("should persist run state even when there are no new guesses", async () => {
      await (
        service as unknown as {
          flushBatch(run: Partial<StrategyRun>, guesses: unknown[]): Promise<void>;
        }
      ).flushBatch(makeRun(), []);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalledWith(StrategyRun, expect.anything());
    });
  });
});
