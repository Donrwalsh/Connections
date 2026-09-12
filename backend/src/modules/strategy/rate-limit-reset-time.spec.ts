import {
  nextPacificMidnight,
  pacificDateStamp,
  secondsUntilNextUtcMidnight,
} from "./rate-limit-reset-time";

describe("nextPacificMidnight", () => {
  it("returns the next Pacific midnight in UTC during PST (UTC-8)", () => {
    // 2026-01-15 12:00 PST
    const now = new Date("2026-01-15T20:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("returns the next Pacific midnight in UTC during PDT (UTC-7)", () => {
    // 2026-07-15 11:00 PDT
    const now = new Date("2026-07-15T18:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  it("returns the upcoming midnight (not one 24h later) when already late Pacific evening", () => {
    // 2026-01-15 23:30 PST
    const now = new Date("2026-01-16T07:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("rolls to the following day when just past Pacific midnight", () => {
    // 2026-01-16 00:30 PST
    const now = new Date("2026-01-16T08:30:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-17T08:00:00.000Z");
  });

  it("lands on the spring-forward day's PDT midnight (the following day is UTC-7)", () => {
    // 2026-03-08 01:00 PST — the day the clocks jump forward at 02:00.
    const now = new Date("2026-03-08T09:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("lands on the fall-back day's PST midnight (the following day is UTC-8)", () => {
    // 2026-11-01 01:00 PDT — the day the clocks fall back at 02:00.
    const now = new Date("2026-11-01T08:00:00Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("returns the *next* midnight when now is exactly a Pacific midnight instant", () => {
    // 2026-01-16 00:00:00.000 PST exactly.
    const now = new Date("2026-01-16T08:00:00.000Z");
    expect(nextPacificMidnight(now).toISOString()).toBe("2026-01-17T08:00:00.000Z");
  });
});

describe("pacificDateStamp", () => {
  it("returns the Pacific calendar date as YYYY-MM-DD", () => {
    // 2026-01-15 12:00 PST
    expect(pacificDateStamp(new Date("2026-01-15T20:00:00Z"))).toBe("2026-01-15");
  });

  it("uses the Pacific day, not the UTC day, either side of midnight", () => {
    // 2026-01-16 00:30 UTC is still 2026-01-15 16:30 PST.
    expect(pacificDateStamp(new Date("2026-01-16T00:30:00Z"))).toBe("2026-01-15");
    // 2026-01-16 08:30 UTC is 2026-01-16 00:30 PST.
    expect(pacificDateStamp(new Date("2026-01-16T08:30:00Z"))).toBe("2026-01-16");
  });

  it("zero-pads single-digit months and days", () => {
    expect(pacificDateStamp(new Date("2026-03-09T20:00:00Z"))).toBe("2026-03-09");
  });
});

describe("secondsUntilNextUtcMidnight", () => {
  it("is the seconds from the given instant to the next 00:00:00 UTC, never negative", () => {
    const at = new Date("2026-09-05T23:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(3600);
  });

  it("returns a full day when called exactly at UTC midnight", () => {
    const at = new Date("2026-09-05T00:00:00.000Z");
    expect(secondsUntilNextUtcMidnight(at)).toBe(86_400);
  });
});
