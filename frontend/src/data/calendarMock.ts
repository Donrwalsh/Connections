// Calendar-range helpers for the header's calendar popover. There's no real
// puzzle-ingestion/coverage data in the backend yet, so the popover just shows
// the puzzle date range (oldest ingested puzzle → today) as a plain month grid
// — no per-date performance data to color cells with yet.
//
// Swap isDateInRange / the month helpers for a real coverage lookup when the
// endpoint lands — the popover component should not need to change shape.

// Matches the backend's NYT_CONNECTIONS_ORIGIN_DATE fallback, but nothing
// enforced that agreement — see initCalendarRange, which fetches the real
// value from GET /game/data/earliest_date and keeps this in sync going
// forward. `let` (not `const`) so that reassignment is visible to every
// importer via ES module live bindings, without threading async state
// through CalendarPopover/Header.
export let CALENDAR_MIN_DATE = "2023-06-12";

/** Fetches the backend's actual earliest-puzzle date once and updates
 * CALENDAR_MIN_DATE to match. Fire-and-forget, called once at app startup
 * (see main.tsx): best-effort, so a failed fetch just leaves the fallback
 * above in place rather than blocking the calendar on it. */
export async function initCalendarRange(): Promise<void> {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/game/data/earliest_date`);
    if (!res.ok) return;
    const date: unknown = await res.json();
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      CALENDAR_MIN_DATE = date;
    }
  } catch {
    // Best-effort — keep the fallback.
  }
}

/** Today's date as a UTC ISO string — matches the backend's getTodaysPuzzle. */
export function todayUtcString(): string {
  return new Date().toISOString().split("T")[0];
}

/** Oldest puzzle month — the calendar cannot navigate before this. */
export function minMonth(): { year: number; monthIndex: number } {
  const date = new Date(`${CALENDAR_MIN_DATE}T00:00:00Z`);
  return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth() };
}

/** Latest puzzle month (today's month) — the calendar cannot navigate past this. */
export function maxMonth(): { year: number; monthIndex: number } {
  const date = new Date(`${todayUtcString()}T00:00:00Z`);
  return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth() };
}

/** Whether a date falls within the puzzle range (oldest ingested → today). */
export function isDateInRange(date: string): boolean {
  return date >= CALENDAR_MIN_DATE && date <= todayUtcString();
}

function shiftDateByDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return date.toISOString().split("T")[0];
}

/** Random date within the puzzle range (oldest ingested → today). */
export function randomPuzzleDate(): string {
  const [minYear, minMonth, minDay] = CALENDAR_MIN_DATE.split("-").map(Number);
  const today = todayUtcString();
  const [maxYear, maxMonth, maxDay] = today.split("-").map(Number);
  const start = Date.UTC(minYear ?? 0, (minMonth ?? 1) - 1, minDay ?? 1);
  const end = Date.UTC(maxYear ?? 0, (maxMonth ?? 1) - 1, maxDay ?? 1);
  const totalDays = Math.floor((end - start) / 86_400_000);
  const offset = Math.floor(Math.random() * (totalDays + 1));
  return shiftDateByDays(CALENDAR_MIN_DATE, offset);
}

export function monthLabel(year: number, monthIndex: number): string {
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export function shiftMonth(
  year: number,
  monthIndex: number,
  delta: number,
): { year: number; monthIndex: number } {
  const date = new Date(Date.UTC(year, monthIndex + delta, 1));
  return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth() };
}

/** 7-column grid for the given month, each entry an ISO date string (UTC) or
 * null for a blank leading/trailing cell. Padded to 42 cells (6 weeks) so the
 * grid is always the same rectangular shape. */
export function getMonthGrid(year: number, monthIndex: number): (string | null)[] {
  const leadingBlanks = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(); // 0 = Sunday
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

  const cells: (string | null)[] = Array.from({ length: leadingBlanks }, () => null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(
      `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
  }
  while (cells.length < 42) cells.push(null);
  return cells;
}
