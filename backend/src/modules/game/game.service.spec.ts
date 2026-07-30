import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { GameService } from "./game.service";
import { Puzzle } from "./entities/puzzle.entity";
import { STRATEGY_QUEUE } from "../queue/queue.module";

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
            members: [{ word: "Word 1" }, { word: "Word 2" }],
          },
          {
            id: 2,
            group_name: "Green Cat",
            level: 1,
            members: [{ word: "Word 3" }],
          },
          {
            id: 3,
            group_name: "Blue Cat",
            level: 2,
            members: [{ word: "Word 4" }],
          },
          {
            id: 4,
            group_name: "Purple Cat",
            level: 3,
            members: [{ word: "Word 5" }],
          },
          {
            id: 5,
            group_name: "Fallback Cat",
            level: 99,
            members: [{ word: "Word 6" }],
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
