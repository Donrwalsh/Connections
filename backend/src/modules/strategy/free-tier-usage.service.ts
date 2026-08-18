import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SolvePrompt } from "./entities/solve-prompt.entity";

// Two separate provider programs, each with its own daily token allowance
// and its own fixed model list. Membership/limits are a program fact, not
// something the SupportedModel allowlist tracks (a model can be supported/
// dispatchable without being part of either program) — so both are kept
// here as plain config rather than DB columns. A model belongs to at most
// one program; there's no overlap between the two lists below.
export type FreeTierId = "flagship" | "mini";

export interface FreeTierProgram {
  id: FreeTierId;
  // Human-readable description of which models this program covers —
  // returned to callers so the frontend doesn't need its own copy of
  // "which models are in each tier" just to explain the number it's
  // showing.
  label: string;
  models: readonly string[];
  dailyLimitTokens: number;
}

export const FLAGSHIP_FREE_TIER: FreeTierProgram = {
  id: "flagship",
  label: "Flagship models",
  models: ["gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o1", "o3"],
  dailyLimitTokens: 250_000,
};

export const MINI_FREE_TIER: FreeTierProgram = {
  id: "mini",
  label: "Mini & nano models",
  models: [
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5-mini",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o-mini",
    "o3-mini",
    "o4-mini",
    "gpt-5-nano",
  ],
  dailyLimitTokens: 2_500_000,
};

export interface FreeTierUsageDto {
  tier: FreeTierId;
  label: string;
  usedTokens: number;
  dailyLimitTokens: number;
  remainingTokens: number;
  // The models counted toward usedTokens — see FreeTierProgram.models.
  models: string[];
}

@Injectable()
export class FreeTierUsageService {
  constructor(
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
  ) {}

  async getFlagshipUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage(FLAGSHIP_FREE_TIER);
  }

  async getMiniUsage(): Promise<FreeTierUsageDto> {
    return this.getUsage(MINI_FREE_TIER);
  }

  /**
   * Tokens spent today (UTC) across every run of one of `program`'s models,
   * summed from SolvePrompt.totalTokens — the same per-call token figure
   * StrategyService's cost calculations use. "Today" resets at UTC midnight
   * rather than server-local time, since that's when the provider's own
   * usage window resets. Shared by both getFlagshipUsage/getMiniUsage so the
   * query itself only exists once — the two programs differ only in which
   * models/limit they pass in, not in how usage is computed.
   */
  private async getUsage(program: FreeTierProgram): Promise<FreeTierUsageDto> {
    const startOfTodayUtc = FreeTierUsageService.startOfTodayUtc();

    const raw = await this.solvePromptRepo
      .createQueryBuilder("prompt")
      .innerJoin("prompt.strategyRun", "run")
      .where("run.modelName IN (:...models)", { models: program.models })
      .andWhere("prompt.createdAt >= :startOfTodayUtc", { startOfTodayUtc })
      .select("COALESCE(SUM(prompt.totalTokens), 0)", "totalTokens")
      .getRawOne<{ totalTokens: string }>();

    const usedTokens = Number(raw?.totalTokens ?? 0);

    return {
      tier: program.id,
      label: program.label,
      usedTokens,
      dailyLimitTokens: program.dailyLimitTokens,
      remainingTokens: Math.max(0, program.dailyLimitTokens - usedTokens),
      models: [...program.models],
    };
  }

  private static startOfTodayUtc(now: Date = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
