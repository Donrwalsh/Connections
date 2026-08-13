import { describe, expect, it, vi } from "vitest";
import {
  CALENDAR_MIN_DATE,
  getMonthGrid,
  isDateInRange,
  maxMonth,
  minMonth,
  monthLabel,
  randomPuzzleDate,
  shiftMonth,
  todayUtcString,
} from "../calendarMock";

describe("todayUtcString", () => {
  it("returns today as a UTC ISO date string", () => {
    expect(todayUtcString()).toBe(new Date().toISOString().split("T")[0]);
    expect(todayUtcString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("minMonth / maxMonth", () => {
  it("minMonth is the oldest puzzle month (June 2023)", () => {
    expect(minMonth()).toEqual({ year: 2023, monthIndex: 5 });
  });

  it("maxMonth is the current month", () => {
    const today = todayUtcString();
    const [year, month] = today.split("-").map(Number);
    expect(maxMonth()).toEqual({ year: year ?? 0, monthIndex: (month ?? 1) - 1 });
  });
});

describe("isDateInRange", () => {
  it("accepts dates from the oldest puzzle through today", () => {
    expect(isDateInRange(CALENDAR_MIN_DATE)).toBe(true);
    expect(isDateInRange(todayUtcString())).toBe(true);
    expect(isDateInRange("2025-01-15")).toBe(true);
  });

  it("rejects dates before the oldest puzzle", () => {
    expect(isDateInRange("2023-06-11")).toBe(false);
    expect(isDateInRange("2020-01-01")).toBe(false);
  });

  it("rejects dates after today", () => {
    const today = todayUtcString();
    const [year, month, day] = today.split("-").map(Number);
    const tomorrow = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1))
      .toISOString()
      .split("T")[0];
    expect(isDateInRange(tomorrow)).toBe(false);
  });
});

describe("randomPuzzleDate", () => {
  it("always returns a date within the puzzle range", () => {
    for (let i = 0; i < 50; i++) {
      const date = randomPuzzleDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(date >= CALENDAR_MIN_DATE).toBe(true);
      expect(date <= todayUtcString()).toBe(true);
    }
  });

  it("can return the first and last dates in the range", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(randomPuzzleDate()).toBe(CALENDAR_MIN_DATE);
    vi.restoreAllMocks();

    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(randomPuzzleDate()).toBe(todayUtcString());
    vi.restoreAllMocks();
  });
});

describe("shiftMonth", () => {
  it("moves forward within a year", () => {
    expect(shiftMonth(2025, 0, 1)).toEqual({ year: 2025, monthIndex: 1 });
  });

  it("rolls forward into the next year", () => {
    expect(shiftMonth(2025, 11, 1)).toEqual({ year: 2026, monthIndex: 0 });
  });

  it("rolls back into the previous year", () => {
    expect(shiftMonth(2025, 0, -1)).toEqual({ year: 2024, monthIndex: 11 });
  });
});

describe("monthLabel", () => {
  it("formats the month and year", () => {
    expect(monthLabel(2025, 0)).toBe("January 2025");
    expect(monthLabel(2024, 11)).toBe("December 2024");
  });
});

describe("getMonthGrid", () => {
  it("always returns a full 42-cell grid", () => {
    for (let month = 0; month < 12; month++) {
      expect(getMonthGrid(2025, month)).toHaveLength(42);
    }
  });

  it("places the 1st on the correct weekday offset", () => {
    // 2025-01-01 is a Wednesday (getUTCDay() === 3).
    const grid = getMonthGrid(2025, 0);
    expect(grid[3]).toBe("2025-01-01");
    expect(grid.slice(0, 3)).toEqual([null, null, null]);
  });

  it("fills the full range of days in the month", () => {
    const grid = getMonthGrid(2025, 1); // February 2025, 28 days
    const days = grid.filter((cell) => cell?.startsWith("2025-02-"));
    expect(days).toHaveLength(28);
  });

  it("pads the tail with nulls", () => {
    const grid = getMonthGrid(2025, 0);
    const lastFilledIndex = grid.findLastIndex((cell) => cell !== null);
    expect(grid.slice(lastFilledIndex + 1)).toEqual(Array(42 - lastFilledIndex - 1).fill(null));
  });
});
