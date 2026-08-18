import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { SolvePrompt } from "./entities/solve-prompt.entity";

describe("FreeTierUsageService", () => {
  let service: FreeTierUsageService;
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };

  function mockUsageQuery(totalTokens: string | null) {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(totalTokens === null ? undefined : { totalTokens }),
    };
    mockSolvePromptRepo.createQueryBuilder.mockReturnValue(qb);
    return qb;
  }

  beforeEach(async () => {
    mockSolvePromptRepo = { createQueryBuilder: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreeTierUsageService,
        { provide: getRepositoryToken(SolvePrompt), useValue: mockSolvePromptRepo },
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
      const qb = mockUsageQuery("1000");

      await service.getFlagshipUsage();

      expect(mockSolvePromptRepo.createQueryBuilder).toHaveBeenCalledWith("prompt");
      expect(qb.innerJoin).toHaveBeenCalledWith("prompt.strategyRun", "run");
      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", {
        models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"],
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
        models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"],
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
      const qb = mockUsageQuery("1000");

      await service.getMiniUsage();

      const miniModels = [
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
      expect(qb.where).toHaveBeenCalledWith("run.modelName IN (:...models)", { models: miniModels });

      const flagshipModels = ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"];
      expect(miniModels.some((model) => flagshipModels.includes(model))).toBe(false);
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
    const qb = mockUsageQuery("0");

    await service.getFlagshipUsage();

    expect(qb.andWhere).toHaveBeenCalledWith("prompt.createdAt >= :startOfTodayUtc", {
      startOfTodayUtc: new Date("2026-08-18T00:00:00.000Z"),
    });
  });

  it("should treat no matching rows as zero tokens used", async () => {
    mockUsageQuery(null);

    const result = await service.getFlagshipUsage();

    expect(result.usedTokens).toBe(0);
    expect(result.remainingTokens).toBe(250_000);
  });
});
