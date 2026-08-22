import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { startOfTodayUtc } from "../../strategies";
import { SupportedModelService } from "../supported-model/supported-model.service";

// Two separate provider programs, each with its own daily token allowance.
// Model membership lives on SupportedModel.freeTier (see
// SupportedModelService.findModelNamesByFreeTier) so it's editable without a
// code change or redeploy. dailyLimitTokens/label are tier-level, not
// model-level, so they stay as the FREE_TIER_LIMITS constant below rather
// than a column on a model-keyed table.
export type FreeTierId = "flagship" | "mini";

export const FREE_TIER_LIMITS: Record<FreeTierId, { label: string; dailyLimitTokens: number }> = {
  flagship: { label: "Flagship models", dailyLimitTokens: 250_000 },
  mini: { label: "Mini & nano models", dailyLimitTokens: 2_500_000 },
};

export interface FreeTierUsageDto {
  tier: FreeTierId;
  label: string;
  usedTokens: number;
  dailyLimitTokens: number;
  remainingTokens: number;
  // The models counted toward usedTokens — from SupportedModel.freeTier.
  models: string[];
}

@Injectable()
export class FreeTierUsageService {
  constructor(
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
    @Inject(SupportedModelService)
    private readonly supportedModelService: SupportedModelService,
  ) {}

  async getFlagshipUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage("flagship");
  }

  async getMiniUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage("mini");
  }

  /**
   * Tokens spent today (UTC) across every run of `tier`'s models, summed
   * from SolvePrompt.totalTokens — the same per-call token figure
   * StrategyService's cost calculations use. "Today" resets at UTC midnight
   * rather than server-local time, since that's when the provider's own
   * usage window resets. getFlagshipUsage/getMiniUsage are thin wrappers
   * over this; FreeTierDispatchService calls it directly since it needs to
   * look usage up by whichever tier it's currently ticking.
   */
  async getUsage(tier: FreeTierId): Promise<FreeTierUsageDto> {
    const { label, dailyLimitTokens } = FREE_TIER_LIMITS[tier];
    const models = await this.supportedModelService.findModelNamesByFreeTier(tier);

    // A tier with zero models configured (reachable via an ordinary Adminer
    // edit, or a typo in the freeTier column value) must skip the query
    // entirely: TypeORM's Postgres driver expands an empty `:...models`
    // spread into literal `IN ()`, which Postgres rejects as a syntax error.
    if (models.length === 0) {
      return {
        tier,
        label,
        usedTokens: 0,
        dailyLimitTokens,
        remainingTokens: dailyLimitTokens,
        models,
      };
    }

    const raw = await this.solvePromptRepo
      .createQueryBuilder("prompt")
      .innerJoin("prompt.strategyRun", "run")
      .where("run.modelName IN (:...models)", { models })
      .andWhere("prompt.createdAt >= :startOfTodayUtc", { startOfTodayUtc: startOfTodayUtc() })
      .select("COALESCE(SUM(prompt.totalTokens), 0)", "totalTokens")
      .getRawOne<{ totalTokens: string }>();

    const usedTokens = Number(raw?.totalTokens ?? 0);

    return {
      tier,
      label,
      usedTokens,
      dailyLimitTokens,
      remainingTokens: Math.max(0, dailyLimitTokens - usedTokens),
      models,
    };
  }
}
