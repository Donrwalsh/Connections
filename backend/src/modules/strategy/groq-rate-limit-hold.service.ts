import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { GroqRateLimitHold } from "./entities/groq-rate-limit-hold.entity";

/**
 * The Groq counterpart to GoogleRateLimitHoldService: source of truth for
 * which Groq models are currently held for exhausting their free-tier
 * requests-per-day quota. Simpler than the Google version — no timezone
 * math at all, since Groq's own rate-limit headers give a reset *duration*
 * from the moment of the hit (see orchestrator/src/solver.ts's
 * parseGroqResetDuration) rather than a fixed daily clock boundary the way
 * Google's Pacific-midnight reset is. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class GroqRateLimitHoldService {
  private readonly logger = new Logger(GroqRateLimitHoldService.name);

  constructor(
    @InjectRepository(GroqRateLimitHold)
    private readonly repo: Repository<GroqRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void> {
    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert({ strategyName, modelName, heldAt, resetAt }, ["strategyName", "modelName"]);
    this.logger.warn(
      `RPD hold set for ${strategyName}/${modelName} until ${resetAt.toISOString()}`,
    );
  }

  async isHeld(strategyName: string, modelName: string): Promise<boolean> {
    const row = await this.repo.findOne({ where: { strategyName, modelName } });
    return row !== null && row.resetAt.getTime() > Date.now();
  }

  async heldModels(strategyName: string): Promise<string[]> {
    const rows = await this.repo.find({
      where: { strategyName, resetAt: MoreThan(new Date()) },
    });
    return rows.map((r) => r.modelName);
  }

  /**
   * The soonest still-future resetAt across this strategy's live holds, or
   * null when nothing is held. GroqRpdResumeService uses this both to
   * decide how long to wait before re-arming itself for runs it could not
   * revive yet, and — unlike Google, where this is only a fallback path —
   * as the sole ongoing scheduling signal, since there is no fixed daily
   * cron for Groq's resume sweep.
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

  async clearExpired(): Promise<string[]> {
    const expired = await this.repo.find({
      where: { resetAt: LessThanOrEqual(new Date()) },
    });
    if (expired.length > 0) {
      await this.repo.remove(expired);
    }
    return expired.map((r) => r.modelName);
  }
}
