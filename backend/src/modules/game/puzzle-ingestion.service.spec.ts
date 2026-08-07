import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { PuzzleIngestionService } from "./puzzle-ingestion.service";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { AUTOMATIC_STRATEGIES } from "../../strategies";

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

const fetchResponse = (status: number, body?: unknown) =>
  ({
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
  let mockQueue: { add: jest.Mock; addBulk: jest.Mock };
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
    process.env.PUZZLE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "puzzle-cache-"));

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

    mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
    };

    mockDataSource = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQuery),
      transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) => cb(mockManager)),
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
    if (process.env.PUZZLE_CACHE_DIR) {
      fs.rmSync(process.env.PUZZLE_CACHE_DIR, { recursive: true, force: true });
    }
    delete process.env.PUZZLE_CACHE_DIR;
    jest.restoreAllMocks();
  });

  describe("populateUntilCaughtUp", () => {
    const mockLatestDate = (year: number, month: number, day: number) =>
      jest
        .spyOn(service as unknown as { getLatestDate(): Promise<Date> }, "getLatestDate")
        .mockResolvedValue(new Date(year, month, day));

    it("should insert puzzles day-by-day until the endpoint returns 404", async () => {
      mockLatestDate(2024, 0, 1);
      process.env.SHUFFLE_SMART_TRIALS = "5";
      process.env.SHUFFLE_FOOLISH_TRIALS = "2";
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      delete process.env.SHUFFLE_SMART_TRIALS;
      delete process.env.SHUFFLE_FOOLISH_TRIALS;

      expect(result).toEqual({ inserted: 1, upToDate: "2024-01-02" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://www.nytimes.com/svc/connections/v2/2024-01-02.json",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      const deterministic = AUTOMATIC_STRATEGIES.filter(
        (s) => s !== "shuffle-smart" && s !== "shuffle-foolish",
      );
      const expectedJobCount = deterministic.length + 5 + 2;
      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      const addedJobs = mockQueue.addBulk.mock.calls[0][0] as {
        name: string;
        data: {
          puzzleId: number;
          strategyName: string;
          date: string;
          trialNumber: number;
        };
      }[];
      expect(addedJobs).toHaveLength(expectedJobCount);
      for (const strategyName of deterministic) {
        expect(addedJobs).toContainEqual({
          name: "run-strategy",
          data: { puzzleId: 42, strategyName, date: "2024-01-02", trialNumber: 0 },
          opts: { jobId: `run-42-${strategyName}-0` },
        });
      }
      expect(addedJobs).toContainEqual({
        name: "run-strategy",
        data: {
          puzzleId: 42,
          strategyName: "shuffle-smart",
          date: "2024-01-02",
          trialNumber: 5,
        },
        opts: { jobId: "run-42-shuffle-smart-5" },
      });
      expect(addedJobs).toContainEqual({
        name: "run-strategy",
        data: {
          puzzleId: 42,
          strategyName: "shuffle-foolish",
          date: "2024-01-02",
          trialNumber: 2,
        },
        opts: { jobId: "run-42-shuffle-foolish-2" },
      });
    });

    it("should skip known awkward NYT dates without fetching", async () => {
      mockLatestDate(2024, 11, 11);

      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 0, upToDate: "2024-12-12" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("2024-12-13"),
        expect.anything(),
      );
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
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
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it("should read from the local cache instead of fetching when a cache file exists", async () => {
      mockLatestDate(2024, 0, 1);
      fs.writeFileSync(
        path.join(process.env.PUZZLE_CACHE_DIR!, "2024-01-02.json"),
        JSON.stringify(PUZZLE_DATA),
      );
      jest
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 1, upToDate: "2024-01-02" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("2024-01-03"),
        expect.anything(),
      );
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("should write a fetched puzzle to the cache file before inserting", async () => {
      mockLatestDate(2024, 0, 1);
      jest
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(404));

      await service.populateUntilCaughtUp();

      const cacheFile = path.join(process.env.PUZZLE_CACHE_DIR!, "2024-01-02.json");
      expect(fs.existsSync(cacheFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(cacheFile, "utf8"))).toEqual(PUZZLE_DATA);
    });

    it("should not fail the ingestion run when writing to the cache fails", async () => {
      mockLatestDate(2024, 0, 1);
      // Point the cache dir at a path nested under a regular file so mkdir
      // throws ENOTDIR — a real filesystem failure, no mocking required.
      const cacheRoot = process.env.PUZZLE_CACHE_DIR!;
      const blockerFile = path.join(cacheRoot, "blocker");
      fs.writeFileSync(blockerFile, "");
      process.env.PUZZLE_CACHE_DIR = path.join(blockerFile, "cache");
      jest
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(404));
      const warnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        "warn",
      );

      const result = await service.populateUntilCaughtUp();

      process.env.PUZZLE_CACHE_DIR = cacheRoot; // let afterEach clean up the temp dir

      expect(result).toEqual({ inserted: 1, upToDate: "2024-01-02" });
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write puzzle cache for 2024-01-02"),
      );
    });
  });

  describe("fetchNytPuzzle", () => {
    it("should return null on a 404", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(fetchResponse(404));

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> }).fetchNytPuzzle(
          "2024-01-02",
        ),
      ).resolves.toBeNull();
    });

    it("should return parsed JSON on a 2xx response", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(fetchResponse(200, PUZZLE_DATA));

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> }).fetchNytPuzzle(
          "2024-01-02",
        ),
      ).resolves.toEqual(PUZZLE_DATA);
    });

    it("should throw after exhausting retries when the NYT endpoint returns a server error", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(fetchResponse(500));
      jest
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      await expect(
        (service as unknown as { fetchNytPuzzle(d: string): Promise<unknown> }).fetchNytPuzzle(
          "2024-01-02",
        ),
      ).rejects.toThrow("NYT fetch for 2024-01-02 failed after 6 attempts");
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

    it("should fall back to the day before the NYT origin date when the table is empty", async () => {
      mockQuery.getRawOne.mockResolvedValueOnce(null);

      const result = await (
        service as unknown as { getLatestDate(): Promise<Date> }
      ).getLatestDate();

      expect(result).toEqual(new Date("2023-06-11"));
    });
  });

  describe("addDays", () => {
    it("should add days across a month boundary", () => {
      const result = (service as unknown as { addDays(d: Date, n: number): Date }).addDays(
        new Date(2024, 0, 31),
        1,
      );

      expect(result).toEqual(new Date(2024, 1, 1));
    });
  });

  describe("formatDate", () => {
    it("should zero-pad month and day", () => {
      const result = (service as unknown as { formatDate(d: Date): string }).formatDate(
        new Date(2024, 0, 5),
      );

      expect(result).toBe("2024-01-05");
    });
  });
});
