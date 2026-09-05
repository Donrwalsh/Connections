import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";
import { SupportedModelService } from "../supported-model/supported-model.service";

const FLAGSHIP_MODELS = ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"];
const MINI_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o3-mini",
  "o4-mini",
  "gpt-5-nano",
];

describe("FreeTierUsageService", () => {
  let service: FreeTierUsageService;
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };
  let mockCategoryEvaluationRepo: { createQueryBuilder: jest.Mock };
  let mockSupportedModelService: { findModelNamesByFreeTier: jest.Mock };

  function makeQb(totalTokens: string | null) {
    return {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(totalTokens === null ? undefined : { totalTokens }),
    };
  }

  // Stubs both token sums getUsage runs: SolvePrompt (solve-step tokens) and
  // CategoryEvaluation (category-judge call tokens). judgeTokens defaults to
  // "0" so the pre-existing SolvePrompt-only assertions are unaffected.
  function mockUsageQuery(promptTokens: string | null, judgeTokens: string | null = "0") {
    const prompt = makeQb(promptTokens);
    const judge = makeQb(judgeTokens);
    mockSolvePromptRepo.createQueryBuilder.mockReturnValue(prompt);
    mockCategoryEvaluationRepo.createQueryBuilder.mockReturnValue(judge);
    return { prompt, judge };
  }

  beforeEach(async () => {
    mockSolvePromptRepo = { createQueryBuilder: jest.fn() };
    mockCategoryEvaluationRepo = { createQueryBuilder: jest.fn() };
    mockSupportedModelService = {
      findModelNamesByFreeTier: jest
        .fn()
        .mockImplementation(async (tier: string) =>
          tier === "flagship" ? [...FLAGSHIP_MODELS] : [...MINI_MODELS],
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierUsageService,
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
        { provide: getRepositoryToken(CategoryEvaluation), useValue: mockCategoryEvaluationRepo },
        { provide: SupportedModelService, useValue: mockSupportedModelService },
      ],
    }).compile();

    service = module.get<FreeTierUsageService>(FreeTierUsageService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe("getFlagshipUsage", () => {
    it("should query only the flagship program's models, joined through the run", async () => {
      const { prompt: qb } = mockUsageQuery("1000");

      await service.getFlagshipUsage();

      expect(mockSupportedModelService.findModelNamesByFreeTier).toHaveBeenCalledWith("flagship");
      expect(mockSolvePromptRepo.createQueryBuilder).toHaveBeenCalledWith("prompt");
      expect(qb.innerJoin).toHaveBeenCalledWith("prompt.strategyRun", "run");
      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", {
        models: FLAGSHIP_MODELS,
      });
    });

    it("should return used/limit/remaining, tier id, and label for the 250k budget", async () => {
      mockUsageQuery("62340");

      const result = await service.getFlagshipUsage();

      expect(result).toEqual({
        tier: "flagship",
        label: "Flagship models",
        usedTokens: 62340,
        dailyLimitTokens: 250_000,
        remainingTokens: 187_660,
        models: FLAGSHIP_MODELS,
      });
    });

    it("should clamp remainingTokens to zero once usage exceeds the daily limit", async () => {
      mockUsageQuery("300000");

      const result = await service.getFlagshipUsage();

      expect(result.usedTokens).toBe(300_000);
      expect(result.remainingTokens).toBe(0);
    });
  });

  describe("getMiniUsage", () => {
    it("should query only the mini program's models, a disjoint set from the flagship program", async () => {
      const { prompt: qb } = mockUsageQuery("1000");

      await service.getMiniUsage();

      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", {
        models: MINI_MODELS,
      });
      expect(MINI_MODELS.some((model) => FLAGSHIP_MODELS.includes(model))).toBe(false);
    });

    it("should return used/limit/remaining, tier id, and label for the 2.5M budget", async () => {
      mockUsageQuery("500000");

      const result = await service.getMiniUsage();

      expect(result.tier).toBe("mini");
      expect(result.label).toBe("Mini & nano models");
      expect(result.usedTokens).toBe(500_000);
      expect(result.dailyLimitTokens).toBe(2_500_000);
      expect(result.remainingTokens).toBe(2_000_000);
    });
  });

  it("should scope the query to tokens spent since UTC midnight today", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-18T15:30:00.000Z"));
    const { prompt: qb } = mockUsageQuery("0");

    await service.getFlagshipUsage();

    expect(qb.andWhere).toHaveBeenCalledWith("prompt.createdAt >= :startOfTodayUtc", {
      startOfTodayUtc: new Date("2026-08-18T00:00:00.000Z"),
    });
  });

  it("should treat no matching rows as zero tokens used", async () => {
    mockUsageQuery(null, null);

    const result = await service.getFlagshipUsage();

    expect(result.usedTokens).toBe(0);
    expect(result.remainingTokens).toBe(250_000);
  });

  describe("category-judge call tokens", () => {
    it("adds category-judge call tokens for the tier's models to the solve-step total", async () => {
      mockUsageQuery("500000", "40000");

      const result = await service.getMiniUsage();

      expect(result.usedTokens).toBe(540_000);
      expect(result.remainingTokens).toBe(2_500_000 - 540_000);
    });

    it("sums CategoryEvaluation.totalTokens for the tier's judge models since UTC midnight", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-08-18T15:30:00.000Z"));
      const { judge } = mockUsageQuery("0", "0");

      await service.getMiniUsage();

      expect(mockCategoryEvaluationRepo.createQueryBuilder).toHaveBeenCalledWith("evaluation");
      expect(judge.where).toHaveBeenCalledWith("evaluation.judgeModel IN (:...models)", {
        models: MINI_MODELS,
      });
      expect(judge.andWhere).toHaveBeenCalledWith("evaluation.evaluatedAt >= :startOfTodayUtc", {
        startOfTodayUtc: new Date("2026-08-18T00:00:00.000Z"),
      });
      expect(judge.select).toHaveBeenCalledWith(
        "COALESCE(SUM(evaluation.totalTokens), 0)",
        "totalTokens",
      );
    });

    it("counts judge tokens even when the tier has no solve-step tokens", async () => {
      mockUsageQuery(null, "12345");

      const result = await service.getMiniUsage();

      expect(result.usedTokens).toBe(12_345);
    });
  });

  it("should skip the DB query entirely and return a zero-usage DTO when the tier has no models configured", async () => {
    mockSupportedModelService.findModelNamesByFreeTier.mockResolvedValueOnce([]);

    const result = await service.getFlagshipUsage();

    expect(result).toEqual({
      tier: "flagship",
      label: "Flagship models",
      usedTokens: 0,
      dailyLimitTokens: 250_000,
      remainingTokens: 250_000,
      models: [],
    });
    expect(mockSolvePromptRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockCategoryEvaluationRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
