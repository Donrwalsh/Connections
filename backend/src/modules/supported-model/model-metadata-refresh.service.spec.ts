import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ModelMetadataRefreshService } from "./model-metadata-refresh.service";
import { OpenRouterClient } from "./openrouter-client";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";

describe("ModelMetadataRefreshService", () => {
  let service: ModelMetadataRefreshService;
  let mockModelRepo: { find: jest.Mock; save: jest.Mock };
  let mockPriceRepo: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let mockClient: { listModels: jest.Mock };

  beforeEach(async () => {
    mockModelRepo = { find: jest.fn(), save: jest.fn() };
    mockPriceRepo = { find: jest.fn(), create: jest.fn((x) => x), save: jest.fn() };
    mockClient = { listModels: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelMetadataRefreshService,
        { provide: getRepositoryToken(SupportedModel), useValue: mockModelRepo },
        { provide: getRepositoryToken(ModelPrice), useValue: mockPriceRepo },
        { provide: OpenRouterClient, useValue: mockClient },
      ],
    }).compile();

    service = module.get(ModelMetadataRefreshService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("updates metadata and inserts a new price row for a matched, changed model", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValue([
      { id: 5, supportedModelId: 1, inputCostPerMillionTokens: 0.05, outputCostPerMillionTokens: 0.2 },
    ]);
    mockClient.listModels.mockResolvedValue([
      {
        id: "openai/gpt-4.1-nano",
        description: "Fast and cheap.",
        created: 1744651369,
        context_length: 128000,
        pricing: { prompt: "0.0000001", completion: "0.0000004" },
      },
    ]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        contextWindow: 128000,
        providerDescription: "Fast and cheap.",
        releaseDate: new Date(1744651369 * 1000),
        metadataUpdatedAt: expect.any(Date),
      }),
    );
    expect(mockPriceRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedModelId: 1,
        inputCostPerMillionTokens: 0.1,
        outputCostPerMillionTokens: 0.4,
      }),
    );
    expect(result).toEqual({ updated: 1, skipped: 0, errored: 0 });
  });

  it("does not insert a new price row when the price hasn't changed", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
    ]);
    mockPriceRepo.find.mockResolvedValue([
      { id: 5, supportedModelId: 1, inputCostPerMillionTokens: 0.1, outputCostPerMillionTokens: 0.4 },
    ]);
    mockClient.listModels.mockResolvedValue([
      {
        id: "openai/gpt-4.1-nano",
        description: "Fast and cheap.",
        created: 1744651369,
        context_length: 128000,
        pricing: { prompt: "0.0000001", completion: "0.0000004" },
      },
    ]);

    await service.refreshAll();

    expect(mockPriceRepo.save).not.toHaveBeenCalled();
  });

  it("skips a model whose slug isn't mapped, without touching it", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 2, strategyName: "llm-ollama", modelName: "mistral", openRouterSlug: null },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockResolvedValue([]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, skipped: 1, errored: 0 });
  });

  it("skips a mapped model OpenRouter has no live entry for, without touching it", async () => {
    mockModelRepo.find.mockResolvedValue([
      {
        id: 3,
        strategyName: "llm-ollama",
        modelName: "mistral",
        openRouterSlug: "mistralai/mistral-7b-instruct",
      },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockResolvedValue([]);

    const result = await service.refreshAll();

    expect(mockModelRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, skipped: 1, errored: 0 });
  });

  it("counts every mapped model as errored, without throwing, when the OpenRouter fetch itself fails", async () => {
    mockModelRepo.find.mockResolvedValue([
      { id: 1, strategyName: "llm-openai", modelName: "gpt-4.1-nano", openRouterSlug: "openai/gpt-4.1-nano" },
      { id: 2, strategyName: "llm-ollama", modelName: "mistral", openRouterSlug: null },
    ]);
    mockPriceRepo.find.mockResolvedValue([]);
    mockClient.listModels.mockRejectedValue(new Error("network error"));

    const result = await service.refreshAll();

    expect(result).toEqual({ updated: 0, skipped: 0, errored: 1 });
  });
});
