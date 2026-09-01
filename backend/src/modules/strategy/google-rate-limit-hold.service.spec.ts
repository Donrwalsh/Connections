import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MoreThan, LessThanOrEqual } from "typeorm";
import {
  GoogleRateLimitHoldService,
  nextPacificMidnight,
  pacificDateStamp,
} from "./google-rate-limit-hold.service";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";

describe("nextPacificMidnight", () => {
  it("returns the next Pacific midnight in UTC during PST (UTC-8)", () => {
    // 2026-01-15 12:00 PST
    const now = new Date("2026-01-15T20:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("returns the next Pacific midnight in UTC during PDT (UTC-7)", () => {
    // 2026-07-15 11:00 PDT
    const now = new Date("2026-07-15T18:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  it("returns the upcoming midnight (not one 24h later) when already late Pacific evening", () => {
    // 2026-01-15 23:30 PST
    const now = new Date("2026-01-16T07:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("rolls to the following day when just past Pacific midnight", () => {
    // 2026-01-16 00:30 PST
    const now = new Date("2026-01-16T08:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-17T08:00:00.000Z");
  });

  it("lands on the spring-forward day's PDT midnight (the following day is UTC-7)", () => {
    // 2026-03-08 01:00 PST — the day the clocks jump forward at 02:00.
    const now = new Date("2026-03-08T09:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("lands on the fall-back day's PST midnight (the following day is UTC-8)", () => {
    // 2026-11-01 01:00 PDT — the day the clocks fall back at 02:00.
    const now = new Date("2026-11-01T08:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("returns the *next* midnight when now is exactly a Pacific midnight instant", () => {
    // 2026-01-16 00:00:00.000 PST exactly.
    const now = new Date("2026-01-16T08:00:00.000Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-17T08:00:00.000Z");
  });
});

describe("pacificDateStamp", () => {
  it("returns the Pacific calendar date as YYYY-MM-DD", () => {
    // 2026-01-15 12:00 PST
    expect(pacificDateStamp(new Date("2026-01-15T20:00:00Z"))).toBe("2026-01-15");
  });

  it("uses the Pacific day, not the UTC day, either side of midnight", () => {
    // 2026-01-16 00:30 UTC is still 2026-01-15 16:30 PST.
    expect(pacificDateStamp(new Date("2026-01-16T00:30:00Z"))).toBe("2026-01-15");
    // 2026-01-16 08:30 UTC is 2026-01-16 00:30 PST.
    expect(pacificDateStamp(new Date("2026-01-16T08:30:00Z"))).toBe("2026-01-16");
  });

  it("zero-pads single-digit months and days", () => {
    expect(pacificDateStamp(new Date("2026-03-09T20:00:00Z"))).toBe("2026-03-09");
  });
});

describe("GoogleRateLimitHoldService", () => {
  let service: GoogleRateLimitHoldService;
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
        GoogleRateLimitHoldService,
        { provide: getRepositoryToken(GoogleRateLimitHold), useValue: repo },
      ],
    }).compile();

    service = module.get(GoogleRateLimitHoldService);
  });

  afterEach(() => jest.clearAllMocks());

  it("upserts a hold row keyed on (strategyName, modelName) with a future resetAt", async () => {
    await service.hold("llm-google", "gemini-3.6-flash");

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [row, conflictPaths] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({ strategyName: "llm-google", modelName: "gemini-3.6-flash" });
    expect(row.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(conflictPaths).toEqual(["strategyName", "modelName"]);
  });

  it("isHeld is true only while resetAt is in the future", async () => {
    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() + 60_000) });
    expect(await service.isHeld("llm-google", "m")).toBe(true);

    repo.findOne.mockResolvedValueOnce({ resetAt: new Date(Date.now() - 60_000) });
    expect(await service.isHeld("llm-google", "m")).toBe(false);

    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.isHeld("llm-google", "m")).toBe(false);
  });

  it("heldModels queries for future resetAt and returns the model names", async () => {
    repo.find.mockResolvedValueOnce([{ modelName: "a" }, { modelName: "b" }]);

    const result = await service.heldModels("llm-google");

    expect(result).toEqual(["a", "b"]);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-google", resetAt: MoreThan(expect.any(Date)) },
    });
  });

  it("nextResetAt returns the soonest still-future resetAt, or null when nothing is held", async () => {
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 600_000);
    repo.find.mockResolvedValueOnce([{ resetAt: later }, { resetAt: soon }]);

    expect(await service.nextResetAt("llm-google")).toEqual(soon);
    expect(repo.find).toHaveBeenCalledWith({
      where: { strategyName: "llm-google", resetAt: MoreThan(expect.any(Date)) },
    });

    repo.find.mockResolvedValueOnce([]);
    expect(await service.nextResetAt("llm-google")).toBeNull();
  });

  it("clearExpired deletes rows whose resetAt has passed and returns their models", async () => {
    const expired = [{ modelName: "x" }, { modelName: "y" }];
    repo.find.mockResolvedValueOnce(expired);

    const result = await service.clearExpired();

    expect(repo.find).toHaveBeenCalledWith({
      where: { resetAt: LessThanOrEqual(expect.any(Date)) },
    });
    expect(repo.remove).toHaveBeenCalledWith(expired);
    expect(result).toEqual(["x", "y"]);
  });

  it("clearExpired does not call remove when nothing is expired", async () => {
    repo.find.mockResolvedValueOnce([]);

    const result = await service.clearExpired();

    expect(repo.remove).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
