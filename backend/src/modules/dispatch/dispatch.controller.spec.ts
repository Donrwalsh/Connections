import { BadRequestException } from "@nestjs/common";
import { DispatchController } from "./dispatch.controller";
import { PROVIDER_POOLS } from "../provider-pool/provider-pool.config";
import { LLM_OLLAMA } from "../../strategies";

describe("DispatchController", () => {
  describe("queueProviderRuns", () => {
    let strategyDispatch: {
      findUnrunPuzzleDatesForModel: jest.Mock;
      triggerStrategyRuns: jest.Mock;
    };
    let supportedModelService: { findModelNamesByStrategy: jest.Mock };
    let controller: DispatchController;

    // Each model's unrun dates, keyed by model name — the stand-in for the
    // random NOT EXISTS query, which is honored up to `limit`.
    let unrunByModel: Record<string, { puzzleId: number; date: string }[]>;

    beforeEach(() => {
      unrunByModel = {};
      strategyDispatch = {
        findUnrunPuzzleDatesForModel: jest.fn(
          async (_strategy: string, model: string, limit: number) =>
            (unrunByModel[model] ?? []).slice(0, limit),
        ),
        triggerStrategyRuns: jest.fn().mockResolvedValue(undefined),
      };
      supportedModelService = { findModelNamesByStrategy: jest.fn().mockResolvedValue([]) };

      controller = new DispatchController(
        strategyDispatch as never,
        {} as never,
        supportedModelService as never,
        {} as never,
        {} as never,
        {} as never,
      );
    });

    const target = (puzzleId: number) => ({
      puzzleId,
      date: `2026-09-${String(puzzleId).padStart(2, "0")}`,
    });

    it("rejects an unknown pool id, listing the valid ones", async () => {
      await expect(controller.queueProviderRuns("bogus", 1)).rejects.toThrow(
        new BadRequestException(
          `Unknown pool 'bogus'. Expected one of: ${PROVIDER_POOLS.map((p) => p.id).join(", ")}.`,
        ),
      );
      expect(strategyDispatch.triggerStrategyRuns).not.toHaveBeenCalled();
    });

    it("rejects n < 1", async () => {
      await expect(controller.queueProviderRuns("ollama", 0)).rejects.toThrow(BadRequestException);
      expect(supportedModelService.findModelNamesByStrategy).not.toHaveBeenCalled();
    });

    it("rejects a pool with no supported models", async () => {
      supportedModelService.findModelNamesByStrategy.mockResolvedValue([]);

      await expect(controller.queueProviderRuns("ollama", 2)).rejects.toThrow(
        new BadRequestException("No supported models for pool 'ollama'."),
      );
      expect(supportedModelService.findModelNamesByStrategy).toHaveBeenCalledWith(LLM_OLLAMA);
    });

    it("queues up to n random unrun dates per model, round-robin across models", async () => {
      supportedModelService.findModelNamesByStrategy.mockResolvedValue(["a", "b"]);
      unrunByModel = { a: [target(1), target(2)], b: [target(3), target(4)] };

      const result = await controller.queueProviderRuns("ollama", 2);

      expect(strategyDispatch.findUnrunPuzzleDatesForModel).toHaveBeenCalledWith(
        LLM_OLLAMA,
        "a",
        2,
      );
      expect(strategyDispatch.findUnrunPuzzleDatesForModel).toHaveBeenCalledWith(
        LLM_OLLAMA,
        "b",
        2,
      );
      expect(strategyDispatch.triggerStrategyRuns.mock.calls).toEqual([
        [1, LLM_OLLAMA, "2026-09-01", "a"],
        [3, LLM_OLLAMA, "2026-09-03", "b"],
        [2, LLM_OLLAMA, "2026-09-02", "a"],
        [4, LLM_OLLAMA, "2026-09-04", "b"],
      ]);
      expect(result).toMatchObject({
        poolId: "ollama",
        strategyName: LLM_OLLAMA,
        requestedPerModel: 2,
        totalQueued: 4,
        models: [
          { modelName: "a", dates: ["2026-09-01", "2026-09-02"], shortfall: 0 },
          { modelName: "b", dates: ["2026-09-03", "2026-09-04"], shortfall: 0 },
        ],
        skipped: [],
      });
    });

    it("queues what is available when a model falls short, and skips models with none", async () => {
      supportedModelService.findModelNamesByStrategy.mockResolvedValue(["a", "b", "c"]);
      unrunByModel = { a: [target(1), target(2), target(3)], b: [target(4)], c: [] };

      const result = await controller.queueProviderRuns("ollama", 3);

      expect(
        strategyDispatch.triggerStrategyRuns.mock.calls.map((call) => [call[0], call[3]]),
      ).toEqual([
        [1, "a"],
        [4, "b"],
        [2, "a"],
        [3, "a"],
      ]);
      expect(result).toMatchObject({
        totalQueued: 4,
        models: [
          { modelName: "a", dates: ["2026-09-01", "2026-09-02", "2026-09-03"], shortfall: 0 },
          { modelName: "b", dates: ["2026-09-04"], shortfall: 2 },
        ],
        skipped: ["c"],
      });
    });

    it("documents every provider pool id as the Swagger enum for poolId", () => {
      const params = Reflect.getMetadata(
        // @nestjs/swagger DECORATORS.API_PARAMETERS (dist/constants isn't importable).
        "swagger/apiParameters",
        DispatchController.prototype.queueProviderRuns,
      ) as { name: string; schema?: { enum?: unknown } }[];
      const poolParam = params.find((p) => p.name === "poolId");

      expect(poolParam?.schema?.enum).toEqual(PROVIDER_POOLS.map((p) => p.id));
    });
  });
});
