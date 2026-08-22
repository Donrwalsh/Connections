import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SupportedModelService } from "./supported-model.service";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";

describe("SupportedModelService", () => {
  let service: SupportedModelService;
  let mockRepo: { findOne: jest.Mock; find: jest.Mock };
  let mockPriceRepo: { find: jest.Mock };

  beforeEach(async () => {
    mockRepo = { findOne: jest.fn(), find: jest.fn() };
    mockPriceRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportedModelService,
        { provide: getRepositoryToken(SupportedModel), useValue: mockRepo },
        { provide: getRepositoryToken(ModelPrice), useValue: mockPriceRepo },
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

  describe("resolveSupportedStrategy", () => {
    it("should return the strategy name for a model supported under exactly one strategy", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14", supported: true },
      ]);

      const result = await service.resolveSupportedStrategy("gpt-4.1-nano-2025-04-14");

      expect(result).toBe("llm-openai");
      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { modelName: "gpt-4.1-nano-2025-04-14", supported: true },
      });
    });

    it("should throw when no supported row exists for the model", async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      await expect(service.resolveSupportedStrategy("gpt-3.5-turbo")).rejects.toThrow(
        new BadRequestException("Model 'gpt-3.5-turbo' is not a supported model."),
      );
    });

    it("should throw when the model is supported under more than one strategy", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { strategyName: "llm-openai", modelName: "shared-model", supported: true },
        { strategyName: "llm-ollama", modelName: "shared-model", supported: true },
      ]);

      await expect(service.resolveSupportedStrategy("shared-model")).rejects.toThrow(
        BadRequestException,
      );
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
      mockPriceRepo.find.mockResolvedValueOnce([]);

      const result = await service.findAll();

      expect(result).toEqual([
        { ...rows[0], inputCostPerMillionTokens: null, outputCostPerMillionTokens: null },
        { ...rows[1], inputCostPerMillionTokens: null, outputCostPerMillionTokens: null },
        { ...rows[2], inputCostPerMillionTokens: null, outputCostPerMillionTokens: null },
      ]);
      expect(mockRepo.find).toHaveBeenCalledWith({ order: { id: "ASC" } });
      expect(mockPriceRepo.find).toHaveBeenCalledWith({ order: { id: "ASC" } });
    });

    it("should price each model from its current (highest-id) ModelPrice row", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano-2025-04-14", supported: true },
      ]);
      // Ascending by id: the second row for supportedModelId 1 is the most
      // recent price and should win over the first.
      mockPriceRepo.find.mockResolvedValueOnce([
        { id: 10, supportedModelId: 1, inputCostPerMillionTokens: 0.2, outputCostPerMillionTokens: 0.8 },
        { id: 11, supportedModelId: 1, inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.4 },
      ]);

      const result = await service.findAll();

      expect(result).toEqual([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano-2025-04-14",
          supported: true,
          inputCostPerMillionTokens: 0.1,
          outputCostPerMillionTokens: 0.4,
        },
      ]);
    });

    it("should leave cost fields null for a model with no ModelPrice row", async () => {
      mockRepo.find.mockResolvedValueOnce([
        { id: 1, strategyName: "llm-openai", modelName: "brand-new-model", supported: true },
      ]);
      mockPriceRepo.find.mockResolvedValueOnce([]);

      const result = await service.findAll();

      expect(result[0]).toMatchObject({
        inputCostPerMillionTokens: null,
        outputCostPerMillionTokens: null,
      });
    });
  });

  describe("findModelNamesByFreeTier", () => {
    it("should return only model names matching the given free tier", async () => {
      mockRepo.find.mockResolvedValueOnce([
        {
          id: 1,
          strategyName: "llm-openai",
          modelName: "gpt-5.4",
          freeTier: "flagship",
          supported: true,
        },
        {
          id: 2,
          strategyName: "llm-openai",
          modelName: "gpt-4o",
          freeTier: "flagship",
          supported: true,
        },
      ]);

      const result = await service.findModelNamesByFreeTier("flagship");

      expect(result).toEqual(["gpt-5.4", "gpt-4o"]);
      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { freeTier: "flagship", supported: true },
        order: { id: "ASC" },
      });
    });

    it("should return an empty array when no models are configured for the tier", async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const result = await service.findModelNamesByFreeTier("mini");

      expect(result).toEqual([]);
    });
  });
});
