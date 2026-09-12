import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { IsNull, LessThanOrEqual, MoreThan } from "typeorm";
import { RateLimitHoldService } from "./rate-limit-hold.service";
import { RateLimitHold } from "./entities/rate-limit-hold.entity";

describe("RateLimitHoldService", () => {
  let service: RateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitHoldService,
        { provide: getRepositoryToken(RateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(RateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("hold — per-model", () => {
    it("upserts on (strategyName, modelName) with resetAt = heldAt + resetInSeconds and a null reason", async () => {
      const before = Date.now();
      await service.hold("llm-groq", { modelName: "openai/gpt-oss-20b", resetInSeconds: 3600 });
      const after = Date.now();

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      const [row, conflict] = repo.upsert.mock.calls[0];
      expect(row).toMatchObject({
        strategyName: "llm-groq",
        modelName: "openai/gpt-oss-20b",
        reason: null,
      });
      expect(row.resetAt.getTime() - row.heldAt.getTime()).toBe(3600 * 1000);
      expect(row.heldAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.heldAt.getTime()).toBeLessThanOrEqual(after);
      expect(conflict).toEqual(["strategyName", "modelName"]);
    });

    it("never consults the account row (the precedence rule is reason-gated)", async () => {
      await service.hold("llm-groq", { modelName: "m", resetInSeconds: 60 });
      expect(repo.findOne).not.toHaveBeenCalled();
    });
  });

  describe("hold — account-wide", () => {
    it("upserts the single row on strategyName with the partial-index predicate and stores the reason", async () => {
      const before = Date.now();
      await service.hold("llm-openrouter", { reason: "daily", resetInSeconds: 3600 });
      const after = Date.now();

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      const [row, options] = repo.upsert.mock.calls[0];
      expect(row).toMatchObject({
        strategyName: "llm-openrouter",
        modelName: null,
        reason: "daily",
      });
      expect(row.resetAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(row.resetAt.getTime()).toBeLessThanOrEqual(after + 3600 * 1000);
      expect(options).toEqual({
        conflictPaths: ["strategyName"],
        indexPredicate: '"modelName" IS NULL',
      });
    });

    it("a per-minute-cooldown request is a no-op while a daily hold is live", async () => {
      repo.findOne.mockResolvedValueOnce({
        strategyName: "llm-openrouter",
        modelName: null,
        reason: "daily",
        resetAt: new Date(Date.now() + 3_600_000),
      });

      await service.hold("llm-openrouter", { reason: "per-minute-cooldown", resetInSeconds: 60 });

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { strategyName: "llm-openrouter", modelName: IsNull() },
      });
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("a per-minute-cooldown request writes when only a cooldown (or nothing) is live", async () => {
      repo.findOne.mockResolvedValueOnce({
        strategyName: "llm-openrouter",
        modelName: null,
        reason: "per-minute-cooldown",
        resetAt: new Date(Date.now() + 60_000),
      });

      await service.hold("llm-openrouter", { reason: "per-minute-cooldown", resetInSeconds: 60 });

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(repo.upsert.mock.calls[0][0].reason).toBe("per-minute-cooldown");
    });

    it("a daily request overwrites a live per-minute-cooldown hold", async () => {
      repo.findOne.mockResolvedValueOnce({
        strategyName: "llm-openrouter",
        modelName: null,
        reason: "per-minute-cooldown",
        resetAt: new Date(Date.now() + 60_000),
      });

      await service.hold("llm-openrouter", { reason: "daily", resetInSeconds: 3600 });

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(repo.upsert.mock.calls[0][0].reason).toBe("daily");
    });
  });

  describe("isHeld", () => {
    it("with a modelName checks that (strategyName, modelName) row and only while resetAt is future", async () => {
      repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
      expect(await service.isHeld("llm-groq", "m")).toBe(true);
      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { strategyName: "llm-groq", modelName: "m" },
      });

      repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
      expect(await service.isHeld("llm-groq", "m")).toBe(false);

      repo.findOne.mockResolvedValueOnce(null);
      expect(await service.isHeld("llm-groq", "m")).toBe(false);
    });

    it("without a modelName checks the account-wide (modelName IS NULL) row", async () => {
      repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
      expect(await service.isHeld("llm-openrouter")).toBe(true);
      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { strategyName: "llm-openrouter", modelName: IsNull() },
      });
    });
  });

  describe("heldReason", () => {
    it("returns the live account-wide row's reason, else null", async () => {
      repo.findOne.mockResolvedValueOnce({
        reason: "daily",
        resetAt: new Date(Date.now() + 60_000),
      });
      expect(await service.heldReason("llm-openrouter")).toBe("daily");

      repo.findOne.mockResolvedValueOnce({
        reason: "daily",
        resetAt: new Date(Date.now() - 60_000),
      });
      expect(await service.heldReason("llm-openrouter")).toBeNull();

      repo.findOne.mockResolvedValueOnce(null);
      expect(await service.heldReason("llm-openrouter")).toBeNull();
    });
  });

  describe("heldModels", () => {
    it("queries future resetAt for the strategy and returns non-null model names only", async () => {
      repo.find.mockResolvedValueOnce([{ modelName: "a" }, { modelName: null }, { modelName: "b" }]);

      const result = await service.heldModels("llm-groq");

      expect(result).toEqual(["a", "b"]);
      expect(repo.find).toHaveBeenCalledWith({
        where: { strategyName: "llm-groq", resetAt: MoreThan(expect.any(Date)) },
      });
    });
  });

  describe("nextResetAt", () => {
    it("returns the soonest still-future resetAt across model and account rows, or null", async () => {
      const soon = new Date(Date.now() + 60_000);
      const later = new Date(Date.now() + 600_000);
      repo.find.mockResolvedValueOnce([{ resetAt: later }, { resetAt: soon }]);

      expect(await service.nextResetAt("llm-groq")).toEqual(soon);

      repo.find.mockResolvedValueOnce([]);
      expect(await service.nextResetAt("llm-groq")).toBeNull();
    });
  });

  describe("clearExpired", () => {
    it("scoped to a strategy: deletes elapsed rows and reports cleared models + account flag", async () => {
      const expired = [{ modelName: "x" }, { modelName: "y" }];
      repo.find.mockResolvedValueOnce(expired);

      const result = await service.clearExpired("llm-groq");

      expect(repo.find).toHaveBeenCalledWith({
        where: { strategyName: "llm-groq", resetAt: LessThanOrEqual(expect.any(Date)) },
      });
      expect(repo.remove).toHaveBeenCalledWith(expired);
      expect(result).toEqual({ clearedModels: ["x", "y"], clearedAccountWide: false });
    });

    it("reports clearedAccountWide when the elapsed row has a null modelName", async () => {
      repo.find.mockResolvedValueOnce([{ modelName: null }]);

      const result = await service.clearExpired("llm-openrouter");

      expect(result).toEqual({ clearedModels: [], clearedAccountWide: true });
    });

    it("with no strategy argument sweeps every pool", async () => {
      repo.find.mockResolvedValueOnce([]);

      const result = await service.clearExpired();

      expect(repo.find).toHaveBeenCalledWith({
        where: { resetAt: LessThanOrEqual(expect.any(Date)) },
      });
      expect(repo.remove).not.toHaveBeenCalled();
      expect(result).toEqual({ clearedModels: [], clearedAccountWide: false });
    });
  });
});
