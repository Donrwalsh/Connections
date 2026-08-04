import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { PuzzleIngestionService } from "./puzzle-ingestion.service";
import { STRATEGY_QUEUE } from "../queue/queue.module";

const PUZZLE_DATA = {
  categories: [
    {
      title: "Fruits",
      cards: [
        { content: "APPLE", position: 0 },
        { content: "BANANA", position: 1 },
        { content: "CHERRY", position: 2 },
        { content: "DATE", position: 3 },
      ],
    },
  ],
};

const fetchResponse = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
}) as unknown as Response;

describe("PuzzleIngestionService", () => {
  let service: PuzzleIngestionService;
  let mockDataSource: {
    createQueryBuilder: jest.Mock;
    transaction: jest.Mock;
  };
  let mockQueue: { add: jest.Mock };
  let mockQuery: {
    select: jest.Mock;
    getRawOne: jest.Mock;
  };
  let mockRepo: {
    createQueryBuilder: jest.Mock;
    save: jest.Mock;
  };
  let mockExecute: jest.Mock;

  beforeEach(async () => {
    mockQuery = {
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ latest: "2024-01-01" }),
    };

    mockExecute = jest.fn().mockResolvedValue({ identifiers: [{ id: 42 }] });

    mockRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: mockExecute,
      }),
      save: jest.fn().mockResolvedValue({ id: 1 }),
    };

    const mockManager = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    };

    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };

    mockDataSource = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQuery),
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
        cb(mockManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PuzzleIngestionService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: STRATEGY_QUEUE, useValue: mockQueue },
      ],
    }).compile();

    service = module.get<PuzzleIngestionService>(PuzzleIngestionService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("populateUntilCaughtUp", () => {
    const mockLatestDate = (year: number, month: number, day: number) =>
      jest
        .spyOn(
          service as unknown as { getLatestDate(): Promise<Date> },
          "getLatestDate",
        )
        .mockResolvedValue(new Date(year, month, day));

    it("should insert puzzles day-by-day until the endpoint returns 404", async () => {
      mockLatestDate(2024, 0, 1);
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 1, upToDate: "2024-01-02" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://www.nytimes.com/svc/connections/v2/2024-01-02.json",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(4);
      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: 42,
        strategyName: "alphabetical",
        date: "2024-01-02",
      });
    });

    it("should skip known awkward NYT dates without fetching", async () => {
      mockLatestDate(2024, 11, 11);

      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 0, upToDate: "2024-12-12" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("2024-12-13"),
        expect.anything(),
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it("should not queue strategies when the puzzle already exists", async () => {
      mockLatestDate(2024, 0, 1);
      mockExecute.mockResolvedValueOnce({ identifiers: [] });

      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 0, upToDate: "2024-01-02" });
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe("fetchNytPuzzle", () => {
    it("should return null on a 404", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(fetchResponse(404));

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> })
          .fetchNytPuzzle("2024-01-02"),
      ).resolves.toBeNull();
    });

    it("should return parsed JSON on a 2xx response", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValue(fetchResponse(200, PUZZLE_DATA));

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> })
          .fetchNytPuzzle("2024-01-02"),
      ).resolves.toEqual(PUZZLE_DATA);
    });

    it("should throw when the NYT endpoint returns a server error", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(fetchResponse(500));

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> })
          .fetchNytPuzzle("2024-01-02"),
      ).rejects.toThrow("NYT fetch failed for 2024-01-02: 500");
    });
  });

  describe("insertPuzzle", () => {
    it("should persist the puzzle, groups, and members and return the id", async () => {
      const result = await (
        service as unknown as {
          insertPuzzle(d: string, data: unknown): Promise<number | null>;
        }
      ).insertPuzzle("2024-01-02", PUZZLE_DATA);

      expect(result).toBe(42);
      expect(mockRepo.save).toHaveBeenNthCalledWith(1, {
        puzzle: { id: 42 },
        level: 0,
        group_name: "Fruits",
      });
      expect(mockRepo.save).toHaveBeenNthCalledWith(2, [
        { group: { id: 1 }, word: "APPLE", position: 0 },
        { group: { id: 1 }, word: "BANANA", position: 1 },
        { group: { id: 1 }, word: "CHERRY", position: 2 },
        { group: { id: 1 }, word: "DATE", position: 3 },
      ]);
    });

    it("should return null and skip saves when the puzzle already exists", async () => {
      mockExecute.mockResolvedValueOnce({ identifiers: [] });

      const result = await (
        service as unknown as {
          insertPuzzle(d: string, data: unknown): Promise<number | null>;
        }
      ).insertPuzzle("2024-01-02", PUZZLE_DATA);

      expect(result).toBeNull();
      expect(mockRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("getLatestDate", () => {
    it("should return the latest stored date as a Date", async () => {
      mockQuery.getRawOne.mockResolvedValueOnce({ latest: "2024-06-15" });

      const result = await (
        service as unknown as { getLatestDate(): Promise<Date> }
      ).getLatestDate();

      expect(result).toEqual(new Date("2024-06-15"));
    });

    it("should fall back to yesterday when the table is empty", async () => {
      mockQuery.getRawOne.mockResolvedValueOnce(null);

      const result = await (
        service as unknown as { getLatestDate(): Promise<Date> }
      ).getLatestDate();

      const expected = new Date();
      expected.setDate(expected.getDate() - 1);
      expect(result).toEqual(expected);
    });
  });

  describe("addDays", () => {
    it("should add days across a month boundary", () => {
      const result = (
        service as unknown as { addDays(d: Date, n: number): Date }
      ).addDays(new Date(2024, 0, 31), 1);

      expect(result).toEqual(new Date(2024, 1, 1));
    });
  });

  describe("formatDate", () => {
    it("should zero-pad month and day", () => {
      const result = (
        service as unknown as { formatDate(d: Date): string }
      ).formatDate(new Date(2024, 0, 5));

      expect(result).toBe("2024-01-05");
    });
  });
});
