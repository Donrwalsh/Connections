import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { GameService } from "./game.service";

describe("GameService", () => {
  let service: GameService;
  let mockDb: { query: jest.Mock };
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    // Create a mock DB object with a mocked query function
    mockDb = {
      query: jest.fn(),
    };

    // Create a mock for the STRATEGY_QUEUE provider/queue
    mockQueue = {
      add: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: "PG",
          useValue: mockDb,
        },
        {
          provide: "STRATEGY_QUEUE", // <-- Provide the missing dependency here
          useValue: mockQueue,
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
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it("should call getPuzzleByDate if date format is valid", async () => {
      const validDate = "2026-07-30";

      // Mock db response for puzzle and groups
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 1, date: validDate }] })
        .mockResolvedValueOnce({
          rows: [
            {
              group_id: 10,
              group_name: "Fruits",
              level: 0,
              word: "APPLE",
              position: 0,
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
      });
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("getPuzzleByDate", () => {
    it("should throw NotFoundException when no puzzle exists for given date", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.getPuzzleByDate("2026-07-30")).rejects.toThrow(
        new NotFoundException("No puzzle for date: 2026-07-30"),
      );
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it("should correctly format categories and map levels to difficulty colors", async () => {
      const mockPuzzleRow = { id: 100, date: "2026-07-30" };
      const mockGroupRows = [
        { group_id: 1, group_name: "Yellow Cat", level: 0, word: "Word 1" },
        { group_id: 1, group_name: "Yellow Cat", level: 0, word: "Word 2" },
        { group_id: 2, group_name: "Green Cat", level: 1, word: "Word 3" },
        { group_id: 3, group_name: "Blue Cat", level: 2, word: "Word 4" },
        { group_id: 4, group_name: "Purple Cat", level: 3, word: "Word 5" },
        { group_id: 5, group_name: "Fallback Cat", level: 99, word: "Word 6" },
      ];

      mockDb.query
        .mockResolvedValueOnce({ rows: [mockPuzzleRow] })
        .mockResolvedValueOnce({ rows: mockGroupRows });

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
            difficulty: "yellow", // Default fallback for out-of-range level
            words: ["Word 6"],
          },
        ],
      });
    });
  });

  describe("getTodaysPuzzle", () => {
    it("should call getPuzzleByDate with today's date formatted as YYYY-MM-DD", async () => {
      const expectedToday = new Date().toISOString().split("T")[0];

      const spy = jest.spyOn(service, "getPuzzleByDate").mockResolvedValue({
        date: expectedToday,
        categories: [],
      });

      await service.getTodaysPuzzle();

      expect(spy).toHaveBeenCalledWith(expectedToday);
    });
  });
});
