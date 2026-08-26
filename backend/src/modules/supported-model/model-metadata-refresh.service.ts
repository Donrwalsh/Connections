import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";
import { OpenRouterClient, OpenRouterModel } from "./openrouter-client";
import { parseParamCount, parseReleaseDate } from "./openrouter-metadata.util";

export interface RefreshSummary {
  updated: number;
  skipped: number;
  errored: number;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Refreshes SupportedModel's OpenRouter-sourced metadata (context window,
 * best-effort param count, provider description, release date) and inserts
 * a new ModelPrice row when a mapped model's price has changed. A model
 * with no openRouterSlug, or a mapped slug OpenRouter has no live entry for
 * (e.g. a delisted model), is skipped — its existing data is left
 * untouched rather than being nulled out or replaced with a guess.
 */
@Injectable()
export class ModelMetadataRefreshService {
  private readonly logger = new Logger(ModelMetadataRefreshService.name);

  constructor(
    @InjectRepository(SupportedModel) private readonly modelRepo: Repository<SupportedModel>,
    @InjectRepository(ModelPrice) private readonly priceRepo: Repository<ModelPrice>,
    private readonly client: OpenRouterClient,
  ) {}

  async refreshAll(): Promise<RefreshSummary> {
    const models = await this.modelRepo.find();

    let openRouterModels: OpenRouterModel[];
    try {
      openRouterModels = await this.client.listModels();
    } catch (err) {
      this.logger.warn(`OpenRouter fetch failed: ${err instanceof Error ? err.message : err}`);
      return { updated: 0, skipped: 0, errored: models.filter((m) => m.openRouterSlug).length };
    }

    const byId = new Map(openRouterModels.map((m) => [m.id, m]));
    const summary: RefreshSummary = { updated: 0, skipped: 0, errored: 0 };

    for (const model of models) {
      if (!model.openRouterSlug) {
        summary.skipped++;
        continue;
      }

      const match = byId.get(model.openRouterSlug);
      if (!match) {
        this.logger.warn(`No live OpenRouter entry for slug '${model.openRouterSlug}' — skipping.`);
        summary.skipped++;
        continue;
      }

      model.contextWindow = match.context_length;
      model.paramCount = parseParamCount(match.id) ?? parseParamCount(match.description);
      model.providerDescription = match.description;
      model.releaseDate = parseReleaseDate(match.created);
      model.metadataUpdatedAt = new Date();
      await this.modelRepo.save(model);

      await this.maybeInsertNewPrice(model, match);
      summary.updated++;
    }

    return summary;
  }

  private async maybeInsertNewPrice(model: SupportedModel, match: OpenRouterModel): Promise<void> {
    // OpenRouter's pricing is USD per token, given as a decimal string.
    // Multiplying by 1e6 to get "per million tokens" reintroduces float
    // error (e.g. "0.0000001" * 1_000_000 = 0.09999999999999999) — round to
    // 6 decimal places, well past any real pricing's precision, so an
    // unchanged price is actually detected as unchanged.
    const inputCostPerMillionTokens = round6(Number(match.pricing.prompt) * 1_000_000);
    const outputCostPerMillionTokens = round6(Number(match.pricing.completion) * 1_000_000);

    const existingPrices = await this.priceRepo.find({
      where: { supportedModelId: model.id },
      order: { id: "DESC" },
      take: 1,
    });
    const current = existingPrices[0];

    if (
      current &&
      current.inputCostPerMillionTokens === inputCostPerMillionTokens &&
      current.outputCostPerMillionTokens === outputCostPerMillionTokens
    ) {
      return;
    }

    const newPrice = this.priceRepo.create({
      supportedModelId: model.id,
      inputCostPerMillionTokens,
      outputCostPerMillionTokens,
    });
    await this.priceRepo.save(newPrice);
  }
}
