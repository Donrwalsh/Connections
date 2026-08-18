// Configurable-metric logic for the benchmark UI: which metrics the
// leaderboard can sort by, how to read a value off a strategy row, and how to
// format/sort the results. Kept framework-free so it is unit-testable without
// rendering.

export type LeaderboardMetricKey = "avgGuesses" | "successRate" | "speed";

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
];

export function getMetricDefinition(key: LeaderboardMetricKey): MetricDefinition {
  return LEADERBOARD_METRICS.find((metric) => metric.key === key) ?? LEADERBOARD_METRICS[0]!;
}

/** Any row shape with the three metric-source fields the leaderboard sorts
 * by (see the live LeaderboardRow in types.ts) — the metric helpers below
 * don't need to know the concrete row type, just that it has these. */
export interface MetricSource {
  avgGuessesToSolve: number | null;
  successRate: number | null;
  avgDurationMs: number | null;
}

export function metricValue(strategy: MetricSource, key: LeaderboardMetricKey): number | null {
  switch (key) {
    case "avgGuesses":
      return strategy.avgGuessesToSolve;
    case "successRate":
      return strategy.successRate;
    case "speed":
      return strategy.avgDurationMs === null ? null : 3_600_000 / strategy.avgDurationMs;
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

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Run-timestamp formatter with an explicit locale/timezone (UTC) so output
 * is deterministic regardless of the host's locale — same reasoning as
 * Game.tsx's puzzle-date formatting. */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "UTC",
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
