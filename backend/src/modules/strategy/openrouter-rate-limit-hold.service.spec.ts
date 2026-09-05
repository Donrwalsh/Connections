import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  OpenRouterRateLimitHoldService,
  secondsUntilNextUtcMidnight,
} from "./openrouter-rate-limit-hold.service";
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";

const STRATEGY = "llm-openrouter";

describe("OpenRouterRateLimitHoldService", () => {
  let service: OpenRouterRateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterRateLimitHoldService,
        { provide: getRepositoryToken(OpenRouterRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(OpenRouterRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("hold('daily', n) upserts the single row keyed on strategyName with resetAt = now + n and reason 'daily'", async () => {
    const before = Date.now();
    await service.hold("daily", 3600);
    const after = Date.now();

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: STRATEGY, reason: "daily" });
    expect(row.resetAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(row.resetAt.getTime()).toBeLessThanOrEqual(after + 3600 * 1000);
    expect(conflictPaths).toEqual(["strategyName"]);
  });

  it("a per-minute-cooldown hold does NOT overwrite a live daily hold", async () => {
    repo.findOne.mockResolvedValueOnce({
      strategyName: STRATEGY,
      reason: "daily",
      resetAt: new Date(Date.now() + 3_600_000),
    });

    await service.hold("per-minute-cooldown", 60);

    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("a daily hold DOES overwrite a live per-minute-cooldown hold", async () => {
    repo.findOne.mockResolvedValueOnce({
      strategyName: STRATEGY,
      reason: "per-minute-cooldown",
      resetAt: new Date(Date.now() + 60_000),
    });

    await service.hold("daily", 3600);

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert.mock.calls[0][0].reason).toBe("daily");
  });

  it("isHeld / heldReason reflect only a live row", async () => {
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld()).toBe(true);

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.heldReason()).toBe("daily");

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld()).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.heldReason()).toBeNull();
  });

  it("nextResetAt returns the live row's resetAt or null", async () => {
    const at = new Date(Date.now() + 120_000);
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: at });
    expect(await service.nextResetAt()).toEqual(at);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.nextResetAt()).toBeNull();
  });

  it("clearExpired deletes an elapsed row and reports whether one was cleared", async () => {
    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() - 1000) });
    expect(await service.clearExpired()).toBe(true);
    expect(repo.delete).toHaveBeenCalledWith({ strategyName: STRATEGY });

    repo.findOne.mockResolvedValueOnce({ reason: "daily", resetAt: new Date(Date.now() + 60_000) });
    expect(await service.clearExpired()).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.clearExpired()).toBe(false);
  });
});

describe("secondsUntilNextUtcMidnight", () => {
  it("is the seconds from the given instant to the next 00:00:00 UTC, never negative", () => {
    const at = new Date("2026-09-05T23:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(3600);
  });

  it("returns a full day when called exactly at UTC midnight", () => {
    const at = new Date("2026-09-05T00:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(86_400);
  });
});
