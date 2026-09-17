// Column-header sort logic for the leaderboard tables: which columns each
// table can sort by, how to read a value off a strategy row for a given
// column, and how to sort by it in either direction. Kept framework-free so
// it is unit-testable without rendering.

import type { LeaderboardRow } from "./types";

/** Every column either StrategyTable variant can sort by. "duration" (raw
 * avgDurationMs, lower is better) backs the LLM table's "Avg duration"
 * column; "speed" (a derived solves/hr rate, higher is better) backs the
 * deterministic table's "Avg speed" column instead — kept as two separate
 * keys, rather than one shared "speed" key across both, so a column's
 * asc/desc arrow always matches the literal direction of the value that
 * column actually displays. */
export type LeaderboardSortKey =
  | "name"
  | "avgGuesses"
  | "successRate"
  | "duration"
  | "speed"
  | "categoryAccuracy"
  | "range"
  | "progress";

export type LeaderboardSortDir = "asc" | "desc";

/** Whether a larger value is "best" for a column — used only to pick the
 * direction a freshly-clicked column starts in; a second click on the same
 * column flips it regardless (see useLeaderboardSort). "name" isn't a
 * "bigger is better" metric at all, but false gives it the same natural
 * starting point (A-first ascending) as every other "false" column. */
const HIGHER_IS_BETTER: Record<LeaderboardSortKey, boolean> = {
  name: false,
  avgGuesses: false,
  successRate: true,
  duration: false,
  speed: true,
  categoryAccuracy: true,
  range: false,
  progress: true,
};

export function defaultSortDir(key: LeaderboardSortKey): LeaderboardSortDir {
  return HIGHER_IS_BETTER[key] ? "desc" : "asc";
}

/** Row shape with every field a leaderboard sort column can read from (see
 * the live LeaderboardRow in types.ts) — the helpers below don't need to
 * know the concrete row type, just that it has these. "name" is the
 * already-formatted display name (see describeLeaderboardRow) rather than
 * the raw strategyName field, since that's what the Strategy column
 * actually shows — and, for LLM rows, several rows can share one
 * strategyName (e.g. every "llm-openai" row) while their display names
 * (the model names) differ. */
export interface LeaderboardSortSource {
  name: string;
  avgGuessesToSolve: number | null;
  successRate: number | null;
  avgDurationMs: number | null;
  categoryAccuracy: number | null;
  maxGuesses: number | null;
  puzzlesCovered: number;
}

export function leaderboardSortValue(
  strategy: LeaderboardSortSource,
  key: LeaderboardSortKey,
): number | string | null {
  switch (key) {
    case "name":
      return strategy.name;
    case "avgGuesses":
      return strategy.avgGuessesToSolve;
    case "successRate":
      return strategy.successRate;
    case "duration":
      return strategy.avgDurationMs;
    case "speed":
      return strategy.avgDurationMs === null ? null : 3_600_000 / strategy.avgDurationMs;
    case "categoryAccuracy":
      return strategy.categoryAccuracy;
    case "range":
      return strategy.maxGuesses;
    case "progress":
      return strategy.puzzlesCovered;
  }
}

/** Sorts leaderboard rows by a column in the given direction; nulls always
 * sort last regardless of direction. String-valued columns (currently just
 * "name") compare with localeCompare instead of subtraction. */
export function sortLeaderboardRows<T extends LeaderboardSortSource>(
  rows: T[],
  key: LeaderboardSortKey,
  dir: LeaderboardSortDir,
): T[] {
  return [...rows].sort((a, b) => {
    const aValue = leaderboardSortValue(a, key);
    const bValue = leaderboardSortValue(b, key);
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    const diff =
      typeof aValue === "string" && typeof bValue === "string"
        ? aValue.localeCompare(bValue)
        : (aValue as number) - (bValue as number);
    return dir === "asc" ? diff : -diff;
  });
}

/** Guess-count formatter for the deterministic/shuffle table — unlike the
 * "Avg guesses" metric's own format() (tuned for LLM runs, which solve or
 * fail within single digits), brute-force strategies aren't capped by a
 * mistake limit and can run into the hundreds or thousands of guesses, so
 * this always rounds to a whole number with thousands separators. */
export function formatGuessCount(value: number): string {
  return Math.round(value).toLocaleString();
}

/** Wall-clock run duration, or null if the run hasn't finished yet — shared
 * by RunHistoryTable and toRunRecord (api.ts) so the same finishedAt/
 * startedAt diff isn't reimplemented in both places. */
export function computeDurationMs(startedAt: string, finishedAt: string | null): number | null {
  return finishedAt === null ? null : new Date(finishedAt).getTime() - new Date(startedAt).getTime();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Run-timestamp formatter. `iso` is always a UTC instant (an ISO string
 * with a "Z"/offset), but deliberately rendered in the *viewer's* local
 * timezone (no `timeZone` override — Intl defaults to the runtime's own)
 * rather than forced to UTC: unlike a puzzle's date (a calendar-day
 * identity every viewer should see the same way, see Game.tsx), a run's
 * startedAt is a real wall-clock moment, and showing it in the viewer's own
 * timezone is what "when did this run start" actually means to them. */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Date-only half of {@link formatTimestamp}, for layouts that stack the
 * date and time on separate rows instead of one combined string. */
export function formatTimestampDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Shorthand mm/dd/yy variant of {@link formatTimestampDate}, for narrow
 * layouts where the long form wraps. Still the viewer's local timezone. */
export function formatTimestampDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Time-only half of {@link formatTimestamp}. */
export function formatTimestampTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** USD token-cost formatter for LLM run rows: most runs cost fractions of a
 * cent, so anything under a cent gets 4 decimal places instead of rounding
 * away to "$0.00". */
export function formatCostUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Success rate to 3 significant figures rather than a rounded whole
 * percent — an occasionally-successful model (e.g. 1 win in 300 attempts,
 * 0.33%) would otherwise round to "0%", indistinguishable from a model
 * that has never solved anything. Number(...toPrecision(3)) rather than a
 * fixed decimal count so round numbers stay clean ("100%", "5%") instead
 * of padding to "100.00%"/"5.00%". */
export function formatSuccessRate(value: number): string {
  return `${Number(value.toPrecision(3))}%`;
}

/** Total USD cost (row.totalCostUsd, which is already all-time — not
 * today-scoped like the token budget) across every LLM row whose model
 * belongs to `models`. Null while either input hasn't loaded yet, so a
 * caller (the Activity page's free-tier widgets) can distinguish "not
 * loaded" from "genuinely $0 spent". */
export function sumSpendUsd(llmRows: LeaderboardRow[] | null, models: Set<string>): number | null {
  if (llmRows === null || models.size === 0) return null;
  return llmRows.reduce(
    (sum, row) => (row.modelName && models.has(row.modelName) ? sum + (row.totalCostUsd ?? 0) : sum),
    0,
  );
}
