import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GameService } from "./game.service";
import { Puzzle } from "./entities/puzzle.entity";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { GuessResult } from "../strategy/entities/guess.entity";

describe("GameService", () => {
  let service: GameService;
  let mockQueue: { add: jest.Mock };
  let mockPuzzleRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn(),
    };

    mockPuzzleRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: STRATEGY_QUEUE,
          useValue: mockQueue,
        },
        {
          // Inject TypeORM token for Puzzle entity
          provide: getRepositoryToken(Puzzle),
          useValue: mockPuzzleRepo,
        },
      ],
    }).compile();

    service = module.get<GameService>(GameService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("getDatesPuzzle", () => {
    it("should throw NotFoundException if date format is invalid", async () => {
      await expect(service.getDatesPuzzle("2026-13-40")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getDatesPuzzle("invalid-date")).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPuzzleRepo.findOne).not.toHaveBeenCalled();
    });

    it("should call getPuzzleByDate if date format is valid", async () => {
      const validDate = "2026-07-30";

      mockPuzzleRepo.findOne.mockResolvedValueOnce({
        id: 1,
        date: validDate,
        answerGroups: [
          {
            id: 10,
            group_name: "Fruits",
            level: 0,
            members: [{ word: "APPLE", position: 0 }],
          },
        ],
      });

      const result = await service.getDatesPuzzle(validDate);

      expect(result).toEqual({
        date: validDate,
        categories: [
          {
            id: "cat-10",
            name: "Fruits",
            difficulty: "yellow",
            words: ["APPLE"],
          },
        ],
        wordOrder: ["APPLE"],
      });
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPuzzleByDate", () => {
    it("should throw NotFoundException when no puzzle exists for given date", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getPuzzleByDate("2026-07-30")).rejects.toThrow(
        new NotFoundException("No puzzle for date: 2026-07-30"),
      );
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it("should correctly format categories and map levels to difficulty colors", async () => {
      const mockPuzzleEntity = {
        id: 100,
        date: "2026-07-30",
        answerGroups: [
          {
            id: 1,
            group_name: "Yellow Cat",
            level: 0,
            members: [
              { word: "Word 1", position: 5 },
              { word: "Word 2", position: 2 },
            ],
          },
          {
            id: 2,
            group_name: "Green Cat",
            level: 1,
            members: [{ word: "Word 3", position: 0 }],
          },
          {
            id: 3,
            group_name: "Blue Cat",
            level: 2,
            members: [{ word: "Word 4", position: 4 }],
          },
          {
            id: 4,
            group_name: "Purple Cat",
            level: 3,
            members: [{ word: "Word 5", position: 1 }],
          },
          {
            id: 5,
            group_name: "Fallback Cat",
            level: 99,
            members: [{ word: "Word 6", position: 3 }],
          },
        ],
      };

      mockPuzzleRepo.findOne.mockResolvedValueOnce(mockPuzzleEntity);

      const result = await service.getPuzzleByDate("2026-07-30");

      expect(result).toEqual({
        date: "2026-07-30",
        categories: [
          {
            id: "cat-1",
            name: "Yellow Cat",
            difficulty: "yellow",
            words: ["Word 1", "Word 2"],
          },
          {
            id: "cat-2",
            name: "Green Cat",
            difficulty: "green",
            words: ["Word 3"],
          },
          {
            id: "cat-3",
            name: "Blue Cat",
            difficulty: "blue",
            words: ["Word 4"],
          },
          {
            id: "cat-4",
            name: "Purple Cat",
            difficulty: "purple",
            words: ["Word 5"],
          },
          {
            id: "cat-5",
            name: "Fallback Cat",
            difficulty: "yellow", // Out-of-range fallback
            words: ["Word 6"],
          },
        ],
        // Sorted by each member's global board position (0-5), not by
        // category/level order — this is what actually exercises the sort.
        wordOrder: ["Word 3", "Word 5", "Word 2", "Word 6", "Word 4", "Word 1"],
      });
    });
  });

  describe("getTodaysPuzzle", () => {
    it("should call getPuzzleByDate with today's date formatted as YYYY-MM-DD", async () => {
      const expectedToday = new Date().toISOString().split("T")[0];

      const spy = jest.spyOn(service, "getPuzzleByDate").mockResolvedValue({
        date: expectedToday,
        categories: [],
        wordOrder: [],
      });

      await service.getTodaysPuzzle();

      expect(spy).toHaveBeenCalledWith(expectedToday);
    });
  });

  describe("triggerRun", () => {
    it("should enqueue a run-strategy job with the puzzle id and strategy", async () => {
      await service.triggerRun("42", "alphabetical");

      expect(mockQueue.add).toHaveBeenCalledWith("run-strategy", {
        puzzleId: "42",
        strategyName: "alphabetical",
      });
    });
  });

  describe("puzzleDateToId", () => {
    it("should return the puzzle id for an existing date", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce({ id: 42 });

      await expect(service.puzzleDateToId("2024-01-02")).resolves.toBe(42);
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledWith({
        where: { date: "2024-01-02" },
      });
    });

    it("should throw NotFoundException when no puzzle exists for the date", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.puzzleDateToId("2024-01-02")).rejects.toThrow(
        new NotFoundException("No puzzle for date: 2024-01-02"),
      );
    });
  });

  describe("evaluateGuess", () => {
    const puzzleWithGroups = (answerGroups: unknown[]) => ({
      id: 1,
      answerGroups,
    });

    it("should return SUCCESS when the guess exactly matches a group", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(
        puzzleWithGroups([
          {
            members: [
              { word: "APPLE" },
              { word: "BANANA" },
              { word: "CHERRY" },
              { word: "DATE" },
            ],
          },
        ]),
      );

      await expect(
        service.evaluateGuess(1, [" apple ", "BANANA", "cherry", "date"]),
      ).resolves.toEqual({ result: GuessResult.SUCCESS });
    });

    it("should return OFF_BY_ONE when exactly 3 words match a group", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(
        puzzleWithGroups([
          {
            members: [
              { word: "APPLE" },
              { word: "BANANA" },
              { word: "CHERRY" },
              { word: "DATE" },
            ],
          },
        ]),
      );

      await expect(
        service.evaluateGuess(1, ["apple", "banana", "cherry", "fig"]),
      ).resolves.toEqual({ result: GuessResult.OFF_BY_ONE });
    });

    it("should return FAILURE when no group is matched or nearly matched", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(
        puzzleWithGroups([
          {
            members: [
              { word: "APPLE" },
              { word: "BANANA" },
              { word: "CHERRY" },
              { word: "DATE" },
            ],
          },
        ]),
      );

      await expect(
        service.evaluateGuess(1, ["fig", "grape", "honey", "kiwi"]),
      ).resolves.toEqual({ result: GuessResult.FAILURE });
    });

    it("should throw NotFoundException when the puzzle does not exist", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.evaluateGuess(999, ["apple", "banana", "cherry", "date"]),
      ).rejects.toThrow(new NotFoundException("Puzzle with ID 999 not found"));
    });
  });

  describe("getLatestDate", () => {
    it("should return the latest puzzle date from the raw query result", async () => {
      mockPuzzleRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValueOnce({
          latest_date: "2024-01-02",
        }),
      });

      await expect(service.getLatestDate()).resolves.toBe("2024-01-02");
      expect(mockPuzzleRepo.createQueryBuilder).toHaveBeenCalledWith("puzzle");
    });
  });

  describe("isValidYYYYMMDD", () => {
    it("should accept valid calendar dates", () => {
      expect(service.isValidYYYYMMDD("2024-02-29")).toBe(true); // leap year
      expect(service.isValidYYYYMMDD("2026-07-30")).toBe(true);
    });

    it("should reject structurally or calendar-invalid dates", () => {
      expect(service.isValidYYYYMMDD("2023-02-29")).toBe(false); // not a leap year
      expect(service.isValidYYYYMMDD("2024-04-31")).toBe(false); // April has 30 days
      expect(service.isValidYYYYMMDD("2024-13-01")).toBe(false); // bad month
      expect(service.isValidYYYYMMDD("2024-00-10")).toBe(false); // zero month
      expect(service.isValidYYYYMMDD("not-a-date")).toBe(false);
      expect(service.isValidYYYYMMDD("2024/01/01")).toBe(false);
    });
  });
});
