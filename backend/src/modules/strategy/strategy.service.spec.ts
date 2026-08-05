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
    find: jest.Mock;
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
    trialNumber: 0,
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
    jest.restoreAllMocks();
  });

  describe("triggerRun", () => {
    it("should enqueue a run-strategy job with date", async () => {
      await service.triggerRun(100, "order", "2024-01-02");

      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 100,
        strategyName: "order",
        date: "2024-01-02",
        trialNumber: 0,
      });
    });

    it("should enqueue a run-strategy job without a date", async () => {
      await service.triggerRun(100, "order");

      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 100,
        strategyName: "order",
        date: undefined,
        trialNumber: 0,
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
        trialNumber: 0,
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
      });
      expect(mockGuessRepo.find).toHaveBeenCalledWith({
        where: { strategyRunId: 9 },
        order: { sequenceNumber: "ASC" },
      });
    });
  });

  describe("getRunsForPuzzle", () => {
    it("should throw BadRequestException for an invalid date", async () => {
      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(false);

      await expect(
        service.getRunsForPuzzle("2024-13-40", "shuffle-smart"),
      ).rejects.toThrow(BadRequestException);
      expect(mockGameService.puzzleDateToId).not.toHaveBeenCalled();
    });

    it("should return an empty list when no runs exist", async () => {
      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(true);
      mockGameService.puzzleDateToId.mockResolvedValueOnce(5);
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      const result = await service.getRunsForPuzzle(
        "2024-01-02",
        "shuffle-smart",
      );

      expect(result).toEqual([]);
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 5, strategyName: "shuffle-smart" },
        order: { trialNumber: "ASC" },
      });
    });

    it("should map every trial run ordered by trialNumber", async () => {
      const startedAt = new Date("2024-01-02T01:00:00Z");
      const guessedAt = new Date("2024-01-02T01:01:00Z");

      mockGameService.isValidYYYYMMDD.mockReturnValueOnce(true);
      mockGameService.puzzleDateToId.mockResolvedValueOnce(5);
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
      mockGuessRepo.find
        .mockResolvedValueOnce([
          {
            sequenceNumber: 1,
            words: ["A", "B", "C", "D"],
            result: GuessResult.FAILURE,
            guessedAt,
          },
        ])
        .mockResolvedValueOnce([
          {
            sequenceNumber: 1,
            words: ["E", "F", "G", "H"],
            result: GuessResult.SUCCESS,
            guessedAt,
          },
        ]);

      const result = await service.getRunsForPuzzle(
        "2024-01-02",
        "shuffle-smart",
      );

      expect(result.map((r) => r.trialNumber)).toEqual([2, 1]);
      expect(result[0]).toEqual({
        id: 9,
        strategyName: "shuffle-smart",
        trialNumber: 2,
        status: StrategyRunStatus.FAILED,
        startedAt,
        finishedAt: new Date("2024-01-02T02:00:00Z"),
        guesses: [
          {
            sequenceNumber: 1,
            words: ["A", "B", "C", "D"],
            result: GuessResult.FAILURE,
            guessedAt,
          },
        ],
      });
      expect(result[1].guesses[0].words).toEqual(["E", "F", "G", "H"]);
      expect(mockGuessRepo.find).toHaveBeenNthCalledWith(1, {
        where: { strategyRunId: 9 },
        order: { sequenceNumber: "ASC" },
      });
      expect(mockGuessRepo.find).toHaveBeenNthCalledWith(2, {
        where: { strategyRunId: 8 },
        order: { sequenceNumber: "ASC" },
      });
    });
  });

  describe("triggerStrategyRuns", () => {
    it("should queue a single trial for deterministic strategies", async () => {
      await service.triggerStrategyRuns(100, "order", "2024-01-02");

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 100,
        strategyName: "order",
        date: "2024-01-02",
        trialNumber: 0,
      });
    });

    it("should queue one job per shuffle-smart trial", async () => {
      process.env.SHUFFLE_SMART_TRIALS = "3";
      try {
        await service.triggerStrategyRuns(100, "shuffle-smart", "2024-01-02");
      } finally {
        delete process.env.SHUFFLE_SMART_TRIALS;
      }

      expect(mockQueue.add).toHaveBeenCalledTimes(3);
      expect(mockQueue.add).toHaveBeenNthCalledWith(1, "run-strategy", {
        puzzleId: 100,
        strategyName: "shuffle-smart",
        date: "2024-01-02",
        trialNumber: 1,
      });
      expect(mockQueue.add).toHaveBeenNthCalledWith(2, "run-strategy", {
        puzzleId: 100,
        strategyName: "shuffle-smart",
        date: "2024-01-02",
        trialNumber: 2,
      });
      expect(mockQueue.add).toHaveBeenNthCalledWith(3, "run-strategy", {
        puzzleId: 100,
        strategyName: "shuffle-smart",
        date: "2024-01-02",
        trialNumber: 3,
      });
    });

    it("should queue one job per shuffle-foolish trial", async () => {
      process.env.SHUFFLE_FOOLISH_TRIALS = "2";
      try {
        await service.triggerStrategyRuns(
          100,
          "shuffle-foolish",
          "2024-01-02",
        );
      } finally {
        delete process.env.SHUFFLE_FOOLISH_TRIALS;
      }

      expect(mockQueue.add).toHaveBeenCalledTimes(2);
      expect(mockQueue.add).toHaveBeenNthCalledWith(1, "run-strategy", {
        puzzleId: 100,
        strategyName: "shuffle-foolish",
        date: "2024-01-02",
        trialNumber: 1,
      });
      expect(mockQueue.add).toHaveBeenNthCalledWith(2, "run-strategy", {
        puzzleId: 100,
        strategyName: "shuffle-foolish",
        date: "2024-01-02",
        trialNumber: 2,
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
        distinct: jest.fn().mockReturnThis(),
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
        distinct: jest.fn().mockReturnThis(),
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

    describe("shuffle-smart strategy", () => {
      beforeEach(() => {
        mockStrategyRunRepo.findOne.mockResolvedValue(makeRun());
        mockGuessRepo.find.mockResolvedValue([]);
        mockGuessRepo.count.mockResolvedValue(0);
      });

      it("should solve a puzzle by sampling random groups", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockGameService.evaluateGuess.mockResolvedValue({
          result: GuessResult.SUCCESS,
        });

        const result = await service.runDeterministicStrategy(
          100,
          "shuffle-smart",
        );

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 2,
        });
        // random()=0 picks pool tail first ([FIG, GRAPE, HONEY, APPLE]), then
        // the remaining 4 words after that group is removed.
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(1, 100, [
          "FIG",
          "GRAPE",
          "HONEY",
          "APPLE",
        ]);
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(2, 100, [
          "CHERRY",
          "DATE",
          "EGGPLANT",
          "BANANA",
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
        mockGuessRepo.find.mockResolvedValue([
          { words: ["FIG", "GRAPE", "HONEY", "APPLE"] },
        ]);
        mockGuessRepo.count.mockResolvedValueOnce(1);

        const randomValues = [0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99];
        jest
          .spyOn(Math, "random")
          .mockImplementation(() => randomValues.shift() ?? 0.5);
        mockGameService.evaluateGuess.mockResolvedValue({
          result: GuessResult.SUCCESS,
        });

        const result = await service.runDeterministicStrategy(
          100,
          "shuffle-smart",
        );

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 3,
        });
        expect(mockGameService.evaluateGuess).toHaveBeenCalledTimes(2);
        // First sample ([FIG, GRAPE, HONEY, APPLE]) is in the tried set, so the
        // strategy must skip it and submit a fresh group instead.
        const firstGuess = mockGameService.evaluateGuess.mock.calls[0][1] as
          string[];
        expect(new Set(firstGuess)).not.toEqual(
          new Set(["FIG", "GRAPE", "HONEY", "APPLE"]),
        );
        expect(new Set(firstGuess)).toEqual(
          new Set(["EGGPLANT", "FIG", "GRAPE", "HONEY"]),
        );
      });

      it("should fail the run once no fresh group can be sampled", async () => {
        // Constant random() means the same group is sampled every time; after
        // the first guess it is always in the tried set, so sampling gives up.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockGameService.evaluateGuess.mockResolvedValue({
          result: GuessResult.FAILURE,
        });

        const result = await service.runDeterministicStrategy(
          100,
          "shuffle-smart",
        );

        expect(result).toEqual({
          status: StrategyRunStatus.FAILED,
          guessCount: 1,
        });
        expect(mockGameService.evaluateGuess).toHaveBeenCalledTimes(1);
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
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockGameService.evaluateGuess.mockResolvedValue({
          result: GuessResult.SUCCESS,
        });

        const result = await service.runDeterministicStrategy(
          100,
          "shuffle-foolish",
        );

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 2,
        });
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(1, 100, [
          "FIG",
          "GRAPE",
          "HONEY",
          "APPLE",
        ]);
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(2, 100, [
          "CHERRY",
          "DATE",
          "EGGPLANT",
          "BANANA",
        ]);
        // Unlike shuffle-smart, no tried set is loaded from prior guesses.
        expect(mockGuessRepo.find).not.toHaveBeenCalled();
      });

      it("should allow the same group to be guessed more than once", async () => {
        // Constant random() keeps sampling the same pool tail. A failure leaves
        // the pool untouched, so the exact same group is guessed twice.
        jest.spyOn(Math, "random").mockReturnValue(0);
        mockGameService.evaluateGuess
          .mockResolvedValueOnce({ result: GuessResult.FAILURE })
          .mockResolvedValue({ result: GuessResult.SUCCESS });

        const result = await service.runDeterministicStrategy(
          100,
          "shuffle-foolish",
        );

        expect(result).toEqual({
          status: StrategyRunStatus.COMPLETED,
          guessCount: 3,
        });
        expect(mockGameService.evaluateGuess).toHaveBeenCalledTimes(3);
        // The first two guesses are the exact same group.
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(1, 100, [
          "FIG",
          "GRAPE",
          "HONEY",
          "APPLE",
        ]);
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(2, 100, [
          "FIG",
          "GRAPE",
          "HONEY",
          "APPLE",
        ]);
        expect(mockGameService.evaluateGuess).toHaveBeenNthCalledWith(3, 100, [
          "CHERRY",
          "DATE",
          "EGGPLANT",
          "BANANA",
        ]);
        expect(mockGuessRepo.find).not.toHaveBeenCalled();
      });
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
      ["shuffle-smart", ["A", "B", "C"]],
      ["shuffle-foolish", ["A", "B", "C"]],
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
