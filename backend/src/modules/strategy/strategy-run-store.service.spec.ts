import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";
import { SolvePrompt, SolvePromptType } from "./entities/solve-prompt.entity";
import { LlmProposalStatus } from "./entities/llm-proposal.entity";

describe("StrategyRunStore", () => {
  let store: StrategyRunStore;
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock };
  let mockGuessRepo: { count: jest.Mock };
  let mockSolvePromptRepo: { count: jest.Mock };
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
    mockSolvePromptRepo = {
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

  describe("countPrompts", () => {
    it("should count SolvePrompt rows scoped to the strategy run", async () => {
      mockSolvePromptRepo.count.mockResolvedValueOnce(5);

      const result = await store.countPrompts(7);

      expect(result).toBe(5);
      expect(mockSolvePromptRepo.count).toHaveBeenCalledWith({
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

    it("should insert SolvePrompt rows before proposals and resolve promptNumber to solvePromptId", async () => {
      mockManager.insert
        .mockResolvedValueOnce({ identifiers: [{ id: 10 }, { id: 11 }] }) // SolvePrompt
        .mockResolvedValueOnce({ identifiers: [{ id: 20 }] }); // Guess

      const prompts = [
        { strategyRunId: 7, promptNumber: 1, promptType: SolvePromptType.INITIAL_SOLVE },
        { strategyRunId: 7, promptNumber: 2, promptType: SolvePromptType.RETRY },
      ];
      const guesses = [
        { words: ["A", "B", "C", "D"], result: "success", sequenceNumber: 1 },
      ];
      const proposals = [
        {
          strategyRun: { id: 7 },
          promptNumber: 2,
          words: ["A", "B", "C", "D"],
          reasoning: "test",
          status: LlmProposalStatus.USED,
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
        reasoning: "test",
        status: LlmProposalStatus.USED,
        solvePromptId: 11,
        guessId: 20,
      });
    });
  });
});
