import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";

describe("StrategyRunStore", () => {
  let store: StrategyRunStore;
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock };
  let mockGuessRepo: { count: jest.Mock };
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
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
      ],
    }).compile();

    store = module.get<StrategyRunStore>(StrategyRunStore);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
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

      const result = await store.loadOrCreateRun(100, "alphabetical");

      expect(result.run).toBe(existing);
      expect(result.puzzle).toBe(puzzle);
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
      expect(mockStrategyRunRepo.create).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException when the puzzle does not exist", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(store.loadOrCreateRun(999, "alphabetical")).rejects.toThrow(
        new NotFoundException("No puzzle with id: 999"),
      );
    });

    it.each([
      ["order", ["A", "B", "C"]],
      ["shuffle-smart", ["A", "B", "C"]],
      ["shuffle-foolish", ["A", "B", "C"]],
      ["llm-openai", ["A", "B", "C"]],
      ["llm-ollama", ["A", "B", "C"]],
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

        const result = await store.loadOrCreateRun(100, strategyName);

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

      const result = await store.countGuesses(7);

      expect(result).toBe(12);
      expect(mockGuessRepo.count).toHaveBeenCalledWith({
        where: { strategyRunId: 7 },
      });
    });
  });

  describe("flushBatch", () => {
    it("should persist run state even when there are no new guesses", async () => {
      await store.flushBatch(makeRun() as StrategyRun, []);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalledWith(StrategyRun, expect.anything());
    });
  });
});
