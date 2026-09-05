import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LLM_OPENROUTER } from "../../strategies";
import { OpenRouterRateLimitHold } from "./entities/openrouter-rate-limit-hold.entity";

export type OpenRouterHoldReason = "daily" | "per-minute-cooldown";

/**
 * The seconds from `now` to the next 00:00:00 UTC — the fallback resetAt for
 * a 'daily' hold when the orchestrator couldn't parse a dailyResetSeconds
 * from the 429 (OpenRouter's daily quota always resets at UTC midnight).
 * Exported as a plain function so the runner and tests can use it directly.
 */
export function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(0, Math.round((nextMidnight - now.getTime()) / 1000));
}

/**
 * The OpenRouter counterpart to GroqRateLimitHoldService — the simplest of
 * the three, because OpenRouter's free-tier limit is account-wide, not
 * per-model, and its reset clock is fixed UTC (no timezone math, no per-hit
 * duration). There is ever exactly one row (unique on strategyName). See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §3.
 */
@Injectable()
export class OpenRouterRateLimitHoldService {
  private readonly logger = new Logger(OpenRouterRateLimitHoldService.name);

  constructor(
    @InjectRepository(OpenRouterRateLimitHold)
    private readonly repo: Repository<OpenRouterRateLimitHold>,
  ) {}

  private async liveRow(): Promise<OpenRouterRateLimitHold | null> {
    const row = await this.repo.findOne({ where: { strategyName: LLM_OPENROUTER } });
    return row && row.resetAt.getTime() > Date.now() ? row : null;
  }

  /**
   * Sets or refreshes the single hold row. A 'per-minute-cooldown' request
   * is a no-op when a 'daily' hold is already live (the daily hold is the
   * stronger, longer signal); a 'daily' request always wins.
   */
  async hold(reason: OpenRouterHoldReason, resetInSeconds: number): Promise<void> {
    if (reason === "per-minute-cooldown") {
      const live = await this.liveRow();
      if (live?.reason === "daily") return;
    }

    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert(
      { strategyName: LLM_OPENROUTER, heldAt, resetAt, reason },
      ["strategyName"],
    );
    this.logger.warn(`OpenRouter ${reason} hold set until ${resetAt.toISOString()}`);
  }

  async isHeld(): Promise<boolean> {
    return (await this.liveRow()) !== null;
  }

  async heldReason(): Promise<OpenRouterHoldReason | null> {
    return (await this.liveRow())?.reason ?? null;
  }

  async nextResetAt(): Promise<Date | null> {
    return (await this.liveRow())?.resetAt ?? null;
  }

  /**
   * Deletes the row if its resetAt has passed. Returns whether a row was
   * actually cleared, so the resume sweep can log/act on it.
   */
  async clearExpired(): Promise<boolean> {
    const row = await this.repo.findOne({ where: { strategyName: LLM_OPENROUTER } });
    if (!row || row.resetAt.getTime() > Date.now()) return false;
    await this.repo.delete({ strategyName: LLM_OPENROUTER });
    return true;
  }
}
