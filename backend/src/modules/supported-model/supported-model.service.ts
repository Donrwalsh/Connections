import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";

// SupportedModel joined with its current (most recently added) ModelPrice
// row — the shape GET /strategy/models returns and getLeaderboard/
// getRunHistory price runs from. Cost fields are nullable: a model can exist
// (and be dispatchable) before it's ever been given a price row.
export interface PriceHistoryEntry {
  strategyName: string;
  modelName: string;
  createdAt: Date;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}

export interface SupportedModelWithRate {
  id: number;
  strategyName: string;
  modelName: string;
  supported: boolean;
  inputCostPerMillionTokens: number | null;
  outputCostPerMillionTokens: number | null;
  contextWindow: number | null;
  paramCount: number | null;
  providerDescription: string | null;
  releaseDate: Date | null;
}

@Injectable()
export class SupportedModelService {
  constructor(
    @InjectRepository(SupportedModel)
    private readonly repo: Repository<SupportedModel>,
    @InjectRepository(ModelPrice)
    private readonly priceRepo: Repository<ModelPrice>,
  ) {}

  /**
   * Guards strategy-run dispatch: throws unless `modelName` is both a known
   * model for `strategyName` and currently marked `supported`. Callers must
   * await this *before* enqueueing anything — a rejected model means no run
   * gets dispatched at all, not a run that fails later.
   */
  async assertSupported(strategyName: string, modelName: string | undefined): Promise<void> {
    if (!modelName) {
      throw new BadRequestException(
        `A 'model' is required to dispatch strategy '${strategyName}'.`,
      );
    }

    const row = await this.repo.findOne({ where: { strategyName, modelName } });

    if (!row || !row.supported) {
      throw new BadRequestException(
        `Model '${modelName}' is not a supported model for strategy '${strategyName}'.`,
      );
    }
  }

  /**
   * The model to use when a run is dispatched without an explicit choice
   * (e.g. automatic puzzle-ingestion dispatch, which has no human caller to
   * ask). Picks the earliest-configured supported model for the strategy;
   * null means the strategy has no supported model configured at all, and
   * callers should skip dispatching rather than guess.
   */
  async getDefaultModel(strategyName: string): Promise<string | null> {
    const row = await this.repo.findOne({
      where: { strategyName, supported: true },
      order: { id: "ASC" },
    });
    return row?.modelName ?? null;
  }

  /**
   * Resolves a bare model name to the one strategy it's configured and
   * currently supported under — used by dispatch routes that take only a
   * model name (see DispatchController) and need to know which strategy
   * queue to dispatch it on. Throws if the model is unknown/unsupported, or
   * if it's configured as supported under more than one strategy, since
   * there'd then be no single correct queue to pick.
   */
  async resolveSupportedStrategy(modelName: string): Promise<string> {
    const rows = await this.repo.find({ where: { modelName, supported: true } });

    if (rows.length === 0) {
      throw new BadRequestException(`Model '${modelName}' is not a supported model.`);
    }

    if (rows.length > 1) {
      throw new BadRequestException(
        `Model '${modelName}' is ambiguous — it is configured as supported under multiple` +
          ` strategies (${rows.map((row) => row.strategyName).join(", ")}).`,
      );
    }

    return rows[0].strategyName;
  }

  /**
   * The full model catalog, every row regardless of `supported` — a model
   * that's since been marked unsupported can still have real historical runs
   * that need to resolve to *something* (e.g. the leaderboard's per-model
   * page), so callers that need to recognize "is this a real model" should
   * not filter this down to supported-only themselves. Each model is priced
   * from its current rate — see ModelPrice — which is null if the model has
   * never been given a price row.
   */
  async findAll(): Promise<SupportedModelWithRate[]> {
    const [models, prices] = await Promise.all([
      this.repo.find({ order: { id: "ASC" } }),
      this.priceRepo.find({ order: { id: "ASC" } }),
    ]);

    // Prices are append-only and fetched oldest-first, so the last write for
    // a given model in this loop is its highest-id (most recent) row —
    // "the current price" — see ModelPrice's entity comment.
    const currentPriceByModelId = new Map<number, ModelPrice>();
    for (const price of prices) {
      currentPriceByModelId.set(price.supportedModelId, price);
    }

    return models.map((model) => {
      const price = currentPriceByModelId.get(model.id);
      return {
        id: model.id,
        strategyName: model.strategyName,
        modelName: model.modelName,
        supported: model.supported,
        inputCostPerMillionTokens: price?.inputCostPerMillionTokens ?? null,
        outputCostPerMillionTokens: price?.outputCostPerMillionTokens ?? null,
        contextWindow: model.contextWindow,
        paramCount: model.paramCount,
        providerDescription: model.providerDescription,
        releaseDate: model.releaseDate,
      };
    });
  }

  /**
   * Every ModelPrice row ever inserted, joined with its model's
   * strategyName/modelName, ordered oldest-first per model — lets a caller
   * find "the price in effect at time T" for a given run, rather than only
   * ever seeing the current price. See getLeaderboard/getRunHistory.
   */
  async findPriceHistory(): Promise<PriceHistoryEntry[]> {
    const [models, prices] = await Promise.all([
      this.repo.find(),
      this.priceRepo.find({ order: { id: "ASC" } }),
    ]);

    const modelById = new Map(models.map((model) => [model.id, model]));

    const entries: PriceHistoryEntry[] = [];
    for (const price of prices) {
      const model = modelById.get(price.supportedModelId);
      if (!model) continue;
      entries.push({
        strategyName: model.strategyName,
        modelName: model.modelName,
        createdAt: price.createdAt,
        inputCostPerMillionTokens: price.inputCostPerMillionTokens,
        outputCostPerMillionTokens: price.outputCostPerMillionTokens,
      });
    }
    return entries;
  }

  /**
   * The model's real context window, if known — used to configure Ollama's
   * num_ctx per-model instead of the flat MODEL_CONTEXT_WINDOW default. null
   * when the model doesn't exist or hasn't been refreshed yet; callers fall
   * back to the env default in that case (see provider.ts).
   */
  async getContextWindow(strategyName: string, modelName: string): Promise<number | null> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row?.contextWindow ?? null;
  }

  /**
   * Model names currently assigned to a free-tier program (see FreeTierId
   * in ../strategy/free-tier-usage.service.ts), from the freeTier column —
   * consumed only by FreeTierUsageService.getUsage. Filtered to `supported:
   * true`, matching getDefaultModel/resolveSupportedStrategy above, so a
   * model marked unsupported (e.g. via Adminer) is correctly excluded from
   * free-tier dispatch/usage accounting. Ordered by id (matching
   * getDefaultModel's convention) so the result is deterministic across
   * calls rather than depending on Postgres's unspecified default scan
   * order. Plain `string` (not FreeTierId) to avoid this module depending
   * on the strategy module's types.
   */
  async findModelNamesByFreeTier(freeTier: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { freeTier, supported: true },
      order: { id: "ASC" },
    });
    return rows.map((row) => row.modelName);
  }
}
