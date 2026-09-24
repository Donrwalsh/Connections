import { BadRequestException } from "@nestjs/common";
import { StrategyController } from "./strategy.controller";
import type { RunHistoryReadModel } from "./strategy-read.service";
import type { SupportedModelService } from "../supported-model/supported-model.service";
import type { FreeTierUsageService } from "./free-tier-usage.service";

describe("StrategyController", () => {
  function makeController(resolveSupportedStrategy: jest.Mock) {
    const runHistoryReadModel = {} as RunHistoryReadModel;
    const supportedModelService = {
      resolveSupportedStrategy,
    } as unknown as SupportedModelService;
    const freeTierUsageService = {} as FreeTierUsageService;
    return new StrategyController(runHistoryReadModel, supportedModelService, freeTierUsageService);
  }

  describe("resolveModelStrategy", () => {
    it("returns the model and its one resolved strategy", async () => {
      const resolveSupportedStrategy = jest.fn().mockResolvedValueOnce("llm-groq");
      const controller = makeController(resolveSupportedStrategy);

      const result = await controller.resolveModelStrategy("openai/gpt-oss-20b");

      expect(result).toEqual({ modelName: "openai/gpt-oss-20b", strategyName: "llm-groq" });
      expect(resolveSupportedStrategy).toHaveBeenCalledWith("openai/gpt-oss-20b");
    });

    it("propagates the service's ambiguity rejection unchanged", async () => {
      const resolveSupportedStrategy = jest.fn().mockRejectedValueOnce(
        new BadRequestException(
          "Model 'openai/gpt-oss-20b' is ambiguous — it is configured as supported under multiple" +
            " strategies (llm-groq, llm-nvidia).",
        ),
      );
      const controller = makeController(resolveSupportedStrategy);

      await expect(controller.resolveModelStrategy("openai/gpt-oss-20b")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
