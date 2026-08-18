import { useEffect, useState } from "react";
import { fetchFreeTierUsage } from "../../data/benchmark/api";
import type { FreeTierId, FreeTierUsage } from "../../data/benchmark/types";

// Usage at or above this share of a tier's daily budget gets the warning
// tint on its bar, as an early heads-up before the budget is exhausted.
const WARNING_THRESHOLD_PERCENT = 90;

// Frontend-owned copy for each tier's title, shown immediately (loading and
// error states included) rather than waiting on the fetched `label` field —
// same reasoning as StrategyMeta's static copy: which models a tier covers
// is backend truth (see FreeTierUsage.label/models), but the display title
// is UI copy this page controls directly.
const TIER_TITLES: Record<FreeTierId, string> = {
  flagship: "Flagship daily tokens",
  mini: "Mini & nano daily tokens",
};

export interface FreeTierBudgetWidgetProps {
  tier: FreeTierId;
}

/** Leaderboard widget: today's spend against one of the two free-token
 * programs (see FreeTierId) — the backend tracks a fixed model list and
 * daily limit per tier (FreeTierUsageService). Self-fetches so the rest of
 * the page doesn't wait on it; render one instance per tier. */
export function FreeTierBudgetWidget({ tier }: FreeTierBudgetWidgetProps) {
  const [usage, setUsage] = useState<FreeTierUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUsage(null);
    setError(null);

    const controller = new AbortController();
    fetchFreeTierUsage(tier, controller.signal)
      .then(setUsage)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load token usage");
      });

    return () => controller.abort();
  }, [tier]);

  const title = TIER_TITLES[tier];

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-error">Couldn&apos;t load token usage: {error}</p>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  const percentUsed =
    usage.dailyLimitTokens === 0
      ? 0
      : Math.min(100, (usage.usedTokens / usage.dailyLimitTokens) * 100);
  const isNearLimit = percentUsed >= WARNING_THRESHOLD_PERCENT;

  return (
    <div className="bench-free-tier" role="status" aria-label={`${title} usage`}>
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{title}</span>
        <span
          className="bench-mono bench-free-tier__figures"
          title={`Covers: ${usage.models.join(", ")}`}
        >
          {usage.usedTokens.toLocaleString()} / {usage.dailyLimitTokens.toLocaleString()} used
        </span>
      </div>
      <div
        className="bench-free-tier__bar"
        role="progressbar"
        aria-valuenow={Math.round(percentUsed)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`bench-free-tier__bar-fill${
            isNearLimit ? " bench-free-tier__bar-fill--warning" : ""
          }`}
          style={{ width: `${percentUsed}%` }}
        />
      </div>
      <span className="bench-muted bench-free-tier__remaining">
        {usage.remainingTokens.toLocaleString()} tokens remaining today
      </span>
    </div>
  );
}
