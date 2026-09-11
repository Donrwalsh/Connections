import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DeterministicSolver } from "./deterministic-solver.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";

describe("DeterministicSolver", () => {
  let service: DeterministicSolver;
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
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
  let mockManager: {
    insert: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
  };
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
    mockStrategyRunRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
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
    // Only needed to satisfy StrategyRunStore's constructor — the
    // deterministic-solve path never calls lastPromptNumber.
    mockSolvePromptRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    mockManager = {
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 1 }] }),
      save: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeterministicSolver,
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
      ],
    }).compile();

    service = module.get<DeterministicSolver>(DeterministicSolver);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
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
