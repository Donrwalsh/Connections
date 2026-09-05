import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";
import { SolvePrompt, SolvePromptType } from "./entities/solve-prompt.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";

describe("StrategyRunStore", () => {
  let store: StrategyRunStore;
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock };
  let mockGuessRepo: { count: jest.Mock };
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };
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
    mockSolvePromptRepo = {
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
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
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
          modelName: null,
          contextWindow: null,
        });
      },
    );

    it("should set modelName from the given model when creating a new run", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
      const created = makeRun();
      mockStrategyRunRepo.create.mockReturnValueOnce(created);
      mockStrategyRunRepo.save.mockResolvedValueOnce(created);

      await store.loadOrCreateRun(100, "llm-openai", 0, "gpt-4.1-nano-2025-04-14");

      expect(mockStrategyRunRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ modelName: "gpt-4.1-nano-2025-04-14" }),
      );
    });

    it("should set contextWindow on a newly created run when given", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
      const created = makeRun();
      mockStrategyRunRepo.create.mockReturnValueOnce(created);
      mockStrategyRunRepo.save.mockResolvedValueOnce(created);

      await store.loadOrCreateRun(100, "llm-ollama", 0, "mistral-nemo", 131072);

      expect(mockStrategyRunRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextWindow: 131072 }),
      );
    });

    it("should leave contextWindow null when not given", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);
      const created = makeRun();
      mockStrategyRunRepo.create.mockReturnValueOnce(created);
      mockStrategyRunRepo.save.mockResolvedValueOnce(created);

      await store.loadOrCreateRun(100, "alphabetical");

      expect(mockStrategyRunRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextWindow: null }),
      );
    });

    it("should not overwrite an existing run's modelName when resuming", async () => {
      const existing = makeRun({ modelName: "gpt-4.1-nano-2025-04-14" });
      mockPuzzleRepo.findOne.mockResolvedValueOnce(puzzle);
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(existing);

      const result = await store.loadOrCreateRun(100, "llm-openai", 0, "gpt-5-nano");

      expect(result.run).toBe(existing);
      expect(mockStrategyRunRepo.create).not.toHaveBeenCalled();
    });
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

  describe("lastPromptNumber", () => {
    it("should return the highest promptNumber recorded for the strategy run", async () => {
      const getRawOne = jest.fn().mockResolvedValueOnce({ max: "5" });
      const where = jest.fn().mockReturnValue({ getRawOne });
      const select = jest.fn().mockReturnValue({ where });
      mockSolvePromptRepo.createQueryBuilder.mockReturnValueOnce({ select });

      const result = await store.lastPromptNumber(7);

      expect(result).toBe(5);
      expect(where).toHaveBeenCalledWith("prompt.strategyRunId = :strategyRunId", {
        strategyRunId: 7,
      });
    });

    it("should return 0 when the strategy run has no prompts yet", async () => {
      const getRawOne = jest.fn().mockResolvedValueOnce({ max: null });
      const where = jest.fn().mockReturnValue({ getRawOne });
      const select = jest.fn().mockReturnValue({ where });
      mockSolvePromptRepo.createQueryBuilder.mockReturnValueOnce({ select });

      const result = await store.lastPromptNumber(7);

      expect(result).toBe(0);
    });
  });

  describe("flushBatch", () => {
    it("should persist run state even when there are no new guesses", async () => {
      await store.flushBatch(makeRun() as StrategyRun, []);

      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockManager.insert).not.toHaveBeenCalled();
      expect(mockManager.save).toHaveBeenCalledWith(StrategyRun, expect.anything());
    });

    it("should insert SolvePrompt rows before proposals and resolve promptNumber to solvePromptId", async () => {
      mockManager.insert
        .mockResolvedValueOnce({ identifiers: [{ id: 10 }, { id: 11 }] }) // SolvePrompt
        .mockResolvedValueOnce({ identifiers: [{ id: 20 }] }); // Guess

      const prompts = [
        { strategyRunId: 7, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE },
        { strategyRunId: 7, promptNumber: 2, promptType: SolvePromptType.RETRY },
      ];
      // flushBatch clears the pendingGuesses array it's given (length = 0),
      // so keep a separate reference for the post-flush assertion below
      // rather than re-reading guesses[0] after it's been emptied.
      const guess1 = { words: ["A", "B", "C", "D"], result: "success", sequenceNumber: 1 };
      const guesses = [guess1];
      const proposals = [
        {
          strategyRun: { id: 7 },
          promptNumber: 2,
          words: ["A", "B", "C", "D"],
          category: "test",
          status: LlmProposalStatus.USED,
          // Paired with its own guess by object identity, mirroring how the
          // LLM runner sets currentProposal.guess = newGuess.
          guess: guess1,
        },
      ];

      await store.flushBatch(
        makeRun() as StrategyRun,
        guesses as Partial<Guess>[],
        proposals as (Partial<import("./entities/llm-proposal.entity").LlmProposal> & {
          promptNumber?: number;
        })[],
        [...prompts],
      );

      // SolvePrompt inserted first
      expect(mockManager.insert.mock.calls[0][0]).toBe("SolvePrompt");
      expect(mockManager.insert.mock.calls[0][1]).toEqual(prompts);

      // Guess inserted second
      expect(mockManager.insert.mock.calls[1][0]).toBe("Guess");

      // LlmProposal inserted third with resolved solvePromptId and guessId
      expect(mockManager.insert.mock.calls[2][0]).toBe("LlmProposal");
      const insertedProposals = mockManager.insert.mock.calls[2][1];
      expect(insertedProposals[0]).toEqual({
        strategyRun: { id: 7 },
        words: ["A", "B", "C", "D"],
        category: "test",
        status: LlmProposalStatus.USED,
        guess: guess1,
        solvePromptId: 11,
        guessId: 20,
      });
    });
  });

  describe("deleteRun", () => {
    it("should throw NotFoundException when the run does not exist", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(null);

      await expect(store.deleteRun(999)).rejects.toThrow(
        new NotFoundException("No strategy run with id: 999"),
      );
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should throw ConflictException when the run is still running", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ status: StrategyRunStatus.RUNNING }),
      );

      await expect(store.deleteRun(7)).rejects.toThrow(ConflictException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it("should delete the run's guesses and judging data before the run itself, and return each table's deleted count", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ status: StrategyRunStatus.ERROR }),
      );
      mockManager.count
        .mockResolvedValueOnce(3) // Guess
        .mockResolvedValueOnce(5) // SolvePrompt
        .mockResolvedValueOnce(2) // LlmProposal
        .mockResolvedValueOnce(4); // CategoryEvaluation

      const result = await store.deleteRun(7);

      expect(result).toEqual({
        deletedGuesses: 3,
        deletedSolvePrompts: 5,
        deletedLlmProposals: 2,
        deletedCategoryEvaluations: 4,
      });
      expect(mockManager.count).toHaveBeenNthCalledWith(1, Guess, { where: { strategyRunId: 7 } });
      expect(mockManager.count).toHaveBeenNthCalledWith(2, SolvePrompt, {
        where: { strategyRunId: 7 },
      });
      expect(mockManager.count).toHaveBeenNthCalledWith(3, LlmProposal, {
        where: { strategyRunId: 7 },
      });
      expect(mockManager.count).toHaveBeenNthCalledWith(4, CategoryEvaluation, {
        where: { strategyRunId: 7 },
      });
      // CategoryEvaluation and Guess must be deleted before StrategyRun:
      // Guess.strategyRunId is ON DELETE SET NULL (deleting the run first
      // would orphan them, not remove them), and CategoryEvaluation is
      // deleted explicitly — rather than left to its ON DELETE CASCADE — so
      // the teardown is auditable via the returned count.
      expect(mockManager.delete).toHaveBeenNthCalledWith(1, CategoryEvaluation, {
        strategyRunId: 7,
      });
      expect(mockManager.delete).toHaveBeenNthCalledWith(2, Guess, { strategyRunId: 7 });
      expect(mockManager.delete).toHaveBeenNthCalledWith(3, StrategyRun, { id: 7 });
    });
  });

  describe("deleteErroredRuns", () => {
    it("should return zeroed totals when no run has error status", async () => {
      mockManager.find.mockResolvedValueOnce([]);

      const result = await store.deleteErroredRuns();

      expect(result).toEqual({
        deletedRuns: 0,
        deletedGuesses: 0,
        deletedSolvePrompts: 0,
        deletedLlmProposals: 0,
        deletedCategoryEvaluations: 0,
      });
      expect(mockManager.find).toHaveBeenCalledWith(StrategyRun, {
        where: { status: StrategyRunStatus.ERROR },
        select: { id: true },
      });
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("should tear down every error run and aggregate each table's deleted count", async () => {
      mockManager.find.mockResolvedValueOnce([{ id: 11 }, { id: 22 }]);
      mockManager.count
        // run 11: Guess, SolvePrompt, LlmProposal, CategoryEvaluation
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4)
        // run 22
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(40);

      const result = await store.deleteErroredRuns();

      expect(result).toEqual({
        deletedRuns: 2,
        deletedGuesses: 11,
        deletedSolvePrompts: 22,
        deletedLlmProposals: 33,
        deletedCategoryEvaluations: 44,
      });
      expect(mockManager.delete).toHaveBeenCalledWith(StrategyRun, { id: 11 });
      expect(mockManager.delete).toHaveBeenCalledWith(StrategyRun, { id: 22 });
    });
  });
});
