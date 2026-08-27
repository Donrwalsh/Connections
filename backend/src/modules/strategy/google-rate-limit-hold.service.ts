import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";

const PACIFIC_TZ = "America/Los_Angeles";

/**
 * The UTC instant of 00:00:00 on the given Pacific calendar date. Measures
 * the zone's UTC offset *at that date* (via toLocaleString round-tripping)
 * so it stays correct on either side of a DST transition.
 */
function pacificMidnightToUtc(year: number, month: number, day: number): Date {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const asPacificWall = new Date(utcGuess).toLocaleString("en-US", { timeZone: PACIFIC_TZ });
  const asUtcWall = new Date(utcGuess).toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs = new Date(asPacificWall).getTime() - new Date(asUtcWall).getTime();
  return new Date(utcGuess - offsetMs);
}

/**
 * The next 00:00 in America/Los_Angeles, expressed as a UTC Date. Google AI
 * Studio's free-tier requests-per-day quota resets at Pacific midnight, so
 * this is when a hold should lift.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  // Today's Pacific calendar date, advanced one day with date-only UTC math
  // (no clock component, so DST cannot skew it).
  const tomorrow = new Date(Date.UTC(part("year"), part("month") - 1, part("day")) + 86_400_000);

  return pacificMidnightToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
  );
}

/**
 * The source of truth for which Google models are currently held for
 * exhausting their free-tier requests-per-day quota. One row per held
 * (strategyName, modelName); the google-rpd-resume sweep clears rows whose
 * resetAt has passed. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Injectable()
export class GoogleRateLimitHoldService {
  private readonly logger = new Logger(GoogleRateLimitHoldService.name);

  constructor(
    @InjectRepository(GoogleRateLimitHold)
    private readonly repo: Repository<GoogleRateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string): Promise<void> {
    const resetAt = nextPacificMidnight();
    await this.repo.upsert(
      { strategyName, modelName, heldAt: new Date(), resetAt },
      ["strategyName", "modelName"],
    );
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
