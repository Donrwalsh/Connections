import { useEffect, useState } from "react";
import {
  fetchFreeTierDispatchStatus,
  fetchFreeTierUsage,
  stopFreeTierDispatch,
} from "../../data/benchmark/api";
import { formatCostUsd } from "../../data/benchmark/metrics";
import type { FreeTierDispatchStatus, FreeTierId, FreeTierUsage } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

// Usage at or above this share of a tier's daily budget gets the warning
// tint on its bar, as an early heads-up before the budget is exhausted.
const WARNING_THRESHOLD_PERCENT = 90;

// How often to re-check whether a free-tier dispatch cycle is still
// running. The cycle can stop on its own (threshold reached, or it runs out
// of puzzles) between page loads, so a one-time fetch on mount would go
// stale — polling is what keeps "Auto-dispatch active" honest without the
// viewer having to refresh the page themselves.
const DISPATCH_STATUS_POLL_MS = 30_000;

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
  /** Total USD cost (summed from the leaderboard's per-model totalCostUsd,
   * across every trial ever run — not just today) of every trial run against
   * this tier's models. Unlike the token-budget figures below, this isn't a
   * daily figure and doesn't reset — it's real spend against the provider
   * bill, which the free-token budget only partially offsets. The parent
   * page owns this (it already loads the leaderboard the number comes from),
   * so it's a prop rather than something this widget fetches itself;
   * undefined/null just omits the line rather than showing $0.00 while it's
   * still loading. */
  spentUsd?: number | null;
  /** Bumped by the parent (e.g. after FreeTierDispatchModal starts a cycle
   * for this tier, or for 'both') to force an immediate dispatch-status
   * refetch instead of waiting up to DISPATCH_STATUS_POLL_MS — an action
   * taken elsewhere on the page that this widget wouldn't otherwise know
   * about. Not needed for this widget's own Disable button, which refetches
   * its own status directly after stopping. */
  refreshSignal?: number;
}

/** Leaderboard widget: today's spend against one of the two free-token
 * programs (see FreeTierId) — the backend tracks a fixed model list and
 * daily limit per tier (FreeTierUsageService). Self-fetches so the rest of
 * the page doesn't wait on it; render one instance per tier. Also shows
 * whether a continuous dispatch cycle (FreeTierDispatchService) is
 * currently running for this tier and at what threshold, with a button to
 * disable it. */
export function FreeTierBudgetWidget({ tier, spentUsd, refreshSignal }: FreeTierBudgetWidgetProps) {
  const [usage, setUsage] = useState<FreeTierUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dispatchStatus, setDispatchStatus] = useState<FreeTierDispatchStatus | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

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

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchFreeTierDispatchStatus(tier, controller.signal)
        .then(setDispatchStatus)
        .catch(() => {
          // Best-effort — the token-usage figures above are this widget's
          // main job, so a failed status check just leaves the indicator
          // showing whatever it last knew (or nothing, on first load).
        });
    };

    poll();
    const intervalId = setInterval(poll, DISPATCH_STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
    // refreshSignal is intentionally in the dependency list even though it's
    // otherwise unused in the effect body — bumping it is how a sibling
    // (FreeTierDispatchModal) triggers an immediate re-poll here instead of
    // waiting up to DISPATCH_STATUS_POLL_MS.
  }, [tier, refreshSignal]);

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopFreeTierDispatch(tier)
      .then(() => fetchFreeTierDispatchStatus(tier))
      .then(setDispatchStatus)
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

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
      {/* Always rendered (reserves a fixed row height via CSS) rather than
       * only when a cycle is active — otherwise the flagship and mini
       * widgets, which rarely have matching dispatch state at the same
       * time, end up different heights and everything below drifts out of
       * vertical alignment between the two side-by-side widgets. */}
      <div className="bench-free-tier__dispatch">
        {dispatchStatus?.active ? (
          <>
            <span
              title={
                `Auto-dispatch is queuing new ${tier}-tier trials, evenly spread across its models, ` +
                `until usage reaches ${dispatchStatus.thresholdPercent}% of the daily budget.`
              }
            >
              <StatusPill label={`Auto-dispatch active · ${dispatchStatus.thresholdPercent}%`} tone="active" />
            </span>
            <button
              type="button"
              className="bench-sort-btn"
              onClick={handleDisable}
              disabled={isDisabling}
            >
              {isDisabling ? "Disabling…" : "Disable"}
            </button>
          </>
        ) : null}
      </div>
      {disableError ? <p className="bench-error">{disableError}</p> : null}
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
      {spentUsd !== undefined && spentUsd !== null ? (
        <span
          className="bench-muted bench-free-tier__spent"
          title="Total cost of every trial ever run against this tier's models, not just today's."
        >
          <span className="bench-mono">{formatCostUsd(spentUsd)}</span> spent on trials so far
        </span>
      ) : null}
    </div>
  );
}
