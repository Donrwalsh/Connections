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

describe("StrategyService", () => {
  let service: StrategyService;
  let mockQueue: { add: jest.Mock };
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let mockGuessRepo: { count: jest.Mock; find: jest.Mock };
  let mockGameService: {
    isValidYYYYMMDD: jest.Mock;
    puzzleDateToId: jest.Mock;
    evaluateGuess: jest.Mock;
  };
  let mockManager: { insert: jest.Mock; save: jest.Mock };
  let mockDataSource: { transaction: jest.Mock };

  const makeRun = (overrides: Partial<StrategyRun> = {}) => ({
    id: 7,
    puzzleId: 100,
    strategyName: "alphabetical",
    status: StrategyRunStatus.RUNNING,
    availableWords: [
      "APPLE",
      "BANANA",
      "CHERRY",
      "DATE",
      "EGGPLANT",
      "FIG",
      "GRAPE",
      "HONEY",
    ],
    currentCombination: [0, 1, 2, 3],
    finishedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
    mockStrategyRunRepo = {
      findOne: jest.fn(),
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
    };
    mockGameService = {
      isValidYYYYMMDD: jest.fn(),
      puzzleDateToId: jest.fn(),
      evaluateGuess: jest.fn(),
    };
    mockManager = {
      insert: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(mockManager),
      ),
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
      ],
    }).compile();

    service = module.get<StrategyService>(StrategyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("triggerRun", () => {
    it("should enqueue a run-strategy job with date", async () => {
      await service.triggerRun(100, "order", "2024-01-02");

      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 100,
        strategyName: "order",
        date: "2024-01-02",
      });
    });

    it("should enqueue a run-strategy job without a date", async () => {
      await service.triggerRun(100, "order");

      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 100,
        strategyName: "order",
        date: undefined,
      });
    });
  });

  describe("getRunDetail", () => {
    it("should throw BadRequestException for an invalid date", async () => {
      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(false);

      await expect(
        service.getRunDetail("2024-13-40", "alphabetical"),
      ).rejects.toThrow(BadRequestException);
      expect(mockGameService.puzzleDateToId).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when the run does not exist", async () => {
      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(true);
      mockGameService.puzzleDateToId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getRunDetail("2024-01-02", "alphabetical"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should map the run and its guesses into a detail DTO", async () => {
      const startedAt = new Date("2024-01-02T01:00:00Z");
      const guessedAt = new Date("2024-01-02T01:01:00Z");

      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(true);
      mockGameService.puzzleDateToId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce({
        id: 9,
        strategyName: "order",
        status: StrategyRunStatus.COMPLETED,
        startedAt,
        finishedAt: new Date("2024-01-02T02:00:00Z"),
      });
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
        strategyName: "order",
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
      });
      expect(mockGuessRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 9 },
        order: { sequenceNumber: "ASC" },
      });
    });
  });

  describe("getUnfinishedPuzzles", () => {
    it("should normalize date values from raw rows", async () => {
      mockPuzzleRepo.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { id: 5, date: new Date("2024-01-02T00:00:00.000Z") },
          { id: "6", date: "2024-01-03T12:30:00.000Z" },
        ]),
      });

      const result = await service.getUnfinishedPuzzles(
        "2024-01-01",
        "2024-01-07",
        "alphabetical",
      );

      expect(result).toEqual([
        { id: 5, date: "2024-01-02" },
        { id: 6, date: "2024-01-03" },
      ]);
      expect(mockPuzzleRepo.createQueryBuilder).toHaveBeenCalledWith("puzzle");
    });

    it("should build the query with the strategy and completion filters", async () => {
      const leftJoin = jest.fn().mockReturnThis();
      const where = jest.fn().mockReturnThis();
      const andWhere = jest.fn().mockReturnThis();
      mockPuzzleRepo.createQueryBuilder.mockReturnValue({
        leftJoin,
        where,
        andWhere,
        select: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      await service.getUnfinishedPuzzles(
        "2024-01-01",
        "2024-01-07",
        "order",
      );

      expect(leftJoin).toHaveBeenCalledWith(
        "StrategyRun",
        "run",
        "run.puzzleId = puzzle.id AND run.strategyName = :strategyName",
        { strategyName: "order" },
      );
      expect(where).toHaveBeenCalledWith(
        "puzzle.date BETWEEN :startDateStr AND :endDateStr",
        { startDateStr: "2024-01-01", endDateStr: "2024-01-07" },
      );
      expect(andWhere).toHaveBeenCalledWith(
        "(run.id IS NULL OR run.status != :completedStatus)",
        { completedStatus: StrategyRunStatus.COMPLETED },
      );
    });
  });

  describe("runDeterministicStrategy", () => {
    it("should short-circuit for an already completed run", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ status: StrategyRunStatus.COMPLETED }),
      );
      mockGuessRepo.count.mockResolvedValueOnce(42);

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.COMPLETED,
        guessCount: 42,
      });
      expect(mockGameService.evaluateGuess).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should solve a running puzzle with consecutive successful guesses", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(makeRun());
      mockGameService.evaluateGuess.mockResolvedValue({
        result: GuessResult.SUCCESS,
      });

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.COMPLETED,
        guessCount: 2,
      });
      expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(1, 100, [
        "APPLE",
        "BANANA",
        "CHERRY",
        "DATE",
      ]);
      expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(2, 100, [
        "EGGPLANT",
        "FIG",
        "GRAPE",
        "HONEY",
      ]);
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
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
      mockGameService.evaluateGuess.mockResolvedValue({
        result: GuessResult.FAILURE,
      });

      const result = await service.runDeterministicStrategy(100, "alphabetical");

      expect(result).toEqual({
        status: StrategyRunStatus.FAILED,
        guessCount: 70, // C(8, 4)
      });
      expect(mockGameService.evaluateGuess).toHaveBeenCalledTimes(70);
      // One flush at the 50-guess batch limit, one at completion.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
      expect(mockManager.insert).toHaveBeenNthCalledWith(1, "Guess", expect.any(Array));
      expect(mockManager.insert).toHaveBeenNthCalledWith(2, "Guess", expect.any(Array));
    });

    it("should throw BadRequestException for an unsupported strategy", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ strategyName: "bogus" }),
      );

      await expect(
        service.runDeterministicStrategy(100, "bogus"),
      ).rejects.toThrow(new BadRequestException("Unsupported strategy name: 'bogus'"));
      expect(mockGameService.evaluateGuess).not.toHaveBeenCalled();
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

    it("should return the existing run when one is found", async () => {
      const existing = makeRun();
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(existing);

      const result = await (
        service as unknown as {
          loadOrCreateRun(id: number, name: string): Promise<StrategyRun>;
        }
      ).loadOrCreateRun(100, "alphabetical");

      expect(result).toBe(existing);
      expect(mockStrategyRunRepo.create).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when the puzzle does not exist", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        (
          service as unknown as {
            loadOrCreateRun(id: number, name: string): Promise<StrategyRun>;
          }
        ).loadOrCreateRun(999, "alphabetical"),
      ).rejects.toThrow(new NotFoundException("No puzzle with id: 999"));
    });

    it.each([
      ["order", ["A", "B", "C"]],
      ["reverse-order", ["C", "B", "A"]],
      ["reverse-alphabetical", ["C", "B", "A"]],
      ["alphabetical", ["A", "B", "C"]],
    ])(
      "should build the word pool in %s order when creating a new run",
      async (strategyName, expectedWords) => {
        mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
        mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
        const created = makeRun();
        mockStrategyRunRepo.create.mockReturnValueOnce(created);
        mockStrategyRunRepo.save.mockResolvedValueOnce(created);

        const result = await (
          service as unknown as {
            loadOrCreateRun(id: number, name: string): Promise<StrategyRun>;
          }
        ).loadOrCreateRun(100, strategyName);

        expect(result).toBe(created);
        expect(mockStrategyRunRepo.create).toHaveBeenCalledWith({
          puzzle,
          strategyName,
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
        where: { strategyRun: { id: 7 } },
      });
    });
  });

  describe("flushBatch", () => {
    it("should be a no-op for an empty batch", async () => {
      await (
        service as unknown as {
          flushBatch(
            run: Partial<StrategyRun>,
            guesses: unknown[],
          ): Promise<void>;
        }
      ).flushBatch(makeRun(), []);

      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
