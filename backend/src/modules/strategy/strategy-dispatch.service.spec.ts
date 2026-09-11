import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  STRATEGY_QUEUE,
  LLM_OPENAI_QUEUE,
  LLM_OLLAMA_QUEUE,
  LLM_GOOGLE_QUEUE,
  LLM_GROQ_QUEUE,
  LLM_OPENROUTER_QUEUE,
  LLM_MISTRAL_QUEUE,
  LLM_SAMBANOVA_QUEUE,
} from "../queue/queue.module";
import { StrategyDispatch } from "./strategy-dispatch.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { StrategyRun, StrategyRunStatus } from "./entities/strategy-run.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { Guess } from "./entities/guess.entity";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { SupportedModelService } from "../supported-model/supported-model.service";

describe("StrategyDispatch", () => {
  let service: StrategyDispatch;
  let mockQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockOpenAIQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockOllamaQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockGoogleQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockGroqQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockOpenRouterQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockMistralQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockSambaNovaQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
  let mockStrategyRunRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockPuzzleRepo: { findOne: jest.Mock; count: jest.Mock; createQueryBuilder: jest.Mock };
  // Only needed to satisfy StrategyRunStore's constructor — none of these
  // tests exercise the Guess-repo path directly.
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
  let mockSupportedModelService: {
    assertSupported: jest.Mock;
    getDefaultModel: jest.Mock;
    findAll: jest.Mock;
    findPriceHistory: jest.Mock;
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
    mockGoogleQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockGroqQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockOpenRouterQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockMistralQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
    mockSambaNovaQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
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
    mockSolvePromptRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
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
      find: jest.fn().mockResolvedValue([]),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyDispatch,
        StrategyRunStore,
        { provide: DataSource, useValue: mockDataSource },
        { provide: STRATEGY_QUEUE, useValue: mockQueue },
        { provide: LLM_OPENAI_QUEUE, useValue: mockOpenAIQueue },
        { provide: LLM_OLLAMA_QUEUE, useValue: mockOllamaQueue },
        { provide: LLM_GOOGLE_QUEUE, useValue: mockGoogleQueue },
        { provide: LLM_GROQ_QUEUE, useValue: mockGroqQueue },
        { provide: LLM_OPENROUTER_QUEUE, useValue: mockOpenRouterQueue },
        { provide: LLM_MISTRAL_QUEUE, useValue: mockMistralQueue },
        { provide: LLM_SAMBANOVA_QUEUE, useValue: mockSambaNovaQueue },
        { provide: getRepositoryToken(StrategyRun), useValue: mockStrategyRunRepo },
        { provide: getRepositoryToken(Puzzle), useValue: mockPuzzleRepo },
        { provide: getRepositoryToken(Guess), useValue: mockGuessRepo },
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
      ],
    }).compile();

    service = module.get<StrategyDispatch>(StrategyDispatch);
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

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-ollama",
        "mistral",
      );
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

    it("should route llm-google runs to the Google queue after validating the model", async () => {
      await service.triggerRun(100, "llm-google", "2024-01-02", 0, "gemini-3.6-flash");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-google",
        "gemini-3.6-flash",
      );
      expect(mockGoogleQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-google",
          date: "2024-01-02",
          trialNumber: 0,
          model: "gemini-3.6-flash",
        },
        { jobId: "run-100-llm-google-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-groq runs to the Groq queue after validating the model", async () => {
      await service.triggerRun(100, "llm-groq", "2024-01-02", 0, "openai/gpt-oss-20b");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-groq",
        "openai/gpt-oss-20b",
      );
      expect(mockGroqQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-groq",
          date: "2024-01-02",
          trialNumber: 0,
          model: "openai/gpt-oss-20b",
        },
        { jobId: "run-100-llm-groq-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
      expect(mockGoogleQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-openrouter runs to the OpenRouter queue after validating the model", async () => {
      await service.triggerRun(100, "llm-openrouter", "2024-01-02", 0, "z-ai/glm-5.2:free");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-openrouter",
        "z-ai/glm-5.2:free",
      );
      expect(mockOpenRouterQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-openrouter",
          date: "2024-01-02",
          trialNumber: 0,
          model: "z-ai/glm-5.2:free",
        },
        { jobId: "run-100-llm-openrouter-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockGroqQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-mistral runs to the Mistral queue after validating the model", async () => {
      await service.triggerRun(100, "llm-mistral", "2024-01-02", 0, "mistral-small-latest");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-mistral",
        "mistral-small-latest",
      );
      expect(mockMistralQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-mistral",
          date: "2024-01-02",
          trialNumber: 0,
          model: "mistral-small-latest",
        },
        { jobId: "run-100-llm-mistral-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockGroqQueue.add).not.toHaveBeenCalled();
      expect(mockOpenRouterQueue.add).not.toHaveBeenCalled();
    });

    it("should route llm-sambanova runs to the SambaNova queue after validating the model", async () => {
      await service.triggerRun(100, "llm-sambanova", "2024-01-02", 0, "DeepSeek-V3.1");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-sambanova",
        "DeepSeek-V3.1",
      );
      expect(mockSambaNovaQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-sambanova",
          date: "2024-01-02",
          trialNumber: 0,
          model: "DeepSeek-V3.1",
        },
        { jobId: "run-100-llm-sambanova-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockMistralQueue.add).not.toHaveBeenCalled();
    });

    it("should not enqueue anything when the model is rejected", async () => {
      mockSupportedModelService.assertSupported.mockRejectedValueOnce(
        new BadRequestException(
          "Model 'bogus' is not a supported model for strategy 'llm-openai'.",
        ),
      );

      await expect(service.triggerRun(100, "llm-openai", "2024-01-02", 0, "bogus")).rejects.toThrow(
        BadRequestException,
      );
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
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

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-ollama",
        "mistral",
      );
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

    it("should queue exactly one new llm-google trial on the Google queue after validating the model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      await service.triggerStrategyRuns(100, "llm-google", "2024-01-02", "gemini-3.6-flash");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-google",
        "gemini-3.6-flash",
      );
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 100, strategyName: "llm-google" },
        select: { trialNumber: true, modelName: true },
      });
      expect(mockGoogleQueue.add).toHaveBeenCalledTimes(1);
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
      expect(mockGoogleQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-google",
          date: "2024-01-02",
          trialNumber: 1,
          model: "gemini-3.6-flash",
        },
        { jobId: "run-100-llm-google-1" },
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

      const result = await service.countTodayDispatchByModel("llm-openai", [
        "gpt-4.1-nano",
        "o3-mini",
      ]);

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

      const result = await service.countTodayDispatchByModel("llm-openai", [
        "gpt-4.1-nano",
        "o3-mini",
      ]);

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
  describe("countTodayLlmCalls", () => {
    it("counts SolvePrompt rows joined to the strategy's runs since UTC midnight", async () => {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(17),
      };
      mockSolvePromptRepo.createQueryBuilder.mockReturnValueOnce(qb);

      const n = await service.countTodayLlmCalls("llm-openrouter");

      expect(n).toBe(17);
      expect(qb.innerJoin).toHaveBeenCalledWith("sp.strategyRun", "run");
      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining("strategyName"), {
        strategyName: "llm-openrouter",
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("createdAt"),
        expect.objectContaining({ startOfTodayUtc: expect.any(Date) }),
      );
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
  describe("deleteRun", () => {
    it("should delegate to the run store and return its deleted counts", async () => {
      mockStrategyRunRepo.findOne.mockResolvedValueOnce(
        makeRun({ id: 7, status: StrategyRunStatus.ERROR }),
      );
      mockManager.count
        .mockResolvedValueOnce(3) // Guess
        .mockResolvedValueOnce(5) // SolvePrompt
        .mockResolvedValueOnce(2) // LlmProposal
        .mockResolvedValueOnce(4); // CategoryEvaluation

      const result = await service.deleteRun(7);

      expect(result).toEqual({
        deletedGuesses: 3,
        deletedSolvePrompts: 5,
        deletedLlmProposals: 2,
        deletedCategoryEvaluations: 4,
      });
      expect(mockStrategyRunRepo.findOne).toHaveBeenCalledWith({ where: { id: 7 } });
    });
  });
  describe("deleteErroredRuns", () => {
    it("should delegate to the run store and return its aggregated deleted counts", async () => {
      mockManager.find.mockResolvedValueOnce([{ id: 11 }]);
      mockManager.count
        .mockResolvedValueOnce(1) // Guess
        .mockResolvedValueOnce(2) // SolvePrompt
        .mockResolvedValueOnce(3) // LlmProposal
        .mockResolvedValueOnce(4); // CategoryEvaluation

      const result = await service.deleteErroredRuns();

      expect(result).toEqual({
        deletedRuns: 1,
        deletedGuesses: 1,
        deletedSolvePrompts: 2,
        deletedLlmProposals: 3,
        deletedCategoryEvaluations: 4,
      });
      expect(mockManager.find).toHaveBeenCalledWith(StrategyRun, {
        where: { status: StrategyRunStatus.ERROR },
        select: { id: true },
      });
    });
  });
  describe("countErroredRuns", () => {
    it("should count only runs in the error status, for the maintenance panel's button", async () => {
      mockStrategyRunRepo.count.mockResolvedValueOnce(5);

      const result = await service.countErroredRuns();

      expect(result).toEqual({ erroredRuns: 5 });
      expect(mockStrategyRunRepo.count).toHaveBeenCalledWith({
        where: { status: StrategyRunStatus.ERROR },
      });
    });
  });
});
