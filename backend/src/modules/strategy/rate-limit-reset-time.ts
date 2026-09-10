/**
 * Reset-clock helpers shared by the rate-limit hold path. These moved here
 * verbatim when the five per-provider *RateLimitHoldService classes were
 * unified into one RateLimitHoldService (which is provider-agnostic and takes
 * a resetInSeconds it does not compute): the callers that decide *when* a hold
 * lifts — the strategy runner and the per-provider resume sweeps — now import
 * the clock math directly from here.
 *
 * `nextPacificMidnight` / `pacificDateStamp` were previously exported from
 * google-rate-limit-hold.service.ts; `secondsUntilNextUtcMidnight` from
 * openrouter-rate-limit-hold.service.ts.
 */

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
 * this is when an llm-google hold should lift.
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
 * The seconds from `now` to the next 00:00:00 UTC — the fallback resetAt for
 * an llm-openrouter 'daily' hold when the orchestrator couldn't parse a
 * dailyResetSeconds from the 429 (OpenRouter's daily quota always resets at
 * UTC midnight).
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
