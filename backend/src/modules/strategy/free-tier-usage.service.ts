import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SolvePrompt } from "./entities/solve-prompt.entity";
import { CategoryEvaluation } from "./entities/category-evaluation.entity";
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
    @InjectRepository(CategoryEvaluation)
    private readonly categoryEvaluationRepo: Repository<CategoryEvaluation>,
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
   * Tokens spent today (UTC) against `tier`'s daily allowance, from two
   * sources that both bill the same provider budget:
   *
   *  - SolvePrompt.totalTokens for every solve step of a run on one of the
   *    tier's models (the per-call figure StrategyService's cost math uses);
   *  - CategoryEvaluation.totalTokens for every category-judge call whose
   *    judgeModel is one of the tier's models — the LLM-as-judge runs on
   *    JUDGE_MODEL (a mini/nano model by default), so its spend lands in
   *    whichever tier that model belongs to. judgeModel is stored per row at
   *    call time, so re-pointing JUDGE_MODEL never moves past spend.
   *
   * "Today" resets at UTC midnight rather than server-local time, since
   * that's when the provider's own usage window resets.
   * getFlagshipUsage/getMiniUsage are thin wrappers over this;
   * FreeTierDispatchService calls it directly since it needs to look usage
   * up by whichever tier it's currently ticking.
   */
  async getUsage(tier: FreeTierId): Promise<FreeTierUsageDto> {
    const { label, dailyLimitTokens } = FREE_TIER_LIMITS[tier];
    const models = await this.supportedModelService.findModelNamesByFreeTier(tier);
    const since = startOfTodayUtc();

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

    const [promptRaw, judgeRaw] = await Promise.all([
      this.solvePromptRepo
        .createQueryBuilder("prompt")
        .innerJoin("prompt.strategyRun", "run")
        .where("run.modelName IN (:...models)", { models })
        .andWhere("prompt.createdAt >= :startOfTodayUtc", { startOfTodayUtc: since })
        .select("COALESCE(SUM(prompt.totalTokens), 0)", "totalTokens")
        .getRawOne<{ totalTokens: string }>(),
      this.categoryEvaluationRepo
        .createQueryBuilder("evaluation")
        .where("evaluation.judgeModel IN (:...models)", { models })
        .andWhere("evaluation.evaluatedAt >= :startOfTodayUtc", { startOfTodayUtc: since })
        .select("COALESCE(SUM(evaluation.totalTokens), 0)", "totalTokens")
        .getRawOne<{ totalTokens: string }>(),
    ]);

    const usedTokens = Number(promptRaw?.totalTokens ?? 0) + Number(judgeRaw?.totalTokens ?? 0);

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
