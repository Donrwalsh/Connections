import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { SambaNovaRateLimitHold } from "./entities/sambanova-rate-limit-hold.entity";

/**
 * The SambaNova counterpart to GroqRateLimitHoldService: source of truth
 * for which SambaNova models are currently held for exhausting a free-tier
 * per-day quota. No timezone math — SambaNova's rate-limit headers give a
 * reset *duration* from the moment of the hit (see orchestrator/src/solver.ts's
 * sambanova branch), not a fixed daily clock boundary. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md.
 */
@Injectable()
export class SambaNovaRateLimitHoldService {
  private readonly logger = new Logger(SambaNovaRateLimitHoldService.name);

  constructor(
    @InjectRepository(SambaNovaRateLimitHold)
    private readonly repo: Repository<SambaNovaRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string, resetInSeconds: number): Promise<void> {
    const heldAt = new Date();
    const resetAt = new Date(heldAt.getTime() + resetInSeconds * 1000);
    await this.repo.upsert({ strategyName, modelName, heldAt, resetAt }, ["strategyName", "modelName"]);
    this.logger.warn(`RPD hold set for ${strategyName}/${modelName} until ${resetAt.toISOString()}`);
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
   * null when nothing is held. SambaNovaRpdResumeService uses this as the
   * sole ongoing scheduling signal (there is no fixed cron), same as Groq.
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
