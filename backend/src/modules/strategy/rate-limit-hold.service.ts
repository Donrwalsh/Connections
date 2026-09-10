import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IsNull, LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { RateLimitHold } from "./entities/rate-limit-hold.entity";

/**
 * The reason an account-wide (OpenRouter) hold was set. 'daily' means the
 * account-wide requests-per-day quota is spent (resetAt = next UTC midnight);
 * 'per-minute-cooldown' is a short global backoff after a 20 RPM 429. Per-model
 * providers never set a reason.
 */
export type RateLimitHoldReason = "daily" | "per-minute-cooldown";

export interface ClearExpiredResult {
  /** Model names of expired per-model rows that were deleted. */
  clearedModels: string[];
  /** Whether an expired account-wide (modelName IS NULL) row was deleted. */
  clearedAccountWide: boolean;
}

interface HoldOptions {
  /** Omit for an account-wide hold (the row's modelName is stored NULL). */
  modelName?: string;
  /** Account-wide callers only. */
  reason?: RateLimitHoldReason;
  /** Seconds from now until the hold lifts; the caller derives this. */
  resetInSeconds: number;
}

/**
 * The one hold store behind the former five per-provider
 * *RateLimitHoldService classes. Per-model callers pass a `modelName`;
 * account-wide callers (OpenRouter) pass none and a `reason`. Nothing
 * provider-specific lives here except the account-wide precedence rule in
 * `hold`, which is reason-gated and therefore inert for per-model callers.
 */
@Injectable()
export class RateLimitHoldService {
  private readonly logger = new Logger(RateLimitHoldService.name);

  constructor(
    @InjectRepository(RateLimitHold)
    private readonly repo: Repository<RateLimitHold>,
  ) {}

  /** The live account-wide row for a strategy, or null if none / expired. */
  private async liveAccountRow(strategyName: string): Promise<RateLimitHold | null> {
    const row = await this.repo.findOne({ where: { strategyName, modelName: IsNull() } });
    return row !== null && row.resetAt.getTime() > Date.now() ? row : null;
  }

  /**
   * Sets or refreshes a hold. With a `modelName` it is a per-model hold keyed
   * on (strategyName, modelName); without one it is the strategy's single
   * account-wide row. A 'per-minute-cooldown' request is a no-op while a
   * 'daily' hold is already live (the daily hold is the stronger, longer
   * signal); a 'daily' request always wins.
   */
  async hold(strategyName: string, opts: HoldOptions): Promise<void> {
    const modelName = opts.modelName ?? null;
    const reason = opts.reason ?? null;

    if (reason === "per-minute-cooldown") {
      const live = await this.liveAccountRow(strategyName);
      if (live?.reason === "daily") return;
    }

    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + opts.resetInSeconds * 1000);
    const row = { strategyName, modelName, reason, heldAt, resetAt };

    if (modelName === null) {
      await this.repo.upsert(row, {
        conflictPaths: ["strategyName"],
        indexPredicate: '"modelName" IS NULL',
      });
    } else {
      await this.repo.upsert(row, ["strategyName", "modelName"]);
    }

    this.logger.warn(
      `rate-limit hold set for ${strategyName}` +
        `${modelName === null ? "" : `/${modelName}`}` +
        `${reason === null ? "" : ` (${reason})`} until ${resetAt.toISOString()}`,
    );
  }

  /**
   * Whether a hold is currently live. With a `modelName`, checks that model's
   * row; without one, checks the strategy's account-wide row.
   */
  async isHeld(strategyName: string, modelName?: string): Promise<boolean> {
    const where =
      modelName === undefined
        ? { strategyName, modelName: IsNull() }
        : { strategyName, modelName };
    const row = await this.repo.findOne({ where });
    return row !== null && row.resetAt.getTime() > Date.now();
  }

  /** The live account-wide hold's reason, or null. Account-scope callers. */
  async heldReason(strategyName: string): Promise<RateLimitHoldReason | null> {
    const row = await this.liveAccountRow(strategyName);
    return (row?.reason as RateLimitHoldReason | undefined) ?? null;
  }

  /**
   * The model names with a live per-model hold for this strategy. Empty for an
   * account-wide strategy (its row has a NULL modelName, which is filtered).
   */
  async heldModels(strategyName: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { strategyName, resetAt: MoreThan(new Date()) },
    });
    return rows.map((r) => r.modelName).filter((m): m is string => m !== null);
  }

  /**
   * The soonest still-future resetAt across this strategy's live holds
   * (per-model and account-wide), or null when nothing is held.
   */
  async nextResetAt(strategyName: string): Promise<Date | null> {
    const rows = await this.repo.find({
      where: { strategyName, resetAt: MoreThan(new Date()) },
    });
    if (rows.length === 0) return null;
    return rows.reduce((soonest, row) =>
      row.resetAt.getTime() < soonest.resetAt.getTime() ? row : soonest,
    ).resetAt;
  }

  /**
   * Deletes every hold whose resetAt has passed — for one strategy when
   * `strategyName` is given, otherwise across all pools. Reports which per-model
   * models and whether an account-wide row were cleared, so both the per-model
   * and the account-wide resume sweeps can act on their own shape.
   */
  async clearExpired(strategyName?: string): Promise<ClearExpiredResult> {
    const where =
      strategyName === undefined
        ? { resetAt: LessThanOrEqual(new Date()) }
        : { strategyName, resetAt: LessThanOrEqual(new Date()) };
    const expired = await this.repo.find({ where });
    if (expired.length > 0) {
      await this.repo.remove(expired);
    }
    return {
      clearedModels: expired.map((r) => r.modelName).filter((m): m is string => m !== null),
      clearedAccountWide: expired.some((r) => r.modelName === null),
    };
  }
}
