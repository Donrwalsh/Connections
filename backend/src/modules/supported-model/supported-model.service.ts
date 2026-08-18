import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SupportedModel } from "./entities/supported-model.entity";

@Injectable()
export class SupportedModelService {
  constructor(
    @InjectRepository(SupportedModel)
    private readonly repo: Repository<SupportedModel>,
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
   * not filter this down to supported-only themselves.
   */
  async findAll(): Promise<SupportedModel[]> {
    return this.repo.find({ order: { id: "ASC" } });
  }
}
