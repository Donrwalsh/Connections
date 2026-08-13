import { LEADERBOARD_METRICS, type LeaderboardMetricKey } from "../../data/benchmark/metrics";

export interface MetricSelectorProps {
  value: LeaderboardMetricKey;
  onChange: (metric: LeaderboardMetricKey) => void;
}

/** Controls which leaderboard metric the strategy table is sorted by.
 * Pill group on desktop, native select on narrow screens. */
export function MetricSelector({ value, onChange }: MetricSelectorProps) {
  return (
    <div className="bench-metric-selector">
      <div className="bench-metric-selector__pills" role="group" aria-label="Leaderboard metric">
        {LEADERBOARD_METRICS.map((metric) => {
          const isSelected = value === metric.key;
          return (
            <button
              key={metric.key}
              type="button"
              className={`bench-metric-btn${isSelected ? " bench-metric-btn--selected" : ""}`}
              aria-pressed={isSelected}
              onClick={() => onChange(metric.key)}
            >
              {metric.label}
            </button>
          );
        })}
      </div>
      <select
        className="bench-metric-selector__select"
        aria-label="Leaderboard metric"
        value={value}
        onChange={(event) => onChange(event.target.value as LeaderboardMetricKey)}
      >
        {LEADERBOARD_METRICS.map((metric) => (
          <option key={metric.key} value={metric.key}>
            {metric.label}
          </option>
        ))}
      </select>
    </div>
  );
}
