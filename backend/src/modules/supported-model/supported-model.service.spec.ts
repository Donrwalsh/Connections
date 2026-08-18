import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SupportedModelService } from "./supported-model.service";
import { SupportedModel } from "./entities/supported-model.entity";

describe("SupportedModelService", () => {
  let service: SupportedModelService;
  let mockRepo: { findOne: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    mockRepo = { findOne: jest.fn(), find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportedModelService,
        { provide: getRepositoryToken(SupportedModel), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<SupportedModelService>(SupportedModelService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("assertSupported", () => {
    it("should throw when no model is given", async () => {
      await expect(service.assertSupported("llm-openai", undefined)).rejects.toThrow(
        new BadRequestException("A 'model' is required to dispatch strategy 'llm-openai'."),
      );
      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });

    it("should throw when no row exists for the strategy/model pair", async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.assertSupported("llm-openai", "gpt-5-nano")).rejects.toThrow(
        new BadRequestException(
          "Model 'gpt-5-nano' is not a supported model for strategy 'llm-openai'.",
        ),
      );
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { strategyName: "llm-openai", modelName: "gpt-5-nano" },
      });
    });

    it("should throw when the row exists but is marked unsupported", async () => {
      mockRepo.findOne.mockResolvedValueOnce({
        strategyName: "llm-openai",
        modelName: "gpt-3.5-turbo",
        supported: false,
      });

      await expect(service.assertSupported("llm-openai", "gpt-3.5-turbo")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should resolve without throwing for a supported model", async () => {
      mockRepo.findOne.mockResolvedValueOnce({
        strategyName: "llm-openai",
        modelName: "gpt-4.1-nano-2025-04-14",
        supported: true,
      });

      await expect(
        service.assertSupported("llm-openai", "gpt-4.1-nano-2025-04-14"),
      ).resolves.toBeUndefined();
    });
  });

  describe("getDefaultModel", () => {
    it("should return the earliest-configured supported model's name", async () => {
      mockRepo.findOne.mockResolvedValueOnce({ modelName: "gpt-4.1-nano-2025-04-14" });

      const result = await service.getDefaultModel("llm-openai");

      expect(result).toBe("gpt-4.1-nano-2025-04-14");
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { strategyName: "llm-openai", supported: true },
        order: { id: "ASC" },
      });
    });

    it("should return null when the strategy has no supported model configured", async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getDefaultModel("llm-ollama");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("should return every row, ordered by id, regardless of supported status", async () => {
      const rows = [
        { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14", supported: true },
        { id: 2, strategyName: "llm-openai", modelName: "gpt-5-nano", supported: true },
        { id: 3, strategyName: "llm-openai", modelName: "gpt-3.5-turbo", supported: false },
      ];
      mockRepo.find.mockResolvedValueOnce(rows);

      const result = await service.findAll();

      expect(result).toBe(rows);
      expect(mockRepo.find).toHaveBeenCalledWith({ order: { id: "ASC" } });
    });
  });
});
