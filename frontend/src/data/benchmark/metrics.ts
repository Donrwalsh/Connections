// Configurable-metric logic for the benchmark UI: which metrics the
// leaderboard can sort by, how to read a value off a strategy row, and how to
// format/sort the results. Kept framework-free so it is unit-testable without
// rendering.

import type { LeaderboardRow } from "./types";

export type LeaderboardMetricKey = "avgGuesses" | "successRate" | "speed" | "categoryAccuracy";

export interface MetricDefinition {
  key: LeaderboardMetricKey;
  label: string;
  description: string;
  higherIsBetter: boolean;
  format: (value: number) => string;
}

export const LEADERBOARD_METRICS: MetricDefinition[] = [
  {
    key: "avgGuesses",
    label: "Avg guesses",
    description: "Mean guesses to solve across completed runs — fewer is better",
    higherIsBetter: false,
    format: (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1)),
  },
  {
    key: "successRate",
    label: "Success rate",
    description: "Share of finished runs that solved the puzzle",
    higherIsBetter: true,
    format: (value) => `${Math.round(value)}%`,
  },
  {
    key: "speed",
    label: "Speed",
    description: "Solves per hour, derived from average solve duration",
    higherIsBetter: true,
    format: (value) => `${Math.round(value).toLocaleString()}/hr`,
  },
  {
    key: "categoryAccuracy",
    label: "Category IQ",
    description: "Share of evaluated successful guesses where the model named the real connection",
    higherIsBetter: true,
    format: (value) => formatSuccessRate(value),
  },
];

export function getMetricDefinition(key: LeaderboardMetricKey): MetricDefinition {
  return LEADERBOARD_METRICS.find((metric) => metric.key === key) ?? LEADERBOARD_METRICS[0]!;
}

/** Any row shape with the four metric-source fields the leaderboard sorts
 * by (see the live LeaderboardRow in types.ts) — the metric helpers below
 * don't need to know the concrete row type, just that it has these. */
export interface MetricSource {
  avgGuessesToSolve: number | null;
  successRate: number | null;
  avgDurationMs: number | null;
  categoryAccuracy: number | null;
}

export function metricValue(strategy: MetricSource, key: LeaderboardMetricKey): number | null {
  switch (key) {
    case "avgGuesses":
      return strategy.avgGuessesToSolve;
    case "successRate":
      return strategy.successRate;
    case "speed":
      return strategy.avgDurationMs === null ? null : 3_600_000 / strategy.avgDurationMs;
    case "categoryAccuracy":
      return strategy.categoryAccuracy;
  }
}

/** Sorts leaderboard rows by metric; best first, nulls last. */
export function sortStrategiesByMetric<T extends MetricSource>(
  strategies: T[],
  key: LeaderboardMetricKey,
): T[] {
  const metric = getMetricDefinition(key);
  return [...strategies].sort((a, b) => {
    const aValue = metricValue(a, key);
    const bValue = metricValue(b, key);
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return 1;
    if (bValue === null) return -1;
    const diff = aValue - bValue;
    return metric.higherIsBetter ? -diff : diff;
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
