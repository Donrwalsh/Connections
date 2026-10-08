import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, EntityManager, Repository } from "typeorm";
import { FreeTierReservation } from "./entities/free-tier-reservation.entity";
import { FREE_TIER_LIMITS, FreeTierId, FreeTierUsageService } from "./free-tier-usage.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { LLM_OPENAI, startOfTodayUtc } from "../../strategies";

export interface ReservationSettlement {
  reservationId: number;
  // True when the call reported usage (its SolvePrompt row carries the real
  // figure, so the reservation is released); false when it didn't (timeout /
  // call error — OpenAI may still have billed it, so the reservation stays).
  recorded: boolean;
}

/**
 * Hard guarantee that free-tier-dispatched llm-openai calls never push a
 * tier's spend past its cycle threshold. Before each call a run reserves the
 * call's worst case (input upper bound + the model's maxOutputTokens); the
 * reservation succeeds only if recorded usage + today's outstanding
 * reservations + this call still fit. Reservations for one tier are
 * serialized by a row lock on that tier's FreeTierDispatchState row, so two
 * concurrent runs can never both take the last of the room. See
 * docs/specs/2026-10-08-free-tier-budget-reservation-design.md.
 */
@Injectable()
export class FreeTierBudgetService {
  private readonly logger = new Logger(FreeTierBudgetService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FreeTierReservation)
    private readonly reservationRepo: Repository<FreeTierReservation>,
    @Inject(FreeTierUsageService) private readonly freeTierUsage: FreeTierUsageService,
    @Inject(SupportedModelService) private readonly supportedModels: SupportedModelService,
  ) {}

  /** Returns the new reservation's id, or null when the call doesn't fit, the
   * tier has no active cycle, or anything goes wrong (fail closed). */
  async reserve(tier: FreeTierId, strategyRunId: number, tokens: number): Promise<number | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const [state] = (await manager.query(
          `SELECT "active", "thresholdPercent" FROM "FreeTierDispatchState" WHERE "tier" = $1 FOR UPDATE`,
          [tier],
        )) as { active: boolean; thresholdPercent: number }[];
        if (!state?.active) return null;

        const threshold = Math.floor(
          FREE_TIER_LIMITS[tier].dailyLimitTokens * (state.thresholdPercent / 100),
        );
        const committed = await this.committedWith(manager, tier);
        if (committed + tokens > threshold) return null;

        const result = await manager.insert(FreeTierReservation, {
          tier,
          strategyRunId,
          reservedTokens: tokens,
          status: "pending",
        });
        return result.identifiers[0].id as number;
      });
    } catch (err) {
      this.logger.error(
        `reserving ${tokens} '${tier}' tokens for run ${strategyRunId} failed — treating as no room: ` +
          `${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Recorded usage + today's outstanding reservations, unlocked — the
   * dispatch tick's view of how much of the threshold is spoken for. */
  async committedTokens(tier: FreeTierId): Promise<number> {
    return this.committedWith(this.reservationRepo.manager, tier);
  }

  /** Per-call output caps for llm-openai models (null = no cap). */
  async modelCaps(models: readonly string[]): Promise<Map<string, number | null>> {
    return this.supportedModels.getMaxOutputTokensByModel(LLM_OPENAI, models);
  }

  // Reservations are read BEFORE recorded usage, deliberately. A settle
  // deletes a reservation and inserts its SolvePrompt row in one commit; if
  // that commit lands between these two reads, this order sees both (an
  // over-count), never neither (an under-count that could let a call through).
  private async committedWith(manager: EntityManager, tier: FreeTierId): Promise<number> {
    const raw = await manager
      .createQueryBuilder(FreeTierReservation, "reservation")
      .select('COALESCE(SUM(reservation."reservedTokens"), 0)', "total")
      .where("reservation.tier = :tier", { tier })
      .andWhere('reservation."createdAt" >= :since', { since: startOfTodayUtc() })
      .getRawOne<{ total: string }>();
    const { usedTokens } = await this.freeTierUsage.getUsage(tier);
    return Number(raw?.total ?? 0) + usedTokens;
  }
}

/** Runs inside StrategyRunStore.flushBatch's transaction, so a recorded call's
 * reservation disappears in the same commit its SolvePrompt row appears. */
export async function settleReservationTx(
  manager: EntityManager,
  settlement: ReservationSettlement,
): Promise<void> {
  if (settlement.recorded) {
    await manager.delete(FreeTierReservation, { id: settlement.reservationId });
  } else {
    await manager.update(
      FreeTierReservation,
      { id: settlement.reservationId },
      { status: "unrecorded" },
    );
  }
}
