import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThanOrEqual, MoreThan, Repository } from "typeorm";
import { LLM_GOOGLE } from "../../strategies";
import { RateLimitHold } from "./entities/rate-limit-hold.entity";

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

const UTC_PARTS_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
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
function wallClockParts(
  at: Date,
  format: Intl.DateTimeFormat,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = format.formatToParts(at);
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
function zoneOffsetMsAt(instantMs: number, format: Intl.DateTimeFormat): number {
  const p = wallClockParts(new Date(instantMs), format);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

/**
 * The UTC instant of 00:00:00 on the given calendar date in a DST-aware zone.
 * Two-pass: the offset sampled at the naive instant gives a first
 * approximation, then re-sampling at that approximation settles the answer —
 * which is what keeps it correct on either side of a DST transition, where
 * the offset at the naive instant and at real zone midnight differ.
 */
function zoneMidnightToUtc(
  year: number,
  month: number,
  day: number,
  format: Intl.DateTimeFormat,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstPass = naive - zoneOffsetMsAt(naive, format);
  return new Date(naive - zoneOffsetMsAt(firstPass, format));
}

/**
 * The America/Los_Angeles calendar date of an instant as `YYYY-MM-DD`. Used
 * to date-stamp the Google side of the resume sweep's job ids so a
 * re-dispatch is fresh per Pacific day but still idempotent within one.
 */
export function pacificDateStamp(now: Date = new Date()): string {
  const { year, month, day } = wallClockParts(now, PACIFIC_PARTS_FORMAT);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The next 00:00 in America/Los_Angeles, expressed as a UTC Date. Google AI
 * Studio's free-tier requests-per-day quota resets at Pacific midnight, so
 * this is when an llm-google hold should lift.
 */
export function nextPacificMidnight(now: Date = new Date()): Date {
  const { year, month, day } = wallClockParts(now, PACIFIC_PARTS_FORMAT);

  // Today's Pacific calendar date, advanced one day with date-only UTC math
  // (no clock component, so DST cannot skew it).
  const tomorrow = new Date(Date.UTC(year, month - 1, day) + 86_400_000);

  return zoneMidnightToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    PACIFIC_PARTS_FORMAT,
  );
}

/**
 * The next 00:00 UTC, expressed as a UTC Date. Groq's free-tier requests-
 * per-day quota resets at UTC midnight, so this is when an llm-groq hold
 * should lift.
 */
export function nextUtcMidnight(now: Date = new Date()): Date {
  const tomorrow = new Date(now.getTime() + 86_400_000);
  return new Date(
    Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate()),
  );
}

/**
 * The UTC calendar date of an instant as `YYYY-MM-DD`. Date-stamps the Groq
 * side of the resume sweep's job ids.
 */
export function utcDateStamp(now: Date = new Date()): string {
  const { year, month, day } = wallClockParts(now, UTC_PARTS_FORMAT);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** When a strategy's free-tier RPD quota resets (as a UTC Date). */
export function strategyResetAt(strategyName: string, now: Date = new Date()): Date {
  return strategyName === LLM_GOOGLE ? nextPacificMidnight(now) : nextUtcMidnight(now);
}

/** Calendar-date stamp for a strategy's reset boundary. */
export function strategyDateStamp(strategyName: string, now: Date = new Date()): string {
  return strategyName === LLM_GOOGLE ? pacificDateStamp(now) : utcDateStamp(now);
}

/**
 * The source of truth for which models are currently held for exhausting a
 * provider's free-tier requests-per-day quota. One row per held
 * (strategyName, modelName); the rpd-resume sweep clears rows whose resetAt
 * has passed. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md and
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Injectable()
export class RateLimitHoldService {
  private readonly logger = new Logger(RateLimitHoldService.name);

  constructor(
    @InjectRepository(RateLimitHold)
    private readonly repo: Repository<RateLimitHold>,
  ) {}

  async hold(strategyName: string, modelName: string): Promise<void> {
    const resetAt = strategyResetAt(strategyName);
    await this.repo.upsert({ strategyName, modelName, heldAt: new Date(), resetAt }, [
      "strategyName",
      "modelName",
    ]);
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
