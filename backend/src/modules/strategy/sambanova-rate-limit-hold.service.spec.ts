import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MoreThan, LessThanOrEqual } from "typeorm";
import { SambaNovaRateLimitHoldService } from "./sambanova-rate-limit-hold.service";
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";

describe("SambaNovaRateLimitHoldService", () => {
  let service: SambaNovaRateLimitHoldService;
  let repo: {
    upsert: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SambaNovaRateLimitHoldService,
        { provide: getRepositoryToken(SambaNovaRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(SambaNovaRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("upserts a hold row keyed on (strategyName, modelName) with resetAt = heldAt + resetInSeconds", async () => {
    const before = Date.now();
    await service.hold("llm-sambanova", "DeepSeek-V3.1", 3600);
    const after = Date.now();

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: "llm-sambanova", modelName: "DeepSeek-V3.1" });
    const deltaMs = row.resetAt.getTime() - row.heldAt.getTime();
    expect(deltaMs).toBe(3600 * 1000);
    expect(row.heldAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.heldAt.getTime()).toBeLessThanOrEqual(after);
    expect(conflictPaths).toEqual(["strategyName", "modelName"]);
  });

  it("isHeld is true only while resetAt is in the future", async () => {
    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld("llm-sambanova", "DeepSeek-V3.1")).toBe(true);

    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld("llm-sambanova", "DeepSeek-V3.1")).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.isHeld("llm-sambanova", "gpt-oss-120b")).toBe(false);
  });

  it("heldModels queries for future resetAt and returns the model names", async () => {
    repo.find.mockResolvedValueOnce([{ modelName: "DeepSeek-V3.1" }, { modelName: "gpt-oss-120b" }]);

    const result = await service.heldModels("llm-sambanova");

    expect(result).toEqual(["DeepSeek-V3.1", "gpt-oss-120b"]);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-sambanova", resetAt: MoreThan(expect.any(Date)) },
    });
  });

  it("nextResetAt returns the soonest still-future resetAt, or null when nothing is held", async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);
    repo.find.mockResolvedValueOnce([{ resetAt: later }, { resetAt: soon }]);

    expect(await service.nextResetAt("llm-sambanova")).toEqual(soon);

    repo.find.mockResolvedValueOnce([]);
    expect(await service.nextResetAt("llm-sambanova")).toBeNull();
  });

  it("clearExpired deletes rows whose resetAt has passed and returns their models", async () => {
    const expired = [{ modelName: "DeepSeek-V3.1" }, { modelName: "gpt-oss-120b" }];
    repo.find.mockResolvedValueOnce(expired);

    const result = await service.clearExpired();

    expect(repo.find).toHaveBeenCalledWith({
      where: { resetAt: LessThanOrEqual(expect.any(Date)) },
    });
    expect(repo.remove).toHaveBeenCalledWith(expired);
    expect(result).toEqual(["DeepSeek-V3.1", "gpt-oss-120b"]);
  });

  it("clearExpired does not call remove when nothing is expired", async () => {
    repo.find.mockResolvedValueOnce([]);

    const result = await service.clearExpired();

    expect(repo.remove).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
