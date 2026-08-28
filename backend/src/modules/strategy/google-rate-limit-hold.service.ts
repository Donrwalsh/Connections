import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { GoogleRateLimitHold } from "./entities/google-rate-limit-hold.entity";

const PACIFIC_TZ = "America/Los_Angeles";

const PACIFIC_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * The Pacific wall-clock Y/M/D h:m:s of a given instant, read straight off
 * Intl's numeric parts. Deliberately never re-parses a formatted string as
 * host-local time — that only round-trips correctly when the *host's* own
 * offset is identical at both sampled instants, which is false for a host
 * whose DST transition falls between the two (e.g. America/Santiago).
 */
function pacificParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = PACIFIC_PARTS_FORMAT.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** The zone's UTC offset in ms at a given instant (negative for Pacific). */
function pacificOffsetMsAt(instantMs: number): number {
  const p = pacificParts(new Date(instantMs));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

/**
 * The UTC instant of 00:00:00 on the given Pacific calendar date. Two-pass:
 * the offset sampled at the naive instant gives a first approximation, then
 * re-sampling at that approximation settles the answer — which is what keeps
 * it correct on either side of a DST transition, where the offset at the
 * naive instant and at real Pacific midnight differ.
 */
function pacificMidnightToUtc(year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstPass = naive - pacificOffsetMsAt(naive);
  return new Date(naive - pacificOffsetMsAt(firstPass));
}

/**
 * The America/Los_Angeles calendar date of an instant as `YYYY-MM-DD`. Used
 * to date-stamp the resume sweep's job ids so a re-dispatch is fresh per
 * Pacific day but still idempotent within one.
 */
export function pacificDateStamp(now: Date = new Date()): string {
  const { year, month, day } = pacificParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The next 00:00 in America/Los_Angeles, expressed as a UTC Date. Google AI
 * Studio's free-tier requests-per-day quota resets at Pacific midnight, so
 * this is when a hold should lift.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const { year, month, day } = pacificParts(now);

  // Today's Pacific calendar date, advanced one day with date-only UTC math
  // (no clock component, so DST cannot skew it).
  const tomorrow = new Date(Date.UTC(year, month - 1, day) + 86_400_000);

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

  /**
   * The soonest still-future resetAt across this strategy's live holds, or
   * null when nothing is held. The resume sweep uses it to decide how long
   * to wait before re-arming itself for runs it could not revive yet.
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
