import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { FreeTierBudgetService, settleReservationTx } from "./free-tier-budget.service";
import { FreeTierReservation } from "./entities/free-tier-reservation.entity";
import { FreeTierUsageService } from "./free-tier-usage.service";
import { SupportedModelService } from "../supported-model/supported-model.service";

describe("FreeTierBudgetService", () => {
  let service: FreeTierBudgetService;
  let reservedSum: number;
  let usedTokens: number;
  let mockManager: {
    query: jest.Mock;
    insert: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockDataSource: { transaction: jest.Mock };
  let mockUsage: { getUsage: jest.Mock };
  let mockSupportedModels: { getMaxOutputTokensByModel: jest.Mock };
  let sumGetRawOne: jest.Mock;

  beforeEach(async () => {
    reservedSum = 0;
    usedTokens = 0;
    sumGetRawOne = jest.fn(async () => ({ total: String(reservedSum) }));
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: sumGetRawOne,
    };
    mockManager = {
      // Default: an active flagship cycle at 80% → threshold 200,000.
      query: jest.fn().mockResolvedValue([{ active: true, thresholdPercent: 80 }]),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 55 }] }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    mockDataSource = {
      transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(mockManager)),
    };
    mockUsage = { getUsage: jest.fn(async () => ({ usedTokens })) };
    mockSupportedModels = { getMaxOutputTokensByModel: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        FreeTierBudgetService,
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: getRepositoryToken(FreeTierReservation),
          useValue: { manager: mockManager },
        },
        { provide: FreeTierUsageService, useValue: mockUsage },
        { provide: SupportedModelService, useValue: mockSupportedModels },
      ],
    }).compile();
    service = module.get(FreeTierBudgetService);
  });

  describe("reserve", () => {
    it("locks the tier's state row before reading anything", async () => {
      await service.reserve("flagship", 7, 1000);

      expect(mockManager.query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [
        "flagship",
      ]);
      expect(mockManager.query.mock.invocationCallOrder[0]).toBeLessThan(
        sumGetRawOne.mock.invocationCallOrder[0],
      );
    });

    it("inserts a pending reservation and returns its id when the call fits", async () => {
      usedTokens = 150_000;
      reservedSum = 40_000;

      // 150,000 + 40,000 + 10,000 = 200,000 = threshold exactly → fits.
      await expect(service.reserve("flagship", 7, 10_000)).resolves.toBe(55);
      expect(mockManager.insert).toHaveBeenCalledWith(FreeTierReservation, {
        tier: "flagship",
        strategyRunId: 7,
        reservedTokens: 10_000,
        status: "pending",
      });
    });

    it("returns null without inserting when the call would cross the threshold", async () => {
      usedTokens = 150_000;
      reservedSum = 40_000;

      await expect(service.reserve("flagship", 7, 10_001)).resolves.toBeNull();
      expect(mockManager.insert).not.toHaveBeenCalled();
    });

    it("reads reservations before recorded usage, so a settle in between can only double-count", async () => {
      await service.reserve("flagship", 7, 1000);

      expect(sumGetRawOne.mock.invocationCallOrder[0]).toBeLessThan(
        mockUsage.getUsage.mock.invocationCallOrder[0],
      );
    });

    it("returns null when the tier has no active cycle", async () => {
      mockManager.query.mockResolvedValueOnce([{ active: false, thresholdPercent: 80 }]);
      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();

      mockManager.query.mockResolvedValueOnce([]);
      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();

      expect(mockManager.insert).not.toHaveBeenCalled();
    });

    it("fails closed: any error returns null", async () => {
      mockDataSource.transaction.mockRejectedValueOnce(new Error("lock timeout"));

      await expect(service.reserve("flagship", 7, 1)).resolves.toBeNull();
    });
  });

  describe("committedTokens", () => {
    it("is today's reservations plus recorded usage", async () => {
      usedTokens = 120_000;
      reservedSum = 33_000;

      await expect(service.committedTokens("mini")).resolves.toBe(153_000);
      expect(mockUsage.getUsage).toHaveBeenCalledWith("mini");
    });
  });

  describe("modelCaps", () => {
    it("looks the caps up for llm-openai", async () => {
      const caps = new Map([["gpt-5", 47000]]);
      mockSupportedModels.getMaxOutputTokensByModel.mockResolvedValueOnce(caps);

      await expect(service.modelCaps(["gpt-5"])).resolves.toBe(caps);
      expect(mockSupportedModels.getMaxOutputTokensByModel).toHaveBeenCalledWith("llm-openai", [
        "gpt-5",
      ]);
    });
  });
});

describe("settleReservationTx", () => {
  it("deletes the reservation when the call's usage was recorded", async () => {
    const manager = { delete: jest.fn(), update: jest.fn() };

    await settleReservationTx(manager as never, { reservationId: 55, recorded: true });

    expect(manager.delete).toHaveBeenCalledWith(FreeTierReservation, { id: 55 });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("keeps the reservation as 'unrecorded' when the call reported no usage", async () => {
    const manager = { delete: jest.fn(), update: jest.fn() };

    await settleReservationTx(manager as never, { reservationId: 55, recorded: false });

    expect(manager.update).toHaveBeenCalledWith(
      FreeTierReservation,
      { id: 55 },
      { status: "unrecorded" },
    );
    expect(manager.delete).not.toHaveBeenCalled();
  });
});
